/**
 * A strict YAML subset for flags-as-code files: block mappings and sequences,
 * flow collections on one line, plain, single- and double-quoted scalars,
 * literal and folded block scalars, and comments. Scalars resolve as in the
 * YAML 1.2 JSON schema, so `yes`, `on` and `off` stay strings. Anchors,
 * aliases, tags, directives, complex keys, multi-line flow collections,
 * multi-line plain scalars and more than one document are refused with the
 * line they appear on, rather than half-supported.
 */

export type YamlValue = null | boolean | number | string | YamlValue[] | { [k: string]: YamlValue };

export class YamlError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(`line ${line}, column ${column}: ${message}`);
    this.name = 'YamlError';
  }
}

export interface YamlDocument {
  value: YamlValue;
  /**
   * The line a value starts on, by its path as `formatPath` writes it
   * (`flags.checkout.rules[1].serve`). A path with no entry of its own (a
   * default the file left out) gets its nearest ancestor's line.
   */
  lineOf: (path: string) => number;
}

interface Line {
  /** 1-based line number. */
  no: number;
  /** The raw text, without the line break. */
  raw: string;
  /** Leading spaces. */
  indent: number;
  /** Content after the indent with any comment removed and trailing spaces trimmed; '' when blank. */
  text: string;
}

const NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?$/;
const INDICATORS = new Set(['&', '*', '!', '|', '>', '%', '@', '`', '?']);
const FLOW_END = new Set([',', ']', '}']);
/** How deep collections may nest; parsing recurses, so this keeps a hostile file from overflowing the stack. */
const MAX_DEPTH = 64;

