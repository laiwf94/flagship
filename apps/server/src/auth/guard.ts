import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Context } from '../context.js';
import type { Role } from '../db/schema.js';
import { AppError } from '../errors.js';
import { safeEqual } from '../util.js';
import { resolveSession, SESSION_COOKIE, type SessionUser } from './sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
    session: { csrfToken: string; tokenHash: Buffer } | null;
  }
  interface FastifyContextConfig {
    /** Minimum role for a session-authenticated route. */
    role?: Role;
    /** Route that needs no session (sign-in). */
    public?: boolean;
  }
}

const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function hasRole(user: SessionUser, role: Role): boolean {
  return RANK[user.role] >= RANK[role];
}

/**
 * Rejects cross-origin state changes. Browsers always send Origin on
 * cross-origin POST/PUT/DELETE, so a mismatch means another site is driving
 * the user's browser. Requests without Origin (curl, server-side clients)
 * carry no ambient browser credentials worth protecting beyond the CSRF token.
 */
export function checkOrigin(ctx: Context, request: FastifyRequest): void {
  if (SAFE_METHODS.has(request.method)) return;
  const origin = request.headers.origin;
  if (origin === undefined) return;
  const own = `${request.protocol}://${request.host}`;
  if (origin === own || ctx.config.allowedOrigins.includes(origin)) return;
  throw new AppError('permission_denied', 'cross-origin request refused');
}

/** onRequest hook for /api routes: session, CSRF token, origin and role. */
export function sessionGuard(ctx: Context) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    checkOrigin(ctx, request);
    const config = request.routeOptions.config;
    if (config.public === true) return;

    const token = request.cookies[SESSION_COOKIE];
    const session =
      token === undefined ? undefined : await resolveSession(ctx.db, ctx.config, token, ctx.now());
    if (session === undefined) throw new AppError('unauthenticated', 'sign in required');

    if (!SAFE_METHODS.has(request.method)) {
      const given = request.headers['x-csrf-token'];
      if (typeof given !== 'string' || !safeEqual(given, session.csrfToken)) {
        throw new AppError('permission_denied', 'missing or invalid CSRF token');
      }
    }
    const role = config.role ?? 'viewer';
    if (!hasRole(session.user, role)) {
      throw new AppError('permission_denied', `this needs the ${role} role`);
    }
    request.user = session.user;
    request.session = { csrfToken: session.csrfToken, tokenHash: session.tokenHash };
  };
}

/** The signed-in user; only call from routes behind sessionGuard. */
export function currentUser(request: FastifyRequest): SessionUser {
  if (request.user === null) throw new AppError('unauthenticated', 'sign in required');
  return request.user;
}
