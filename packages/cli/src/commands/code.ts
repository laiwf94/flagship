import { readFile, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import {
  applyPlan,
  appliedText,
  hasChanges,
  makePlan,
  planText,
  type Plan,
  type PlanOptions,
} from '../code.js';
import { bool, csv, str, strs, type Command, type Context, type Values } from '../command.js';
import { UsageError } from '../errors.js';
import { readFlagsFile, writeFlagsFile, type FlagsFile, type LiveFlag } from '../flagsfile.js';
import { getFlag } from './flags.js';
import type { FlagSummary } from './flags.js';

const DEFAULT_FILE = 'flags.yaml';

/** The exit status of `plan --check` when applying would change something. */
export const CHANGES_STATUS = 3;

async function readText(ctx: Context, path: string, what: string): Promise<string> {
  try {
    return await readFile(resolve(ctx.io.cwd, path), 'utf8');
  } catch (e) {
    throw new UsageError(`can't read ${what} ${path}: ${(e as Error).message}`);
  }
}

/** The file's path from the working directory, with forward slashes, as its default source. */
function defaultSource(ctx: Context, path: string): string {
  return relative(ctx.io.cwd, resolve(ctx.io.cwd, path)).split(sep).join('/');
}

async function loadFile(ctx: Context, path: string): Promise<FlagsFile> {
  return readFlagsFile(await readText(ctx, path, 'flags file'), path, defaultSource(ctx, path));
}

/** The project: the file's, unless the command line or environment names a different one. */
function projectFor(ctx: Context, file: { project: string | undefined; file: string }): string {
  const explicit = str(ctx.globals, 'project') ?? ctx.io.env.FLAGSHIP_PROJECT;
  if (file.project !== undefined) {
    if (explicit !== undefined && explicit !== '' && explicit !== file.project) {
      throw new UsageError(
        `${file.file} is for project "${file.project}", not "${explicit}"; drop --project or fix the file`,
      );
    }
    return file.project;
  }
  return ctx.project();
}

function options(values: Values): PlanOptions {
  return { prune: bool(values, 'prune'), takeOver: bool(values, 'take-over') };
}

const planOptions = {
  prune: {
    type: 'boolean',
    description: 'Archive flags this file used to manage and no longer lists',
  },
  'take-over': {
    type: 'boolean',
    description: 'Manage flags another file manages, instead of refusing',
  },
} as const;

const plan: Command = {
  path: ['plan'],
  summary: 'Show what applying a flags file would change, and any drift',
  args: '[file]',
  arity: [0, 1],
  details: [
    `Reads the flags file (default ${DEFAULT_FILE}) and compares it with the server. Changes`,
    'made outside the file since the last apply are marked as drift. Nothing is written.',
    `With --check the exit status is ${CHANGES_STATUS} when applying would change something,`,
    'so a scheduled CI job can catch drift. --out saves the plan for flagship apply --plan.',
  ].join('\n'),
  options: {
    ...planOptions,
    check: {
      type: 'boolean',
      description: `Exit with status ${CHANGES_STATUS} when there are changes`,
    },
    out: { type: 'string', value: 'PATH', description: 'Save the plan as JSON for apply --plan' },
  },
  async run(ctx, values, [path = DEFAULT_FILE]) {
    const file = await loadFile(ctx, path);
    const p = await makePlan(ctx, file, projectFor(ctx, file), options(values));
    const out = str(values, 'out');
    if (out !== undefined) {
      await writeFile(resolve(ctx.io.cwd, out), `${JSON.stringify(p, null, 2)}\n`, 'utf8');
    }
    const changes = hasChanges(p);
    return {
      json: p,
      text: planText(p),
      status: bool(values, 'check') && (changes || p.summary.orphan > 0) ? CHANGES_STATUS : 0,
    };
  },
};

function readPlan(text: string, path: string): Plan {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new UsageError(`${path} is not a saved plan: ${(e as Error).message}`);
  }
  const p = value as Partial<Plan> | null;
  if (
    p === null ||
    typeof p !== 'object' ||
    p.format !== 'flagship-plan' ||
    p.version !== 1 ||
    typeof p.project !== 'string' ||
    typeof p.source !== 'string' ||
    !Array.isArray(p.flags)
  ) {
    throw new UsageError(`${path} is not a plan saved by flagship plan --out`);
  }
  return p as Plan;
}

