import type { FlagType } from '@flagship/core';
import { CliError } from './errors.js';

/** What a generator needs to know about a flag. */
export interface CodegenFlag {
  key: string;
  name: string;
  description: string;
  type: FlagType;
  clientSide: boolean;
  variants: readonly { key: string; value: unknown; name?: string | undefined }[];
}

export interface CodegenInput {
  project: string;
  flags: readonly CodegenFlag[];
}

export const LANGUAGES = ['typescript', 'go'] as const;
export type Language = (typeof LANGUAGES)[number];

/** Splits a key on anything that isn't a letter or digit: "new-checkout.v2" is new, checkout, v2. */
function words(key: string): string[] {
  return key.split(/[^A-Za-z0-9]+/).filter((w) => w !== '');
}

const upperFirst = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
const lowerFirst = (w: string) => w.charAt(0).toLowerCase() + w.slice(1);

/** "new-checkout" as newCheckout; a key starting with a digit gets "flag" in front. */
export function camelCase(key: string): string {
  const [first = '', ...rest] = words(key);
  const name = lowerFirst(first) + rest.map(upperFirst).join('');
  return /^[0-9]/.test(name) ? `flag${upperFirst(name)}` : name;
}

/** "new-checkout" as NewCheckout, exported in Go; a leading digit gets "Flag" in front. */
export function pascalCase(key: string): string {
  const name = words(key).map(upperFirst).join('');
  return /^[0-9]/.test(name) ? `Flag${name}` : name;
}

/**
 * Fails when two flags (or a flag and a generated helper) would get the same
 * name, which happens when keys differ only in separators or case.
 */
function unique(names: readonly { name: string; what: string }[]): void {
  const seen = new Map<string, string>();
  const clashes: string[] = [];
  for (const { name, what } of names) {
    const before = seen.get(name);
    if (before === undefined) seen.set(name, what);
    else clashes.push(`${before} and ${what} both become ${name}`);
  }
  if (clashes.length > 0) {
    throw new CliError(
      'codegen_name_clash',
      `generated names clash: ${clashes.join('; ')}. Rename one of the flags or variants`,
      clashes.map((message) => ({ path: '', message })),
    );
  }
}

function sorted(flags: readonly CodegenFlag[]): CodegenFlag[] {
  return [...flags].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** The distinct string values a flag can serve, in variant order. */
function stringValues(flag: CodegenFlag): string[] {
  const out: string[] = [];
  for (const v of flag.variants) {
    if (typeof v.value === 'string' && !out.includes(v.value)) out.push(v.value);
  }
  return out;
}

/** Text that is safe inside a comment: one line each, no control characters. */
function commentLines(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) =>
      Array.from(l, (ch) => (unprintable(ch) ? ' ' : ch))
        .join('')
        .trimEnd(),
    );
}

/** Control characters and the two Unicode line separators, which would end a comment line. */
function unprintable(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return cp < 0x20 || cp === 0x7f || cp === 0x2028 || cp === 0x2029;
}

/** A doc comment for a flag: `head` first, then the name, description and variants. */
function describe(flag: CodegenFlag, head: string): string[] {
  const lines = commentLines(head);
  if (flag.name !== '' && flag.name !== flag.key) lines.push('', ...commentLines(flag.name));
  const description = flag.description.trim();
  if (description !== '') lines.push('', ...commentLines(description));
  const variants = flag.variants.map(
    (v) => `${v.key} = ${JSON.stringify(v.value)}${v.name ? ` (${v.name})` : ''}`,
  );
  lines.push('', ...commentLines(`Variants: ${variants.join(', ')}.`));
  // Blank runs at the end of a description would leave empty comment lines.
  while (lines.at(-1) === '') lines.pop();
  return lines;
}

// ---------------------------------------------------------------------------
// TypeScript

const TS_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function tsProperty(name: string): string {
  return TS_IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

/** A JSDoc block, with "*\/" broken up so a description can't end it early. */
function jsdoc(lines: readonly string[], indent: string): string[] {
  const safe = lines.map((l) => l.replaceAll('*/', '*\\/'));
  if (safe.length === 1) return [`${indent}/** ${safe[0] ?? ''} */`];
  return [
    `${indent}/**`,
    ...safe.map((l) => (l === '' ? `${indent} *` : `${indent} * ${l}`)),
    `${indent} */`,
  ];
}

/** The structural TypeScript type of one JSON value: literals widen to their primitive type. */
function tsTypeOf(value: unknown, indent: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return 'boolean';
    case 'number':
      return 'number';
    case 'string':
      return 'string';
    case 'object': {
      if (Array.isArray(value)) {
        if (value.length === 0) return 'Json[]';
        const items = tsUnion(value.map((v) => tsTypeOf(v, indent)));
        return items.includes(' | ') ? `(${items})[]` : `${items}[]`;
      }
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 0) return 'Record<string, never>';
      const inner = `${indent}  `;
      const props = entries.map(([k, v]) => `${inner}${tsProperty(k)}: ${tsTypeOf(v, inner)};`);
      return `{\n${props.join('\n')}\n${indent}}`;
    }
    default:
      return 'Json';
  }
}

