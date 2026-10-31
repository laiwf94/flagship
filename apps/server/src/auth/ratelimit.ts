import { sql } from 'kysely';
import type { Db } from '../db/database.js';

export type LimitScope = 'email' | 'ip';

export interface SignInLimits {
  /** Attempts per email address in one window. */
  email: number;
  /** Attempts per client address in one window. */
  ip: number;
  windowMs: number;
}

export const SIGN_IN_LIMITS: SignInLimits = { email: 10, ip: 50, windowMs: 15 * 60_000 };

interface AttemptRow {
  scope: LimitScope;
  attempts: Date[];
  allowed: boolean;
}

/**
 * Limits sign-in attempts per email and per client address in a sliding
 * window, with its state in Postgres so every server instance draws on the
 * same budget.
 *
 * An attempt is reserved before the password is checked, with one
 * INSERT ... ON CONFLICT DO UPDATE ... RETURNING for both keys. The decision
 * is made inside the upsert, on the row Postgres has locked, so concurrent
 * guesses on any number of instances cannot all pass a check before any of
 * them is counted. A refused attempt is not recorded, so hammering a locked
 * key does not extend its lockout. Afterwards the caller settles the
 * reservation: a failure keeps it, a success clears the email's budget and
 * gives the address its attempt back, so only failures count against it.
 *
 * Each row keeps at most `limit` timestamps, so a row is a few hundred bytes
 * and the table holds one row per key seen in the last window; prune() drops
 * the rest in bounded batches.
 */
export class SignInLimiter {
  constructor(
    private readonly db: Db,
    private readonly limits: SignInLimits = SIGN_IN_LIMITS,
  ) {}

  /**
   * Reserves an attempt for both keys. Returns 0 when it may go ahead, or the
   * milliseconds until the more restrictive key allows another attempt.
   * Throws when the store cannot be reached; callers fail closed.
   */
  async begin(email: string, ip: string, now: Date): Promise<number> {
    const { email: emailLimit, ip: ipLimit, windowMs } = this.limits;
    const cutoff = new Date(now.getTime() - windowMs);
    const limit = sql<number>`(CASE la.scope WHEN 'email' THEN ${emailLimit}::int ELSE ${ipLimit}::int END)`;
    const recent = sql<
      Date[]
    >`array(SELECT t FROM unnest(la.attempts) AS t WHERE t > ${cutoff}::timestamptz ORDER BY t)`;
    const { rows } = await sql<AttemptRow>`
      INSERT INTO login_attempts AS la (scope, key, attempts, last_at, allowed)
      VALUES
        ('email', ${email}, ARRAY[${now}::timestamptz], ${now}, true),
        ('ip', ${ip}, ARRAY[${now}::timestamptz], ${now}, true)
      ON CONFLICT (scope, key) DO UPDATE SET
        attempts = CASE WHEN cardinality(${recent}) < ${limit}
          THEN ${recent} || ${now}::timestamptz
          ELSE ${recent} END,
        last_at = CASE WHEN cardinality(${recent}) < ${limit}
          THEN greatest(la.last_at, ${now}::timestamptz)
          ELSE la.last_at END,
        allowed = cardinality(${recent}) < ${limit}
      RETURNING la.scope, la.attempts, la.allowed`.execute(this.db);

    if (rows.every((r) => r.allowed)) return 0;
    let wait = 0;
    for (const row of rows) {
      if (row.allowed) {
        // Refused by the other key: no password is checked, so give it back.
        await this.refund(row.scope, row.scope === 'email' ? email : ip, now);
        continue;
      }
      const lim = row.scope === 'email' ? emailLimit : ipLimit;
      const times = row.attempts.map((d) => d.getTime()).sort((a, b) => a - b);
      const oldest = times[times.length - lim] ?? now.getTime();
      wait = Math.max(wait, oldest + windowMs - now.getTime(), 1);
    }
    return wait;
  }

  /** Settles a reservation made at `at` for a sign-in that succeeded. */
  async succeeded(email: string, ip: string, at: Date): Promise<void> {
    await this.db
      .deleteFrom('login_attempts')
      .where('scope', '=', 'email')
      .where('key', '=', email)
      .execute();
    await this.refund('ip', ip, at);
  }

  /** Removes one attempt recorded at `at`, and the row once it is empty. */
  private async refund(scope: LimitScope, key: string, at: Date): Promise<void> {
    const { rows } = await sql<{ left: number }>`
      UPDATE login_attempts SET attempts =
        attempts[:array_position(attempts, ${at}::timestamptz) - 1]
        || attempts[array_position(attempts, ${at}::timestamptz) + 1:]
      WHERE scope = ${scope} AND key = ${key} AND ${at}::timestamptz = ANY (attempts)
      RETURNING cardinality(attempts) AS left`.execute(this.db);
    if (rows[0]?.left === 0) {
      await sql`DELETE FROM login_attempts
        WHERE scope = ${scope} AND key = ${key} AND cardinality(attempts) = 0`.execute(this.db);
    }
  }

  /**
   * Deletes up to `batch` rows whose last attempt is older than the window,
   * oldest first. The outer condition is re-checked on the locked row, so a
   * row that took a new attempt meanwhile is kept.
   */
  async prune(now: Date, batch = 1000): Promise<number> {
    const cutoff = new Date(now.getTime() - this.limits.windowMs);
    const r = await sql`
      DELETE FROM login_attempts
      WHERE last_at <= ${cutoff}::timestamptz AND (scope, key) IN (
        SELECT scope, key FROM login_attempts
        WHERE last_at <= ${cutoff}::timestamptz
        ORDER BY last_at
        LIMIT ${batch}::int
      )`.execute(this.db);
    return Number(r.numAffectedRows ?? 0);
  }
}
