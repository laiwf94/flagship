import {
  FLAG_TYPES,
  diff,
  LIMITS,
  formatPath,
  keySchema,
  parseYaml,
  prerequisiteSchema,
  ruleSchema,
  serveSchema,
  stringifyYaml,
  variantSchema,
  YamlError,
  type FlagType,
  type YamlValue,
} from '@flagship/core';
import type { Prerequisite, Rule, Serve, Variant } from '@flagship/admin-client';
import { z } from 'zod';
import { CliError } from './errors.js';

/** One environment's targeting, as the server stores it. */
export interface Targeting {
  enabled: boolean;
  offVariant: string;
  prerequisites: Prerequisite[];
  rules: Rule[];
  fallthrough: Serve;
}

/** A flag as the file wants it, with defaults filled in. */
export interface DesiredFlag {
  key: string;
  name: string;
  description: string;
  type: FlagType;
  clientSide: boolean;
  variants: Variant[];
  /** Only the environments the file manages; the others are left alone. */
  environments: Record<string, Targeting>;
}

export interface FlagsFile {
  /** The path it was read from, as given. */
  file: string;
  /** What the server records as the manager of its flags. */
  source: string;
  project: string | undefined;
  flags: DesiredFlag[];
  /** The line a document path starts on. */
  lineOf: (path: string) => number;
}

/** A problem in the file: where, and what. */
export interface FileIssue {
  file: string;
  line: number;
  path: string;
  message: string;
}

/** Thrown for anything wrong in a flags file; its details carry each issue with its line. */
export class FlagsFileError extends CliError {
  constructor(
    file: string,
    readonly issues: FileIssue[],
  ) {
    super(
      'invalid_flags_file',
      `${file} has ${issues.length === 1 ? 'a problem' : `${issues.length} problems`}`,
      issues,
    );
  }
}

export const FILE_VERSION = 1;

export const BOOLEAN_VARIANTS: readonly Variant[] = [
  { key: 'on', value: true },
  { key: 'off', value: false },
];

/** A serve, or a variant key as shorthand for serving that variant. */
const fileServe = z.union([keySchema.transform((variant) => ({ variant })), serveSchema]);

const fileRule = ruleSchema.extend({ serve: fileServe });

const fileTargeting = z.strictObject({
  enabled: z.boolean().default(false),
  offVariant: keySchema.optional(),
  prerequisites: z.array(prerequisiteSchema).max(LIMITS.prerequisitesPerFlag).default([]),
  rules: z.array(fileRule).max(LIMITS.rulesPerFlag).default([]),
  fallthrough: fileServe.optional(),
});

const fileFlag = z.strictObject({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().max(LIMITS.descriptionLength).default(''),
  type: z.enum(FLAG_TYPES).default('boolean'),
  clientSide: z.boolean().default(false),
  variants: z.array(variantSchema).min(2).max(LIMITS.variantsPerFlag).optional(),
  environments: z.record(keySchema, z.union([fileTargeting, z.null()])).default({}),
});

const fileDocument = z.strictObject({
  version: z.literal(FILE_VERSION, { error: `must be ${FILE_VERSION}` }),
  project: keySchema.optional(),
  source: z.string().trim().min(1).max(200).optional(),
  flags: z.record(keySchema, z.union([fileFlag, z.null()])).default({}),
});

type Issue = z.core.$ZodIssue;

/**
 * Zod issues made readable for a file: an unknown key points at that key's
 * line, and a union that no branch matched reports the branch that got
 * furthest (so `serve: {variant: 1}` says what is wrong with the variant).
 */
function flatten(
  issues: readonly Issue[],
  prefix: PropertyKey[],
): { path: PropertyKey[]; message: string }[] {
  return issues.flatMap((i) => {
    const path = [...prefix, ...i.path];
    if (i.code === 'unrecognized_keys') {
      return i.keys.map((k) => ({ path: [...path, k], message: `unknown field "${k}"` }));
    }
    if (i.code === 'invalid_key') {
      return flatten(i.issues, path).map((x) => ({ ...x, message: `key ${x.message}` }));
    }
    if (i.code === 'invalid_union' && i.errors.length > 0) {
      const branches = i.errors.map((branch) => flatten(branch, path));
      const depth = (list: { path: PropertyKey[] }[]) =>
        Math.max(0, ...list.map((x) => x.path.length));
      const best = branches.reduce((a, b) => (depth(b) > depth(a) ? b : a));
      if (depth(best) > path.length) return best;
    }
    return [{ path, message: i.message }];
  });
}

/** The off variant the server picks for a new flag: the one whose value is false, else the first. */
export function defaultOffVariant(variants: readonly Variant[]): string {
  return (variants.find((v) => v.value === false) ?? variants[0])?.key ?? 'off';
}

/**
 * Reads a flags file: YAML of the supported subset, checked against the
 * document schema, with every problem reported at its line.
 */
