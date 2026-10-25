import type { Flag, Ruleset, Segment } from '@flagship/core';
import { sql } from 'kysely';
import type { Db } from '../db/database.js';

export const CHANGES_CHANNEL = 'flagship_changes';

export interface FlagRow {
  id: string;
  project_id: string;
  key: string;
  name: string;
  description: string;
  type: Flag['type'];
  variants: Flag['variants'];
  salt: string;
  client_side: boolean;
  version: number;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ConfigRow {
  environment_id: string;
  flag_id: string;
  enabled: boolean;
  off_variant: string;
  prerequisites: Flag['prerequisites'];
  rules: Flag['rules'];
  fallthrough: Flag['fallthrough'];
  updated_at: Date;
}

export interface SegmentRow {
  id: string;
  environment_id: string;
  key: string;
  name: string;
  description: string;
  included: string[];
  excluded: string[];
  rules: Segment['rules'];
  version: number;
  created_at: Date;
  updated_at: Date;
}

type FlagPart = Pick<FlagRow, 'key' | 'type' | 'variants' | 'salt' | 'client_side' | 'version'>;
type ConfigPart = Pick<
  ConfigRow,
  'enabled' | 'off_variant' | 'prerequisites' | 'rules' | 'fallthrough'
>;

/** The ruleset form of a flag in one environment: what SDKs evaluate. */
export function toFlag(f: FlagPart, c: ConfigPart): Flag {
  return {
    key: f.key,
    type: f.type,
    variants: f.variants,
    enabled: c.enabled,
    offVariant: c.off_variant,
    prerequisites: c.prerequisites,
    rules: c.rules,
    fallthrough: c.fallthrough,
    salt: f.salt,
    clientSide: f.client_side,
    version: f.version,
  };
}

export function toSegment(
  s: Pick<SegmentRow, 'key' | 'included' | 'excluded' | 'rules' | 'version'>,
): Segment {
  return {
    key: s.key,
    included: s.included,
    excluded: s.excluded,
    rules: s.rules,
    version: s.version,
  };
}

/** Reads one environment's ruleset. Callers wanting a consistent snapshot pass a transaction. */
export async function loadRuleset(db: Db, environmentId: string): Promise<Ruleset> {
  const env = await db
    .selectFrom('environments')
    .select(['key', 'ruleset_version'])
    .where('id', '=', environmentId)
    .executeTakeFirstOrThrow();
  const rows = await db
    .selectFrom('flags')
    .innerJoin('flag_configs', 'flag_configs.flag_id', 'flags.id')
    .select([
      'flags.key',
      'flags.type',
      'flags.variants',
      'flags.salt',
      'flags.client_side',
      'flags.version',
      'flag_configs.enabled',
      'flag_configs.off_variant',
      'flag_configs.prerequisites',
      'flag_configs.rules',
      'flag_configs.fallthrough',
    ])
    .where('flag_configs.environment_id', '=', environmentId)
    .where('flags.archived_at', 'is', null)
    .orderBy('flags.key')
    .execute();
  const segments = await db
    .selectFrom('segments')
    .selectAll()
    .where('environment_id', '=', environmentId)
    .orderBy('key')
    .execute();
  const flags: Record<string, Flag> = {};
  for (const r of rows) flags[r.key] = toFlag(r, r);
  return {
    environment: env.key,
    version: env.ruleset_version,
    flags,
    segments: Object.fromEntries(segments.map((s) => [s.key, toSegment(s)])),
  };
}

/** Locks environment rows in a fixed order so concurrent writers can't deadlock. */
export async function lockEnvironments(trx: Db, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await trx
    .selectFrom('environments')
    .select('id')
    .where('id', 'in', [...ids])
    .orderBy('id')
    .forUpdate()
    .execute();
}

/**
 * Bumps the environment's ruleset version, records the patch for stream
 * resume and notifies every server instance. NOTIFY is delivered on commit,
 * so listeners never see a change that was rolled back.
 */
export async function recordChange(
  trx: Db,
  environmentId: string,
  kind: 'flag' | 'segment',
  key: string,
  value: Flag | Segment | null,
  retention: number,
): Promise<number> {
  const { ruleset_version: version } = await trx
    .updateTable('environments')
    .set((eb) => ({ ruleset_version: eb('ruleset_version', '+', 1) }))
    .where('id', '=', environmentId)
    .returning('ruleset_version')
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('ruleset_changes')
    .values({
      environment_id: environmentId,
      version,
      kind,
      key,
      value: value === null ? null : JSON.stringify(value),
    })
    .execute();
  await trx
    .deleteFrom('ruleset_changes')
    .where('environment_id', '=', environmentId)
    .where('version', '<=', version - retention)
    .execute();
  await sql`SELECT pg_notify(${CHANGES_CHANNEL}, ${`${environmentId}:${version}`})`.execute(trx);
  return version;
}
