import type { Flag, Ruleset } from '@flagship/core';
import { describe, expect, it } from 'vitest';
import type { ChangeRequest } from '../api';
import { humanPath } from './DiffView';
import { applyBlocker, flagsUsingSegment, rulesetWith } from './proposal';

const flag = (key: string, over: Partial<Flag> = {}): Flag => ({
  key,
  type: 'boolean',
  variants: [
    { key: 'on', value: true },
    { key: 'off', value: false },
  ],
  salt: key,
  clientSide: false,
  version: 1,
  enabled: true,
  offVariant: 'off',
  prerequisites: [],
  rules: [],
  fallthrough: { variant: 'off' },
  ...over,
});

const uses = (segment: string) => ({
  id: `in-${segment}`,
  clauses: [{ operator: 'inSegment' as const, segments: ['other', segment] }],
  serve: { variant: 'on' },
});

const ruleset: Ruleset = {
  environment: 'production',
  version: 1,
  flags: {
    a: flag('a', { rules: [uses('beta')] }),
    b: flag('b', { prerequisites: [{ flag: 'a', variant: 'on' }] }),
    c: flag('c', { prerequisites: [{ flag: 'b', variant: 'on' }] }),
    d: flag('d', { rules: [uses('gamma')] }),
    e: flag('e'),
  },
  segments: {
    beta: { key: 'beta', included: ['x'], excluded: [], rules: [], version: 7 },
    gamma: { key: 'gamma', included: [], excluded: [], rules: [], version: 1 },
  },
};

const content = { name: 'Beta', description: '', included: ['y'], excluded: ['z'], rules: [] };

describe('rulesetWith', () => {
  it('swaps one flag’s targeting and keeps its metadata', () => {
    const next = rulesetWith(
      ruleset,
      { target: 'flag', flag: 'e', segment: null },
      {
        enabled: false,
        offVariant: 'on',
        prerequisites: [],
        rules: [],
        fallthrough: { variant: 'on' },
      },
    );
    expect(next?.flags.e).toEqual({
      ...ruleset.flags.e,
      enabled: false,
      offVariant: 'on',
      fallthrough: { variant: 'on' },
    });
    expect(next?.flags.a).toBe(ruleset.flags.a);
    expect(
      rulesetWith(ruleset, { target: 'flag', flag: 'gone', segment: null }, null),
    ).toBeUndefined();
    expect(
      rulesetWith(ruleset, { target: 'flag', flag: 'e', segment: null }, null),
    ).toBeUndefined();
  });

  it('replaces, adds and removes a segment', () => {
    const req = { target: 'segment' as const, flag: null, segment: 'beta' };
    expect(rulesetWith(ruleset, req, content)?.segments.beta).toEqual({
      key: 'beta',
      included: ['y'],
      excluded: ['z'],
      rules: [],
      version: 7,
    });
    expect(Object.keys(rulesetWith(ruleset, req, null)?.segments ?? {})).toEqual(['gamma']);
    expect(ruleset.segments.beta).toBeDefined();
    const fresh = rulesetWith(ruleset, { ...req, segment: 'new' }, content);
    expect(fresh?.segments.new?.version).toBe(0);
  });
});

describe('flagsUsingSegment', () => {
  it('finds direct users and every flag that depends on them through prerequisites', () => {
    expect(flagsUsingSegment(ruleset, 'beta')).toEqual(['a', 'b', 'c']);
    expect(flagsUsingSegment(ruleset, 'gamma')).toEqual(['d']);
    expect(flagsUsingSegment(ruleset, 'nobody')).toEqual([]);
  });
});

describe('applyBlocker', () => {
  const base = {
    status: 'open',
    live: { version: 1, stale: false, changedSinceBase: [], conflicts: [] },
    approvals: { required: 2, approvedBy: ['a'], changesRequestedBy: [] },
  } as unknown as ChangeRequest;

  it('says why a request cannot be applied yet, most fundamental reason first', () => {
    expect(applyBlocker({ ...base, status: 'applied' })).toBe('This change request is applied.');
    expect(
      applyBlocker({
        ...base,
        live: { version: 2, stale: true, changedSinceBase: [], conflicts: [] },
      }),
    ).toMatch(/Rebase it first/);
    expect(
      applyBlocker({
        ...base,
        live: {
          version: 2,
          stale: true,
          changedSinceBase: [],
          conflicts: [{ path: 'enabled', base: false, ours: true, theirs: false }],
        },
      }),
    ).toMatch(/conflict/);
    expect(
      applyBlocker({
        ...base,
        approvals: { required: 1, approvedBy: ['a'], changesRequestedBy: ['b', 'c'] },
      }),
    ).toBe('Changes were requested by b, c.');
    expect(applyBlocker(base)).toBe('Needs 2 approvals, has 1.');
    expect(
      applyBlocker({ ...base, approvals: { required: 1, approvedBy: [], changesRequestedBy: [] } }),
    ).toBe('Needs 1 approval, has 0.');
    expect(
      applyBlocker({
        ...base,
        approvals: { required: 1, approvedBy: ['a'], changesRequestedBy: [] },
      }),
    ).toBeUndefined();
  });
});

describe('humanPath for merge paths', () => {
  it('names rules and prerequisites by id and segment parts by their labels', () => {
    expect(humanPath('rules[id=beta].serve.variant')).toBe('Rule "beta" › serve › variant');
    expect(humanPath('prerequisites[flag=billing]')).toBe('Prerequisite "billing"');
    expect(humanPath('included')).toBe('Always include');
    expect(humanPath('excluded')).toBe('Always exclude');
    expect(humanPath('segment')).toBe('Whole segment');
    expect(humanPath('rules[2].clauses[0]')).toBe('Rule 3 › condition 1');
  });
});
