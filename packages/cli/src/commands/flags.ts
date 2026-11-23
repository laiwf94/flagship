import type {
  CreateFlagBody,
  UpdateFlagBody,
  UpdateTargetingBody,
  Variant,
} from '@flagship/admin-client';
import type { Flag, Lifecycle } from '@flagship/core';
import {
  bool,
  int,
  oneOf,
  pick,
  str,
  type Command,
  type Context,
  type Option,
  type Values,
} from '../command.js';
import { UsageError } from '../errors.js';
import { compact, fields, list, table, when } from '../output.js';

export interface EnvTargeting {
  enabled: boolean;
  offVariant: string;
  prerequisites: Flag['prerequisites'];
  rules: Flag['rules'];
  fallthrough: Flag['fallthrough'];
  version: number;
  updatedAt: string;
}

export interface FlagView {
  key: string;
  name: string;
  description: string;
  type: Flag['type'];
  variants: Variant[];
  clientSide: boolean;
  archived: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  environments: Record<string, EnvTargeting>;
  managedBy: ManagedBy | null;
}

/** The flags file that manages a flag, and the versions its last apply left. */
export interface ManagedBy {
  source: string;
  metadataVersion: number;
  environments: Record<string, number>;
  appliedAt: string;
  appliedBy: string;
}

export interface FlagSummary {
  key: string;
  name: string;
  type: Flag['type'];
  version: number;
  targetingVersion: number;
  updatedAt: string;
  status: 'on' | 'off' | 'rollout' | 'archived';
  ruleCount: number;
  lifecycle: Lifecycle;
  lastEvaluatedAt: string | null;
  managedBy: string | null;
}

export const TARGETING_FIELDS = [
  'enabled',
  'offVariant',
  'prerequisites',
  'rules',
  'fallthrough',
] as const;

const ifVersion: Option = {
  type: 'string',
  value: 'N',
  description: 'Only change it if it is still at this version (default: the version just read)',
};

export async function getFlag(ctx: Context, key: string): Promise<FlagView> {
  return ctx.call<FlagView>((c) => c.getFlag({ path: { project: ctx.project(), flag: key } }));
}

/** The flag's targeting in the selected environment, or a clear error. */
export function targetingIn(flag: FlagView, environment: string): EnvTargeting {
  const t = flag.environments[environment];
  if (t === undefined) {
    throw new UsageError(
      `flag "${flag.key}" has no environment "${environment}"; it has ${list(Object.keys(flag.environments).sort())}`,
    );
  }
  return t;
}

/** Describes a serve: "on", or "on 10% / off 90%" for a split. */
export function serveText(serve: Flag['fallthrough']): string {
  if ('variant' in serve) return serve.variant;
  const parts = serve.rollout.variants.map((v) => `${v.variant} ${v.weight / 1000}%`);
  const by =
    serve.rollout.bucketBy && serve.rollout.bucketBy !== 'key'
      ? ` by ${serve.rollout.bucketBy}`
      : '';
  return `${parts.join(' / ')}${by}`;
}

function clauseText(c: Flag['rules'][number]['clauses'][number]): string {
  const not = c.negate === true ? 'not ' : '';
  if (c.operator === 'inSegment') return `${not}in segment ${c.segments.join(' or ')}`;
  return `${c.attribute} ${not}${c.operator} ${c.values.map((v) => compact(v)).join(', ')}`;
}

export function targetingLines(t: Omit<EnvTargeting, 'version' | 'updatedAt'>): string[] {
  const lines = [`  ${t.enabled ? 'on' : `off (serves ${t.offVariant})`}`];
  for (const p of t.prerequisites) lines.push(`  requires ${p.flag} = ${p.variant}`);
  for (const r of t.rules) {
    lines.push(
      `  rule ${r.id}: if ${r.clauses.map(clauseText).join(' and ')} then ${serveText(r.serve)}`,
    );
  }
  lines.push(`  default: ${serveText(t.fallthrough)}`);
  return lines;
}

const flagList: Command = {
  path: ['flag', 'list'],
  summary: 'List flags with their status in an environment',
  options: {
    search: {
      type: 'string',
      value: 'TEXT',
      description: 'Only flags whose key or name contain this',
    },
    status: { type: 'string', value: 'STATUS', description: 'on, off, rollout or archived' },
    type: { type: 'string', value: 'TYPE', description: 'boolean, string, number or json' },
    limit: { type: 'string', value: 'N', description: 'At most this many (1 to 500, default 100)' },
    all: { type: 'boolean', description: 'Fetch every page instead of stopping at --limit' },
  },
  async run(ctx, values) {
    const project = ctx.project();
    const environment = ctx.environment();
    const limit = int(values, 'limit', { min: 1, max: 500 }) ?? 100;
    const query = {
      environment,
      q: str(values, 'search'),
      status: oneOf(values, 'status', ['on', 'off', 'rollout', 'archived'] as const),
      type: oneOf(values, 'type', ['boolean', 'string', 'number', 'json'] as const),
      limit,
    };
    const flags: FlagSummary[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await ctx.call<{ flags: FlagSummary[] }>((c) =>
        c.listFlags({ path: { project }, query: { ...query, after } }),
      );
      flags.push(...page.flags);
      const last = page.flags.at(-1);
      if (!bool(values, 'all') || page.flags.length < limit || last === undefined) break;
      after = last.key;
    }
    return {
      json: { environment, flags },
      text:
        flags.length === 0
          ? `No flags in ${project}/${environment}.`
          : table(
              ['KEY', 'STATUS', 'TYPE', 'RULES', 'STAGE', 'UPDATED', 'LAST EVALUATED'],
              flags.map((f) => [
                f.key,
                f.status,
                f.type,
                String(f.ruleCount),
                f.lifecycle.stale ? `${f.lifecycle.stage} (stale)` : f.lifecycle.stage,
                when(f.updatedAt),
                when(f.lastEvaluatedAt),
              ]),
            ),
    };
  },
};

