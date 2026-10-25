export interface DiffEntry {
  /** Dotted path, `rules[1].serve.variant`; empty for the root. */
  path: string;
  op: 'added' | 'removed' | 'changed';
  before?: unknown;
  after?: unknown;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function join(path: string, part: string | number): string {
  if (typeof part === 'number') return `${path}[${part}]`;
  return path === '' ? part : `${path}.${part}`;
}

function walk(before: unknown, after: unknown, path: string, out: DiffEntry[]): void {
  if (Array.isArray(before) && Array.isArray(after)) {
    const n = Math.max(before.length, after.length);
    for (let i = 0; i < n; i++) {
      if (i >= before.length) out.push({ path: join(path, i), op: 'added', after: after[i] });
      else if (i >= after.length)
        out.push({ path: join(path, i), op: 'removed', before: before[i] });
      else walk(before[i], after[i], join(path, i), out);
    }
    return;
  }
  if (isObject(before) && isObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].sort()) {
      const inBefore = Object.hasOwn(before, key) && before[key] !== undefined;
      const inAfter = Object.hasOwn(after, key) && after[key] !== undefined;
      if (!inBefore && inAfter) out.push({ path: join(path, key), op: 'added', after: after[key] });
      else if (inBefore && !inAfter) {
        out.push({ path: join(path, key), op: 'removed', before: before[key] });
      } else if (inBefore && inAfter) walk(before[key], after[key], join(path, key), out);
    }
    return;
  }
  if (before !== after) out.push({ path, op: 'changed', before, after });
}

/**
 * Structural difference between two JSON values. Arrays compare by index,
 * which is what a reader of a rule list expects: "rule 2 changed".
 */
export function diff(before: unknown, after: unknown): DiffEntry[] {
  const out: DiffEntry[] = [];
  if (before === undefined && after !== undefined) return [{ path: '', op: 'added', after }];
  if (before !== undefined && after === undefined) return [{ path: '', op: 'removed', before }];
  walk(before, after, '', out);
  return out;
}