function tsUnion(types: readonly string[]): string {
  return [...new Set(types)].join(' | ');
}

function tsValueType(flag: CodegenFlag, indent: string): string {
  switch (flag.type) {
    case 'boolean':
      return 'boolean';
    case 'number':
      return 'number';
    case 'string': {
      const values = stringValues(flag);
      return values.length === 0 ? 'string' : values.map((v) => JSON.stringify(v)).join(' | ');
    }
    case 'json':
      return tsUnion(flag.variants.map((v) => tsTypeOf(v.value, indent)));
  }
}

const TS_METHOD: Record<FlagType, string> = {
  boolean: 'boolVariation',
  string: 'stringVariation',
  number: 'numberVariation',
  json: 'jsonVariation',
};

/** The body of one accessor: a call to the client, checked against the known values for strings. */
function tsCall(flag: CodegenFlag, args: string): string {
  const call = `client.${TS_METHOD[flag.type]}(${JSON.stringify(flag.key)}, ${args})`;
  if (flag.type === 'string' && stringValues(flag).length > 0) {
    return `known(${call}, ${camelCase(flag.key)}Values, fallback)`;
  }
  return call;
}

function tsAccessors(
  flags: readonly CodegenFlag[],
  params: string,
  args: string,
  indent: string,
): string[] {
  const lines: string[] = [];
  for (const f of flags) {
    lines.push(
      ...jsdoc(describe(f, `Flag ${JSON.stringify(f.key)} (${f.type}).`), indent),
      `${indent}${tsProperty(camelCase(f.key))}: (${params}fallback: FlagValues[${JSON.stringify(f.key)}]): FlagValues[${JSON.stringify(f.key)}] =>`,
      `${indent}  ${tsCall(f, args)},`,
    );
  }
  return lines;
}

/** The body of serverFlags or browserFlags: an object of accessors. */
function tsObject(flags: readonly CodegenFlag[], params: string, args: string): string[] {
  // With no flags the client goes unused, which strict settings would flag.
  if (flags.length === 0) return ['  void client;', '  return {};'];
  return ['  return {', ...tsAccessors(flags, params, args, '    '), '  };'];
}

/**
 * A TypeScript module with each flag's key, its value type and an accessor
 * per flag over the Node SDK (`serverFlags`) and the browser SDK
 * (`browserFlags`, client-side flags only). A string flag's accessor returns
 * the union of its variant values, and the fallback if the server ever serves
 * anything else, so a variant added after generation can't surprise a switch.
 */
