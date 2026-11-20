import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/database.js';
import type { Role } from '../db/schema.js';
import { AppError, notFound } from '../errors.js';
import { isScope, SCOPE_ROLE, SCOPES, type Scope } from '../auth/scopes.js';
import { recordAudit, type Actor } from './audit.js';
import { getEnvironment, getProject } from './projects.js';

const PREFIX = 'fst_';
const TOKEN_PATTERN = /^fst_[A-Za-z0-9_-]{43}$/;
const TOUCH_INTERVAL_MS = 60_000;
const DAY_MS = 86_400_000;
export const MAX_TOKEN_DAYS = 365;
/** Expired and revoked tokens stay listed this long, then housekeeping deletes them. */
export const TOKEN_RETENTION_DAYS = 30;

const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };

export interface ApiTokenView {
  id: string;
  name: string;
  displayPrefix: string;
  scopes: Scope[];
  /** The one project the token may touch, or null for every project. */
  project: string | null;
  /** The environments it may write to, or null for all of them. */
  environments: string[] | null;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
  expired: boolean;
}

export interface TokenOwner {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface TokenIdentity {
  id: string;
  name: string;
  user: TokenOwner;
  scopes: readonly Scope[];
  projectKey: string | null;
  environmentKeys: readonly string[] | null;
}

export interface CreateTokenInput {
  name: string;
  scopes: Scope[];
  project?: string | undefined;
  environments?: string[] | undefined;
  expiresInDays: number;
}

function hashToken(raw: string): Buffer {
  return createHash('sha256').update(raw).digest();
}

/** Keeps scopes in catalogue order so a token reads the same however it was asked for. */
function ordered(scopes: readonly string[]): Scope[] {
  const set = new Set(scopes);
  return SCOPES.filter((s) => set.has(s));
}

interface TokenRow {
  id: string;
  name: string;
  display_prefix: string;
  scopes: string[];
  project_key: string | null;
  environment_ids: string[] | null;
  created_at: Date;
  expires_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

async function environmentKeys(db: Db, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .selectFrom('environments')
    .select(['id', 'key'])
    .where('id', 'in', [...new Set(ids)])
    .execute();
  return new Map(rows.map((r) => [r.id, r.key]));
}

function view(row: TokenRow, envs: Map<string, string>, now: Date): ApiTokenView {
  return {
    id: row.id,
    name: row.name,
    displayPrefix: row.display_prefix,
    scopes: ordered(row.scopes),
    project: row.project_key,
    environments:
      row.environment_ids === null
        ? null
        : row.environment_ids.flatMap((id) => {
            const key = envs.get(id);
            return key === undefined ? [] : [key];
          }),
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    revoked: row.revoked_at !== null,
    expired: row.expires_at <= now,
  };
}

function selectTokens(db: Db) {
  return db
    .selectFrom('api_tokens')
    .leftJoin('projects', 'projects.id', 'api_tokens.project_id')
    .select([
      'api_tokens.id',
      'api_tokens.name',
      'api_tokens.display_prefix',
      'api_tokens.scopes',
      'projects.key as project_key',
      'api_tokens.environment_ids',
      'api_tokens.created_at',
      'api_tokens.expires_at',
      'api_tokens.last_used_at',
      'api_tokens.revoked_at',
    ]);
}

/** A user's own tokens, newest first, including revoked and expired ones until they are pruned. */
export async function listApiTokens(db: Db, userId: string, now: Date): Promise<ApiTokenView[]> {
  const rows = await selectTokens(db)
    .where('api_tokens.user_id', '=', userId)
    .orderBy('api_tokens.created_at', 'desc')
    .orderBy('api_tokens.id', 'desc')
    .execute();
  const envs = await environmentKeys(
    db,
    rows.flatMap((r) => r.environment_ids ?? []),
  );
  return rows.map((r) => view(r, envs, now));
}

/**
 * 256 random bits behind `fst_`. Only the SHA-256 is stored, as for SDK keys.
 * Scopes above the user's role are refused here, and requests are checked
 * against the owner's role again, so a token never outranks its owner.
 */
export async function createApiToken(
  db: Db,
  owner: TokenOwner,
  input: CreateTokenInput,
  now: Date,
  actor: Actor,
): Promise<ApiTokenView & { secret: string }> {
  const scopes = ordered(input.scopes.filter(isScope));
  const above = scopes.filter((s) => RANK[SCOPE_ROLE[s]] > RANK[owner.role]);
  if (above.length > 0) {
    throw new AppError(
      'permission_denied',
      `your ${owner.role} role cannot grant ${above.join(', ')}`,
    );
  }
  if (input.environments !== undefined && input.project === undefined) {
    throw new AppError('invalid_argument', 'environments need a project', [
      { path: 'environments', message: 'name the project they belong to' },
    ]);
  }
  const project = input.project === undefined ? undefined : await getProject(db, input.project);
  const envs =
    project === undefined || input.environments === undefined
      ? undefined
      : await Promise.all(
          [...new Set(input.environments)].map((key) => getEnvironment(db, project.id, key)),
        );
  const secret = `${PREFIX}${randomBytes(32).toString('base64url')}`;
  const expiresAt = new Date(now.getTime() + input.expiresInDays * DAY_MS);

  return db.transaction().execute(async (trx) => {
    const row = await trx
      .insertInto('api_tokens')
      .values({
        user_id: owner.id,
        name: input.name,
        display_prefix: secret.slice(0, 12),
        token_hash: hashToken(secret),
        scopes,
        project_id: project?.id ?? null,
        environment_ids: envs === undefined ? null : envs.map((e) => e.id),
        created_at: now,
        expires_at: expiresAt,
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();
    const created = view(
      {
        id: row.id,
        name: input.name,
        display_prefix: secret.slice(0, 12),
        scopes,
        project_key: project?.key ?? null,
        environment_ids: envs?.map((e) => e.id) ?? null,
        created_at: now,
        expires_at: expiresAt,
        last_used_at: null,
        revoked_at: null,
      },
      new Map(envs?.map((e) => [e.id, e.key])),
      now,
    );
    await recordAudit(trx, {
      projectId: project?.id ?? null,
      actor,
      action: 'api_token.create',
      targetType: 'api_token',
      targetKey: `${created.name} (${created.displayPrefix}…)`,
      after: {
        owner: owner.email,
        scopes: created.scopes,
        project: created.project,
        environments: created.environments,
        expiresAt: created.expiresAt,
      },
    });
    return { ...created, secret };
  });
}

/** Revokes one of the user's tokens, or anyone's for an admin. Takes effect on the next request. */
export async function revokeApiToken(
  db: Db,
  user: TokenOwner,
  id: string,
  now: Date,
  actor: Actor,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    let q = trx
      .updateTable('api_tokens')
      .set({ revoked_at: now })
      .where('id', '=', id)
      .where('revoked_at', 'is', null);
    if (user.role !== 'admin') q = q.where('user_id', '=', user.id);
    const row = await q
      .returning(['name', 'display_prefix', 'project_id', 'scopes'])
      .executeTakeFirst();
    if (row === undefined) throw notFound('active API token');
    await recordAudit(trx, {
      projectId: row.project_id,
      actor,
      action: 'api_token.revoke',
      targetType: 'api_token',
      targetKey: `${row.name} (${row.display_prefix}…)`,
      before: { scopes: ordered(row.scopes) },
    });
  });
}

/** Deletes tokens that expired or were revoked more than the retention ago. */
export function pruneApiTokens(db: Db) {
  return async (now: Date): Promise<number> => {
    const before = new Date(now.getTime() - TOKEN_RETENTION_DAYS * DAY_MS);
    const r = await db
      .deleteFrom('api_tokens')
      .where((eb) => eb.or([eb('expires_at', '<', before), eb('revoked_at', '<', before)]))
      .executeTakeFirst();
    return Number(r.numDeletedRows);
  };
}

export class TokenAuthenticator {
  private readonly touched = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly now: () => Date,
  ) {}

