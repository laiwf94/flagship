import type { Ruleset } from '@flagship/core';
import { sql } from 'kysely';
import type { Db } from '../src/db/database.js';

/**
 * Writes a whole ruleset into a new project and environment, straight to the
 * tables, so conformance cases can be served by the real endpoints.
 */
export async function seedRuleset(
  db: Db,
  projectKey: string,
  ruleset: Ruleset,
  options: { clientSide?: boolean } = {},
): Promise<{ projectId: string; environmentId: string }> {
  return db.transaction().execute(async (trx) => {
    const project = await trx
      .insertInto('projects')
      .values({ key: projectKey, name: projectKey })
      .returning('id')
      .executeTakeFirstOrThrow();
    const env = await trx
      .insertInto('environments')
      .values({ project_id: project.id, key: ruleset.environment, name: ruleset.environment })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const flag of Object.values(ruleset.flags)) {
      const row = await trx
        .insertInto('flags')
        .values({
          project_id: project.id,
          key: flag.key,
          name: flag.key,
          description: '',
          type: flag.type,
          variants: JSON.stringify(flag.variants),
          salt: flag.salt,
          client_side: options.clientSide ?? flag.clientSide,
          archived_at: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('flag_configs')
        .values({
          flag_id: row.id,
          environment_id: env.id,
          enabled: flag.enabled,
          off_variant: flag.offVariant,
          prerequisites: JSON.stringify(flag.prerequisites),
          rules: JSON.stringify(flag.rules),
          fallthrough: JSON.stringify(flag.fallthrough),
        })
        .execute();
    }
    for (const s of Object.values(ruleset.segments)) {
      await trx
        .insertInto('segments')
        .values({
          environment_id: env.id,
          key: s.key,
          name: s.key,
          description: '',
          included: JSON.stringify(s.included),
          excluded: JSON.stringify(s.excluded),
          rules: JSON.stringify(s.rules),
        })
        .execute();
    }
    await sql`UPDATE environments SET ruleset_version = 1 WHERE id = ${env.id}`.execute(trx);
    return { projectId: project.id, environmentId: env.id };
  });
}
