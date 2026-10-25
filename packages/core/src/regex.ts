import { LIMITS } from './model.js';

/**
 * A small regular-expression engine that runs in time linear in the input.
 *
 * Targeting patterns are typed into the admin UI and then executed inside
 * every SDK on every evaluation. JavaScript's RegExp backtracks, so a pattern
 * like `(a+)+$` can pin a CPU for minutes on a 30-character input. Instead of
 * trying to recognise every dangerous pattern, we compile a deliberately
 * limited syntax to a Thompson NFA and simulate it with a Pike VM, the
 * approach RE2 and Rust's regex crate take: cost is O(input x program), with
 * both bounded.
 *
 * Supported: literals, `.`, `^`, `$`, `|`, groups `( )` and `(?: )`, classes
 * `[a-z0-9_]` and `[^...]`, escapes `\d \D \w \W \s \S \t \n \r` and escaped
 * punctuation, quantifiers `* + ? {m} {m,} {m,n}` (lazy `?` suffix accepted,
 * it doesn't change whether a match exists). Not supported: backreferences,
 * lookaround, word boundaries, flags. Matching is a search, like
 * `RegExp.prototype.test`, over Unicode code points.
 */

type CharTest = (cp: number) => boolean;

type Node =
  | { kind: 'char'; test: CharTest }
  | { kind: 'start' }
  | { kind: 'end' }
  | { kind: 'concat'; items: Node[] }
  | { kind: 'alt'; items: Node[] }
  | { kind: 'repeat'; node: Node; min: number; max: number };

type Inst =
  | { op: 'char'; test: CharTest }
  | { op: 'split'; a: number; b: number }
  | { op: 'jmp'; to: number }
  | { op: 'start' }
  | { op: 'end' }
  | { op: 'match' };

export interface CompiledPattern {
  readonly source: string;
  readonly program: readonly Inst[];
}

export class PatternError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(`${message} at position ${position}`);
    this.name = 'PatternError';
  }
}

const MAX_REPEAT = 100;
const MAX_PROGRAM = 4000;

const isDigit: CharTest = (c) => c >= 48 && c <= 57;
const isWord: CharTest = (c) =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
// The same set JavaScript's \s matches.
const SPACES = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
]);
const isSpace: CharTest = (c) => SPACES.has(c) || (c >= 0x2000 && c <= 0x200a);
const isLineTerminator = (c: number) => c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029;
const not =
  (t: CharTest): CharTest =>
  (c) =>
    !t(c);

const PUNCTUATION = new Set<string>('\\^$.|?*+()[]{}/-');

function codePoints(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) out.push(ch.codePointAt(0) ?? 0);
  return out;
}

class Parser {
  private pos = 0;
  private readonly cps: number[];

  constructor(source: string) {
    this.cps = codePoints(source);
  }

  parse(): Node {
    const node = this.alternation();
    // alternation() only stops early at a ")" that has no "(".
    if (this.pos < this.cps.length) throw new PatternError('unmatched ")"', this.pos);
    return node;
  }

  private peek(): number | undefined {
    return this.cps[this.pos];
  }

  private eat(ch: string): boolean {
    if (this.peek() === ch.codePointAt(0)) {
      this.pos++;
      return true;
    }
    return false;
  }

  private alternation(): Node {
    const items = [this.concatenation()];
    while (this.eat('|')) items.push(this.concatenation());
    return items.length === 1 ? (items[0] as Node) : { kind: 'alt', items };
  }

  private concatenation(): Node {
    const items: Node[] = [];
    for (;;) {
      const c = this.peek();
      if (c === undefined || c === 0x7c /* | */ || c === 0x29 /* ) */) break;
      items.push(this.repetition());
    }
    return { kind: 'concat', items };
  }

  private repetition(): Node {
    const atomStart = this.pos;
    let node = this.atom();
    for (;;) {
      const at = this.pos;
      let min: number;
      let max: number;
      if (this.eat('*')) [min, max] = [0, Infinity];
      else if (this.eat('+')) [min, max] = [1, Infinity];
      else if (this.eat('?')) [min, max] = [0, 1];
      else if (this.peek() === 0x7b /* { */) [min, max] = this.braces();
      else return node;
      if (node.kind === 'start' || node.kind === 'end') {
        throw new PatternError('nothing to repeat', atomStart);
      }
      if (node.kind === 'repeat') throw new PatternError('quantifier after quantifier', at);
      this.eat('?');
      node = { kind: 'repeat', node, min, max };
    }
  }

  private braces(): [number, number] {
    const start = this.pos;
    this.pos++;
    const min = this.number();
    let max = min;
    if (this.eat(',')) max = this.peek() === 0x7d ? Infinity : this.number();
    if (!this.eat('}')) throw new PatternError('expected "}"', this.pos);
    if (max < min) throw new PatternError('repeat range is backwards', start);
    if (min > MAX_REPEAT || (max !== Infinity && max > MAX_REPEAT)) {
      throw new PatternError(`repeat counts are limited to ${MAX_REPEAT}`, start);
    }
    return [min, max];
  }

