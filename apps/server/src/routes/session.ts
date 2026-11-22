import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { dummyHash, hashPassword, verifyPassword } from '../auth/passwords.js';
import type { SignInLimiter } from '../auth/ratelimit.js';
import {
  createSession,
  deleteOtherSessions,
  deleteSession,
  SESSION_COOKIE,
} from '../auth/sessions.js';
import { currentUser } from '../auth/guard.js';
import type { Context } from '../context.js';
import { AppError, parse } from '../errors.js';
import { operations } from '../openapi.js';
import { recordAudit } from '../services/audit.js';

export const passwordSchema = z.string().min(12, 'use at least 12 characters').max(256);

const loginSchema = z.strictObject({
  email: z.string().trim().max(254),
  password: z.string().max(256),
});

const passwordChangeSchema = z.strictObject({
  currentPassword: z.string().max(256),
  newPassword: passwordSchema,
});

function secureCookie(ctx: Context, request: FastifyRequest): boolean {
  if (ctx.config.cookieSecure === 'auto') return request.protocol === 'https';
  return ctx.config.cookieSecure === 'true';
}

function clearCookie(ctx: Context, request: FastifyRequest, reply: FastifyReply): void {
  void reply.clearCookie(SESSION_COOKIE, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookie(ctx, request),
  });
}

/**
 * Runs a limiter call and fails closed: if the shared budget cannot be read or
 * written, nobody signs in, rather than everybody guessing without a limit.
 */
async function limited<T>(request: FastifyRequest, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    request.log.error({ err }, 'sign-in limiter unavailable');
    throw new AppError('unavailable', 'sign-in is temporarily unavailable', undefined, {
      'retry-after': '5',
    });
  }
}

const op = operations('session');

export function sessionRoutes(ctx: Context, limiter: SignInLimiter) {
  return async (api: FastifyInstance): Promise<void> => {
    api.post(
      '/session',
      {
        config: {
          public: true,
          openapi: op('signIn', 'Sign in; sets the session cookie and returns the CSRF token', {
            body: loginSchema,
          }),
        },
      },
      async (request, reply) => {
        const { email, password } = parse(loginSchema, request.body, 'sign-in');
        const normalized = email.toLowerCase();
        const now = ctx.now();
        const wait = await limited(request, () => limiter.begin(normalized, request.ip, now));
        if (wait > 0) {
          throw new AppError(
            'resource_exhausted',
            'too many failed sign-ins, try again later',
            undefined,
            {
              'retry-after': String(Math.ceil(wait / 1000)),
            },
          );
        }

        const user = await ctx.db
          .selectFrom('users')
          .select(['id', 'email', 'name', 'role', 'password_hash', 'disabled_at'])
          .where('email', '=', normalized)
          .executeTakeFirst();
        const ok = await verifyPassword(password, user?.password_hash ?? (await dummyHash()));
        if (user === undefined || !ok || user.disabled_at !== null) {
          // The reserved attempt stays counted against both keys.
          throw new AppError('unauthenticated', 'email or password is incorrect');
        }
        await limited(request, () => limiter.succeeded(normalized, request.ip, now));

        const session = await createSession(ctx.db, ctx.config, user.id, ctx.now());
        void reply.setCookie(SESSION_COOKIE, session.token, {
          path: '/',
          httpOnly: true,
          sameSite: 'lax',
          secure: secureCookie(ctx, request),
          expires: session.expiresAt,
        });
        return {
          user: { id: user.id, email: user.email, name: user.name, role: user.role },
          csrfToken: session.csrfToken,
        };
      },
    );

    api.get(
      '/session',
      {
        config: {
          sessionOnly: true,
          openapi: op('getSession', 'The signed-in user and CSRF token'),
        },
      },
      async (request) => ({
        user: currentUser(request),
        csrfToken: request.session?.csrfToken,
      }),
    );

    api.delete(
      '/session',
      { config: { sessionOnly: true, openapi: op('signOut', 'Sign out', { status: [204] }) } },
      async (request, reply) => {
        if (request.session !== null) await deleteSession(ctx.db, request.session.tokenHash);
        clearCookie(ctx, request, reply);
        return reply.status(204).send();
      },
    );

    api.put(
      '/session/password',
      {
        config: {
          sessionOnly: true,
          openapi: op('changePassword', 'Change your password and end your other sessions', {
            body: passwordChangeSchema,
            status: [204],
          }),
        },
      },
      async (request, reply) => {
        const user = currentUser(request);
        const body = parse(passwordChangeSchema, request.body, 'password change');
        const row = await ctx.db
          .selectFrom('users')
          .select('password_hash')
          .where('id', '=', user.id)
          .executeTakeFirstOrThrow();
        if (!(await verifyPassword(body.currentPassword, row.password_hash))) {
          throw new AppError('invalid_argument', 'current password is incorrect', [
            { path: 'currentPassword', message: 'current password is incorrect' },
          ]);
        }
        const hash = await hashPassword(body.newPassword);
        await ctx.db.transaction().execute(async (trx) => {
          await trx
            .updateTable('users')
            .set({ password_hash: hash })
            .where('id', '=', user.id)
            .execute();
          await deleteOtherSessions(trx, user.id, request.session?.tokenHash);
          await recordAudit(trx, {
            projectId: null,
            actor: { id: user.id, name: user.name },
            action: 'user.password_change',
            targetType: 'user',
            targetKey: user.email,
          });
        });
        return reply.status(204).send();
      },
    );
  };
}
