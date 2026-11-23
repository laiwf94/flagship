import { AdminApiError } from '@flagship/admin-client';
import type { Variant } from '@flagship/admin-client';
import { diff, validateRuleset, type DiffEntry, type Flag, type Ruleset } from '@flagship/core';
import type { Context } from './command.js';
import type { ChangeRequestView } from './commands/changeRequests.js';
import type { EnvTargeting, FlagSummary, FlagView } from './commands/flags.js';
import { CliError } from './errors.js';
import {
  FlagsFileError,
  defaultOffVariant,
  type DesiredFlag,
  type FileIssue,
  type FlagsFile,
  type Targeting,
} from './flagsfile.js';
import { compact, list } from './output.js';

/** A change to one part of a flag, and whether someone made the live side outside the file. */
export interface Change {
  changes: DiffEntry[];
  /** The live side moved past what the last apply left, outside the file. */
  drift: boolean;
}

export interface MetadataChange extends Change {
  /** Live variants the file no longer has. */
  removedVariants: Variant[];
}

export interface EnvironmentPlan extends Change {
  environment: string;
  /** The live targeting version the plan was made against (1 for a flag still to be created). */
  version: number;
  /** Protected environments take the change as a change request. */
  via: 'direct' | 'change-request';
  /** An open change request that already proposes exactly this. */
  pending: string | null;
  targeting: Targeting;
}

export interface FlagPlan {
  key: string;
  action: 'create' | 'update' | 'unchanged' | 'archive' | 'orphan';
  /** The live metadata version the plan was made against, or null when it doesn't exist. */
  version: number | null;
  /** Archived on the server and back in the file. */
  restore: boolean;
  /** Not managed by this file yet: apply starts managing it. */
  adopt: boolean;
  metadata: MetadataChange | null;
  environments: EnvironmentPlan[];
  /** The management record needs writing even if nothing else does. */
  record: boolean;
  desired: DesiredFlag | null;
}

export interface Plan {
  format: 'flagship-plan';
  version: 1;
  project: string;
  source: string;
  file: string;
  createdAt: string;
  flags: FlagPlan[];
  summary: {
    create: number;
    update: number;
    archive: number;
    orphan: number;
    unchanged: number;
    drift: number;
    pending: number;
  };
}

export interface PlanOptions {
  /** Archive flags this file used to manage and no longer lists. */
  prune: boolean;
  /** Take over flags another file manages. */
  takeOver: boolean;
}

interface Metadata {
  name: string;
  description: string;
  clientSide: boolean;
  variants: Variant[];
}

interface EnvironmentInfo {
  key: string;
  protected: boolean;
}

/** What the server holds that a plan compares against. */
export interface LiveState {
  environments: EnvironmentInfo[];
  /** Every flag the file names that exists (archived or not), and every orphan. */
  flags: Map<string, FlagView>;
  /** Non-archived flags this file manages that it no longer lists. */
  orphans: string[];
  rulesets: Map<string, Ruleset>;
}

const TARGETING_KEYS = ['enabled', 'offVariant', 'prerequisites', 'rules', 'fallthrough'] as const;

function metadataOf(
  f: Pick<FlagView, 'name' | 'description' | 'clientSide' | 'variants'>,
): Metadata {
  return {
    name: f.name,
    description: f.description,
    clientSide: f.clientSide,
    variants: f.variants,
  };
}

/** Just the targeting fields. Live targeting comes typed with the core model, the same data. */
function targetingOf(live: Targeting | EnvTargeting): Targeting {
  const t = live as Targeting;
  return {
    enabled: t.enabled,
    offVariant: t.offVariant,
    prerequisites: t.prerequisites,
    rules: t.rules,
    fallthrough: t.fallthrough,
  };
}

/** The targeting a new flag starts with in every environment, as the server makes it. */
function initialTargeting(variants: readonly Variant[]): Targeting {
  const off = defaultOffVariant(variants);
  return {
    enabled: false,
    offVariant: off,
    prerequisites: [],
    rules: [],
    fallthrough: { variant: off },
  };
}

function asRulesetFlag(d: DesiredFlag, t: Targeting, salt: string): Flag {
  // The API's types are the model's with exact optional fields; validation checks the rest.
  return {
    key: d.key,
    type: d.type,
    variants: d.variants,
    clientSide: d.clientSide,
    salt,
    version: 0,
    ...targetingOf(t),
  };
}

