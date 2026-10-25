import { diff, type DiffEntry } from '@flagship/core';
import type { Db } from '../db/database.js';

export interface Actor {
  id: string | null;
  name: string;
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
}

/** Call inside the transaction that makes the change, so the two commit together. */
export async function recordAudit(db: Db, e: AuditEntry): Promise<void> {
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
  before: unknown;
  after: unknown;
  diff: DiffEntry[];
}

export async function listAudit(
  db: Db,
  projectId: string,
  filter: {
    targetType?: string | undefined;
    targetKey?: string | undefined;
    before?: number | undefined;
    limit: number;
  },
): Promise<AuditView[]> {
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
      'audit_log.before',
      'audit_log.after',
      'environments.key as environment',
    ])
    .where('audit_log.project_id', '=', projectId);
  if (filter.targetType !== undefined) q = q.where('audit_log.target_type', '=', filter.targetType);
  if (filter.targetKey !== undefined) q = q.where('audit_log.target_key', '=', filter.targetKey);
  if (filter.before !== undefined) q = q.where('audit_log.id', '<', filter.before);
  const rows = await q.orderBy('audit_log.id', 'desc').limit(filter.limit).execute();
  return rows.map((r) => ({
    id: r.id,
    at: r.created_at.toISOString(),
    actor: r.actor_name,
    action: r.action,
    targetType: r.target_type,
    targetKey: r.target_key,
    environment: r.environment,
    before: r.before ?? null,
    after: r.after ?? null,
    diff: diff(r.before ?? undefined, r.after ?? undefined),
  }));
}
