import { createHash, randomBytes } from 'node:crypto';
import type { Config } from '../config.js';
import type { Db } from '../db/database.js';
import type { Role } from '../db/schema.js';

export const SESSION_COOKIE = 'flagship_session';
const TOUCH_INTERVAL_MS = 60_000;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface Session {
  user: SessionUser;
  csrfToken: string;
  tokenHash: Buffer;
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

function expiry(config: Config, created: Date, now: Date): Date {
  const idle = now.getTime() + config.sessionIdleMinutes * 60_000;
  const absolute = created.getTime() + config.sessionMaxHours * 3_600_000;
  return new Date(Math.min(idle, absolute));
}

/**
 * Creates a session and returns the raw token for the cookie. Only its
 * SHA-256 is stored, so a leaked sessions table can't be replayed.
 */
export async function createSession(
  db: Db,
  config: Config,
  userId: string,
  now: Date,
): Promise<{ token: string; csrfToken: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  const expiresAt = expiry(config, now, now);
  await db
    .insertInto('sessions')
    .values({
      token_hash: hashToken(token),
      user_id: userId,
      csrf_token: csrfToken,
      created_at: now,
      last_seen_at: now,
      expires_at: expiresAt,
    })
    .execute();
  return { token, csrfToken, expiresAt };
}

/** Resolves a cookie token to a live session, sliding the idle expiry at most once a minute. */
export async function resolveSession(
  db: Db,
  config: Config,
  token: string,
  now: Date,
): Promise<Session | undefined> {
  if (token.length === 0 || token.length > 100) return undefined;
  const tokenHash = hashToken(token);
  const row = await db
    .selectFrom('sessions')
    .innerJoin('users', 'users.id', 'sessions.user_id')
    .select([
      'sessions.csrf_token',
      'sessions.created_at',
      'sessions.last_seen_at',
      'sessions.expires_at',
      'users.id',
      'users.email',
      'users.name',
      'users.role',
      'users.disabled_at',
    ])
    .where('sessions.token_hash', '=', tokenHash)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  if (row.expires_at <= now || row.disabled_at !== null) {
    await db.deleteFrom('sessions').where('token_hash', '=', tokenHash).execute();
    return undefined;
  }
  if (now.getTime() - row.last_seen_at.getTime() > TOUCH_INTERVAL_MS) {
    await db
      .updateTable('sessions')
      .set({ last_seen_at: now, expires_at: expiry(config, row.created_at, now) })
      .where('token_hash', '=', tokenHash)
      .execute();
  }
  return {
    user: { id: row.id, email: row.email, name: row.name, role: row.role },
    csrfToken: row.csrf_token,
    tokenHash,
  };
}

export async function deleteSession(db: Db, tokenHash: Buffer): Promise<void> {
  await db.deleteFrom('sessions').where('token_hash', '=', tokenHash).execute();
}

export async function deleteOtherSessions(db: Db, userId: string, keep?: Buffer): Promise<void> {
  let q = db.deleteFrom('sessions').where('user_id', '=', userId);
  if (keep !== undefined) q = q.where('token_hash', '!=', keep);
  await q.execute();
}

export async function pruneExpiredSessions(db: Db, now: Date): Promise<number> {
  const r = await db.deleteFrom('sessions').where('expires_at', '<=', now).executeTakeFirst();
  return Number(r.numDeletedRows);
}