/** Where a ruleset validation issue belongs in the file. */
function issuePath(file: FlagsFile, env: string, path: string): { path: string; prefix: string } {
  const m = /^flags\.([^.[]+)(?:\.([A-Za-z]+))?(.*)$/.exec(path);
  const desired = m === null ? undefined : file.flags.find((f) => f.key === m[1]);
  if (m === null || desired === undefined) {
    return { path: 'flags', prefix: `${env}: ${path === '' ? '' : `${path}: `}` };
  }
  const field = m[2] ?? '';
  if ((TARGETING_KEYS as readonly string[]).includes(field)) {
    if (Object.hasOwn(desired.environments, env)) {
      return { path: `flags.${desired.key}.environments.${env}.${field}${m[3] ?? ''}`, prefix: '' };
    }
    return {
      path: `flags.${desired.key}.variants`,
      prefix: `the live targeting in ${env}, which the file leaves alone, `,
    };
  }
  // Variants, type and the like are the same in every environment: report them once.
  return { path, prefix: '' };
}

/**
 * Checks every environment's ruleset as it would be after the plan: the live
 * ruleset with the file's flags put in and pruned flags taken out. This finds
 * what the server would refuse (unknown segments and variants, prerequisite
 * cycles) before anything is written, at the file's own lines.
 */
export function validatePlan(file: FlagsFile, live: LiveState, plan: FlagPlan[]): void {
  const issues: FileIssue[] = [];
  const seen = new Set<string>();
  for (const env of live.environments) {
    const base = live.rulesets.get(env.key);
    if (base === undefined) continue;
    const ruleset: Ruleset = { ...base, flags: { ...base.flags } };
    for (const p of plan) {
      if (p.action === 'archive') {
        Reflect.deleteProperty(ruleset.flags, p.key);
        continue;
      }
      const d = p.desired;
      if (d === null) continue;
      const existing = live.flags.get(d.key);
      const t =
        d.environments[env.key] ?? existing?.environments[env.key] ?? initialTargeting(d.variants);
      ruleset.flags[d.key] = asRulesetFlag(d, targetingOf(t), ruleset.flags[d.key]?.salt ?? d.key);
    }
    const result = validateRuleset(ruleset);
    if (result.ok) continue;
    for (const i of result.issues) {
      const { path, prefix } = issuePath(file, env.key, i.path);
      const message = `${prefix}${i.message}`;
      const id = `${path}\u0000${message}`;
      if (seen.has(id)) continue;
      seen.add(id);
      issues.push({ file: file.file, line: file.lineOf(path), path, message });
    }
  }
  if (issues.length > 0) throw new FlagsFileError(file.file, issues);
}

/** Plans one flag of the file against its live state. Pure: no requests. */
export function planFlag(
  file: FlagsFile,
  desired: DesiredFlag,
  live: FlagView | undefined,
  environments: readonly EnvironmentInfo[],
  options: PlanOptions,
): FlagPlan {
  const issues: FileIssue[] = [];
  const at = `flags.${desired.key}`;
  const issue = (path: string, message: string) =>
    issues.push({ file: file.file, line: file.lineOf(path), path, message });
  const protectedEnv = new Map(environments.map((e) => [e.key, e.protected]));
  for (const env of Object.keys(desired.environments)) {
    if (!protectedEnv.has(env)) {
      issue(
        `${at}.environments.${env}`,
        `the project has no environment "${env}"; it has ${list(environments.map((e) => e.key))}`,
      );
    }
  }
  if (live !== undefined && live.type !== desired.type) {
    issue(`${at}.type`, `is ${live.type} on the server; a flag's type can't change`);
  }
  const record = live?.managedBy ?? null;
  if (record !== null && record.source !== file.source && !options.takeOver) {
    issue(
      at,
      `is managed by ${record.source}; remove it there, release it in the console, or pass --take-over`,
    );
  }
  if (issues.length > 0) throw new FlagsFileError(file.file, issues);

  const ours = record !== null && record.source === file.source;
  const wanted = metadataOf(desired);
  let metadata: MetadataChange | null = null;
  if (live !== undefined) {
    const changes = diff(metadataOf(live), wanted);
    if (changes.length > 0) {
      const keys = new Set(desired.variants.map((v) => v.key));
      metadata = {
        changes,
        drift: ours && live.version !== record.metadataVersion,
        removedVariants: live.variants.filter((v) => !keys.has(v.key)),
      };
    }
  }
  const envPlans: EnvironmentPlan[] = [];
  for (const [env, target] of Object.entries(desired.environments)) {
    const current = live?.environments[env];
    const before =
      current === undefined ? initialTargeting(desired.variants) : targetingOf(current);
    const changes = diff(before, target);
    if (changes.length === 0) continue;
    const recorded = ours ? record.environments[env] : undefined;
    envPlans.push({
      environment: env,
      version: current?.version ?? 1,
      via: protectedEnv.get(env) === true ? 'change-request' : 'direct',
      pending: null,
      changes,
      drift: current !== undefined && recorded !== undefined && current.version !== recorded,
      targeting: target,
    });
  }
  const restore = live?.archived === true;
  const changed = live === undefined || restore || metadata !== null || envPlans.length > 0;
  let stale = !ours;
  if (ours && live !== undefined) {
    const envs = Object.keys(desired.environments);
    stale =
      record.metadataVersion !== live.version ||
      Object.keys(record.environments).length !== envs.length ||
      envs.some((e) => record.environments[e] !== live.environments[e]?.version);
  }
  return {
    key: desired.key,
    action: live === undefined ? 'create' : changed ? 'update' : 'unchanged',
    version: live?.version ?? null,
    restore,
    adopt: !ours,
    metadata,
    environments: envPlans,
    record: changed || stale,
    desired,
  };
}

function summarize(flags: FlagPlan[]): Plan['summary'] {
  const count = (a: FlagPlan['action']) => flags.filter((f) => f.action === a).length;
  return {
    create: count('create'),
    update: count('update'),
    archive: count('archive'),
    orphan: count('orphan'),
    unchanged: count('unchanged'),
    drift: flags.filter(
      (f) =>
        f.metadata?.drift === true || f.environments.some((e) => e.drift && e.pending === null),
    ).length,
    pending: flags.reduce((n, f) => n + f.environments.filter((e) => e.pending !== null).length, 0),
  };
}

/** Whether applying the plan would write anything a reader would call a change. */
export function hasChanges(plan: Plan): boolean {
  return plan.flags.some(
    (f) =>
      f.action === 'create' ||
      f.action === 'archive' ||
      f.restore ||
      f.metadata !== null ||
      f.environments.some((e) => e.pending === null),
  );
}

/** Plans from already-gathered live state; the requests are in makePlan. */
export function planFrom(
  file: FlagsFile,
  project: string,
  live: LiveState,
  options: PlanOptions,
  now = new Date(),
): Plan {
  const flags = file.flags.map((d) =>
    planFlag(file, d, live.flags.get(d.key), live.environments, options),
  );
  for (const key of live.orphans) {
    const f = live.flags.get(key);
    flags.push({
      key,
      action: options.prune ? 'archive' : 'orphan',
      version: f?.version ?? null,
      restore: false,
      adopt: false,
      metadata: null,
      environments: [],
      record: false,
      desired: null,
    });
  }
  validatePlan(file, live, flags);
  return {
    format: 'flagship-plan',
    version: 1,
    project,
    source: file.source,
    file: file.file,
    createdAt: now.toISOString(),
    flags,
    summary: summarize(flags),
  };
}

/** Runs `fn` over `items` with at most `limit` in flight. */
async function pool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (t: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function notFound(e: unknown): boolean {
  return e instanceof AdminApiError && e.status === 404;
}

/** Reads what the plan needs from the server: environments, the named flags, orphans, rulesets. */
export async function gather(ctx: Context, file: FlagsFile, project: string): Promise<LiveState> {
  const p = await ctx.call<{ environments: { key: string; requiredApprovals: number }[] }>((c) =>
    c.getProject({ path: { project } }),
  );
  const environments = p.environments.map((e) => ({
    key: e.key,
    protected: e.requiredApprovals > 0,
  }));
  const first = environments[0];
  const summaries: FlagSummary[] = [];
  if (first !== undefined) {
    let after: string | undefined;
    for (;;) {
      const page = await ctx.call<{ flags: FlagSummary[] }>((c) =>
        c.listFlags({ path: { project }, query: { environment: first.key, limit: 500, after } }),
      );
      summaries.push(...page.flags);
      const last = page.flags.at(-1);
      if (page.flags.length < 500 || last === undefined) break;
      after = last.key;
    }
  }
  const named = new Set(file.flags.map((f) => f.key));
  const orphans = summaries
    .filter((s) => s.managedBy === file.source && !named.has(s.key))
    .map((s) => s.key);
  const keys = [...named, ...orphans];
  const views = await pool(keys, 8, async (key) => {
    try {
      return await ctx.call<FlagView>((c) => c.getFlag({ path: { project, flag: key } }));
    } catch (e) {
      if (notFound(e)) return undefined;
      throw e;
    }
  });
  const flags = new Map<string, FlagView>();
  for (const v of views) if (v !== undefined) flags.set(v.key, v);
  const rulesets = new Map<string, Ruleset>();
  await pool(environments, 4, async (e) => {
    rulesets.set(
      e.key,
      await ctx.call<Ruleset>((c) => c.getRuleset({ path: { project, environment: e.key } })),
    );
  });
  return { environments, flags, orphans, rulesets };
}

/** Equal as JSON, whatever the key order (the server stores JSON as jsonb, which reorders keys). */
function sameJson(a: unknown, b: unknown): boolean {
  return diff(a, b).length === 0;
}

/** Marks environment changes an open change request already proposes. */
async function findPending(ctx: Context, plan: Plan): Promise<void> {
  for (const f of plan.flags) {
    for (const e of f.environments) {
      if (e.via !== 'change-request' || f.action === 'create') continue;
      const { changeRequests } = await ctx.call<{ changeRequests: { id: string }[] }>((c) =>
        c.listChangeRequests({
          path: { project: plan.project },
          query: { status: 'open', flag: f.key, environment: e.environment, limit: 20 },
        }),
      );
      for (const r of changeRequests) {
        const full = await ctx.call<ChangeRequestView & { proposed: unknown }>((c) =>
          c.getChangeRequest({ path: { project: plan.project, id: r.id } }),
        );
        if (sameJson(full.proposed, targetingOf(e.targeting))) {
          e.pending = full.id;
          break;
        }
      }
    }
  }
  plan.summary = summarize(plan.flags);
}

export async function makePlan(
  ctx: Context,
  file: FlagsFile,
  project: string,
  options: PlanOptions,
): Promise<Plan> {
  const live = await gather(ctx, file, project);
  const plan = planFrom(file, project, live, options);
  await findPending(ctx, plan);
  return plan;
}

function diffLine(d: DiffEntry, indent: string): string {
  const at = d.path === '' ? '(whole)' : d.path;
  if (d.op === 'added') return `${indent}+ ${at}: ${compact(d.after)}`;
  if (d.op === 'removed') return `${indent}- ${at}: ${compact(d.before)}`;
  return `${indent}~ ${at}: ${compact(d.before)} -> ${compact(d.after)}`;
}

const DRIFT = ' [drift: changed outside the file since the last apply]';

/** The plan as a reviewer reads it in a terminal or a pull request comment. */
export function planText(plan: Plan): string {
  const lines = [`Plan for project ${plan.project} from ${plan.file} (source ${plan.source}):`, ''];
  for (const f of plan.flags) {
    if (f.action === 'unchanged') continue;
    if (f.action === 'archive') {
      lines.push(`- archive flag ${f.key}: no longer in the file`);
      continue;
    }
    if (f.action === 'orphan') {
      lines.push(`! flag ${f.key} was managed by this file but is not in it; --prune archives it`);
      continue;
    }
    const d = f.desired;
    const head =
      f.action === 'create'
        ? `+ create flag ${f.key} (${d?.type ?? '?'})`
        : `~ ${f.restore ? 'restore and update' : 'update'} flag ${f.key}${f.adopt ? ' (starts being managed by this file)' : ''}`;
    lines.push(head);
    if (f.metadata !== null) {
      lines.push(`    flag (version ${f.version ?? '?'}):${f.metadata.drift ? DRIFT : ''}`);
      for (const c of f.metadata.changes) lines.push(diffLine(c, '      '));
    }
    for (const e of f.environments) {
      const how = e.via === 'change-request' ? ' as a change request' : '';
      if (e.pending !== null) {
        lines.push(
          `    ${e.environment}: change request ${e.pending} already proposes this; waiting for approval`,
        );
        continue;
      }
      const version = f.action === 'create' ? '' : ` (version ${e.version})`;
      lines.push(`    ${e.environment}${version}${how}:${e.drift ? DRIFT : ''}`);
      for (const c of e.changes) lines.push(diffLine(c, '      '));
    }
    lines.push('');
  }
  const s = plan.summary;
  const parts = [
    s.create > 0 ? `${s.create} to create` : '',
    s.update > 0 ? `${s.update} to update` : '',
    s.archive > 0 ? `${s.archive} to archive` : '',
    s.orphan > 0 ? `${s.orphan} no longer in the file` : '',
  ].filter((x) => x !== '');
  if (!hasChanges(plan) && s.orphan === 0) {
    lines.push(
      s.pending > 0
        ? `No changes. ${s.pending} change request${s.pending === 1 ? '' : 's'} still waiting for approval.`
        : `No changes. ${s.unchanged} flag${s.unchanged === 1 ? '' : 's'} match the file.`,
    );
  } else {
    lines.push(
      `Flags: ${parts.join(', ')}, ${s.unchanged} unchanged.${s.drift > 0 ? ` ${s.drift} with drift.` : ''}`,
    );
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** One write apply made, for the report. */
export interface Applied {
  flag: string;
  step:
    | 'create'
    | 'restore'
    | 'metadata'
    | 'variants'
    | 'targeting'
    | 'change-request'
    | 'archive'
    | 'record';
  environment?: string;
  version?: number;
  changeRequest?: string;
  note?: string;
}

function titleOf(source: string, flag: string, env: string): string {
  const t = `Apply ${source}: ${flag} in ${env}`;
  return t.length <= 200 ? t : `${t.slice(0, 197)}...`;
}

/**
 * Carries out a plan. Every write sends the version the plan read (or the one
 * the previous write returned), so anything that changed since the plan was
 * made stops apply with a version conflict instead of being overwritten.
 * Writes go in phases so each is valid on its own: creates and restores,
 * metadata (keeping variants still in use until targeting moves off them),
 * targeting, the removal of those variants, archives, and last the record of
 * what the file now manages.
 */
export async function applyPlan(ctx: Context, plan: Plan): Promise<Applied[]> {
  const project = plan.project;
  const done: Applied[] = [];
  const versions = new Map<string, number>();
  const envVersions = new Map<string, number>();
  const later: { key: string; variants: Variant[] }[] = [];
  const write = async (step: () => Promise<void>, what: string) => {
    try {
      await step();
    } catch (e) {
      const summary =
        done.length === 0
          ? 'nothing was applied'
          : `${done.length} earlier step${done.length === 1 ? ' was' : 's were'} applied`;
      if (e instanceof AdminApiError) {
        const hint =
          e.code === 'version_conflict' ? '; something changed since the plan: plan again' : '';
        throw new CliError(e.code, `${what} failed: ${e.message} (${summary})${hint}`, e.details);
      }
      throw e;
    }
  };
  const active = plan.flags.filter((f) => f.desired !== null);

  for (const f of active) {
    const d = f.desired as DesiredFlag;
    if (f.action === 'create') {
      await write(async () => {
        const created = await ctx.call<FlagView>((c) =>
          c.createFlag({
            path: { project },
            body: {
              key: d.key,
              name: d.name,
              description: d.description,
              type: d.type,
              variants: d.variants,
              clientSide: d.clientSide,
            },
          }),
        );
        versions.set(d.key, created.version);
        done.push({ flag: d.key, step: 'create', version: created.version });
      }, `creating ${d.key}`);
    } else if (f.version !== null) {
      versions.set(d.key, f.version);
    }
    if (f.restore) {
      await write(async () => {
        const r = await ctx.call<FlagView>((c) =>
          c.restoreFlag({
            path: { project, flag: d.key },
            body: { version: versions.get(d.key) ?? 0 },
          }),
        );
        versions.set(d.key, r.version);
        done.push({ flag: d.key, step: 'restore', version: r.version });
      }, `restoring ${d.key}`);
    }
  }

  for (const f of active) {
    if (f.metadata === null) continue;
    const d = f.desired as DesiredFlag;
    // Variants the file drops stay until targeting has moved off them.
    const keep = f.environments.length > 0 ? f.metadata.removedVariants : [];
    if (keep.length > 0) later.push({ key: d.key, variants: d.variants });
    await write(async () => {
      const r = await ctx.call<FlagView>((c) =>
        c.updateFlag({
          path: { project, flag: d.key },
          body: {
            version: versions.get(d.key) ?? 0,
            name: d.name,
            description: d.description,
            clientSide: d.clientSide,
            variants: [...d.variants, ...keep],
          },
        }),
      );
      versions.set(d.key, r.version);
      done.push({
        flag: d.key,
        step: 'metadata',
        version: r.version,
        ...(keep.length === 0
          ? {}
          : { note: `kept ${list(keep.map((v) => v.key))} until targeting moves off them` }),
      });
    }, `updating ${d.key}`);
  }

  for (const f of active) {
    const d = f.desired as DesiredFlag;
    for (const e of f.environments) {
      if (e.pending !== null) continue;
      const version = f.action === 'create' ? 1 : e.version;
      if (e.via === 'direct') {
        await write(async () => {
          const r = await ctx.call<FlagView>((c) =>
            c.updateTargeting({
              path: { project, flag: d.key, environment: e.environment },
              body: { version, ...targetingOf(e.targeting) },
            }),
          );
          const now = r.environments[e.environment]?.version ?? version + 1;
          envVersions.set(`${d.key}/${e.environment}`, now);
          done.push({ flag: d.key, step: 'targeting', environment: e.environment, version: now });
        }, `updating ${d.key} in ${e.environment}`);
      } else {
        await write(async () => {
          const r = await ctx.call<ChangeRequestView>((c) =>
            c.proposeFlagChange({
              path: { project, flag: d.key, environment: e.environment },
              body: {
                baseVersion: version,
                title: titleOf(plan.source, d.key, e.environment),
                description: `Proposed by flagship apply from ${plan.source}.`,
                ...targetingOf(e.targeting),
              },
            }),
          );
          done.push({
            flag: d.key,
            step: 'change-request',
            environment: e.environment,
            changeRequest: r.id,
          });
        }, `proposing ${d.key} in ${e.environment}`);
      }
    }
  }

  for (const { key, variants } of later) {
    const f = active.find((x) => x.key === key);
    const waiting = f?.environments.filter((e) => e.via === 'change-request') ?? [];
    if (waiting.length > 0) {
      done.push({
        flag: key,
        step: 'variants',
        note: `variants stay until the change requests in ${list(waiting.map((e) => e.environment))} are applied; apply again then`,
      });
      continue;
    }
    await write(async () => {
      const r = await ctx.call<FlagView>((c) =>
        c.updateFlag({
          path: { project, flag: key },
          body: { version: versions.get(key) ?? 0, variants },
        }),
      );
      versions.set(key, r.version);
      done.push({ flag: key, step: 'variants', version: r.version });
    }, `removing variants of ${key}`);
  }

  for (const f of plan.flags) {
    if (f.action !== 'archive') continue;
    await write(async () => {
      const r = await ctx.call<FlagView>((c) =>
        c.archiveFlag({ path: { project, flag: f.key }, body: { version: f.version ?? 0 } }),
      );
      done.push({ flag: f.key, step: 'archive', version: r.version });
    }, `archiving ${f.key}`);
  }

  for (const f of active) {
    if (!f.record) continue;
    const d = f.desired as DesiredFlag;
    await write(async () => {
      const now = await ctx.call<FlagView>((c) => c.getFlag({ path: { project, flag: d.key } }));
      const environments: Record<string, number> = {};
      for (const env of Object.keys(d.environments)) {
        const v = now.environments[env]?.version;
        if (v !== undefined) environments[env] = v;
      }
      await ctx.call((c) =>
        c.setFlagManagedBy({
          path: { project, flag: d.key },
          body: { version: versions.get(d.key) ?? now.version, source: plan.source, environments },
        }),
      );
      done.push({ flag: d.key, step: 'record' });
    }, `recording ${d.key} as managed by ${plan.source}`);
  }
  return done;
}

export function appliedText(done: readonly Applied[]): string {
  if (done.length === 0) return 'Nothing to apply.';
  return done
    .map((a) => {
      const env = a.environment === undefined ? '' : ` in ${a.environment}`;
      const v = a.version === undefined ? '' : ` (version ${a.version})`;
      const note = a.note === undefined ? '' : `: ${a.note}`;
      switch (a.step) {
        case 'create':
          return `Created ${a.flag}${v}.`;
        case 'restore':
          return `Restored ${a.flag}${v}.`;
        case 'metadata':
          return `Updated ${a.flag}${v}${note}.`;
        case 'variants':
          return a.version === undefined
            ? `Kept old variants of ${a.flag}${note}.`
            : `Removed old variants of ${a.flag}${v}.`;
        case 'targeting':
          return `Updated ${a.flag}${env}${v}.`;
        case 'change-request':
          return `Proposed change request ${a.changeRequest ?? '?'} for ${a.flag}${env}.`;
        case 'archive':
          return `Archived ${a.flag}${v}.`;
        case 'record':
          return `Recorded ${a.flag} as managed by this file.`;
      }
      return '';
    })
    .join('\n');
}