export function readFlagsFile(text: string, file: string, defaultSource: string): FlagsFile {
  let doc: ReturnType<typeof parseYaml>;
  try {
    doc = parseYaml(text);
  } catch (e) {
    if (e instanceof YamlError) {
      throw new FlagsFileError(file, [
        { file, line: e.line, path: '', message: e.message.replace(/^line \d+, /, '') },
      ]);
    }
    throw e;
  }
  const issue = (path: string, message: string): FileIssue => ({
    file,
    line: doc.lineOf(path),
    path,
    message,
  });
  if (doc.value === null || typeof doc.value !== 'object' || Array.isArray(doc.value)) {
    throw new FlagsFileError(file, [
      issue('', 'must be a mapping with version and flags, e.g. "version: 1"'),
    ]);
  }
  const parsed = fileDocument.safeParse(doc.value);
  if (!parsed.success) {
    throw new FlagsFileError(
      file,
      flatten(parsed.error.issues, [])
        .map((i) => issue(formatPath(i.path), i.message))
        .sort((a, b) => a.line - b.line),
    );
  }
  const issues: FileIssue[] = [];
  const flags: DesiredFlag[] = [];
  for (const [key, f] of Object.entries(parsed.data.flags)) {
    const at = `flags.${key}`;
    const flag = f ?? fileFlag.parse({});
    // Zod leaves absent optional fields out, so its output fits the API's exact types.
    let variants = flag.variants as Variant[] | undefined;
    if (variants === undefined) {
      if (flag.type !== 'boolean') {
        issues.push(issue(`${at}.type`, `${flag.type} flags need variants`));
        continue;
      }
      variants = BOOLEAN_VARIANTS.map((v) => ({ ...v }));
    }
    const environments: Record<string, Targeting> = {};
    for (const [env, t] of Object.entries(flag.environments)) {
      const targeting = t ?? fileTargeting.parse({});
      const offVariant = targeting.offVariant ?? defaultOffVariant(variants);
      if (targeting.enabled && targeting.fallthrough === undefined) {
        issues.push(
          issue(
            `${at}.environments.${env}.enabled`,
            'an enabled flag needs a fallthrough: what everyone no rule matches gets',
          ),
        );
        continue;
      }
      environments[env] = {
        enabled: targeting.enabled,
        offVariant,
        prerequisites: targeting.prerequisites,
        rules: targeting.rules as Rule[],
        fallthrough: (targeting.fallthrough ?? { variant: offVariant }) as Serve,
      };
    }
    flags.push({
      key,
      name: flag.name ?? key,
      description: flag.description,
      type: flag.type,
      clientSide: flag.clientSide,
      variants,
      environments,
    });
  }
  if (issues.length > 0) throw new FlagsFileError(file, issues);
  return {
    file,
    source: parsed.data.source ?? defaultSource,
    project: parsed.data.project,
    flags,
    lineOf: doc.lineOf,
  };
}

/** The flag fields a file holds for one live flag, leaving out what equals the defaults. */
export interface LiveFlag {
  key: string;
  name: string;
  description: string;
  type: FlagType;
  clientSide: boolean;
  variants: Variant[];
  environments: Record<string, Targeting>;
}

/** Equal as JSON, whatever the key order (the server stores JSON as jsonb, which reorders keys). */
function sameJson(a: unknown, b: unknown): boolean {
  return diff(a, b).length === 0;
}

function serveOut(serve: Serve): YamlValue {
  return 'variant' in serve ? serve.variant : serve;
}

/**
 * Writes live flags as a flags file that reads back to the same state: the
 * starting point for managing existing flags as code.
 */
export function writeFlagsFile(
  flags: readonly LiveFlag[],
  options: { project?: string | undefined; source?: string | undefined },
): string {
  const out: Record<string, YamlValue> = {};
  for (const f of flags) {
    const entry: Record<string, YamlValue> = {};
    if (f.name !== f.key) entry.name = f.name;
    if (f.description !== '') entry.description = f.description;
    if (f.type !== 'boolean') entry.type = f.type;
    if (f.clientSide) entry.clientSide = true;
    if (f.type !== 'boolean' || !sameJson(f.variants, BOOLEAN_VARIANTS)) {
      entry.variants = f.variants;
    }
    const envs: Record<string, YamlValue> = {};
    for (const [env, t] of Object.entries(f.environments)) {
      const e: Record<string, YamlValue> = {};
      if (t.enabled) e.enabled = true;
      if (t.offVariant !== defaultOffVariant(f.variants)) e.offVariant = t.offVariant;
      if (t.prerequisites.length > 0) e.prerequisites = t.prerequisites;
      if (t.rules.length > 0) {
        e.rules = t.rules.map((r) => ({ ...r, serve: serveOut(r.serve) }));
      }
      if (t.enabled || !sameJson(t.fallthrough, { variant: t.offVariant })) {
        e.fallthrough = serveOut(t.fallthrough);
      }
      envs[env] = e;
    }
    if (Object.keys(envs).length > 0) entry.environments = envs;
    out[f.key] = entry;
  }
  const doc: Record<string, YamlValue> = { version: FILE_VERSION };
  if (options.project !== undefined) doc.project = options.project;
  if (options.source !== undefined) doc.source = options.source;
  doc.flags = out;
  return [
    '# Flags managed as code. Edit, then run: flagship plan, flagship apply.',
    stringifyYaml(doc),
  ].join('\n');
}
