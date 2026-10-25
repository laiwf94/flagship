import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { dummyHash, hashPassword, verifyPassword } from '../auth/passwords.js';
import { FailureLimiter } from '../auth/ratelimit.js';
import {
  createSession,
  deleteOtherSessions,
  deleteSession,
  SESSION_COOKIE,
} from '../auth/sessions.js';
import { currentUser } from '../auth/guard.js';
import type { Context } from '../context.js';
import { AppError, parse } from '../errors.js';
import { recordAudit } from '../services/audit.js';

const WINDOW_MS = 15 * 60_000;

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

export function sessionRoutes(ctx: Context) {
  const byEmail = new FailureLimiter(10, WINDOW_MS);
  const byIp = new FailureLimiter(50, WINDOW_MS);

  return async (api: FastifyInstance): Promise<void> => {
    api.post('/session', { config: { public: true } }, async (request, reply) => {
      const { email, password } = parse(loginSchema, request.body, 'sign-in');
      const normalized = email.toLowerCase();
      const now = ctx.now().getTime();
      const wait = Math.max(byEmail.retryAfter(normalized, now), byIp.retryAfter(request.ip, now));
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
        byEmail.fail(normalized, now);
        byIp.fail(request.ip, now);
        throw new AppError('unauthenticated', 'email or password is incorrect');
      }
      byEmail.reset(normalized);

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
    });

    api.get('/session', async (request) => ({
      user: currentUser(request),
      csrfToken: request.session?.csrfToken,
    }));

    api.delete('/session', async (request, reply) => {
      if (request.session !== null) await deleteSession(ctx.db, request.session.tokenHash);
      clearCookie(ctx, request, reply);
      return reply.status(204).send();
    });

    api.put('/session/password', async (request, reply) => {
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
    });
  };
}