/** Resolves a plain scalar as the YAML 1.2 JSON schema does, with `~` and empty as null. */
function resolvePlain(s: string): YamlValue {
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (s === 'true' || s === 'True' || s === 'TRUE') return true;
  if (s === 'false' || s === 'False' || s === 'FALSE') return false;
  if (NUMBER.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  return s;
}

/** Where a comment starts in `s`, outside quotes: a `#` at the start or after whitespace. */
function commentStart(s: string): number {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === '"') {
      if (c === '\\') i++;
      else if (c === '"') quote = null;
    } else if (quote === "'") {
      if (c === "'") {
        if (s[i + 1] === "'") i++;
        else quote = null;
      }
    } else if (c === '#' && (i === 0 || s[i - 1] === ' ' || s[i - 1] === '\t')) {
      return i;
    } else if ((c === '"' || c === "'") && (i === 0 || /[\s[{,:-]/.test(s[i - 1] ?? ''))) {
      quote = c;
    }
  }
  return -1;
}

function splitLines(text: string): Line[] {
  const raws = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  return raws.map((raw, i) => {
    let indent = 0;
    while (raw[indent] === ' ') indent++;
    const rest = raw.slice(indent);
    const cut = commentStart(rest);
    const body = (cut === -1 ? rest : rest.slice(0, cut)).replace(/[ \t]+$/, '');
    return { no: i + 1, raw, indent, text: body };
  });
}

/** Sets a key without ever touching the prototype, so a `__proto__` key is just data. */
function put(out: Record<string, YamlValue>, key: string, value: YamlValue): void {
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
}

function joinPath(path: string, part: string | number): string {
  if (typeof part === 'number') return `${path}[${part}]`;
  return path === '' ? part : `${path}.${part}`;
}

function parentPath(path: string): string | undefined {
  if (path === '') return undefined;
  const bracket = path.lastIndexOf('[');
  const dot = path.lastIndexOf('.');
  const cut = Math.max(bracket, dot);
  return cut <= 0 ? '' : path.slice(0, cut);
}

/** A cursor over one line's text, for keys, quoted scalars and flow collections. */
class Inline {
  pos = 0;
  depth = 0;
  constructor(
    readonly s: string,
    readonly line: number,
    /** Column of s[0], 1-based. */
    readonly column: number,
    readonly lines: Map<string, number>,
  ) {}

  fail(message: string, at = this.pos): never {
    throw new YamlError(message, this.line, this.column + at);
  }

  atEnd(): boolean {
    return this.pos >= this.s.length;
  }

  peek(): string {
    return this.s[this.pos] ?? '';
  }

  spaces(): void {
    while (this.s[this.pos] === ' ' || this.s[this.pos] === '\t') this.pos++;
  }

  doubleQuoted(): string {
    const start = this.pos;
    this.pos++;
    let out = '';
    for (;;) {
      if (this.atEnd()) this.fail('a double-quoted string must close on the same line', start);
      const c = this.s[this.pos++] ?? '';
      if (c === '"') return out;
      if (c !== '\\') {
        out += c;
        continue;
      }
      const e = this.s[this.pos++] ?? '';
      const simple: Record<string, string> = {
        '"': '"',
        '\\': '\\',
        '/': '/',
        b: '\b',
        f: '\f',
        n: '\n',
        r: '\r',
        t: '\t',
        '0': '\0',
        ' ': ' ',
      };
      if (Object.hasOwn(simple, e)) {
        out += simple[e] ?? '';
      } else if (e === 'u' || e === 'x' || e === 'U') {
        const width = e === 'x' ? 2 : e === 'u' ? 4 : 8;
        const hex = this.s.slice(this.pos, this.pos + width);
        if (!new RegExp(`^[0-9A-Fa-f]{${width}}$`).test(hex)) {
          this.fail(`\\${e} needs ${width} hex digits`, this.pos - 2);
        }
        const code = Number.parseInt(hex, 16);
        if (code > 0x10ffff) this.fail(`\\${e}${hex} is not a Unicode code point`, this.pos - 2);
        out += String.fromCodePoint(code);
        this.pos += width;
      } else {
        this.fail(`unknown escape "\\${e}"`, this.pos - 2);
      }
    }
  }

  singleQuoted(): string {
    const start = this.pos;
    this.pos++;
    let out = '';
    for (;;) {
      if (this.atEnd()) this.fail('a single-quoted string must close on the same line', start);
      const c = this.s[this.pos++] ?? '';
      if (c === "'") {
        if (this.s[this.pos] === "'") {
          out += "'";
          this.pos++;
          continue;
        }
        return out;
      }
      out += c;
    }
  }

  /** A plain scalar up to the end, or inside a flow collection up to `,`, `]`, `}` or `: `. */
  plain(inFlow: boolean): string {
    const start = this.pos;
    const first = this.peek();
    if (INDICATORS.has(first)) {
      const what: Record<string, string> = {
        '&': 'anchors',
        '*': 'aliases',
        '!': 'tags',
        '|': 'block scalars here',
        '>': 'block scalars here',
        '%': 'directives',
        '@': '"@" at the start of a plain value',
        '`': '"`" at the start of a plain value',
        '?': 'complex keys',
      };
      this.fail(`${what[first] ?? first} are not supported; quote the value if it is text`);
    }
    if (first === '-' && (this.s[this.pos + 1] === ' ' || this.pos + 1 === this.s.length)) {
      this.fail('a list item can not start here; put it on its own line');
    }
    while (!this.atEnd()) {
      const c = this.peek();
      if (inFlow && FLOW_END.has(c)) break;
      if (
        c === ':' &&
        (this.pos + 1 === this.s.length || /[\s,\]}]/.test(this.s[this.pos + 1] ?? ''))
      ) {
        if (inFlow) break;
        this.fail(
          'a key: value pair can not be a value on the same line; nest it on the next line',
        );
      }
      if (inFlow && (c === '[' || c === '{')) this.fail(`"${c}" inside a plain value; quote it`);
      this.pos++;
    }
    return this.s.slice(start, this.pos).replace(/[ \t]+$/, '');
  }

  /** Any value: flow collection, quoted or plain scalar. */
  value(path: string, inFlow: boolean): YamlValue {
    this.lines.set(path, this.line);
    const c = this.peek();
    if (c === '[') return this.flowSequence(path);
    if (c === '{') return this.flowMapping(path);
    if (c === '"') return this.doubleQuoted();
    if (c === "'") return this.singleQuoted();
    return resolvePlain(this.plain(inFlow));
  }

  flowSequence(path: string): YamlValue[] {
    const start = this.pos;
    this.enter(start);
    try {
      return this.flowItems(path, start);
    } finally {
      this.depth--;
    }
  }

  private enter(at: number): void {
    if (++this.depth > MAX_DEPTH) this.fail(`nesting is deeper than ${MAX_DEPTH} levels`, at);
  }

  private flowItems(path: string, start: number): YamlValue[] {
    this.pos++;
    const out: YamlValue[] = [];
    for (;;) {
      this.spaces();
      if (this.atEnd()) this.fail('a [ list ] must close on the same line', start);
      if (this.peek() === ']') {
        this.pos++;
        return out;
      }
      if (out.length > 0) {
        if (this.peek() !== ',') this.fail('expected "," or "]"');
        this.pos++;
        this.spaces();
        if (this.peek() === ']') {
          this.pos++;
          return out;
        }
      }
      if (this.peek() === ',') this.fail('empty entry in a [ list ]');
      out.push(this.value(joinPath(path, out.length), true));
    }
  }

  flowKey(): string {
    const c = this.peek();
    if (c === '"') return this.doubleQuoted();
    if (c === "'") return this.singleQuoted();
    const key = this.plain(true);
    if (key === '') this.fail('expected a key');
    return key;
  }

  flowMapping(path: string): Record<string, YamlValue> {
    const start = this.pos;
    this.enter(start);
    try {
      return this.flowEntries(path, start);
    } finally {
      this.depth--;
    }
  }

  private flowEntries(path: string, start: number): Record<string, YamlValue> {
    this.pos++;
    const out: Record<string, YamlValue> = {};
    let first = true;
    for (;;) {
      this.spaces();
      if (this.atEnd()) this.fail('a { mapping } must close on the same line', start);
      if (this.peek() === '}') {
        this.pos++;
        return out;
      }
      if (!first) {
        if (this.peek() !== ',') this.fail('expected "," or "}"');
        this.pos++;
        this.spaces();
        if (this.peek() === '}') {
          this.pos++;
          return out;
        }
      }
      first = false;
      const keyAt = this.pos;
      const key = this.flowKey();
      this.spaces();
      if (this.peek() !== ':') this.fail(`expected ":" after key "${key}"`);
      this.pos++;
      this.spaces();
      if (Object.hasOwn(out, key)) this.fail(`duplicate key "${key}"`, keyAt);
      const child = joinPath(path, key);
      if (this.atEnd() || this.peek() === ',' || this.peek() === '}') {
        this.lines.set(child, this.line);
        put(out, key, null);
      } else {
        put(out, key, this.value(child, true));
      }
    }
  }
}

