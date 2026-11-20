import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Context } from '../context.js';
import type { Role } from '../db/schema.js';
import { AppError } from '../errors.js';
import type { TokenIdentity } from '../services/apitokens.js';
import { safeEqual } from '../util.js';
import { isReadScope, type Scope } from './scopes.js';
import { resolveSession, SESSION_COOKIE, type SessionUser } from './sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
    session: { csrfToken: string; tokenHash: Buffer } | null;
    /** The API token a request authenticated with, when it did not use a session. */
    apiToken: { id: string; name: string } | null;
  }
  interface FastifyContextConfig {
    /** Minimum role for the route, checked against the user or the token's owner. */
    role?: Role;
    /** Route that needs no session (sign-in). */
    public?: boolean;
    /** The scope an API token needs for this route. */
    scope?: Scope;
    /** Route that API tokens can never use (sessions, users, tokens themselves). */
    sessionOnly?: boolean;
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

/**
 * onRoute hook for /api: every route must say whether API tokens can use it
 * (`scope`) or not (`sessionOnly`), so a new route can't be left open to
 * tokens, or closed to them, by omission.
 */
export function requireScopeDeclaration(route: {
  method: string | string[];
  url: string;
  config?: unknown;
}): void {
  const config = (route.config ?? {}) as { public?: boolean; scope?: Scope; sessionOnly?: boolean };
  const declared =
    (config.public === true ? 1 : 0) +
    (config.scope !== undefined ? 1 : 0) +
    (config.sessionOnly === true ? 1 : 0);
  if (declared !== 1) {
    const method = Array.isArray(route.method) ? route.method.join(',') : route.method;
    throw new Error(
      `${method} ${route.url} must declare exactly one of public, scope or sessionOnly`,
    );
  }
}

function param(request: FastifyRequest, name: string): string | undefined {
  const value = (request.params as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Authorizes a bearer-token request against the route's declared scope, the
 * owner's current role, and the token's project and environments. An
 * environment-restricted token may read project-level data, but only writes
 * through routes that name one of its environments.
 */
export function authorizeToken(identity: TokenIdentity, request: FastifyRequest): void {
  const config = request.routeOptions.config;
  const scope = config.scope;
  if (scope === undefined) {
    throw new AppError('permission_denied', 'API tokens cannot use this route; sign in instead');
  }
  if (!identity.scopes.includes(scope)) {
    throw new AppError('permission_denied', `this token lacks the ${scope} scope`);
  }
  const role = config.role ?? 'viewer';
  if (!hasRole(identity.user, role)) {
    throw new AppError('permission_denied', `this needs the ${role} role`);
  }
  if (identity.projectKey !== null) {
    const project = param(request, 'project');
    if (project !== identity.projectKey) {
      throw new AppError(
        'permission_denied',
        `this token is limited to project "${identity.projectKey}"`,
      );
    }
  }
  if (identity.environmentKeys !== null) {
    const environment = param(request, 'environment');
    const allowed =
      environment === undefined
        ? isReadScope(scope)
        : identity.environmentKeys.includes(environment);
    if (!allowed) {
      throw new AppError(
        'permission_denied',
        `this token is limited to the ${identity.environmentKeys.join(', ')} environment` +
          (identity.environmentKeys.length === 1 ? '' : 's'),
      );
    }
  }
}

function bearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return undefined;
  return header.slice(7).trim();
}

/**
 * onRequest hook for /api routes: origin first, then either an API token
 * (`Authorization: Bearer fst_...`) or the session cookie with its CSRF token
 * and role. A token is not an ambient browser credential, so it needs no CSRF
 * token; when one is given, the cookie is ignored.
 */
export function sessionGuard(ctx: Context) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    checkOrigin(ctx, request);
    const config = request.routeOptions.config;
    if (config.public === true) return;

    const raw = bearer(request);
    if (raw !== undefined) {
      const identity = await ctx.tokens.authenticate(raw);
      if (identity === undefined) {
        throw new AppError('unauthenticated', 'unknown, expired or revoked API token');
      }
      authorizeToken(identity, request);
      request.user = identity.user;
      request.apiToken = { id: identity.id, name: identity.name };
      return;
    }

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