const apply: Command = {
  path: ['apply'],
  summary: 'Make the server match a flags file',
  args: '[file]',
  arity: [0, 1],
  details: [
    'Plans as flagship plan does, then applies it. Every write carries the version the plan',
    'read, so a change made in between stops apply instead of being overwritten. Protected',
    'environments get a change request (once: an open one with the same change is reused).',
    '--plan applies a plan saved with plan --out, exactly as reviewed.',
    'Without --reason, changes are recorded with "flagship apply from <source>".',
  ].join('\n'),
  options: {
    ...planOptions,
    plan: { type: 'string', value: 'PATH', description: 'Apply a plan saved by plan --out' },
  },
  async run(ctx, values, [path]) {
    const saved = str(values, 'plan');
    let p: Plan;
    if (saved !== undefined) {
      if (path !== undefined) throw new UsageError('pass either a flags file or --plan, not both');
      if (bool(values, 'prune') || bool(values, 'take-over')) {
        throw new UsageError('--prune and --take-over are part of the saved plan; plan again');
      }
      p = readPlan(await readText(ctx, saved, 'plan'), saved);
      projectFor(ctx, { project: p.project, file: saved });
    } else {
      const file = await loadFile(ctx, path ?? DEFAULT_FILE);
      setReason(ctx, file.source);
      p = await makePlan(ctx, file, projectFor(ctx, file), options(values));
    }
    setReason(ctx, p.source);
    const done = await applyPlan(ctx, p);
    const head = hasChanges(p) || done.length > 0 ? `${planText(p)}\n\n` : '';
    return { json: { plan: p, applied: done }, text: `${head}${appliedText(done)}` };
  },
};

/** Records changes with a reason naming the file, unless --reason gave one. */
function setReason(ctx: Context, source: string): void {
  if (str(ctx.globals, 'reason') === undefined)
    ctx.globals.reason = `flagship apply from ${source}`;
}

const pull: Command = {
  path: ['pull'],
  summary: 'Write live flags as a flags file, to start managing them as code',
  details: [
    'Prints the YAML (or writes it with --out). Pass --flag for some flags only, and',
    '--environments for the environments the file should manage (default: all of them).',
  ].join('\n'),
  options: {
    flag: { type: 'string', multiple: true, value: 'KEY', description: 'Only this flag' },
    environments: {
      type: 'string',
      multiple: true,
      value: 'KEYS',
      description: 'Only these environments, comma separated',
    },
    source: { type: 'string', value: 'TEXT', description: 'The source to write into the file' },
    out: { type: 'string', value: 'PATH', description: 'Write the file here instead of stdout' },
  },
  async run(ctx, values) {
    const project = ctx.project();
    let keys = strs(values, 'flag');
    if (keys.length === 0) {
      const env = ctx.explicitEnvironment() ?? ctx.profile.environment;
      const p = await ctx.call<{ environments: { key: string }[] }>((c) =>
        c.getProject({ path: { project } }),
      );
      const first = env ?? p.environments[0]?.key;
      if (first === undefined) throw new UsageError(`project "${project}" has no environments`);
      const all: FlagSummary[] = [];
      let after: string | undefined;
      for (;;) {
        const page = await ctx.call<{ flags: FlagSummary[] }>((c) =>
          c.listFlags({ path: { project }, query: { environment: first, limit: 500, after } }),
        );
        all.push(...page.flags);
        const last = page.flags.at(-1);
        if (page.flags.length < 500 || last === undefined) break;
        after = last.key;
      }
      keys = all.map((f) => f.key);
    }
    const only = csv(values, 'environments');
    const flags: LiveFlag[] = [];
    for (const key of keys) {
      const f = await getFlag(ctx, key);
      const envs = only.length === 0 ? Object.keys(f.environments) : only;
      const missing = envs.filter((e) => !Object.hasOwn(f.environments, e));
      if (missing.length > 0) {
        throw new UsageError(`flag "${key}" has no environment ${missing.join(', ')}`);
      }
      flags.push({
        key: f.key,
        name: f.name,
        description: f.description,
        type: f.type,
        clientSide: f.clientSide,
        variants: f.variants,
        environments: Object.fromEntries(
          envs.map((e) => {
            const t = f.environments[e];
            return [
              e,
              {
                enabled: t?.enabled ?? false,
                offVariant: t?.offVariant ?? '',
                prerequisites: t?.prerequisites ?? [],
                rules: t?.rules ?? [],
                fallthrough: t?.fallthrough ?? { variant: '' },
              },
            ];
          }),
        ) as LiveFlag['environments'],
      });
    }
    const text = writeFlagsFile(flags, { project, source: str(values, 'source') });
    const out = str(values, 'out');
    if (out !== undefined) await writeFile(resolve(ctx.io.cwd, out), text, 'utf8');
    return {
      json: { project, flags: flags.map((f) => f.key), file: out ?? null, yaml: text },
      text: out === undefined ? text.trimEnd() : `Wrote ${flags.length} flags to ${out}.`,
    };
  },
};

export const codeCommands: Command[] = [plan, apply, pull];
