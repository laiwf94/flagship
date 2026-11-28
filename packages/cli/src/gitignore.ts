/**
 * .gitignore matching as git does it, for walking a tree without spawning
 * git: patterns from each directory's .gitignore apply below it, a deeper
 * file overrides a shallower one, the last matching pattern wins, and `!`
 * re-includes, except under a directory that is itself ignored (the walker
 * never enters one). See gitignore(5).
 */

export interface IgnoreRule {
  /** Matched against the path relative to the .gitignore's directory, or the name alone. */
  regex: RegExp;
  negate: boolean;
  /** A trailing slash: matches directories only. */
  dirOnly: boolean;
  /** No slash except a trailing one: matched against the name at any depth. */
  basename: boolean;
}

/** The rules of one .gitignore (or exclude file), for paths under `base`. */
export interface IgnoreFile {
  /** The directory it applies to, relative to the root, with forward slashes; "" is the root. */
  base: string;
  rules: IgnoreRule[];
}

/** One glob segment (no slashes) as a regular expression source. */
function segmentSource(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === '\\') {
      i++;
      out += i < glob.length ? escapeChar(glob.charAt(i)) : '\\\\';
    } else if (c === '*') {
      out += '[^/]*';
      while (glob[i + 1] === '*') i++;
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '[') {
      const end = classEnd(glob, i);
      if (end === -1) {
        out += '\\[';
        continue;
      }
      out += classSource(glob.slice(i + 1, end));
      i = end;
    } else {
      out += escapeChar(c);
    }
  }
  return out;
}

function escapeChar(c: string): string {
  return /[\\^$.*+?()[\]{}|/-]/.test(c) ? `\\${c}` : c;
}

const POSIX_CLASSES: Record<string, string> = {
  alnum: 'A-Za-z0-9',
  alpha: 'A-Za-z',
  blank: ' \\t',
  digit: '0-9',
  lower: 'a-z',
  punct: '!-\\/:-@\\[-`{-~',
  space: ' \\t\\n\\r\\f\\v',
  upper: 'A-Z',
  xdigit: '0-9A-Fa-f',
};

/** The index of the `]` closing a bracket expression at `start`, or -1. */
function classEnd(glob: string, start: number): number {
  let i = start + 1;
  if (glob[i] === '!' || glob[i] === '^') i++;
  // A `]` first in the class is a literal.
  if (glob[i] === ']') i++;
  for (; i < glob.length; i++) {
    if (glob[i] === '\\') i++;
    else if (glob.startsWith('[:', i)) {
      const close = glob.indexOf(':]', i + 2);
      if (close !== -1) i = close + 1;
    } else if (glob[i] === ']') return i;
  }
  return -1;
}

function classSource(body: string): string {
  let i = 0;
  let out = '[';
  if (body[0] === '!' || body[0] === '^') {
    out += '^/';
    i = 1;
  }
  const first = i;
  for (; i < body.length; i++) {
    const c = body.charAt(i);
    if (c === '\\' && i + 1 < body.length) {
      i++;
      out += `\\${body.charAt(i)}`;
    } else if (body.startsWith('[:', i) && body.indexOf(':]', i + 2) !== -1) {
      const close = body.indexOf(':]', i + 2);
      out += POSIX_CLASSES[body.slice(i + 2, close)] ?? '';
      i = close + 1;
    } else if (c === '-') {
      // Literal at either end; a range otherwise.
      out += i === first || i === body.length - 1 ? '\\-' : '-';
    } else {
      out += /[\\\]^[]/.test(c) ? `\\${c}` : c;
    }
  }
  return `${out}]`;
}

/** Turns one line of a .gitignore into a rule, or null for blanks and comments. */
export function parseIgnoreLine(raw: string): IgnoreRule | null {
  let line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  // Trailing spaces are dropped unless escaped with a backslash.
  let end = line.length;
  while (end > 0 && line[end - 1] === ' ' && line[end - 2] !== '\\') end--;
  line = line.slice(0, end);
  if (line === '' || line.startsWith('#')) return null;
  let negate = false;
  if (line.startsWith('!')) {
    negate = true;
    line = line.slice(1);
  } else if (line.startsWith('\\!') || line.startsWith('\\#')) {
    line = line.slice(1);
  }
  let dirOnly = false;
  if (line.endsWith('/') && !line.endsWith('\\/')) {
    dirOnly = true;
    line = line.replace(/\/+$/, '');
  }
  if (line === '') return null;
  const basename = !line.includes('/');
  if (line.startsWith('/')) line = line.slice(1);

  if (basename) {
    return { regex: new RegExp(`^${segmentSource(line)}$`), negate, dirOnly, basename };
  }
  const parts = line.split('/');
  let source = '';
  for (const [i, part] of parts.entries()) {
    const last = i === parts.length - 1;
    if (part === '**') {
      if (i === 0) source += '(?:.*/)?';
      else if (last) source += '/.*';
      else source += '(?:/.*)?';
      continue;
    }
    if (i > 0 && !(i === 1 && parts[0] === '**')) source += '/';
    source += segmentSource(part);
  }
  return { regex: new RegExp(`^${source}$`, 's'), negate, dirOnly, basename };
}

export function parseIgnoreFile(text: string, base: string): IgnoreFile {
  const rules: IgnoreRule[] = [];
  for (const line of text.split('\n')) {
    const rule = parseIgnoreLine(line);
    if (rule !== null) rules.push(rule);
  }
  return { base, rules };
}

/**
 * Whether a path (relative to the root, forward slashes) is ignored, given
 * the ignore files that apply to it from the root down. The last rule that
 * matches decides; deeper files come later, so they win.
 */
export function isIgnored(files: readonly IgnoreFile[], path: string, isDir: boolean): boolean {
  const slash = path.lastIndexOf('/');
  const name = slash === -1 ? path : path.slice(slash + 1);
  for (let f = files.length - 1; f >= 0; f--) {
    const file = files[f];
    if (file === undefined) continue;
    let rel: string;
    if (file.base === '') rel = path;
    else if (path.startsWith(`${file.base}/`)) rel = path.slice(file.base.length + 1);
    else continue;
    for (let r = file.rules.length - 1; r >= 0; r--) {
      const rule = file.rules[r];
      if (rule === undefined) continue;
      if (rule.dirOnly && !isDir) continue;
      if (rule.regex.test(rule.basename ? name : rel)) return !rule.negate;
    }
  }
  return false;
}
