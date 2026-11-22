import type { SegmentRule } from '@flagship/admin-client';
import {
  csv,
  int,
  pick,
  str,
  type Command,
  type Context,
  type Option,
  type Values,
} from '../command.js';
import { UsageError } from '../errors.js';
import { compact, fields, list, table, when } from '../output.js';

export interface SegmentView {
  key: string;
  name: string;
  description: string;
  included: string[];
  excluded: string[];
  rules: SegmentRule[];
  version: number;
  updatedAt: string;
}

/** What a segment is, without its key and bookkeeping: what create, update and proposals send. */
export interface SegmentContent {
  name: string;
  description?: string;
  included: string[];
  excluded: string[];
  rules: SegmentRule[];
}

const CONTENT_FIELDS = ['name', 'description', 'included', 'excluded', 'rules'] as const;

const contentOptions: Record<string, Option> = {
  file: {
    type: 'string',
    value: 'PATH',
    description: 'Content as JSON (name, description, included, excluded, rules), or - for stdin',
  },
  name: { type: 'string', value: 'NAME', description: 'Display name' },
  description: { type: 'string', value: 'TEXT', description: 'What it is for' },
  include: {
    type: 'string',
    multiple: true,
    value: 'KEYS',
    description: 'Add context keys to the include list (comma-separated or repeated)',
  },
  exclude: {
    type: 'string',
    multiple: true,
    value: 'KEYS',
    description: 'Add context keys to the exclude list',
  },
  unlist: {
    type: 'string',
    multiple: true,
    value: 'KEYS',
    description: 'Remove context keys from both lists',
  },
};

function strings(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
    throw new UsageError(`${what} must be an array of strings`);
  }
  return v;
}

/** Reads --file onto `base`, then applies --name, --description and the member edits. */
export async function segmentContent(
  ctx: Context,
  values: Values,
  base: SegmentContent,
): Promise<SegmentContent> {
  const out: SegmentContent = {
    ...base,
    included: [...base.included],
    excluded: [...base.excluded],
  };
  const file = str(values, 'file');
  if (file !== undefined) {
    const raw = pick(await ctx.readFileJson(file, 'segment'), CONTENT_FIELDS, 'segment');
    if (raw.name !== undefined) {
      if (typeof raw.name !== 'string') throw new UsageError('segment name must be a string');
      out.name = raw.name;
    }
    if (raw.description !== undefined) {
      if (typeof raw.description !== 'string') {
        throw new UsageError('segment description must be a string');
      }
      out.description = raw.description;
    }
    if (raw.included !== undefined) out.included = strings(raw.included, 'included');
    if (raw.excluded !== undefined) out.excluded = strings(raw.excluded, 'excluded');
    if (raw.rules !== undefined) {
      if (!Array.isArray(raw.rules)) throw new UsageError('segment rules must be an array');
      out.rules = raw.rules as SegmentRule[];
    }
  }
  const name = str(values, 'name');
  if (name !== undefined) out.name = name;
  const description = str(values, 'description');
  if (description !== undefined) out.description = description;

  const include = csv(values, 'include');
  const exclude = csv(values, 'exclude');
  const unlist = new Set(csv(values, 'unlist'));
  const both = include.filter((k) => exclude.includes(k));
  if (both.length > 0) throw new UsageError(`can't both include and exclude ${list(both)}`);
  // A key moves to the list it is added to, so it is never on both.
  const included = new Set(out.included.filter((k) => !exclude.includes(k) && !unlist.has(k)));
  const excluded = new Set(out.excluded.filter((k) => !include.includes(k) && !unlist.has(k)));
  for (const k of include) included.add(k);
  for (const k of exclude) excluded.add(k);
  out.included = [...included];
  out.excluded = [...excluded];
  return out;
}

export async function getSegment(ctx: Context, key: string): Promise<SegmentView> {
  return ctx.call<SegmentView>((c) =>
    c.getSegment({
      path: { project: ctx.project(), environment: ctx.environment(), segment: key },
    }),
  );
}

export function contentOf(s: SegmentView): SegmentContent {
  return {
    name: s.name,
    description: s.description,
    included: s.included,
    excluded: s.excluded,
    rules: s.rules,
  };
}

