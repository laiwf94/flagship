import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  describeReason,
  lifecycleOf,
  reachableVariants,
  STALE_AFTER_DAYS,
  type LifecycleInput,
} from './lifecycle.js';

const DAY = 86_400_000;
const now = Date.parse('2030-06-01T12:00:00Z');

const base = (over: Partial<LifecycleInput> = {}): LifecycleInput => ({
  config: {
    enabled: true,
    offVariant: 'off',
    prerequisites: [],
    rules: [],
    fallthrough: {
      rollout: {
        variants: [
          { variant: 'on', weight: 50_000 },
          { variant: 'off', weight: 50_000 },
        ],
      },
    },
  },
  archived: false,
  createdAt: now - 90 * DAY,
  targetingChangedAt: now - 60 * DAY,
  lastEvaluatedAt: now - DAY,
  now,
  ...over,
});

const rule = (variant: string) => ({
  id: `r-${variant}`,
  clauses: [{ attribute: 'country', operator: 'equals' as const, values: ['NZ'] }],
  serve: { variant },
});

describe('reachableVariants', () => {
  it('collects the off variant, rule variants and non-zero rollout weights', () => {
    expect([...reachableVariants({ ...base().config, enabled: false })]).toEqual(['off']);
    expect([
      ...reachableVariants({
        enabled: true,
        offVariant: 'off',
        prerequisites: [{ flag: 'other', variant: 'on' }],
        rules: [rule('blue')],
        fallthrough: {
          rollout: {
            variants: [
              { variant: 'on', weight: 100_000 },
              { variant: 'green', weight: 0 },
            ],
          },
        },
      }),
    ]).toEqual(['off', 'blue', 'on']);
  });
});