const flagGet: Command = {
  path: ['flag', 'get'],
  summary: 'Show a flag, its variants and its targeting',
  details: 'Shows every environment, or only the one given with --environment.',
  args: '<key>',
  arity: [1, 1],
  async run(ctx, _values, [key = '']) {
    const flag = await getFlag(ctx, key);
    const only = ctx.explicitEnvironment();
    const envs = only === undefined ? Object.keys(flag.environments) : [only];
    const lines = [
      fields([
        ['key', flag.key],
        ['name', flag.name],
        ['description', flag.description || '-'],
        ['type', flag.type],
        ['client side', flag.clientSide ? 'yes' : 'no'],
        ['archived', flag.archived ? 'yes' : 'no'],
        ['version', String(flag.version)],
        ['updated', when(flag.updatedAt)],
      ]),
      '',
      'Variants:',
      ...flag.variants.map(
        (v) => `  ${v.key} = ${compact(v.value)}${v.name ? ` (${v.name})` : ''}`,
      ),
    ];
    for (const env of envs) {
      const t = targetingIn(flag, env);
      lines.push(
        '',
        `${env} (version ${t.version}, updated ${when(t.updatedAt)}):`,
        ...targetingLines(t),
      );
    }
    return { json: flag, text: lines.join('\n') };
  },
};

async function variantsOption(ctx: Context, values: Values): Promise<Variant[] | undefined> {
  const source = str(values, 'variants');
  if (source === undefined) return undefined;
  const v = await ctx.readJson(source, '--variants');
  if (!Array.isArray(v))
    throw new UsageError('--variants must be a JSON array of {key, value, name?}');
  return v as Variant[];
}

function clientSideOption(values: Values): boolean | undefined {
  if (bool(values, 'client-side') && bool(values, 'server-only')) {
    throw new UsageError('use either --client-side or --server-only');
  }
  if (bool(values, 'client-side')) return true;
  if (bool(values, 'server-only')) return false;
  return undefined;
}

const flagCreate: Command = {
  path: ['flag', 'create'],
  summary: 'Create a flag (off in every environment until targeted)',
  args: '<key>',
  arity: [1, 1],
  details:
    'Boolean flags get "on" and "off" variants unless --variants says otherwise; other types need --variants.',
  options: {
    name: { type: 'string', value: 'NAME', description: 'Display name (default: the key)' },
    description: { type: 'string', value: 'TEXT', description: 'What it is for' },
    type: {
      type: 'string',
      value: 'TYPE',
      description: 'boolean (default), string, number or json',
    },
    variants: {
      type: 'string',
      value: 'JSON',
      description: 'Variants as JSON, @file or - for stdin: [{"key":"a","value":"A"}, ...]',
    },
    'client-side': { type: 'boolean', description: 'Let client-side keys evaluate it' },
  },
  async run(ctx, values, [key = '']) {
    const body: CreateFlagBody = {
      key,
      name: str(values, 'name') ?? key,
      type: oneOf(values, 'type', ['boolean', 'string', 'number', 'json'] as const) ?? 'boolean',
    };
    const description = str(values, 'description');
    if (description !== undefined) body.description = description;
    const variants = await variantsOption(ctx, values);
    if (variants !== undefined) body.variants = variants;
    if (bool(values, 'client-side')) body.clientSide = true;
    const flag = await ctx.call<FlagView>((c) =>
      c.createFlag({ path: { project: ctx.project() }, body }),
    );
    return { json: flag, text: `Created flag ${flag.key} (${flag.type}).` };
  },
};