/** The key of a `key: value` line and where its value starts, or undefined when the line is not one. */
function mappingKey(
  line: Line,
  lines: Map<string, number>,
): { key: string; rest: string; restColumn: number } | undefined {
  const s = line.text;
  const c = s[0];
  if (c === '[' || c === '{' || (c === '-' && (s[1] === ' ' || s.length === 1))) return undefined;
  const cur = new Inline(s, line.no, line.indent + 1, lines);
  let key: string;
  if (c === '"' || c === "'") {
    key = c === '"' ? cur.doubleQuoted() : cur.singleQuoted();
    cur.spaces();
    if (cur.peek() !== ':') return undefined;
  } else {
    const at = /:(?=\s|$)/.exec(s);
    if (at === null) return undefined;
    key = s.slice(0, at.index).replace(/[ \t]+$/, '');
    if (key === '') cur.fail('expected a key before ":"');
    if (key === '<<') cur.fail('merge keys are not supported');
    if (INDICATORS.has(key[0] ?? '')) {
      cur.pos = 0;
      cur.plain(false);
    }
    cur.pos = at.index;
  }
  cur.pos++;
  cur.spaces();
  return { key, rest: s.slice(cur.pos), restColumn: line.indent + 1 + cur.pos };
}

/** A `---` or `...` line, which ends any block before it. */
function isMarker(line: Line): boolean {
  return line.indent === 0 && (line.text === '...' || /^---(\s|$)/.test(line.text));
}

class Parser {
  i = 0;
  depth = 0;
  readonly paths = new Map<string, number>();

  constructor(readonly lines: Line[]) {}

  /** The next line with content, skipping blank and comment-only lines. */
  peek(): Line | undefined {
    while (this.i < this.lines.length && this.lines[this.i]?.text === '') this.i++;
    return this.lines[this.i];
  }

  fail(message: string, line: Line, column = line.indent + 1): never {
    throw new YamlError(message, line.no, column);
  }

  document(): YamlValue {
    let first = this.peek();
    if (first?.text.startsWith('%')) this.fail('directives are not supported', first);
    if (first !== undefined && first.indent === 0 && /^---(\s|$)/.test(first.text)) {
      if (first.text !== '---') this.fail('put the document on the line after ---', first, 5);
      this.i++;
      first = this.peek();
    }
    if (first === undefined) return null;
    if (first.indent !== 0) this.fail('the document must start at column 1', first);
    const value = this.block(0, '');
    const extra = this.peek();
    if (extra !== undefined) {
      if (extra.indent === 0 && extra.text === '...') {
        this.i++;
        const after = this.peek();
        if (after !== undefined) this.fail('only one document per file', after);
      } else if (extra.indent === 0 && /^---(\s|$)/.test(extra.text)) {
        this.fail('only one document per file', extra);
      } else {
        this.fail(
          extra.indent > 0 ? 'unexpected indentation' : 'unexpected content after the document',
          extra,
        );
      }
    }
    return value;
  }

