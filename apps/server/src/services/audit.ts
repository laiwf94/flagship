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
