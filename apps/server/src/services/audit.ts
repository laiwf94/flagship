import { diff, type DiffEntry } from '@flagship/core';
import { sql } from 'kysely';
import type { Db } from '../db/database.js';
import { AppError } from '../errors.js';

/** Why a change was made, as its author gave it. */
export interface ChangeNote {
  reason: string | null;
  link: string | null;
}

export interface Actor {
  id: string | null;
  name: string;
  /** The reason and link given with the request that made the change. */
  note?: ChangeNote | undefined;
}

export interface AuditEntry {
  projectId: string | null;
  environmentId?: string | null;
  actor: Actor;
  action: string;
  targetType: string;
  targetKey: string;
  before?: unknown;
  after?: unknown;
  /** Overrides the actor's note, for example with the one a change request was proposed with. */
  note?: ChangeNote | undefined;
}

/** Call inside the transaction that makes the change, so the two commit together. */
export async function recordAudit(db: Db, e: AuditEntry): Promise<void> {
  const note = e.note ?? e.actor.note;
  await db
    .insertInto('audit_log')
    .values({
      project_id: e.projectId,
      environment_id: e.environmentId ?? null,
      actor_id: e.actor.id,
      actor_name: e.actor.name,
      action: e.action,
      target_type: e.targetType,
      target_key: e.targetKey,
      before: e.before === undefined ? null : JSON.stringify(e.before),
      after: e.after === undefined ? null : JSON.stringify(e.after),
      reason: note?.reason ?? null,
      link: note?.link ?? null,
    })
    .execute();
}

export interface AuditView {
  id: number;
  at: string;
  actor: string;
  action: string;
  targetType: string;
  targetKey: string;
  environment: string | null;
  reason: string | null;
  link: string | null;
  before: unknown;
  after: unknown;
  diff: DiffEntry[];
}

/** Where a page ended: the last entry's exact timestamp and id. */
export interface AuditCursor {
  /** Microsecond-precision UTC timestamp, as Postgres stores it. */
  at: string;
  id: number;
}

const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export function encodeCursor(c: AuditCursor): string {
  return Buffer.from(`${c.at}|${c.id}`, 'utf8').toString('base64url');
}

/** Reads a cursor from a previous page, or throws invalid_argument. */
export function decodeCursor(raw: string): AuditCursor {
  const text = /^[A-Za-z0-9_-]{1,100}$/.test(raw)
    ? Buffer.from(raw, 'base64url').toString('utf8')
    : '';
  const [at, id, extra] = text.split('|');
  const n = Number(id);
  if (
    extra !== undefined ||
    at === undefined ||
    !CURSOR_AT.test(at) ||
    Number.isNaN(Date.parse(at)) ||
    !Number.isSafeInteger(n) ||
    n < 1
  ) {
    throw new AppError('invalid_argument', 'invalid cursor', [
      { path: 'cursor', message: 'not a cursor from a previous page' },
    ]);
  }
  return { at, id: n };
}

/** The characters the search column turns into spaces; keep in step with migration 007. */
const SEPARATORS = /[.\-_/:@#?&=+~%]+/g;

/**
 * Rewrites a search the way the search column was built, keeping web-search
 * syntax: a word with separators becomes a phrase ("INC-42" is "inc 42" in
 * that order), a leading minus still negates, and quoted phrases and `or`
 * are left as they are.
 */
export function searchQuery(text: string): string {
  return text
    .split('"')
    .map((part, i) => {
      if (i % 2 === 1) return part.replace(SEPARATORS, ' ');
      return part
        .split(/\s+/)
        .map((word) => {
          const neg = word.length > 1 && word.startsWith('-') ? '-' : '';
          const body = word.slice(neg.length).replace(SEPARATORS, ' ').trim();
          if (body === '') return '';
          return body.includes(' ') ? `${neg}"${body.replace(/\s+/g, ' ')}"` : neg + body;
        })
        .filter((w) => w !== '')
        .join(' ');
    })
    .join(' " ');
}

export interface AuditFilter {
  targetType?: string | undefined;
  targetKey?: string | undefined;
  /** Exact actor name. */
  actor?: string | undefined;
  /** Web-search syntax over action, target, actor, reason and link: words, "phrases", -not, or. */
  text?: string | undefined;
  /** Inclusive lower bound on the entry's time. */
  from?: Date | undefined;
  /** Exclusive upper bound on the entry's time. */
  to?: Date | undefined;
  /** Continue after this entry. */
  after?: AuditCursor | undefined;
  limit: number;
}

export interface AuditPage {
  entries: AuditView[];
  /** Cursor for the next (older) page, or null when this was the last one. */
  next: string | null;
}

/**
 * One page of a project's audit log, newest first. Pages by keyset on
 * (created_at, id) so a deep page costs the same as the first, and every
 * filter has an index in that order: target, actor, the project alone, and
 * the GIN index on `search` for text. Asks for one row more than the page to
 * know whether another page exists.
 */
export async function searchAudit(db: Db, projectId: string, f: AuditFilter): Promise<AuditPage> {
  let q = db
    .selectFrom('audit_log')
    .leftJoin('environments', 'environments.id', 'audit_log.environment_id')
    .select([
      'audit_log.id',
      'audit_log.created_at',
      'audit_log.actor_name',
      'audit_log.action',
      'audit_log.target_type',
      'audit_log.target_key',
      'audit_log.reason',
      'audit_log.link',
      'audit_log.before',
      'audit_log.after',
      'environments.key as environment',
      sql<string>`to_char(audit_log.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
        'exact_at',
      ),
    ])
    .where('audit_log.project_id', '=', projectId);
  if (f.targetType !== undefined) q = q.where('audit_log.target_type', '=', f.targetType);
  if (f.targetKey !== undefined) q = q.where('audit_log.target_key', '=', f.targetKey);
  if (f.actor !== undefined) q = q.where('audit_log.actor_name', '=', f.actor);
  if (f.text !== undefined) {
    q = q.where(
      sql<boolean>`audit_log.search @@ websearch_to_tsquery('simple', ${searchQuery(f.text)})`,
    );
  }
  if (f.from !== undefined) q = q.where('audit_log.created_at', '>=', f.from);
  if (f.to !== undefined) q = q.where('audit_log.created_at', '<', f.to);
  if (f.after !== undefined) {
    const { at, id } = f.after;
    q = q.where(
      sql<boolean>`(audit_log.created_at, audit_log.id) < (${at}::timestamptz, ${id}::bigint)`,
    );
  }
  const rows = await q
    .orderBy('audit_log.created_at', 'desc')
    .orderBy('audit_log.id', 'desc')
    .limit(f.limit + 1)
    .execute();
  const page = rows.slice(0, f.limit);
  const last = page.at(-1);
  return {
    entries: page.map((r) => ({
      id: r.id,
      at: r.created_at.toISOString(),
      actor: r.actor_name,
      action: r.action,
      targetType: r.target_type,
      targetKey: r.target_key,
      environment: r.environment,
      reason: r.reason,
      link: r.link,
      before: r.before ?? null,
      after: r.after ?? null,
      diff: diff(r.before ?? undefined, r.after ?? undefined),
    })),
    next:
      rows.length > f.limit && last !== undefined
        ? encodeCursor({ at: last.exact_at, id: last.id })
        : null,
  };
}