  /** The node at the current line, which is at `indent`. */
  block(indent: number, path: string): YamlValue {
    const line = this.peek();
    if (line === undefined || isMarker(line)) return null;
    if (++this.depth > MAX_DEPTH) {
      this.fail(`nesting is deeper than ${MAX_DEPTH} levels`, line);
    }
    try {
      return this.node(line, indent, path);
    } finally {
      this.depth--;
    }
  }

  private node(line: Line, indent: number, path: string): YamlValue {
    this.checkIndent(line);
    if (line.text === '-' || line.text.startsWith('- ')) return this.sequence(indent, path);
    if (mappingKey(line, this.paths) !== undefined) return this.mapping(indent, path);
    return this.scalarLine(line, line.text, line.indent + 1, path);
  }

  checkIndent(line: Line): void {
    if (/^ *\t/.test(line.raw) && line.text !== '') {
      this.fail('indent with spaces, not tabs', line, line.raw.indexOf('\t') + 1);
    }
  }

  /** A value written on one line: a flow collection or a scalar. */
  scalarLine(line: Line, text: string, column: number, path: string): YamlValue {
    const cur = new Inline(text, line.no, column, this.paths);
    const value = cur.value(path, false);
    cur.spaces();
    if (!cur.atEnd()) cur.fail('unexpected text after the value');
    this.i++;
    const next = this.peek();
    if (next !== undefined && next.indent > line.indent && next.no === line.no + 1) {
      this.fail('a value can not continue on the next line; quote it or use a | block', next);
    }
    return value;
  }

  mapping(indent: number, path: string): Record<string, YamlValue> {
    const out: Record<string, YamlValue> = {};
    for (;;) {
      const line = this.peek();
      if (line === undefined || line.indent < indent || isMarker(line)) return out;
      this.checkIndent(line);
      if (line.indent > indent) this.fail('unexpected indentation', line);
      const entry = mappingKey(line, this.paths);
      if (entry === undefined) {
        if (line.text === '-' || line.text.startsWith('- ')) {
          this.fail('a list item where a key was expected', line);
        }
        this.fail('expected "key: value"', line);
      }
      const { key, rest, restColumn } = entry;
      if (Object.hasOwn(out, key)) this.fail(`duplicate key "${key}"`, line);
      const child = joinPath(path, key);
      this.paths.set(child, line.no);
      put(out, key, this.value(line, indent, rest, restColumn, child));
    }
  }

  sequence(indent: number, path: string): YamlValue[] {
    const out: YamlValue[] = [];
    for (;;) {
      const line = this.peek();
      if (line === undefined || line.indent < indent || isMarker(line)) return out;
      this.checkIndent(line);
      if (line.indent > indent) this.fail('unexpected indentation', line);
      if (line.text !== '-' && !line.text.startsWith('- ')) return out;
      const child = joinPath(path, out.length);
      this.paths.set(child, line.no);
      let offset = 1;
      while (line.text[offset] === ' ') offset++;
      const rest = line.text.slice(offset);
      const column = line.indent + offset + 1;
      if (rest === '' || rest.startsWith('|') || rest.startsWith('>')) {
        out.push(this.value(line, indent, rest, column, child));
      } else if (
        rest === '-' ||
        rest.startsWith('- ') ||
        mappingKey({ ...line, indent: column - 1, text: rest }, this.paths)
      ) {
        // A compact nested node: read the rest of this line as if it started a
        // line of its own at its column.
        line.indent = column - 1;
        line.text = rest;
        out.push(this.block(line.indent, child));
      } else {
        out.push(this.scalarLine(line, rest, column, child));
      }
    }
  }

  /** The value after `key:` or `-`: inline on the line, a block scalar, or a nested block. */
  value(line: Line, indent: number, rest: string, column: number, path: string): YamlValue {
    if (rest.startsWith('|') || rest.startsWith('>'))
      return this.blockScalar(line, indent, rest, column);
    if (rest !== '') return this.scalarLine(line, rest, column, path);
    this.i++;
    const next = this.peek();
    if (next === undefined) return null;
    if (next.indent > indent) return this.block(next.indent, path);
    // YAML lets a list sit at the same indentation as its key.
    if (next.indent === indent && (next.text === '-' || next.text.startsWith('- '))) {
      const parentIsKey = !path.endsWith(']');
      if (parentIsKey) return this.sequence(indent, path);
    }
    return null;
  }