const flagUpdate: Command = {
  path: ['flag', 'update'],
  summary: "Change a flag's name, description, variants or client-side access",
  args: '<key>',
  arity: [1, 1],
  options: {
    name: { type: 'string', value: 'NAME', description: 'New display name' },
    description: { type: 'string', value: 'TEXT', description: 'New description' },
    variants: { type: 'string', value: 'JSON', description: 'All variants, as for flag create' },
    'client-side': { type: 'boolean', description: 'Let client-side keys evaluate it' },
    'server-only': { type: 'boolean', description: 'Stop client-side keys evaluating it' },
    'if-version': ifVersion,
  },
  async run(ctx, values, [key = '']) {
    const pinned = int(values, 'if-version', { min: 1 });
    const body: UpdateFlagBody = { version: pinned ?? (await getFlag(ctx, key)).version };
    const name = str(values, 'name');
    if (name !== undefined) body.name = name;
    const description = str(values, 'description');
    if (description !== undefined) body.description = description;
    const variants = await variantsOption(ctx, values);
    if (variants !== undefined) body.variants = variants;
    const clientSide = clientSideOption(values);
    if (clientSide !== undefined) body.clientSide = clientSide;
    if (Object.keys(body).length === 1) {
      throw new UsageError(
        'nothing to change: pass --name, --description, --variants, --client-side or --server-only',
      );
    }
    const flag = await ctx.call<FlagView>((c) =>
      c.updateFlag({ path: { project: ctx.project(), flag: key }, body }),
    );
    return { json: flag, text: `Updated flag ${flag.key} (now version ${flag.version}).` };
  },
};

function killSwitch(enabled: boolean): Command {
  return {
    path: ['flag', enabled ? 'on' : 'off'],
    summary: enabled
      ? 'Turn a flag on in an environment (its rules apply again)'
      : 'Turn a flag off in an environment: everyone gets the off variant',
    details: 'The kill switch works on protected environments too, without a change request.',
    args: '<key>',
    arity: [1, 1],
    async run(ctx, _values, [key = '']) {
      const environment = ctx.environment();
      const flag = await ctx.call<FlagView>((c) =>
        c.setKillSwitch({
          path: { project: ctx.project(), flag: key, environment },
          body: { enabled },
        }),
      );
      return { json: flag, text: `Turned ${key} ${enabled ? 'on' : 'off'} in ${environment}.` };
    },
  };
}

/** Targeting from a file, keeping only its targeting fields so `flag get --json` output can be edited and fed back. */
export async function targetingFile(
  ctx: Context,
  path: string,
): Promise<Omit<UpdateTargetingBody, 'version'>> {
  const raw = pick(await ctx.readFileJson(path, 'targeting'), TARGETING_FIELDS, 'targeting');
  const missing = TARGETING_FIELDS.filter((f) => raw[f] === undefined);
  if (missing.length > 0)
    throw new UsageError(`targeting in ${path} is missing ${missing.join(', ')}`);
  return raw as Omit<UpdateTargetingBody, 'version'>;
}

const flagTarget: Command = {
  path: ['flag', 'target'],
  summary: "Replace a flag's targeting in an environment from a JSON file",
  details: [
    'The file holds enabled, offVariant, prerequisites, rules and fallthrough; other fields are',
    'ignored, so one environment of `flag get --json` can be edited and passed back. Protected',
    'environments refuse direct edits: propose the same file with change-request propose.',
  ].join('\n'),
  args: '<key>',
  arity: [1, 1],
  options: {
    file: { type: 'string', value: 'PATH', description: 'The targeting JSON, or - for stdin' },
    'if-version': ifVersion,
  },
  async run(ctx, values, [key = '']) {
    const file = str(values, 'file');
    if (file === undefined) throw new UsageError('pass --file PATH (or --file - for stdin)');
    const environment = ctx.environment();
    const targeting = await targetingFile(ctx, file);
    const pinned = int(values, 'if-version', { min: 1 });
    const version = pinned ?? targetingIn(await getFlag(ctx, key), environment).version;
    const flag = await ctx.call<FlagView>((c) =>
      c.updateTargeting({
        path: { project: ctx.project(), flag: key, environment },
        body: { version, ...targeting },
      }),
    );
    const now = targetingIn(flag, environment);
    return {
      json: flag,
      text: [
        `Updated ${key} in ${environment} (now version ${now.version}):`,
        ...targetingLines(now),
      ].join('\n'),
    };
  },
};

function archive(restore: boolean): Command {
  return {
    path: ['flag', restore ? 'restore' : 'archive'],
    summary: restore ? 'Bring an archived flag back' : 'Archive a flag: SDKs stop seeing it',
    args: '<key>',
    arity: [1, 1],
    options: { 'if-version': ifVersion },
    async run(ctx, values, [key = '']) {
      const version = int(values, 'if-version', { min: 1 }) ?? (await getFlag(ctx, key)).version;
      const path = { project: ctx.project(), flag: key };
      const flag = await ctx.call<FlagView>((c) =>
        restore
          ? c.restoreFlag({ path, body: { version } })
          : c.archiveFlag({ path, body: { version } }),
      );
      return { json: flag, text: `${restore ? 'Restored' : 'Archived'} flag ${key}.` };
    },
  };
}

export const flagCommands: Command[] = [
  flagList,
  flagGet,
  flagCreate,
  flagUpdate,
  killSwitch(true),
  killSwitch(false),
  flagTarget,
  archive(false),
  archive(true),
];