describe('lifecycleOf', () => {
  it('walks a flag from new to active to launched to inactive as time passes', () => {
    const created = now - 100 * DAY;
    const at = (day: number) => created + day * DAY;
    const flag = base({ createdAt: created, targetingChangedAt: created, lastEvaluatedAt: null });

    expect(lifecycleOf({ ...flag, now: at(2) })).toEqual({
      stage: 'new',
      stale: false,
      reasons: [],
    });
    expect(lifecycleOf({ ...flag, lastEvaluatedAt: at(3), now: at(3) }).stage).toBe('active');

    // Rolled out to 100% on day 10 and left alone for the window while still in use.
    const done = {
      ...flag,
      config: { ...flag.config, fallthrough: { variant: 'on' } },
      targetingChangedAt: at(10),
    };
    expect(lifecycleOf({ ...done, lastEvaluatedAt: at(39), now: at(39) }).stage).toBe('active');
    expect(lifecycleOf({ ...done, lastEvaluatedAt: at(40), now: at(40) })).toEqual({
      stage: 'launched',
      stale: true,
      reasons: [
        { kind: 'launched', variant: 'on', enabled: true, since: new Date(at(10)).toISOString() },
      ],
    });

    // Then the code stops asking for it: the last evaluation was day 40.
    const life = lifecycleOf({ ...done, lastEvaluatedAt: at(40), now: at(70) });
    expect(life.stage).toBe('inactive');
    expect(life.reasons.map((r) => r.kind)).toEqual(['unevaluated', 'launched']);
    expect(life.reasons[0]).toEqual({
      kind: 'unevaluated',
      lastEvaluatedAt: new Date(at(40)).toISOString(),
      since: new Date(at(40)).toISOString(),
    });

    // A new rule makes it active again as soon as it is evaluated.
    const changed = {
      ...done,
      config: { ...done.config, rules: [rule('off')] },
      targetingChangedAt: at(71),
      lastEvaluatedAt: at(72),
      now: at(72),
    };
    expect(lifecycleOf(changed).stage).toBe('active');
  });

  it('stays active one millisecond short of the window and while variants differ', () => {
    const single = { ...base().config, fallthrough: { variant: 'on' } };
    expect(
      lifecycleOf(base({ config: single, targetingChangedAt: now - STALE_AFTER_DAYS * DAY + 1 }))
        .stage,
    ).toBe('active');
    expect(lifecycleOf(base({ lastEvaluatedAt: now - STALE_AFTER_DAYS * DAY + 1 })).stage).toBe(
      'active',
    );
    // A rule serving another variant keeps it active even if nothing changed for months.
    expect(lifecycleOf(base({ config: { ...single, rules: [rule('off')] } })).stage).toBe('active');
    // Every rule serving the same variant as the default is still one variant.
    expect(lifecycleOf(base({ config: { ...single, rules: [rule('on')] } })).stage).toBe(
      'launched',
    );
  });

  it('treats a flag switched off for the window as launched with the off variant', () => {
    const life = lifecycleOf(base({ config: { ...base().config, enabled: false } }));
    expect(life.stage).toBe('launched');
    expect(life.reasons[0]).toMatchObject({ kind: 'launched', variant: 'off', enabled: false });
  });

  it('marks a flag never evaluated since it was created as inactive after the window', () => {
    const life = lifecycleOf(base({ lastEvaluatedAt: null }));
    expect(life).toEqual({
      stage: 'inactive',
      stale: true,
      reasons: [
        {
          kind: 'unevaluated',
          lastEvaluatedAt: null,
          since: new Date(now - 90 * DAY).toISOString(),
        },
      ],
    });
  });

  it('ignores evaluations from before the flag was created', () => {
    const created = now - 3 * DAY;
    const life = lifecycleOf(
      base({ createdAt: created, targetingChangedAt: created, lastEvaluatedAt: now - 40 * DAY }),
    );
    expect(life.stage).toBe('new');
  });

  it('counts an evaluation stored at the start of the hour the flag was created in', () => {
    const created = now - 2 * DAY + 20 * 60_000;
    const hour = created - 20 * 60_000;
    const input = base({ createdAt: created, targetingChangedAt: created, lastEvaluatedAt: hour });
    expect(lifecycleOf(input).stage).toBe('new');
    expect(lifecycleOf({ ...input, evaluationResolutionMs: 3_600_000 }).stage).toBe('active');
  });

  it('reports archived flags as archived and never stale', () => {
    expect(lifecycleOf(base({ archived: true, lastEvaluatedAt: null }))).toEqual({
      stage: 'archived',
      stale: false,
      reasons: [],
    });
  });

  it('honours a custom window', () => {
    expect(lifecycleOf(base({ lastEvaluatedAt: now - 8 * DAY, staleAfterDays: 7 })).stage).toBe(
      'inactive',
    );
  });

  it('is stale exactly when it has a reason, and has one for each condition that holds', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 200 }),
        fc.integer({ min: 0, max: 200 }),
        fc.option(fc.integer({ min: 0, max: 200 }), { nil: null }),
        fc.boolean(),
        fc.boolean(),
        (createdDaysAgo, changedDaysAgo, evaluatedDaysAgo, single, enabled) => {
          const createdAt = now - createdDaysAgo * DAY;
          const input = base({
            createdAt,
            targetingChangedAt: Math.max(createdAt, now - changedDaysAgo * DAY),
            lastEvaluatedAt: evaluatedDaysAgo === null ? null : now - evaluatedDaysAgo * DAY,
            config: {
              ...base().config,
              enabled,
              ...(single ? { fallthrough: { variant: 'on' } } : {}),
            },
          });
          const life = lifecycleOf(input);
          expect(life.stale).toBe(life.reasons.length > 0);
          expect(life.stale).toBe(life.stage === 'launched' || life.stage === 'inactive');
          for (const r of life.reasons) expect(describeReason(r).length).toBeGreaterThan(0);
        },
      ),
    );
  });
});

describe('describeReason', () => {
  it('says what makes the flag stale', () => {
    const since = '2030-05-01T00:00:00.000Z';
    expect(describeReason({ kind: 'launched', variant: 'on', enabled: true, since })).toBe(
      'Serves on to everyone, unchanged since 2030-05-01',
    );
    expect(describeReason({ kind: 'launched', variant: 'off', enabled: false, since })).toBe(
      'Switched off (serves off to everyone) since 2030-05-01',
    );
    expect(describeReason({ kind: 'unevaluated', lastEvaluatedAt: since, since })).toBe(
      'Not evaluated since 2030-05-01',
    );
    expect(describeReason({ kind: 'unevaluated', lastEvaluatedAt: null, since })).toBe(
      'Never evaluated since it was created on 2030-05-01',
    );
  });
});
