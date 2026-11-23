import type { Ruleset } from '@flagship/core';
import { describe, expect, it } from 'vitest';
import {
  appliedText,
  hasChanges,
  planFlag,
  planFrom,
  planText,
  type LiveState,
  type Plan,
} from './code.js';
import type { FlagView } from './commands/flags.js';
import { FlagsFileError, readFlagsFile, type FileIssue } from './flagsfile.js';

const SOURCE = 'github.com/acme/web/flags.yaml';

const file = (lines: string[]) =>
  readFlagsFile(
    `${['version: 1', `source: ${SOURCE}`, 'flags:', ...lines].join('\n')}\n`,
    'flags.yaml',
    'x',
  );

const ENVS = [
  { key: 'development', protected: false },
  { key: 'production', protected: true },
];
const OPTIONS = { prune: false, takeOver: false };

function liveFlag(overrides: Partial<FlagView> = {}): FlagView {
  const env = (version: number) => ({
    enabled: true,
    offVariant: 'off',
    prerequisites: [],
    rules: [],
    fallthrough: { variant: 'on' },
    version,
    updatedAt: '2030-01-01T00:00:00Z',
  });
  return {
    key: 'checkout',
    name: 'Checkout',
    description: '',
    type: 'boolean',
    variants: [
      { key: 'on', value: true },
      { key: 'off', value: false },
    ],
    clientSide: false,
    archived: false,
    version: 2,
    createdAt: '2030-01-01T00:00:00Z',
    updatedAt: '2030-01-01T00:00:00Z',
    environments: { development: env(5), production: env(3) },
    managedBy: {
      source: SOURCE,
      metadataVersion: 2,
      environments: { development: 5 },
      appliedAt: '2030-01-01T00:00:00Z',
      appliedBy: 'ci',
    },
    ...overrides,
  };
}

const CHECKOUT = [
  '  checkout:',
  '    name: Checkout',
  '    environments:',
  '      development: { enabled: true, fallthrough: on }',
];

function ruleset(env: string, flags: Ruleset['flags'] = {}): Ruleset {
  return { environment: env, version: 1, flags, segments: {} };
}

function live(flags: FlagView[], orphans: string[] = []): LiveState {
  return {
    environments: ENVS,
    flags: new Map(flags.map((f) => [f.key, f])),
    orphans,
    rulesets: new Map(ENVS.map((e) => [e.key, ruleset(e.key)])),
  };
}

function fileIssues(fn: () => unknown): FileIssue[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof FlagsFileError) return e.issues;
    throw e;
  }
  throw new Error('expected a FlagsFileError');
}

describe('planFlag', () => {
  it('finds nothing to do when the live flag matches and the record is current', () => {
    const f = file(CHECKOUT);
    const p = planFlag(f, f.flags[0]!, liveFlag(), ENVS, OPTIONS);
    expect(p).toMatchObject({ action: 'unchanged', adopt: false, record: false, metadata: null });
    expect(p.environments).toEqual([]);
  });

  it('tells the file changing from drift outside the file', () => {
    const f = file([
      '  checkout:',
      '    name: Checkout 2',
      '    environments:',
      '      development: { enabled: false }',
      '      production: { enabled: true, fallthrough: off }',
    ]);
    const fromFile = planFlag(f, f.flags[0]!, liveFlag(), ENVS, OPTIONS);
    expect(fromFile.metadata).toMatchObject({ drift: false, removedVariants: [] });
    expect(fromFile.environments.map((e) => [e.environment, e.via, e.drift])).toEqual([
      ['development', 'direct', false],
      ['production', 'change-request', false],
    ]);
    const moved = liveFlag({ version: 4 });
    moved.environments.development!.version = 7;
    const drifted = planFlag(f, f.flags[0]!, moved, ENVS, OPTIONS);
    expect(drifted.metadata?.drift).toBe(true);
    expect(drifted.environments[0]?.drift).toBe(true);
    // production was never recorded, so a difference there is not drift.
    expect(drifted.environments[1]?.drift).toBe(false);
  });

  it('refreshes the record when versions moved but the content still matches', () => {
    const f = file(CHECKOUT);
    const p = planFlag(f, f.flags[0]!, liveFlag({ version: 3 }), ENVS, OPTIONS);
    expect(p).toMatchObject({ action: 'unchanged', record: true });
  });

  it('plans creating, restoring and adopting', () => {
    const f = file(CHECKOUT);
    expect(planFlag(f, f.flags[0]!, undefined, ENVS, OPTIONS)).toMatchObject({
      action: 'create',
      version: null,
      adopt: true,
      record: true,
    });
    expect(planFlag(f, f.flags[0]!, liveFlag({ archived: true }), ENVS, OPTIONS)).toMatchObject({
      action: 'update',
      restore: true,
    });
    expect(planFlag(f, f.flags[0]!, liveFlag({ managedBy: null }), ENVS, OPTIONS)).toMatchObject({
      action: 'unchanged',
      adopt: true,
      record: true,
    });
  });

  it('lists the variants a change removes', () => {
    const f = file([
      '  checkout:',
      '    name: Checkout',
      '    variants: [{ key: on, value: true }, { key: off, value: false }]',
    ]);
    const withBeta = liveFlag();
    withBeta.variants = [...withBeta.variants, { key: 'beta', value: true }];
    expect(planFlag(f, f.flags[0]!, withBeta, ENVS, OPTIONS).metadata?.removedVariants).toEqual([
      { key: 'beta', value: true },
    ]);
  });

  it('refuses unknown environments, a type change and another file’s flag', () => {
    const f = file([
      '  checkout:',
      '    type: string',
      '    variants: [{ key: a, value: a }, { key: b, value: b }]',
      '    environments:',
      '      staging: {}',
    ]);
    const other = liveFlag();
    other.managedBy = { ...other.managedBy!, source: 'elsewhere.yaml' };
    expect(fileIssues(() => planFlag(f, f.flags[0]!, other, ENVS, OPTIONS))).toEqual([
      {
        file: 'flags.yaml',
        line: 8,
        path: 'flags.checkout.environments.staging',
        message: 'the project has no environment "staging"; it has development, production',
      },
      {
        file: 'flags.yaml',
        line: 5,
        path: 'flags.checkout.type',
        message: "is boolean on the server; a flag's type can't change",
      },
      {
        file: 'flags.yaml',
        line: 4,
        path: 'flags.checkout',
        message:
          'is managed by elsewhere.yaml; remove it there, release it in the console, or pass --take-over',
      },
    ]);
    const plain = file(CHECKOUT);
    expect(
      planFlag(plain, plain.flags[0]!, other, ENVS, { prune: false, takeOver: true }),
    ).toMatchObject({ adopt: true, record: true });
  });
});