  private number(): number {
    const start = this.pos;
    let n = 0;
    while (this.peek() !== undefined && isDigit(this.peek() ?? 0)) {
      n = n * 10 + ((this.peek() ?? 48) - 48);
      this.pos++;
      if (n > 1_000_000) throw new PatternError('number too large', start);
    }
    if (this.pos === start) throw new PatternError('expected a number', start);
    return n;
  }

  private atom(): Node {
    const start = this.pos;
    const c = this.peek();
    if (c === undefined) throw new PatternError('unexpected end of pattern', start);
    const ch = String.fromCodePoint(c);
    this.pos++;
    switch (ch) {
      case '(': {
        if (this.eat('?')) {
          if (!this.eat(':')) {
            throw new PatternError('lookaround and named groups are not supported', start);
          }
        }
        const inner = this.alternation();
        if (!this.eat(')')) throw new PatternError('missing ")"', start);
        // Wrapped so that `(?:a*)*` reads as a repeated group, not a double quantifier.
        return { kind: 'concat', items: [inner] };
      }
      case '[':
        return { kind: 'char', test: this.charClass(start) };
      case '.':
        return { kind: 'char', test: not(isLineTerminator) };
      case '^':
        return { kind: 'start' };
      case '$':
        return { kind: 'end' };
      case '\\':
        return { kind: 'char', test: this.escape(start, false) };
      case '*':
      case '+':
      case '?':
      case '{':
        throw new PatternError('nothing to repeat', start);
      case ']':
      case '}':
        throw new PatternError(`unescaped "${ch}"`, start);
      default:
        return { kind: 'char', test: (x) => x === c };
    }
  }

  private escape(start: number, inClass: boolean): CharTest {
    const c = this.peek();
    if (c === undefined) throw new PatternError('pattern ends with "\\"', start);
    this.pos++;
    const ch = String.fromCodePoint(c);
    switch (ch) {
      case 'd':
        return isDigit;
      case 'D':
        return not(isDigit);
      case 'w':
        return isWord;
      case 'W':
        return not(isWord);
      case 's':
        return isSpace;
      case 'S':
        return not(isSpace);
      case 't':
        return (x) => x === 0x09;
      case 'n':
        return (x) => x === 0x0a;
      case 'r':
        return (x) => x === 0x0d;
      default:
        if (PUNCTUATION.has(ch)) return (x) => x === c;
        throw new PatternError(
          inClass || !isDigit(c)
            ? `unsupported escape "\\${ch}"`
            : 'backreferences are not supported',
          start,
        );
    }
  }

  private classAtom(): { test: CharTest; cp: number | undefined } {
    const start = this.pos;
    const c = this.peek();
    if (c === undefined) throw new PatternError('missing "]"', start);
    this.pos++;
    if (c === 0x5c /* \ */) {
      const next = this.peek();
      const test = this.escape(start, true);
      const name = String.fromCodePoint(next ?? 0);
      // Only escapes that stand for one character can be range ends; \d and friends can't.
      let cp: number | undefined;
      if (PUNCTUATION.has(name)) cp = next;
      else if (name === 't') cp = 0x09;
      else if (name === 'n') cp = 0x0a;
      else if (name === 'r') cp = 0x0d;
      return { test, cp };
    }
    return { test: (x) => x === c, cp: c };
  }

  private charClass(start: number): CharTest {
    const negated = this.eat('^');
    const parts: CharTest[] = [];
    let first = true;
    while (first || this.peek() !== 0x5d /* ] */) {
      if (this.peek() === undefined) throw new PatternError('missing "]"', start);
      if (first && this.peek() === 0x5d) throw new PatternError('empty character class', start);
      first = false;
      const lo = this.classAtom();
      if (this.peek() === 0x2d /* - */ && this.cps[this.pos + 1] !== 0x5d) {
        this.pos++;
        const at = this.pos;
        const hi = this.classAtom();
        if (lo.cp === undefined || hi.cp === undefined) {
          throw new PatternError('a range needs single characters at both ends', at);
        }
        if (hi.cp < lo.cp) throw new PatternError('range out of order', at);
        const [a, b] = [lo.cp, hi.cp];
        parts.push((x) => x >= a && x <= b);
      } else {
        parts.push(lo.test);
      }
    }
    this.pos++;
    const test: CharTest = (x) => parts.some((p) => p(x));
    return negated ? not(test) : test;
  }
}

class Compiler {
  readonly program: Inst[] = [];

  private emit(inst: Inst): number {
    if (this.program.length >= MAX_PROGRAM) {
      throw new PatternError('pattern is too complex', 0);
    }
    this.program.push(inst);
    return this.program.length - 1;
  }

  private patch(at: number, inst: Inst): void {
    this.program[at] = inst;
  }

