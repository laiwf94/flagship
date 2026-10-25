import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import type { Db } from '../db/database.js';
import type { KeyKind } from '../db/schema.js';
import { notFound } from '../errors.js';
import { recordAudit, type Actor } from './audit.js';

const PREFIX: Record<KeyKind, string> = { server: 'fss_', client: 'fsc_' };
const KEY_PATTERN = /^fs[sc]_[A-Za-z0-9_-]{43}$/;
const TOUCH_INTERVAL_MS = 60_000;

export const KEYS_CHANNEL = 'flagship_keys';

export interface ApiKeyView {
  id: string;
  kind: KeyKind;
  name: string;
  displayPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
}

export interface KeyIdentity {
  keyId: string;
  kind: KeyKind;
  environmentId: string;
  environmentKey: string;
  projectId: string;
  projectKey: string;
}

function hashKey(raw: string): Buffer {
  return createHash('sha256').update(raw).digest();
}

function view(row: {
  id: string;
  kind: KeyKind;
  name: string;
  display_prefix: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}): ApiKeyView {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    displayPrefix: row.display_prefix,
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    revoked: row.revoked_at !== null,
  };
}

const columns = [
  'id',
  'kind',
  'name',
  'display_prefix',
  'created_at',
  'last_used_at',
  'revoked_at',
] as const;

export async function listApiKeys(db: Db, environmentId: string): Promise<ApiKeyView[]> {
  const rows = await db
    .selectFrom('api_keys')
    .select(columns)
    .where('environment_id', '=', environmentId)
    .orderBy('created_at', 'desc')
    .execute();
  return rows.map(view);
}

/**
 * 256 random bits behind a readable prefix. Only the SHA-256 is stored: the
 * key has full entropy, so a fast hash is enough (no salt or KDF needed), and
 * lookups by hash don't leak timing about the secret.
 */
export async function createApiKey(
  db: Db,
  env: { id: string; projectId: string; key: string },
  input: { kind: KeyKind; name: string },
  actor: Actor,
): Promise<ApiKeyView & { secret: string }> {
  const secret = `${PREFIX[input.kind]}${randomBytes(32).toString('base64url')}`;
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .insertInto('api_keys')
      .values({
        environment_id: env.id,
        kind: input.kind,
        name: input.name,
        display_prefix: secret.slice(0, 12),
        key_hash: hashKey(secret),
        created_by: actor.id,
      })
      .returning(columns)
      .executeTakeFirstOrThrow();
    const created = view(row);
    await recordAudit(trx, {
      projectId: env.projectId,
      environmentId: env.id,
      actor,
      action: 'api_key.create',
      targetType: 'api_key',
      targetKey: `${created.name} (${created.displayPrefix}…)`,
      after: { kind: created.kind, name: created.name, displayPrefix: created.displayPrefix },
    });
    return { ...created, secret };
  });
}

/** Revokes immediately; open streams on the key are closed by every instance via NOTIFY. */
export async function revokeApiKey(
  db: Db,
  env: { id: string; projectId: string },
  id: string,
  actor: Actor,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const row = await trx
      .updateTable('api_keys')
      .set({ revoked_at: new Date() })
      .where('id', '=', id)
      .where('environment_id', '=', env.id)
      .where('revoked_at', 'is', null)
      .returning(['name', 'display_prefix', 'kind'])
      .executeTakeFirst();
    if (row === undefined) throw notFound('active API key');
    await recordAudit(trx, {
      projectId: env.projectId,
      environmentId: env.id,
      actor,
      action: 'api_key.revoke',
      targetType: 'api_key',
      targetKey: `${row.name} (${row.display_prefix}…)`,
      before: { kind: row.kind, name: row.name, displayPrefix: row.display_prefix },
    });
    await sql`SELECT pg_notify(${KEYS_CHANNEL}, ${id})`.execute(trx);
  });
}

export class KeyAuthenticator {
  private readonly touched = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly now: () => Date,
  ) {}

  async authenticate(raw: string): Promise<KeyIdentity | undefined> {
    if (!KEY_PATTERN.test(raw)) return undefined;
    const row = await this.db
      .selectFrom('api_keys')
      .innerJoin('environments', 'environments.id', 'api_keys.environment_id')
      .innerJoin('projects', 'projects.id', 'environments.project_id')
      .select([
        'api_keys.id',
        'api_keys.kind',
        'api_keys.revoked_at',
        'environments.id as environment_id',
        'environments.key as environment_key',
        'projects.id as project_id',
        'projects.key as project_key',
      ])
      .where('api_keys.key_hash', '=', hashKey(raw))
      .executeTakeFirst();
    if (row === undefined || row.revoked_at !== null) return undefined;
    const now = this.now();
    const last = this.touched.get(row.id) ?? 0;
    if (now.getTime() - last > TOUCH_INTERVAL_MS) {
      if (this.touched.size > 100_000) this.touched.clear();
      this.touched.set(row.id, now.getTime());
      await this.db
        .updateTable('api_keys')
        .set({ last_used_at: now })
        .where('id', '=', row.id)
        .execute();
    }
    return {
      keyId: row.id,
      kind: row.kind,
      environmentId: row.environment_id,
      environmentKey: row.environment_key,
      projectId: row.project_id,
      projectKey: row.project_key,
    };
  }
}
