import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { jsonEqual, threeWayMerge } from './merge.js';

const KEYS = { rules: 'id', prerequisites: 'flag' };

const rule = (id: string, variant: string, value = 'de') => ({
  id,
  clauses: [{ attribute: 'country', op: 'equals', values: [value] }],
  serve: { variant },
});

const config = (over: Record<string, unknown> = {}) => ({
  enabled: false,
  offVariant: 'off',
  prerequisites: [] as unknown[],
  rules: [rule('a', 'on'), rule('b', 'off')] as unknown[],
  fallthrough: { variant: 'off' } as unknown,
  ...over,
});

describe('jsonEqual', () => {
  it('compares deeply, ignoring key order and undefined members', () => {
    expect(jsonEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(jsonEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(jsonEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(jsonEqual([1, 2], [2, 1])).toBe(false);
    expect(jsonEqual([1], { 0: 1 })).toBe(false);
    expect(jsonEqual(null, {})).toBe(false);
    expect(jsonEqual({ a: 1 }, { b: 1 })).toBe(false);
  });
});

describe('threeWayMerge', () => {
  it('takes whichever side changed a field', () => {
    const base = config();
    const ours = config({ enabled: true });
    const theirs = config({ fallthrough: { variant: 'on' } });
    const { merged, conflicts } = threeWayMerge(base, ours, theirs, KEYS);
    expect(conflicts).toEqual([]);
    expect(merged).toEqual(config({ enabled: true, fallthrough: { variant: 'on' } }));
  });

  it('accepts the same change made on both sides', () => {
    const base = config();
    const same = config({ enabled: true });
    expect(threeWayMerge(base, same, config({ enabled: true }), KEYS)).toEqual({
      merged: same,
      conflicts: [],
    });
  });

  it('reports a field both sides changed differently, with all three values', () => {
    const { conflicts } = threeWayMerge(
      config(),
      config({ fallthrough: { variant: 'on' } }),
      config({
        fallthrough: {
          rollout: {
            variants: [
              { variant: 'on', weight: 50_000 },
              { variant: 'off', weight: 50_000 },
            ],
          },
        },
      }),
      KEYS,
    );
    // One side changed the variant, the other replaced it with a rollout.
    expect(conflicts).toEqual([
      { path: 'fallthrough.variant', base: 'off', ours: 'on', theirs: undefined },
    ]);
  });

  it('merges edits to different rules, matched by id rather than position', () => {
    const base = config();
    // Ours edits rule b; theirs inserts a rule at the top, moving b down one place.
    const ours = config({ rules: [rule('a', 'on'), rule('b', 'on')] });
    const theirs = config({ rules: [rule('z', 'on', 'fr'), rule('a', 'on'), rule('b', 'off')] });
    const { merged, conflicts } = threeWayMerge(base, ours, theirs, KEYS);
    expect(conflicts).toEqual([]);
    expect(merged.rules).toEqual([rule('z', 'on', 'fr'), rule('a', 'on'), rule('b', 'on')]);
  });

  it('reports the same rule changed differently, by its id', () => {
    const { conflicts } = threeWayMerge(
      config(),
      config({ rules: [rule('a', 'off', 'fr'), rule('b', 'off')] }),
      config({ rules: [rule('a', 'v2', 'it'), rule('b', 'off')] }),
      KEYS,
    );
    expect(conflicts).toEqual([
      expect.objectContaining({ path: 'rules[id=a].clauses' }),
      { path: 'rules[id=a].serve.variant', base: 'on', ours: 'off', theirs: 'v2' },
    ]);
  });

  it('treats deleting a rule the other side edited as a conflict, and deleting an untouched one as a change', () => {
    const base = config();
    const deleted = threeWayMerge(
      base,
      config({ rules: [rule('a', 'on'), rule('b', 'on')] }),
      config({ rules: [rule('b', 'off')] }),
      KEYS,
    );
    expect(deleted.conflicts).toEqual([]);
    expect(deleted.merged.rules).toEqual([rule('b', 'on')]);

    const edited = threeWayMerge(
      base,
      config({ rules: [rule('a', 'on')] }),
      config({ rules: [rule('a', 'on'), rule('b', 'on')] }),
      KEYS,
    );
    expect(edited.conflicts).toEqual([
      { path: 'rules[id=b]', base: rule('b', 'off'), ours: undefined, theirs: rule('b', 'on') },
    ]);
  });

  it('keeps rules both sides added, each after its predecessor', () => {
    const { merged, conflicts } = threeWayMerge(
      config(),
      config({ rules: [rule('a', 'on'), rule('x', 'on'), rule('b', 'off')] }),
      config({ rules: [rule('y', 'on'), rule('a', 'on'), rule('b', 'off'), rule('w', 'off')] }),
      KEYS,
    );
    expect(conflicts).toEqual([]);
    expect((merged.rules as { id: string }[]).map((r) => r.id)).toEqual(['y', 'a', 'x', 'b', 'w']);
  });

  it('takes one side reordering rules, and reports both reordering them differently', () => {
    const base = config({ rules: [rule('a', 'on'), rule('b', 'off'), rule('c', 'on')] });
    const reordered = threeWayMerge(
      base,
      config({ rules: [rule('c', 'on'), rule('a', 'on'), rule('b', 'off')] }),
      config({ rules: [rule('a', 'off'), rule('b', 'off'), rule('c', 'on')] }),
      KEYS,
    );
    expect(reordered.conflicts).toEqual([]);
    expect(reordered.merged.rules).toEqual([rule('c', 'on'), rule('a', 'off'), rule('b', 'off')]);

    const both = threeWayMerge(
      base,
      config({ rules: [rule('c', 'on'), rule('a', 'on'), rule('b', 'off')] }),
      config({ rules: [rule('b', 'off'), rule('a', 'on'), rule('c', 'on')] }),
      KEYS,
    );
    expect(both.conflicts).toEqual([
      { path: 'rules', base: ['a', 'b', 'c'], ours: ['c', 'a', 'b'], theirs: ['b', 'a', 'c'] },
    ]);
  });

  it('merges prerequisites by flag', () => {
    const base = config({ prerequisites: [{ flag: 'auth', variant: 'on' }] });
    const { merged, conflicts } = threeWayMerge(
      base,
      config({
        prerequisites: [
          { flag: 'auth', variant: 'on' },
          { flag: 'billing', variant: 'on' },
        ],
      }),
      config({ prerequisites: [{ flag: 'auth', variant: 'v2' }] }),
      KEYS,
    );
    expect(conflicts).toEqual([]);
    expect(merged.prerequisites).toEqual([
      { flag: 'auth', variant: 'v2' },
      { flag: 'billing', variant: 'on' },
    ]);
  });

  it('treats arrays without usable keys as one value', () => {
    const dupes = [rule('a', 'on'), rule('a', 'off')];
    const { conflicts } = threeWayMerge(
      config(),
      config({ rules: dupes }),
      config({ rules: [rule('b', 'on')] }),
      KEYS,
    );
    expect(conflicts.map((c) => c.path)).toEqual(['rules']);
    const unkeyed = threeWayMerge({ list: [1, 2] }, { list: [1, 3] }, { list: [0, 2] });
    expect(unkeyed.conflicts.map((c) => c.path)).toEqual(['list']);
  });

  it('adds and removes object members from either side', () => {
    const { merged, conflicts } = threeWayMerge({ a: 1, b: 2 }, { a: 1, b: 2, c: 3 }, { a: 1 });
    expect(conflicts).toEqual([]);
    expect(merged).toEqual({ a: 1, c: 3 });
  });

  it('is the identity when only one side changed, and symmetric without conflicts', () => {
    const value = fc.letrec((tie) => ({
      leaf: fc.oneof(fc.boolean(), fc.integer({ min: 0, max: 3 }), fc.constantFrom('x', 'y')),
      node: fc.oneof(
        { depthSize: 'small' },
        tie('leaf'),
        fc.dictionary(fc.constantFrom('p', 'q', 'r'), tie('node'), { maxKeys: 3 }),
      ),
    })).node;
    fc.assert(
      fc.property(value, value, value, (base, ours, theirs) => {
        expect(threeWayMerge(base, ours, base)).toEqual({ merged: ours, conflicts: [] });
        expect(threeWayMerge(base, base, theirs)).toEqual({ merged: theirs, conflicts: [] });
        const ab = threeWayMerge(base, ours, theirs);
        const ba = threeWayMerge(base, theirs, ours);
        expect(ab.conflicts.length).toBe(ba.conflicts.length);
        if (ab.conflicts.length === 0) expect(jsonEqual(ab.merged, ba.merged)).toBe(true);
      }),
    );
  });
});
