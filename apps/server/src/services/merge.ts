/**
 * Three-way merge of JSON values, for change requests whose target moved on
 * after they were proposed. `base` is what the proposal started from, `ours`
 * is the proposal and `theirs` is what is live now. A part changed on only
 * one side takes that side's value; a part changed on both sides to different
 * values is a conflict. Objects merge key by key. Arrays named in `keys`
 * merge element by element, matched on that field (rules by `id`,
 * prerequisites by `flag`), so two people editing different rules of one
 * flag do not conflict. Every other array is one value.
 */

export interface MergeConflict {
  /** `rules[id=beta].serve.variant`, or `rules` for an ordering conflict. */
  path: string;
  base: unknown;
  ours: unknown;
  theirs: unknown;
}

export interface MergeResult<T> {
  merged: T;
  conflicts: MergeConflict[];
}

type Obj = Record<string, unknown>;

function isObject(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep equality of JSON values; key order does not matter. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]));
  }
  return false;
}

function join(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

/** Element keys of an array, or undefined when they are missing or repeated. */
function keysOf(list: unknown, field: string): string[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const key = isObject(item) ? item[field] : undefined;
    if (typeof key !== 'string' || seen.has(key)) return undefined;
    seen.add(key);
    out.push(key);
  }
  return out;
}

class Merger {
  readonly conflicts: MergeConflict[] = [];

  constructor(private readonly keys: Readonly<Record<string, string>>) {}

  value(base: unknown, ours: unknown, theirs: unknown, path: string): unknown {
    if (jsonEqual(ours, theirs)) return ours;
    if (jsonEqual(base, ours)) return theirs;
    if (jsonEqual(base, theirs)) return ours;
    if (isObject(base) && isObject(ours) && isObject(theirs)) {
      return this.object(base, ours, theirs, path);
    }
    const field = this.keys[path];
    if (field !== undefined) {
      const kb = keysOf(base, field);
      const ko = keysOf(ours, field);
      const kt = keysOf(theirs, field);
      if (kb !== undefined && ko !== undefined && kt !== undefined) {
        return this.keyed(
          base as Obj[],
          ours as Obj[],
          theirs as Obj[],
          { base: kb, ours: ko, theirs: kt },
          field,
          path,
        );
      }
    }
    this.conflicts.push({ path, base, ours, theirs });
    return ours;
  }

  private object(base: Obj, ours: Obj, theirs: Obj, path: string): Obj {
    const out: Obj = {};
    const keys = new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)]);
    for (const key of [...keys].sort()) {
      const merged = this.value(base[key], ours[key], theirs[key], join(path, key));
      if (merged !== undefined) out[key] = merged;
    }
    return out;
  }

  private keyed(
    base: Obj[],
    ours: Obj[],
    theirs: Obj[],
    ids: { base: string[]; ours: string[]; theirs: string[] },
    field: string,
    path: string,
  ): Obj[] {
    const index = (list: Obj[]) => new Map(list.map((item) => [item[field] as string, item]));
    const [b, o, t] = [index(base), index(ours), index(theirs)];
    const merged = new Map<string, unknown>();
    for (const id of new Set([...ids.base, ...ids.ours, ...ids.theirs])) {
      const value = this.value(b.get(id), o.get(id), t.get(id), `${path}[${field}=${id}]`);
      if (value !== undefined) merged.set(id, value);
    }

    // Order: whichever side reordered the elements they all share wins; both
    // reordering them differently is a conflict. Elements only one side has
    // go after their predecessor on that side.
    const shared = (list: string[]) => list.filter((id) => b.has(id) && o.has(id) && t.has(id));
    const [sb, so, st] = [shared(ids.base), shared(ids.ours), shared(ids.theirs)];
    const oursMoved = !jsonEqual(so, sb);
    const theirsMoved = !jsonEqual(st, sb);
    if (oursMoved && theirsMoved && !jsonEqual(so, st)) {
      this.conflicts.push({ path, base: ids.base, ours: ids.ours, theirs: ids.theirs });
    }
    const [primary, secondary] = oursMoved ? [ids.ours, ids.theirs] : [ids.theirs, ids.ours];
    const order = primary.filter((id) => merged.has(id));
    let cursor = -1;
    for (const id of secondary) {
      const at = order.indexOf(id);
      if (at >= 0) cursor = at;
      else if (merged.has(id)) order.splice(++cursor, 0, id);
    }
    return order.map((id) => merged.get(id) as Obj);
  }
}

export function threeWayMerge<T>(
  base: T,
  ours: T,
  theirs: T,
  keys: Readonly<Record<string, string>> = {},
): MergeResult<T> {
  const merger = new Merger(keys);
  const merged = merger.value(base, ours, theirs, '') as T;
  return { merged, conflicts: merger.conflicts };
}

/**
 * Three-way merge of a list used as a set (segment members). Whatever `ours`
 * added since `base` is added to `theirs`, and whatever it removed is
 * removed, so it never conflicts. `theirs` keeps its order, and additions go
 * at the end in the order `ours` has them.
 */
export function mergeSet(
  base: readonly string[],
  ours: readonly string[],
  theirs: readonly string[],
): string[] {
  const b = new Set(base);
  const o = new Set(ours);
  const removed = new Set(base.filter((x) => !o.has(x)));
  const out = theirs.filter((x) => !removed.has(x));
  const present = new Set(out);
  for (const x of ours) {
    if (!b.has(x) && !present.has(x)) {
      out.push(x);
      present.add(x);
    }
  }
  return out;
}