export function generateTypeScript(input: CodegenInput): string {
  const flags = sorted(input.flags);
  const client = flags.filter((f) => f.clientSide);
  unique(flags.map((f) => ({ name: camelCase(f.key), what: `flag "${f.key}"` })));
  const strings = flags.filter((f) => f.type === 'string' && stringValues(f).length > 0);

  const out: string[] = [
    `// Generated by flagship codegen from project ${JSON.stringify(input.project)}. Do not edit:`,
    '// run flagship codegen again when flags change, and flagship codegen --check in CI.',
    '',
    '/** A JSON value, as flags serve them. */',
    'export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };',
    '',
    '/** The type of the value each flag serves, by key. */',
  ];
  if (flags.length === 0) {
    out.push('export type FlagValues = Record<never, never>;');
  } else {
    out.push('export type FlagValues = {');
    for (const f of flags) {
      out.push(`  ${tsProperty(f.key)}: ${tsValueType(f, '  ')};`);
    }
    out.push('};');
  }
  out.push(
    '',
    'export type FlagKey = keyof FlagValues;',
    '',
    '/** Every flag key, sorted. */',
    flags.length === 0
      ? 'export const FLAG_KEYS: readonly FlagKey[] = [];'
      : `export const FLAG_KEYS: readonly FlagKey[] = [${flags.map((f) => JSON.stringify(f.key)).join(', ')}];`,
  );
  if (strings.length > 0) {
    out.push('');
    for (const f of strings) {
      out.push(
        `const ${camelCase(f.key)}Values: readonly string[] = [${stringValues(f)
          .map((v) => JSON.stringify(v))
          .join(', ')}];`,
      );
    }
    out.push(
      '',
      'function known<T extends string>(value: string, values: readonly string[], fallback: T): T {',
      '  return values.includes(value) ? (value as T) : fallback;',
      '}',
    );
  }
  out.push(
    '',
    '/** What serverFlags needs: FlagshipClient from @flagship/node has these methods. */',
    'export interface ServerEvaluator<C> {',
    '  boolVariation(flagKey: string, context: C, fallback: boolean): boolean;',
    '  stringVariation(flagKey: string, context: C, fallback: string): string;',
    '  numberVariation(flagKey: string, context: C, fallback: number): number;',
    '  jsonVariation<T extends Json>(flagKey: string, context: C, fallback: T): T;',
    '}',
    '',
    '/** What browserFlags needs: the client from @flagship/browser has these methods. */',
    'export interface BrowserEvaluator {',
    '  boolVariation(flagKey: string, fallback: boolean): boolean;',
    '  stringVariation(flagKey: string, fallback: string): string;',
    '  numberVariation(flagKey: string, fallback: number): number;',
    '  jsonVariation<T extends Json>(flagKey: string, fallback: T): T;',
    '}',
    '',
    '/** One typed accessor per flag, evaluated for a context on the server. */',
    'export function serverFlags<C>(client: ServerEvaluator<C>) {',
    ...tsObject(flags, 'context: C, ', 'context, fallback'),
    '}',
    '',
    '/** One typed accessor per client-side flag, for the browser SDK. */',
    'export function browserFlags(client: BrowserEvaluator) {',
  );
  out.push(...tsObject(client, '', 'fallback'), '}', '');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Go

const GO_KEYWORDS = new Set([
  'break',
  'case',
  'chan',
  'const',
  'continue',
  'default',
  'defer',
  'else',
  'fallthrough',
  'for',
  'func',
  'go',
  'goto',
  'if',
  'import',
  'interface',
  'map',
  'package',
  'range',
  'return',
  'select',
  'struct',
  'switch',
  'type',
  'var',
]);

/** Whether `name` can be a Go package name. */
export function goPackageName(name: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(name) && !GO_KEYWORDS.has(name);
}

/** A Go interpreted string literal. Lone surrogates, which UTF-8 can't hold, become U+FFFD. */
export function goQuote(text: string): string {
  let out = '"';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\r') out += '\\r';
    else if (cp < 0x20 || cp === 0x7f) out += `\\x${cp.toString(16).padStart(2, '0')}`;
    else if (cp >= 0xd800 && cp <= 0xdfff) out += '\\uFFFD';
    else if (cp === 0xfeff || cp === 0x2028 || cp === 0x2029) {
      out += `\\u${cp.toString(16).toUpperCase().padStart(4, '0')}`;
    } else out += ch;
  }
  return `${out}"`;
}

/** Lines as gofmt aligns them: each column padded to its widest cell, the last left as is. */
function goAligned(rows: readonly (readonly string[])[], indent: string): string[] {
  const columns = Math.max(0, ...rows.map((r) => r.length));
  const widths: number[] = [];
  for (let c = 0; c < columns - 1; c++) {
    widths.push(Math.max(...rows.map((r) => (c < r.length - 1 ? (r[c]?.length ?? 0) : 0))));
  }
  return rows.map(
    (r) =>
      indent +
      r.map((cell, c) => (c === r.length - 1 ? cell : cell.padEnd(widths[c] ?? 0))).join(' '),
  );
}

const GO_METHOD: Record<FlagType, { method: string; type: string }> = {
  boolean: { method: 'BoolVariation', type: 'bool' },
  string: { method: 'StringVariation', type: 'string' },
  number: { method: 'NumberVariation', type: 'float64' },
  json: { method: 'JSONVariation', type: 'any' },
};

/**
 * A Go doc comment for an accessor as one paragraph, starting with its name
 * as Go doc comments do. Text is flattened onto unindented lines with no
 * blank ones between, so gofmt finds no headings, lists or code blocks in a
 * description and leaves the comment exactly as written.
 */
function goDoc(flag: CodegenFlag, name: string): string[] {
  const flat = (text: string) => commentLines(text).join(' ').replace(/\s+/g, ' ').trim();
  const title = flat(flag.name);
  const head = `${name} returns flag ${goQuote(flag.key)} (${flag.type})`;
  const lines = [
    title !== '' && title !== flag.key
      ? `${head}: ${title}${/[.!?]$/.test(title) ? '' : '.'}`
      : `${head}.`,
  ];
  const description = flat(flag.description);
  if (description !== '') lines.push(description);
  const variants = flag.variants.map((v) => `${v.key} = ${JSON.stringify(v.value)}`);
  lines.push(flat(`Variants: ${variants.join(', ')}.`));
  return lines;
}

/**
 * A Go file with a constant per flag key, a string type with constants for
 * each string flag's variants, and a typed accessor per flag over any
 * `Evaluator`, the interface the Go SDK's client implements. The output is
 * what gofmt would print, so a `gofmt -l` check in CI stays quiet.
 */