describe('planFrom', () => {
  const NOW = new Date('2030-01-02T00:00:00Z');

  it('reports orphans, or archives them with --prune', () => {
    const f = file(CHECKOUT);
    const state = live([liveFlag(), liveFlag({ key: 'old' })], ['old']);
    const kept = planFrom(f, 'web', state, OPTIONS, NOW);
    expect(kept).toMatchObject({
      format: 'flagship-plan',
      project: 'web',
      source: SOURCE,
      createdAt: '2030-01-02T00:00:00.000Z',
      summary: { orphan: 1, archive: 0, unchanged: 1 },
    });
    expect(hasChanges(kept)).toBe(false);
    expect(planText(kept)).toContain('! flag old was managed by this file but is not in it');
    const pruned = planFrom(f, 'web', state, { prune: true, takeOver: false }, NOW);
    expect(pruned.summary).toMatchObject({ archive: 1, orphan: 0 });
    expect(hasChanges(pruned)).toBe(true);
    expect(planText(pruned)).toContain('- archive flag old: no longer in the file');
    expect(planText(pruned)).toContain('Flags: 1 to archive, 1 unchanged.');
  });

  it('checks the resulting rulesets and points at the file', () => {
    const f = file([
      '  checkout:',
      '    environments:',
      '      development:',
      '        enabled: true',
      '        prerequisites: [{ flag: missing, variant: on }]',
      '        fallthrough: on',
      '  theme:',
      '    type: string',
      '    variants: [{ key: a, value: 1 }, { key: b, value: b }]',
    ]);
    const issues = fileIssues(() => planFrom(f, 'web', live([]), OPTIONS, NOW));
    expect(issues).toContainEqual({
      file: 'flags.yaml',
      line: 8,
      path: 'flags.checkout.environments.development.prerequisites[0].flag',
      message: 'unknown flag "missing"',
    });
    expect(issues).toContainEqual(
      expect.objectContaining({ line: 12, path: 'flags.theme.variants[0].value' }),
    );
    // One problem in two environments is reported once.
    expect(issues.filter((i) => i.path === 'flags.theme.variants[0].value')).toHaveLength(1);
  });

  it('blames live targeting the file leaves alone on the file’s variants', () => {
    const f = file([
      '  checkout:',
      '    name: Checkout',
      '    variants: [{ key: yes, value: true }, { key: no, value: false }]',
      '    environments:',
      '      development: { enabled: true, offVariant: no, fallthrough: yes }',
    ]);
    const issues = fileIssues(() => planFrom(f, 'web', live([liveFlag()]), OPTIONS, NOW));
    expect(issues).toContainEqual(
      expect.objectContaining({
        line: 6,
        path: 'flags.checkout.variants',
        message: expect.stringContaining(
          'the live targeting in production, which the file leaves alone, unknown variant',
        ),
      }),
    );
  });

  it('blames a pruned flag that others still use on the flags list', () => {
    const f = file(CHECKOUT);
    const state = live([liveFlag(), liveFlag({ key: 'old' })], ['old']);
    const dependent = {
      key: 'dependent',
      type: 'boolean' as const,
      variants: [
        { key: 'on', value: true },
        { key: 'off', value: false },
      ],
      enabled: true,
      offVariant: 'off',
      prerequisites: [{ flag: 'old', variant: 'on' }],
      rules: [],
      fallthrough: { variant: 'on' },
      salt: 'dependent',
      clientSide: false,
      version: 1,
    };
    state.rulesets.set(
      'development',
      ruleset('development', { dependent, old: { ...dependent, key: 'old', prerequisites: [] } }),
    );
    const issues = fileIssues(() =>
      planFrom(f, 'web', state, { prune: true, takeOver: false }, NOW),
    );
    expect(issues).toEqual([
      {
        file: 'flags.yaml',
        line: 3,
        path: 'flags',
        message: 'development: flags.dependent.prerequisites[0].flag: unknown flag "old"',
      },
    ]);
  });
});

