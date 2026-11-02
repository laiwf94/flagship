/**
 * Project export and import.
 *
 * An export is one JSON document holding everything that decides what SDKs
 * evaluate: the project, its environments, every flag (archived ones too) with
 * its targeting in each environment, and every segment. API keys, scheduled
 * changes, the audit log and exposure counts are not part of it: keys are
 * secrets stored only as hashes, and the rest is history, not configuration.
 *
 * The writer streams: it reads inside one read-only REPEATABLE READ
 * transaction, so the document is a consistent snapshot, and it reads and
 * writes a page at a time, so memory stays flat however large the project is.
 * The last field is the checksum of each environment's ruleset, the same
 * checksum SDKs verify, so a document cut short by a failed download is not
 * valid JSON and a document changed after export fails the check on import.
 *
 * The importer validates the whole document before writing anything: shape
 * and limits, references between environments, flags and segments, every
 * environment's ruleset as `validateRuleset` sees it, and the checksums when
 * present. Only then does it create the project in one transaction. Versions
 * and salts are kept, so the imported project serves rulesets identical to
 * the exported one, checksums included.
 */
import {
  FLAG_TYPES,
  LIMITS,
  RulesetDigest,
  keySchema,
  own,
  prerequisiteSchema,
  ruleSchema,
  segmentRuleSchema,
  serveSchema,
  validateFlag,
  validateRuleset,
  variantSchema,
  type Flag,
  type Ruleset,
  type Segment,
} from '@flagship/core';
import type { ControlledTransaction } from 'kysely';
import { z } from 'zod';
import type { Db } from '../db/database.js';
import type { Database } from '../db/schema.js';
import { AppError, notFound, type FieldIssue } from '../errors.js';
import { recordAudit, type Actor } from './audit.js';
import { nativeSha256, toFlag, toSegment } from './rulesets.js';

export const EXPORT_FORMAT = 'flagship.project';
export const EXPORT_FORMAT_VERSION = 1;
/** Projects can have at most this many environments (the create route's limit too). */
export const MAX_ENVIRONMENTS = 20;

const FLAG_PAGE = 200;
const SEGMENT_PAGE = 20;
const INSERT_CHUNK = 500;
const SEGMENT_INSERT_CHUNK = 20;

const name = z.string().trim().min(1).max(100);
const description = z.string().max(LIMITS.descriptionLength);
const version = z.int().min(1).max(2_147_483_647);
const member = z.string().min(1).max(LIMITS.segmentMemberLength);
const checksum = z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hex digits');

const targetingDoc = z.strictObject({
  enabled: z.boolean(),
  offVariant: keySchema,
  prerequisites: z.array(prerequisiteSchema).max(LIMITS.prerequisitesPerFlag),
  rules: z.array(ruleSchema).max(LIMITS.rulesPerFlag),
  fallthrough: serveSchema,
  version: version.optional(),
});

const flagDoc = z.strictObject({
  key: keySchema,
  name,
  description: description.default(''),
  type: z.enum(FLAG_TYPES),
  variants: z.array(variantSchema).min(2).max(LIMITS.variantsPerFlag),
  salt: z.string().min(1).max(LIMITS.keyLength).optional(),
  clientSide: z.boolean().default(false),
  archived: z.boolean().default(false),
  version: version.optional(),
  environments: z.record(keySchema, targetingDoc),
});

const segmentDoc = z.strictObject({
  environment: keySchema,
  key: keySchema,
  name,
  description: description.default(''),
  included: z.array(member).max(LIMITS.segmentMembers),
  excluded: z.array(member).max(LIMITS.segmentMembers),
  rules: z.array(segmentRuleSchema).max(LIMITS.segmentRules),
  version: version.optional(),
});

const projectDoc = z.strictObject({ key: keySchema, name });

export const exportDocumentSchema = z.strictObject({
  format: z.literal(EXPORT_FORMAT),
  formatVersion: z.literal(EXPORT_FORMAT_VERSION),
  exportedAt: z.iso.datetime({ offset: true }).optional(),
  project: projectDoc,
  environments: z.array(projectDoc).min(1).max(MAX_ENVIRONMENTS),
  flags: z.array(flagDoc).max(LIMITS.flagsPerRuleset),
  segments: z.array(segmentDoc).max(LIMITS.segmentsPerRuleset * MAX_ENVIRONMENTS),
  /** Each environment's ruleset checksum at export. Leave it out to import an edited file. */
  checksums: z.record(keySchema, checksum).optional(),
});