  /** Resolves a bearer token to a live identity: not revoked, not expired, owner not disabled. */
  async authenticate(raw: string): Promise<TokenIdentity | undefined> {
    if (!TOKEN_PATTERN.test(raw)) return undefined;
    const row = await this.db
      .selectFrom('api_tokens')
      .innerJoin('users', 'users.id', 'api_tokens.user_id')
      .leftJoin('projects', 'projects.id', 'api_tokens.project_id')
      .select([
        'api_tokens.id',
        'api_tokens.name',
        'api_tokens.scopes',
        'api_tokens.environment_ids',
        'api_tokens.expires_at',
        'api_tokens.revoked_at',
        'projects.key as project_key',
        'users.id as user_id',
        'users.email',
        'users.name as user_name',
        'users.role',
        'users.disabled_at',
      ])
      .where('api_tokens.token_hash', '=', hashToken(raw))
      .executeTakeFirst();
    const now = this.now();
    if (
      row === undefined ||
      row.revoked_at !== null ||
      row.expires_at <= now ||
      row.disabled_at !== null
    ) {
      return undefined;
    }
    let environmentKeysOut: string[] | null = null;
    if (row.environment_ids !== null) {
      const envs = await environmentKeys(this.db, row.environment_ids);
      environmentKeysOut = [...envs.values()];
    }
    const last = this.touched.get(row.id) ?? 0;
    if (now.getTime() - last > TOUCH_INTERVAL_MS) {
      if (this.touched.size > 100_000) this.touched.clear();
      this.touched.set(row.id, now.getTime());
      await this.db
        .updateTable('api_tokens')
        .set({ last_used_at: now })
        .where('id', '=', row.id)
        .execute();
    }
    return {
      id: row.id,
      name: row.name,
      user: { id: row.user_id, email: row.email, name: row.user_name, role: row.role },
      scopes: ordered(row.scopes),
      projectKey: row.project_key,
      environmentKeys: environmentKeysOut,
    };
  }
}