describe('planText', () => {
  it('shows each change, how it lands, and the totals', () => {
    const f = file([
      '  checkout:',
      '    name: Checkout 2',
      '    environments:',
      '      development: { enabled: false }',
      '      production: { enabled: true, fallthrough: off }',
      '  fresh:',
      '    environments:',
      '      development: { enabled: true, fallthrough: on }',
    ]);
    const moved = liveFlag({ version: 4 });
    const plan = planFrom(f, 'web', live([moved]), OPTIONS);
    expect(planText(plan).split('\n')).toEqual([
      `Plan for project web from flags.yaml (source ${SOURCE}):`,
      '',
      '~ update flag checkout',
      '    flag (version 4): [drift: changed outside the file since the last apply]',
      '      ~ name: "Checkout" -> "Checkout 2"',
      '    development (version 5):',
      '      ~ enabled: true -> false',
      '      ~ fallthrough.variant: "on" -> "off"',
      '    production (version 3) as a change request:',
      '      ~ fallthrough.variant: "on" -> "off"',
      '',
      '+ create flag fresh (boolean)',
      '    development:',
      '      ~ enabled: false -> true',
      '      ~ fallthrough.variant: "off" -> "on"',
      '',
      'Flags: 1 to create, 1 to update, 0 unchanged. 1 with drift.',
    ]);
    plan.flags[0]!.environments[1]!.pending = 'cr-1';
    expect(planText(plan)).toContain(
      '    production: change request cr-1 already proposes this; waiting for approval',
    );
  });

  it('says when nothing changes, counting requests still waiting', () => {
    const f = file([
      '  checkout:',
      '    name: Checkout',
      '    environments:',
      '      production: { enabled: true, fallthrough: off }',
    ]);
    const plan = planFrom(f, 'web', live([liveFlag()]), OPTIONS);
    expect(hasChanges(plan)).toBe(true);
    plan.flags[0]!.environments[0]!.pending = 'cr-1';
    plan.summary.pending = 1;
    expect(hasChanges(plan)).toBe(false);
    expect(planText(plan)).toContain('No changes. 1 change request still waiting for approval.');
    plan.summary.pending = 2;
    expect(planText(plan)).toContain('No changes. 2 change requests still waiting for approval.');
    const one: Plan = {
      ...plan,
      flags: [],
      summary: { ...plan.summary, pending: 0, unchanged: 1 },
    };
    expect(planText(one)).toContain('No changes. 1 flag match the file.');
  });
});

describe('appliedText', () => {
  it('describes each write', () => {
    expect(appliedText([])).toBe('Nothing to apply.');
    expect(
      appliedText([
        { flag: 'a', step: 'create', version: 1 },
        { flag: 'a', step: 'restore', version: 3 },
        {
          flag: 'a',
          step: 'metadata',
          version: 4,
          note: 'kept beta until targeting moves off them',
        },
        { flag: 'a', step: 'targeting', environment: 'development', version: 2 },
        { flag: 'a', step: 'change-request', environment: 'production', changeRequest: 'cr-1' },
        {
          flag: 'a',
          step: 'variants',
          note: 'variants stay until the change requests in production are applied; apply again then',
        },
        { flag: 'a', step: 'variants', version: 5 },
        { flag: 'b', step: 'archive', version: 9 },
        { flag: 'a', step: 'record' },
      ]).split('\n'),
    ).toEqual([
      'Created a (version 1).',
      'Restored a (version 3).',
      'Updated a (version 4): kept beta until targeting moves off them.',
      'Updated a in development (version 2).',
      'Proposed change request cr-1 for a in production.',
      'Kept old variants of a: variants stay until the change requests in production are applied; apply again then.',
      'Removed old variants of a (version 5).',
      'Archived b (version 9).',
      'Recorded a as managed by this file.',
    ]);
  });
});