export type ExportDocument = z.input<typeof exportDocumentSchema>;
type ParsedDocument = z.output<typeof exportDocumentSchema>;
type FlagDoc = z.output<typeof flagDoc>;
type TargetingDoc = z.output<typeof targetingDoc>;
type SegmentDoc = z.output<typeof segmentDoc>;

export interface ImportSummary {
  project: { key: string; name: string };
  environments: string[];
  flags: number;
  segments: number;
  checksums: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Export

/** JSON for a value nested `depth` levels into the document, two-space indented. */
function nested(value: unknown, depth: number): string {
  const pad = '  '.repeat(depth);
  return JSON.stringify(value, null, 2).replaceAll('\n', `\n${pad}`);
}

/**
 * Writes `items` as the elements of a JSON array opened by the caller, one
 * compact line each: a diff of two exports shows which flags changed, and the
 * file is a third the size it would be fully indented.
 */
async function* arrayItems<T>(
  pages: AsyncIterable<T[]>,
  write: (item: T) => unknown,
): AsyncGenerator<string> {
  let first = true;
  for await (const page of pages) {
    if (page.length === 0) continue;
    const parts: string[] = [];
    for (const item of page) {
      parts.push(`${first ? '' : ','}\n    ${JSON.stringify(write(item))}`);
      first = false;
    }
    yield parts.join('');
  }
  if (!first) yield '\n  ';
}

type Trx = ControlledTransaction<Database>;

async function* flagPages(trx: Trx, projectId: string, envs: readonly EnvRef[]) {
  let after: string | undefined;
  for (;;) {
    let q = trx
      .selectFrom('flags')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('key')
      .limit(FLAG_PAGE);
    if (after !== undefined) q = q.where('key', '>', after);
    const flags = await q.execute();
    if (flags.length === 0) return;
    const configs = await trx
      .selectFrom('flag_configs')
      .selectAll()
      .where(
        'flag_id',
        'in',
        flags.map((f) => f.id),
      )
      .execute();
    const byFlag = new Map<string, Map<string, (typeof configs)[number]>>();
    for (const c of configs) {
      let m = byFlag.get(c.flag_id);
      if (m === undefined) {
        m = new Map<string, (typeof configs)[number]>();
        byFlag.set(c.flag_id, m);
      }
      m.set(c.environment_id, c);
    }
    yield flags.map((f) => {
      const per = byFlag.get(f.id) ?? new Map<string, (typeof configs)[number]>();
      const environments: Record<string, TargetingDoc & { version: number }> = {};
      const rows: { env: EnvRef; config: (typeof configs)[number] }[] = [];
      for (const env of envs) {
        const c = per.get(env.id);
        if (c === undefined) continue;
        rows.push({ env, config: c });
        environments[env.key] = {
          enabled: c.enabled,
          offVariant: c.off_variant,
          prerequisites: c.prerequisites,
          rules: c.rules,
          fallthrough: c.fallthrough,
          version: c.version,
        };
      }
      return { flag: f, rows, environments };
    });
    after = flags[flags.length - 1]?.key;
    if (flags.length < FLAG_PAGE) return;
  }
}

async function* segmentPages(trx: Trx, envs: readonly EnvRef[]) {
  for (const env of envs) {
    let after: string | undefined;
    for (;;) {
      let q = trx
        .selectFrom('segments')
        .selectAll()
        .where('environment_id', '=', env.id)
        .orderBy('key')
        .limit(SEGMENT_PAGE);
      if (after !== undefined) q = q.where('key', '>', after);
      const rows = await q.execute();
      if (rows.length === 0) break;
      yield rows.map((row) => ({ env, row }));
      after = rows[rows.length - 1]?.key;
      if (rows.length < SEGMENT_PAGE) break;
    }
  }
}

interface EnvRef {
  id: string;
  key: string;
  name: string;
}

/**
 * Streams a project as an export document. The project is looked up before
 * the first chunk, so an unknown key rejects the first `next()` with
 * not_found and nothing has been written. Abandoning the iterator (a client
 * that disconnects) rolls the read transaction back.
 */
export async function* exportProject(
  db: Db,
  projectKey: string,
  now: () => Date = () => new Date(),
): AsyncGenerator<string> {
  const trx = await db
    .startTransaction()
    .setIsolationLevel('repeatable read')
    .setAccessMode('read only')
    .execute();
  try {
    const project = await trx
      .selectFrom('projects')
      .select(['id', 'key', 'name'])
      .where('key', '=', projectKey)
      .executeTakeFirst();
    if (project === undefined) throw notFound(`project "${projectKey}"`);
    const envs: EnvRef[] = await trx
      .selectFrom('environments')
      .select(['id', 'key', 'name'])
      .where('project_id', '=', project.id)
      .orderBy('created_at')
      .orderBy('key')
      .execute();
    const digests = new Map(
      envs.map((e) => [e.key, RulesetDigest.of({ flags: {}, segments: {} }, nativeSha256)]),
    );

    yield '{\n' +
      `  "format": ${JSON.stringify(EXPORT_FORMAT)},\n` +
      `  "formatVersion": ${EXPORT_FORMAT_VERSION},\n` +
      `  "exportedAt": ${JSON.stringify(now().toISOString())},\n` +
      `  "project": ${nested({ key: project.key, name: project.name }, 1)},\n` +
      `  "environments": ${nested(
        envs.map((e) => ({ key: e.key, name: e.name })),
        1,
      )},\n` +
      '  "flags": [';

    yield* arrayItems(flagPages(trx, project.id, envs), ({ flag, rows, environments }) => {
      if (flag.archived_at === null) {
        for (const { env, config } of rows) {
          digests.get(env.key)?.prepare('flag', flag.key, toFlag(flag, config)).apply();
        }
      }
      return {
        key: flag.key,
        name: flag.name,
        description: flag.description,
        type: flag.type,
        variants: flag.variants,
        salt: flag.salt,
        clientSide: flag.client_side,
        archived: flag.archived_at !== null,
        version: flag.version,
        environments,
      };
    });

    yield '],\n  "segments": [';
    yield* arrayItems(segmentPages(trx, envs), ({ env, row }) => {
      digests.get(env.key)?.prepare('segment', row.key, toSegment(row)).apply();
      return {
        environment: env.key,
        key: row.key,
        name: row.name,
        description: row.description,
        included: row.included,
        excluded: row.excluded,
        rules: row.rules,
        version: row.version,
      };
    });

    const checksums = Object.fromEntries([...digests].map(([env, d]) => [env, d.checksum]));
    yield `],\n  "checksums": ${nested(checksums, 1)}\n}\n`;
    await trx.commit().execute();
  } finally {
    // Reached early when the reader stops (a client that went away) or a read
    // failed. A failed rollback still releases the connection, and the
    // original error, if any, is the one worth reporting.
    if (!trx.isCommitted && !trx.isRolledBack) {
      await trx
        .rollback()
        .execute()
        .catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// Import

export interface PlannedImport {
  document: ParsedDocument;
  /** Each environment's ruleset as it will be served, keyed by environment key. */
  rulesets: Map<string, Ruleset>;
  checksums: Record<string, string>;
}

function fail(issues: FieldIssue[]): never {
  throw new AppError('invalid_argument', 'invalid project export', issues.slice(0, 100));
}

/** The ruleset form of one flag in one environment, as it will be stored. */
function plannedFlag(f: FlagDoc, t: TargetingDoc): Flag {
  return toFlag(
    {
      key: f.key,
      type: f.type,
      variants: f.variants,
      salt: f.salt ?? f.key,
      client_side: f.clientSide,
      version: f.version ?? 1,
    },
    {
      enabled: t.enabled,
      off_variant: t.offVariant,
      prerequisites: t.prerequisites,
      rules: t.rules,
      fallthrough: t.fallthrough,
      version: t.version ?? 1,
    },
  );
}

function plannedSegment(s: SegmentDoc): Segment {
  return toSegment({ ...s, version: s.version ?? 1 });
}

/**
 * Checks an export document completely, without touching the database:
 * shape, uniqueness, references, every environment's ruleset and the
 * checksums. Throws invalid_argument listing up to 100 problems with paths
 * into the document.
 */
export function planImport(input: unknown): PlannedImport {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    fail([{ path: '', message: 'must be a JSON object' }]);
  }
  const header = input as Record<string, unknown>;
  if (header['format'] !== EXPORT_FORMAT) {
    fail([{ path: 'format', message: `must be "${EXPORT_FORMAT}"` }]);
  }
  if (header['formatVersion'] !== EXPORT_FORMAT_VERSION) {
    const raw = header['formatVersion'];
    const given = raw === undefined ? 'missing' : JSON.stringify(raw);
    fail([
      {
        path: 'formatVersion',
        message: `version ${given} is not supported; this server reads version ${EXPORT_FORMAT_VERSION}`,
      },
    ]);
  }
  const parsed = exportDocumentSchema.safeParse(input);
  if (!parsed.success) {
    fail(
      parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
    );
  }
  const doc = parsed.data;
  const issues: FieldIssue[] = [];

  const envKeys = new Set<string>();
  doc.environments.forEach((e, i) => {
    if (envKeys.has(e.key)) issues.push({ path: `environments.${i}.key`, message: 'duplicate' });
    envKeys.add(e.key);
  });

  const flagKeys = new Set<string>();
  doc.flags.forEach((f, i) => {
    if (flagKeys.has(f.key)) issues.push({ path: `flags.${i}.key`, message: 'duplicate' });
    flagKeys.add(f.key);
    for (const env of envKeys) {
      if (!Object.hasOwn(f.environments, env)) {
        issues.push({
          path: `flags.${i}.environments`,
          message: `has no targeting for environment "${env}"`,
        });
      }
    }
    for (const env of Object.keys(f.environments)) {
      if (!envKeys.has(env)) {
        issues.push({
          path: `flags.${i}.environments.${env}`,
          message: 'is not one of the exported environments',
        });
      }
    }
  });

  const segmentKeys = new Set<string>();
  doc.segments.forEach((s, i) => {
    if (!envKeys.has(s.environment)) {
      issues.push({
        path: `segments.${i}.environment`,
        message: 'is not one of the exported environments',
      });
    }
    const id = `${s.environment}\n${s.key}`;
    if (segmentKeys.has(id)) {
      issues.push({ path: `segments.${i}.key`, message: `duplicate in ${s.environment}` });
    }
    segmentKeys.add(id);
  });
  if (issues.length > 0) fail(issues);

  const rulesets = new Map<string, Ruleset>();
  const checksums: Record<string, string> = {};
  for (const env of doc.environments) {
    const ruleset: Ruleset = { environment: env.key, version: 0, flags: {}, segments: {} };
    doc.flags.forEach((f, i) => {
      const t = own(f.environments, env.key);
      if (t === undefined) return;
      const flag = plannedFlag(f, t);
      if (!f.archived) {
        ruleset.flags[f.key] = flag;
        return;
      }
      // Archived flags aren't served, but restoring one must give a valid flag.
      const alone = validateFlag(flag);
      if (!alone.ok) {
        for (const issue of alone.issues) {
          issues.push({ path: `flags.${i}.environments.${env.key}`, message: issueText(issue) });
        }
      }
    });
    for (const s of doc.segments) {
      if (s.environment === env.key) ruleset.segments[s.key] = plannedSegment(s);
    }
    const result = validateRuleset(ruleset);
    if (!result.ok) {
      for (const issue of result.issues) {
        issues.push({ path: `rulesets.${env.key}.${issue.path}`, message: issue.message });
      }
      continue;
    }
    rulesets.set(env.key, ruleset);
    checksums[env.key] = RulesetDigest.of(ruleset, nativeSha256).checksum;
  }
  if (issues.length > 0) fail(issues);

  if (doc.checksums !== undefined) {
    for (const env of envKeys) {
      const expected = own(doc.checksums, env);
      if (expected === undefined) {
        issues.push({ path: `checksums.${env}`, message: 'missing' });
      } else if (expected !== checksums[env]) {
        issues.push({
          path: `checksums.${env}`,
          message:
            'does not match the contents: the file changed after it was exported. ' +
            'Remove "checksums" to import an edited file on purpose',
        });
      }
    }
    for (const env of Object.keys(doc.checksums)) {
      if (!envKeys.has(env)) {
        issues.push({
          path: `checksums.${env}`,
          message: 'is not one of the exported environments',
        });
      }
    }
    if (issues.length > 0) fail(issues);
  }
  return { document: doc, rulesets, checksums };
}

function issueText(issue: { path: string; message: string }): string {
  return issue.path === '' ? issue.message : `${issue.path}: ${issue.message}`;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function uniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

/**
 * Validates an export document and creates it as a new project, all or
 * nothing. `as` renames the project, which is how a project is copied.
 */
export async function importProject(
  db: Db,
  input: unknown,
  actor: Actor,
  as: { key?: string | undefined; name?: string | undefined } = {},
): Promise<ImportSummary> {
  const plan = planImport(input);
  const doc = plan.document;
  const project = { key: as.key ?? doc.project.key, name: as.name ?? doc.project.name };
  try {
    await db.transaction().execute(async (trx) => {
      const { id: projectId } = await trx
        .insertInto('projects')
        .values(project)
        .returning('id')
        .executeTakeFirstOrThrow();
      const envIds = new Map<string, string>();
      for (const env of doc.environments) {
        const row = await trx
          .insertInto('environments')
          .values({ project_id: projectId, key: env.key, name: env.name })
          .returning('id')
          .executeTakeFirstOrThrow();
        envIds.set(env.key, row.id);
      }
      const at = new Date();
      for (const page of chunks(doc.flags, INSERT_CHUNK)) {
        const inserted = await trx
          .insertInto('flags')
          .values(
            page.map((f) => ({
              project_id: projectId,
              key: f.key,
              name: f.name,
              description: f.description,
              type: f.type,
              variants: JSON.stringify(f.variants),
              salt: f.salt ?? f.key,
              client_side: f.clientSide,
              version: f.version ?? 1,
              archived_at: f.archived ? at : null,
            })),
          )
          .returning(['id', 'key'])
          .execute();
        const ids = new Map(inserted.map((r) => [r.key, r.id]));
        const configs = page.flatMap((f) =>
          doc.environments.map((env) => {
            const t = own(f.environments, env.key);
            const flagId = ids.get(f.key);
            const environmentId = envIds.get(env.key);
            if (t === undefined || flagId === undefined || environmentId === undefined) {
              throw new Error(`import plan lost flag "${f.key}" in ${env.key}`);
            }
            return {
              flag_id: flagId,
              environment_id: environmentId,
              enabled: t.enabled,
              off_variant: t.offVariant,
              prerequisites: JSON.stringify(t.prerequisites),
              rules: JSON.stringify(t.rules),
              fallthrough: JSON.stringify(t.fallthrough),
              version: t.version ?? 1,
            };
          }),
        );
        for (const part of chunks(configs, INSERT_CHUNK)) {
          await trx.insertInto('flag_configs').values(part).execute();
        }
      }
      for (const page of chunks(doc.segments, SEGMENT_INSERT_CHUNK)) {
        await trx
          .insertInto('segments')
          .values(
            page.map((s) => {
              const environmentId = envIds.get(s.environment);
              if (environmentId === undefined) {
                throw new Error(`import plan lost environment "${s.environment}"`);
              }
              return {
                environment_id: environmentId,
                key: s.key,
                name: s.name,
                description: s.description,
                included: JSON.stringify(s.included),
                excluded: JSON.stringify(s.excluded),
                rules: JSON.stringify(s.rules),
                version: s.version ?? 1,
              };
            }),
          )
          .execute();
      }
      await recordAudit(trx, {
        projectId,
        actor,
        action: 'project.import',
        targetType: 'project',
        targetKey: project.key,
        after: {
          ...project,
          environments: doc.environments,
          flags: doc.flags.length,
          segments: doc.segments.length,
          ...(as.key !== undefined || as.name !== undefined ? { from: doc.project } : {}),
        },
      });
    });
  } catch (err) {
    if (uniqueViolation(err)) {
      throw new AppError('already_exists', `project "${project.key}" exists`);
    }
    throw err;
  }
  return {
    project,
    environments: doc.environments.map((e) => e.key),
    flags: doc.flags.length,
    segments: doc.segments.length,
    checksums: plan.checksums,
  };
}
