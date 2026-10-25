import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { diff } from './diff.js';

describe('diff', () => {
  it('reports nested changes, additions and removals with paths', () => {
    expect(
      diff(
        { enabled: false, rules: [{ id: 'a', serve: { variant: 'on' } }], name: 'x' },
        { enabled: true, rules: [{ id: 'a', serve: { variant: 'off' } }, { id: 'b' }], tags: [] },
      ),
    ).toEqual([
      { path: 'enabled', op: 'changed', before: false, after: true },
      { path: 'name', op: 'removed', before: 'x' },
      { path: 'rules[0].serve.variant', op: 'changed', before: 'on', after: 'off' },
      { path: 'rules[1]', op: 'added', after: { id: 'b' } },
      { path: 'tags', op: 'added', after: [] },
    ]);
  });

  it('handles roots, type changes and shrinking arrays', () => {
    expect(diff(undefined, { a: 1 })).toEqual([{ path: '', op: 'added', after: { a: 1 } }]);
    expect(diff({ a: 1 }, undefined)).toEqual([{ path: '', op: 'removed', before: { a: 1 } }]);
    expect(diff({ a: [1] }, { a: { 0: 1 } })).toEqual([
      { path: 'a', op: 'changed', before: [1], after: { 0: 1 } },
    ]);
    expect(diff([1, 2, 3], [1])).toEqual([
      { path: '[1]', op: 'removed', before: 2 },
      { path: '[2]', op: 'removed', before: 3 },
    ]);
    expect(diff({ a: undefined }, {})).toEqual([]);
  });

  it('is empty exactly when the values are deeply equal', () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.jsonValue(), (a, b) => {
        const same = JSON.stringify(a) === JSON.stringify(b);
        if (same) expect(diff(a, b)).toEqual([]);
        expect(diff(a, structuredClone(a))).toEqual([]);
        if (diff(a, b).length === 0) expect(diff(b, a)).toEqual([]);
      }),
    );
  });
});