  blockScalar(line: Line, indent: number, header: string, column: number): string {
    const m = /^([|>])([-+]?)$/.exec(header);
    if (m === null) {
      this.fail(
        /^[|>][-+]?[1-9]/.test(header)
          ? 'explicit block indentation is not supported'
          : `expected "|" or ">" with an optional "-" or "+", not "${header}"`,
        line,
        column,
      );
    }
    const literal = m[1] === '|';
    const chomp = m[2];
    this.i++;
    const body: string[] = [];
    let contentIndent = -1;
    let j = this.i;
    for (; j < this.lines.length; j++) {
      const l = this.lines[j];
      if (l === undefined) break;
      const blank = l.raw.trim() === '';
      if (blank) {
        body.push('');
        continue;
      }
      if (/^ *\t/.test(l.raw))
        this.fail('indent with spaces, not tabs', l, l.raw.indexOf('\t') + 1);
      if (contentIndent === -1) {
        if (l.indent <= indent) break;
        contentIndent = l.indent;
      }
      if (l.indent < contentIndent) break;
      body.push(l.raw.slice(contentIndent));
    }
    this.i = j;
    // Trailing blank lines are kept only by the "+" chomping indicator.
    let end = body.length;
    while (end > 0 && body[end - 1] === '') end--;
    const trailing = body.length - end;
    const content = body.slice(0, end);
    let text: string;
    if (literal) {
      text = content.join('\n');
    } else {
      text = '';
      for (let k = 0; k < content.length; k++) {
        const cur = content[k] ?? '';
        if (k === 0) {
          text = cur;
          continue;
        }
        const prev = content[k - 1] ?? '';
        const indented = cur.startsWith(' ') || prev.startsWith(' ');
        if (cur === '') text += '\n';
        else if (prev === '' || indented) text += (prev === '' ? '' : '\n') + cur;
        else text += ` ${cur}`;
      }
    }
    if (content.length === 0) return chomp === '+' ? '\n'.repeat(trailing) : '';
    if (chomp === '-') return text;
    if (chomp === '+') return `${text}\n${'\n'.repeat(trailing)}`;
    return `${text}\n`;
  }
}

/** Parses one YAML document of the supported subset, or throws a YamlError naming the line. */
export function parseYaml(text: string): YamlDocument {
  const parser = new Parser(splitLines(text));
  const value = parser.document();
  const paths = parser.paths;
  return {
    value,
    lineOf(path: string): number {
      let p: string | undefined = path;
      while (p !== undefined) {
        const line = paths.get(p);
        if (line !== undefined) return line;
        p = parentPath(p);
      }
      return 1;
    },
  };
}

const PLAIN_SAFE = /^[A-Za-z_./][A-Za-z0-9_ ./()-]*$/;

function scalar(v: string | number | boolean | null): string {
  if (v === null) return 'null';
  if (typeof v !== 'string') return JSON.stringify(v);
  if (PLAIN_SAFE.test(v) && !v.endsWith(' ') && resolvePlain(v) === v && !/ #|: /.test(v)) {
    return v;
  }
  return JSON.stringify(v);
}

function key(k: string): string {
  return PLAIN_SAFE.test(k) && !k.endsWith(' ') && !k.includes(' ') ? k : JSON.stringify(k);
}

function emit(value: YamlValue, indent: string, out: string[], prefix: string): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push(`${prefix}[]`);
      return;
    }
    if (prefix !== '') out.push(prefix.replace(/ $/, ''));
    for (const item of value) emitItem(item, indent, out);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      out.push(`${prefix}{}`);
      return;
    }
    if (prefix !== '') out.push(prefix.replace(/ $/, ''));
    for (const [k, v] of entries) emit(v, `${indent}  `, out, `${indent}${key(k)}: `);
    return;
  }
  out.push(`${prefix}${scalar(value)}`);
}

function emitItem(item: YamlValue, indent: string, out: string[]): void {
  const inner = `${indent}  `;
  if (Array.isArray(item) && item.length > 0) {
    out.push(`${indent}-`);
    for (const x of item) emitItem(x, inner, out);
    return;
  }
  if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
    const entries = Object.entries(item);
    if (entries.length > 0) {
      entries.forEach(([k, v], n) => {
        emit(v, `${inner}  `, out, `${n === 0 ? `${indent}- ` : inner}${key(k)}: `);
      });
      return;
    }
  }
  emit(item, inner, out, `${indent}- `);
}

/**
 * Writes JSON-compatible data as block YAML that `parseYaml` reads back to
 * the same value. Strings that could read as anything else are double-quoted.
 */
export function stringifyYaml(value: YamlValue): string {
  const out: string[] = [];
  emit(value, '', out, '');
  return `${out.join('\n')}\n`;
}