  compile(node: Node): void {
    switch (node.kind) {
      case 'char':
        this.emit({ op: 'char', test: node.test });
        return;
      case 'start':
        this.emit({ op: 'start' });
        return;
      case 'end':
        this.emit({ op: 'end' });
        return;
      case 'concat':
        for (const item of node.items) this.compile(item);
        return;
      case 'alt': {
        const jumps: number[] = [];
        node.items.forEach((item, i) => {
          if (i === node.items.length - 1) {
            this.compile(item);
            return;
          }
          const split = this.emit({ op: 'jmp', to: -1 });
          this.compile(item);
          jumps.push(this.emit({ op: 'jmp', to: -1 }));
          this.patch(split, { op: 'split', a: split + 1, b: this.program.length });
        });
        for (const j of jumps) this.patch(j, { op: 'jmp', to: this.program.length });
        return;
      }
      case 'repeat': {
        for (let i = 0; i < node.min; i++) this.compile(node.node);
        if (node.max === Infinity) {
          const split = this.emit({ op: 'jmp', to: -1 });
          this.compile(node.node);
          this.emit({ op: 'jmp', to: split });
          this.patch(split, { op: 'split', a: split + 1, b: this.program.length });
          return;
        }
        const splits: number[] = [];
        for (let i = node.min; i < node.max; i++) {
          splits.push(this.emit({ op: 'jmp', to: -1 }));
          this.compile(node.node);
        }
        for (const s of splits) this.patch(s, { op: 'split', a: s + 1, b: this.program.length });
        return;
      }
    }
  }
}

/** Compiles a pattern or throws PatternError with the position of the problem. */
export function compilePattern(source: string): CompiledPattern {
  if (source.length > LIMITS.regexPatternLength) {
    throw new PatternError(
      `patterns are limited to ${LIMITS.regexPatternLength} characters`,
      LIMITS.regexPatternLength,
    );
  }
  const ast = new Parser(source).parse();
  const compiler = new Compiler();
  compiler.compile(ast);
  compiler.program.push({ op: 'match' });
  return { source, program: compiler.program };
}

/** Returns a description of what is wrong with the pattern, or undefined if it is usable. */
export function patternProblem(source: string): string | undefined {
  try {
    compilePattern(source);
    return undefined;
  } catch (err) {
    if (err instanceof PatternError) return err.message;
    throw err;
  }
}

/**
 * Searches `input` for a match. Inputs longer than LIMITS.regexInputLength
 * UTF-16 units never match, which keeps the worst case at roughly
 * 1,024 x 4,000 steps.
 */
export function search(pattern: CompiledPattern, input: string): boolean {
  if (input.length > LIMITS.regexInputLength) return false;
  const prog = pattern.program;
  const cps = codePoints(input);
  const n = cps.length;
  let current: number[] = [];
  let next: number[] = [];
  const mark = new Int32Array(prog.length).fill(-1);
  let generation = 0;

  // Epsilon closure from pc at position i; returns true if Match is reachable.
  const add = (list: number[], pc: number, i: number): boolean => {
    const stack = [pc];
    let matched = false;
    while (stack.length > 0) {
      const p = stack.pop() ?? 0;
      if (mark[p] === generation) continue;
      mark[p] = generation;
      const inst = prog[p];
      if (inst === undefined) continue;
      switch (inst.op) {
        case 'jmp':
          stack.push(inst.to);
          break;
        case 'split':
          stack.push(inst.b, inst.a);
          break;
        case 'start':
          if (i === 0) stack.push(p + 1);
          break;
        case 'end':
          if (i === n) stack.push(p + 1);
          break;
        case 'match':
          matched = true;
          break;
        case 'char':
          list.push(p);
          break;
      }
    }
    return matched;
  };

  for (let i = 0; i <= n; i++) {
    // Unanchored search: a new thread starts at every position.
    if (add(current, 0, i)) return true;
    if (i === n) break;
    const cp = cps[i] ?? 0;
    generation++;
    next.length = 0;
    for (const pc of current) {
      const inst = prog[pc];
      if (inst?.op === 'char' && inst.test(cp) && add(next, pc + 1, i + 1)) return true;
    }
    // The next round adds its start thread under the same generation, so it
    // can't duplicate a thread that is already in the list.
    [current, next] = [next, current];
  }
  return false;
}

const cache = new Map<string, CompiledPattern | null>();
const CACHE_LIMIT = 1000;

/**
 * Cached compile-and-search used by the evaluator. A pattern that fails to
 * compile never matches; validation keeps such patterns out of stored rules.
 */
export function matchesPattern(source: string, input: string): boolean {
  let compiled = cache.get(source);
  if (compiled === undefined) {
    try {
      compiled = compilePattern(source);
    } catch (err) {
      if (!(err instanceof PatternError)) throw err;
      compiled = null;
    }
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(source, compiled);
  }
  return compiled !== null && search(compiled, input);
}