export function generateGo(input: CodegenInput, packageName: string): string {
  if (!goPackageName(packageName)) {
    throw new CliError(
      'codegen_package',
      `"${packageName}" is not a Go package name: use lowercase letters, digits and _`,
    );
  }
  const flags = sorted(input.flags);
  const strings = flags.filter((f) => f.type === 'string' && stringValues(f).length > 0);
  const names: { name: string; what: string }[] = [
    { name: 'Evaluator', what: 'the Evaluator interface' },
    { name: 'Flags', what: 'the Flags type' },
    { name: 'New', what: 'the New function' },
    { name: 'Keys', what: 'the Keys list' },
  ];
  for (const f of flags) names.push({ name: `Key${pascalCase(f.key)}`, what: `flag "${f.key}"` });
  for (const f of strings) {
    const base = pascalCase(f.key);
    names.push({ name: `${base}Value`, what: `the value type of flag "${f.key}"` });
    for (const v of f.variants) {
      if (typeof v.value === 'string') {
        names.push({ name: base + pascalCase(v.key), what: `variant "${v.key}" of "${f.key}"` });
      }
    }
  }
  unique(names);

  const out: string[] = [
    `// Code generated by flagship codegen from project ${goQuote(input.project)}. DO NOT EDIT.`,
    '',
    `// Package ${packageName} has typed accessors for the flags of project ${goQuote(input.project)}.`,
    '// Run flagship codegen again when flags change, and flagship codegen --check in CI.',
    `package ${packageName}`,
    '',
    '// Evaluator evaluates flags for a context of type C. The flagship Go SDK client implements it.',
    'type Evaluator[C any] interface {',
    '\tBoolVariation(flagKey string, context C, fallback bool) bool',
    '\tStringVariation(flagKey string, context C, fallback string) string',
    '\tNumberVariation(flagKey string, context C, fallback float64) float64',
    '\tJSONVariation(flagKey string, context C, fallback any) any',
    '}',
  ];
  if (flags.length > 0) {
    out.push(
      '',
      '// Flag keys.',
      'const (',
      ...goAligned(
        flags.map((f) => [`Key${pascalCase(f.key)}`, `= ${goQuote(f.key)}`]),
        '\t',
      ),
      ')',
      '',
      '// Keys lists every flag key, sorted.',
      'var Keys = []string{',
      ...flags.map((f) => `\tKey${pascalCase(f.key)},`),
      '}',
    );
  } else {
    out.push('', '// Keys lists every flag key, sorted.', 'var Keys = []string{}');
  }
  for (const f of strings) {
    const base = pascalCase(f.key);
    out.push(
      '',
      `// ${base}Value is a value flag ${goQuote(f.key)} serves.`,
      `type ${base}Value string`,
      '',
      `// Values of flag ${goQuote(f.key)}, one per variant.`,
      'const (',
      ...goAligned(
        f.variants.flatMap((v) =>
          typeof v.value === 'string'
            ? [[base + pascalCase(v.key), `${base}Value`, `= ${goQuote(v.value)}`]]
            : [],
        ),
        '\t',
      ),
      ')',
    );
  }
  out.push(
    '',
    '// Flags has one typed accessor per flag.',
    'type Flags[C any] struct {',
    '\tclient Evaluator[C]',
    '}',
    '',
    '// New returns the typed accessors over client.',
    'func New[C any](client Evaluator[C]) Flags[C] {',
    '\treturn Flags[C]{client: client}',
    '}',
  );
  for (const f of flags) {
    const base = pascalCase(f.key);
    const { method, type } = GO_METHOD[f.type];
    const key = `Key${base}`;
    out.push('', ...goDoc(f, base).map((l) => `// ${l}`));
    if (f.type === 'string' && stringValues(f).length > 0) {
      const cases = f.variants
        .filter((v) => typeof v.value === 'string')
        .reduce<{ seen: Set<string>; names: string[] }>(
          (acc, v) => {
            if (!acc.seen.has(v.value as string)) {
              acc.seen.add(v.value as string);
              acc.names.push(base + pascalCase(v.key));
            }
            return acc;
          },
          { seen: new Set(), names: [] },
        ).names;
      out.push(
        `// It returns fallback for any value other than these.`,
        `func (f Flags[C]) ${base}(context C, fallback ${base}Value) ${base}Value {`,
        `\tswitch v := ${base}Value(f.client.StringVariation(${key}, context, string(fallback))); v {`,
        `\tcase ${cases.join(', ')}:`,
        '\t\treturn v',
        '\t}',
        '\treturn fallback',
        '}',
      );
    } else {
      out.push(
        `func (f Flags[C]) ${base}(context C, fallback ${type}) ${type} {`,
        `\treturn f.client.${method}(${key}, context, fallback)`,
        '}',
      );
    }
  }
  out.push('');
  return out.join('\n');
}