function segmentText(s: SegmentView): string {
  const lines = [
    fields([
      ['key', s.key],
      ['name', s.name],
      ['description', s.description || '-'],
      ['version', String(s.version)],
      ['updated', when(s.updatedAt)],
      [
        'included',
        `${s.included.length}${s.included.length > 0 ? `: ${preview(s.included)}` : ''}`,
      ],
      [
        'excluded',
        `${s.excluded.length}${s.excluded.length > 0 ? `: ${preview(s.excluded)}` : ''}`,
      ],
    ]),
  ];
  if (s.rules.length > 0) {
    lines.push('', 'Rules (a context matching any is in the segment):');
    for (const r of s.rules) {
      const clauses = r.clauses.map(
        (c) =>
          `${c.attribute} ${c.negate === true ? 'not ' : ''}${c.operator} ${c.values
            .map((v) => compact(v))
            .join(', ')}`,
      );
      lines.push(`  ${r.id}: ${clauses.join(' and ')}`);
    }
  }
  return lines.join('\n');
}

/** The first few members, so a 10,000-key list doesn't flood the terminal. */
function preview(keys: readonly string[]): string {
  const shown = keys.slice(0, 10).join(', ');
  return keys.length > 10 ? `${shown}, ... (--json for all)` : shown;
}

const segmentList: Command = {
  path: ['segment', 'list'],
  summary: "List an environment's segments",
  async run(ctx) {
    const environment = ctx.environment();
    const { segments } = await ctx.call<{ segments: SegmentView[] }>((c) =>
      c.listSegments({ path: { project: ctx.project(), environment } }),
    );
    return {
      json: { environment, segments },
      text:
        segments.length === 0
          ? `No segments in ${environment}.`
          : table(
              ['KEY', 'NAME', 'INCLUDED', 'EXCLUDED', 'RULES', 'VERSION', 'UPDATED'],
              segments.map((s) => [
                s.key,
                s.name,
                String(s.included.length),
                String(s.excluded.length),
                String(s.rules.length),
                String(s.version),
                when(s.updatedAt),
              ]),
            ),
    };
  },
};

const segmentGet: Command = {
  path: ['segment', 'get'],
  summary: 'Show a segment',
  args: '<key>',
  arity: [1, 1],
  async run(ctx, _values, [key = '']) {
    const s = await getSegment(ctx, key);
    return { json: s, text: segmentText(s) };
  },
};

const segmentCreate: Command = {
  path: ['segment', 'create'],
  summary: 'Create a segment in an environment',
  args: '<key>',
  arity: [1, 1],
  options: contentOptions,
  async run(ctx, values, [key = '']) {
    const environment = ctx.environment();
    const content = await segmentContent(ctx, values, {
      name: key,
      included: [],
      excluded: [],
      rules: [],
    });
    const s = await ctx.call<SegmentView>((c) =>
      c.createSegment({ path: { project: ctx.project(), environment }, body: { key, ...content } }),
    );
    return { json: s, text: `Created segment ${s.key} in ${environment}.` };
  },
};

const segmentUpdate: Command = {
  path: ['segment', 'update'],
  summary: 'Change a segment: replace it from a file, or edit its name and member lists',
  details:
    'Starts from the live segment, applies --file, then --name, --description, --include, --exclude and --unlist.',
  args: '<key>',
  arity: [1, 1],
  options: {
    ...contentOptions,
    'if-version': {
      type: 'string',
      value: 'N',
      description: 'Only change it if it is still at this version (default: the version just read)',
    },
  },
  async run(ctx, values, [key = '']) {
    const environment = ctx.environment();
    const live = await getSegment(ctx, key);
    const content = await segmentContent(ctx, values, contentOf(live));
    const version = int(values, 'if-version', { min: 1 }) ?? live.version;
    const s = await ctx.call<SegmentView>((c) =>
      c.updateSegment({
        path: { project: ctx.project(), environment, segment: key },
        body: { version, ...content },
      }),
    );
    return {
      json: s,
      text: `Updated segment ${key} in ${environment} (now version ${s.version}).`,
    };
  },
};

const segmentDelete: Command = {
  path: ['segment', 'delete'],
  summary: 'Delete a segment that no flag uses',
  args: '<key>',
  arity: [1, 1],
  options: {
    'if-version': {
      type: 'string',
      value: 'N',
      description: 'Only delete it if it is still at this version (default: the version just read)',
    },
  },
  async run(ctx, values, [key = '']) {
    const environment = ctx.environment();
    const version = int(values, 'if-version', { min: 1 }) ?? (await getSegment(ctx, key)).version;
    await ctx.call((c) =>
      c.deleteSegment({
        path: { project: ctx.project(), environment, segment: key },
        query: { version },
      }),
    );
    return {
      json: { deleted: key, environment, version },
      text: `Deleted segment ${key} from ${environment}.`,
    };
  },
};

export const segmentCommands: Command[] = [
  segmentList,
  segmentGet,
  segmentCreate,
  segmentUpdate,
  segmentDelete,
];
