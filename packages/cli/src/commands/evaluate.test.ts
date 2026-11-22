import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bucketOf, type Ruleset } from '@flagship/core';
import { describe, expect, it } from 'vitest';
import { harness } from '../../test/memory-io.js';

const boolean = [
  { key: 'on', value: true },
  { key: 'off', value: false },
];

const ruleset: Ruleset = {
  environment: 'production',
  version: 7,
  flags: {
    billing: {
      key: 'billing',
      type: 'boolean',
      variants: boolean,
      enabled: true,
      offVariant: 'off',
      prerequisites: [],
      rules: [],
      fallthrough: { variant: 'on' },
      salt: 'billing',
      clientSide: false,
      version: 1,
    },
    checkout: {
      key: 'checkout',
      type: 'boolean',
      variants: boolean,
      enabled: true,
      offVariant: 'off',
      prerequisites: [{ flag: 'billing', variant: 'on' }],
      rules: [
        {
          id: 'staff',
          description: 'Our own people',
          clauses: [
            { attribute: 'email', operator: 'endsWith', values: ['@example.com'] },
            { attribute: 'age', operator: 'gte', values: [18], negate: true },
          ],
          serve: { variant: 'on' },
        },
        {
          id: 'beta',
          clauses: [{ operator: 'inSegment', segments: ['beta', 'staff'] }],
          serve: { variant: 'on' },
        },
        {
          id: 'pro',
          clauses: [{ attribute: 'plan', operator: 'in', values: ['pro'] }],
          serve: { variant: 'on' },
        },
      ],
      fallthrough: {
        rollout: {
          bucketBy: 'org',
          variants: [
            { variant: 'on', weight: 25_000 },
            { variant: 'off', weight: 75_000 },
          ],
        },
      },
      salt: 'checkout-salt',
      clientSide: false,
      version: 3,
    },
    killed: {
      key: 'killed',
      type: 'boolean',
      variants: boolean,
      enabled: false,
      offVariant: 'off',
      prerequisites: [],
      rules: [],
      fallthrough: { variant: 'on' },
      salt: 'killed',
      clientSide: false,
      version: 1,
    },
    'needs-killed': {
      key: 'needs-killed',
      type: 'boolean',
      variants: boolean,
      enabled: true,
      offVariant: 'off',
      prerequisites: [{ flag: 'killed', variant: 'on' }],
      rules: [],
      fallthrough: { variant: 'on' },
      salt: 'nk',
      clientSide: false,
      version: 1,
    },
  },
  segments: {
    beta: { key: 'beta', included: ['bob'], excluded: [], rules: [], version: 1 },
    staff: { key: 'staff', included: [], excluded: [], rules: [], version: 1 },
  },
};

function setup() {
  const h = harness();
  writeFileSync(join(h.dir, 'ruleset.json'), JSON.stringify(ruleset));
  return h;
}

describe('flagship eval', () => {
  it('explains a split with the bucket, from a saved ruleset, without a server', async () => {
    const { cli } = setup();
    const r = await cli([
      'eval',
      'checkout',
      '--ruleset',
      'ruleset.json',
      '--key',
      'carol',
      '--attr',
      'org=acme',
      '--attr',
      'age=30',
      '--attr',
      'email=carol@other.org',
    ]);
    const bucket = bucketOf('checkout-salt', 'acme');
    const variant = bucket < 25_000 ? 'on' : 'off';
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(
      [
        `checkout = ${variant === 'on'} (variant ${variant}, SPLIT)`,
        '  in ruleset.json for {"org":"acme","age":30,"email":"carol@other.org","key":"carol"}',
        '',
        '  1. kill switch: on',
        '  2. prerequisite billing must serve on: it served on, passed',
        '  3. rule staff (Our own people): no match',
        '      no   email endsWith "@example.com"',
        '      no   age not gte 18',
        '  4. rule beta: no match',
        '      no   in segment beta (not in), staff (not in)',
        '  5. rule pro: no match',
        '      no   plan in "pro"',
        '  6. default rule: serves on 25% / off 75% by org',
        `      bucket ${bucket} of 100000 (${(bucket / 1000).toFixed(3)}%) by org = "acme"`,
      ].join('\n'),
    );
  });

  it('says which rule matched and how many were not reached', async () => {
    const { cli } = setup();
    const r = await cli(['eval', 'checkout', '--ruleset', 'ruleset.json', '--key', 'bob']);
    expect(r.stdout.split('\n')[0]).toBe(
      'checkout = true (variant on, TARGETING_MATCH by rule beta)',
    );
    expect(r.stdout).toContain('      yes  in segment beta (in), staff (not in)');
    expect(r.stdout).toMatch(/\(1 later rule not reached\)$/);
    const staff = await cli([
      'eval',
      'checkout',
      '--ruleset',
      'ruleset.json',
      '--context',
      '{"key":"s","email":"s@example.com","age":17}',
    ]);
    expect(staff.stdout).toMatch(/\(2 later rules not reached\)$/);
  });

  it('prints the trace as JSON, with the evaluation SDKs would return', async () => {
    const { cli } = setup();
    const r = await cli(['eval', 'killed', '--ruleset', 'ruleset.json', '--key', 'k', '--json']);
    expect(r.json()).toEqual({
      source: 'ruleset.json',
      flag: 'killed',
      context: { key: 'k' },
      evaluation: { reason: 'DISABLED', variant: 'off', value: false },
      trace: [{ step: 'killSwitch', enabled: false }],
    });
    const text = await cli(['eval', 'killed', '--ruleset', 'ruleset.json', '--key', 'k']);
    expect(text.stdout).toContain('kill switch: off, so the off variant is served');
    const pre = await cli(['eval', 'needs-killed', '--ruleset', 'ruleset.json', '--key', 'k']);
    expect(pre.stdout).toContain(
      'prerequisite killed must serve on: it served off and is off, failed',
    );
  });

  it('exits 1 when the evaluation is an error', async () => {
    const { cli } = setup();
    const r = await cli(['eval', 'nope', '--ruleset', 'ruleset.json', '--key', 'k']);
    expect(r.status).toBe(1);
    expect(r.stdout.split('\n')[0]).toBe('nope = error FLAG_NOT_FOUND: no flag "nope"');
  });

  it('evaluates every flag with --all, reading the ruleset from stdin', async () => {
    const { cli } = setup();
    const r = await cli(['eval', '--all', '--ruleset', '-', '--key', 'bob'], {
      stdin: JSON.stringify(ruleset),
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(
      [
        'FLAG          VALUE  VARIANT  REASON',
        'billing       true   on       DEFAULT',
        'checkout      true   on       TARGETING_MATCH (beta)',
        'killed        false  off      DISABLED',
        'needs-killed  false  off      PREREQUISITE_FAILED',
      ].join('\n'),
    );
    const j = await cli(['eval', '--all', '--ruleset', '-', '--key', 'bob', '--json'], {
      stdin: JSON.stringify(ruleset),
    });
    expect(j.json().results.checkout).toEqual({
      reason: 'TARGETING_MATCH',
      variant: 'on',
      value: true,
      ruleId: 'beta',
    });
    const empty = await cli(['eval', '--all', '--ruleset', '-', '--key', 'bob'], {
      stdin: JSON.stringify({ ...ruleset, flags: {}, segments: {} }),
    });
    expect(empty.stdout).toBe('No flags in stdin.');
  });

  it('refuses bad input', async () => {
    const { cli } = setup();
    const cases: [string[], string, string?][] = [
      [['eval', '--ruleset', 'ruleset.json', '--key', 'k'], 'name one flag, or pass --all'],
      [['eval', 'a', '--all', '--ruleset', 'ruleset.json', '--key', 'k'], 'name one flag'],
      [['eval', 'checkout', '--ruleset', 'ruleset.json'], 'the context needs a key'],
      [['eval', 'checkout', '--ruleset', 'ruleset.json', '--attr', 'x'], '--attr takes name=value'],
      [
        ['eval', 'checkout', '--ruleset', 'ruleset.json', '--context', '[1]'],
        'must be a JSON object',
      ],
      [
        ['eval', 'checkout', '--ruleset', 'ruleset.json', '--context', '{'],
        '--context in the argument is not valid JSON',
      ],
      [
        ['eval', 'checkout', '--ruleset', 'nope.json', '--key', 'k'],
        "can't read ruleset from nope.json",
      ],
      [
        ['eval', 'checkout', '--ruleset', '-', '--key', 'k'],
        'ruleset in stdin is not valid JSON',
        '',
      ],
    ];
    for (const [argv, message, stdin] of cases) {
      const r = await cli(argv, stdin === undefined ? {} : { stdin });
      expect(r.status, argv.join(' ')).toBe(2);
      expect(r.stderr, argv.join(' ')).toContain(message);
    }
    const invalid = await cli(['eval', 'x', '--ruleset', '-', '--key', 'k', '--json'], {
      stdin: '{"environment":"p","version":1,"flags":{"x":{}},"segments":{}}',
    });
    expect(invalid.status).toBe(1);
    expect(JSON.parse(invalid.stderr).error).toMatchObject({
      code: 'invalid_ruleset',
      message: 'the ruleset from stdin is not valid',
      details: expect.arrayContaining([
        expect.objectContaining({ path: expect.stringMatching(/^flags\.x/) }),
      ]),
    });
  });

  it('keeps --attr values that are not JSON as strings, and lets --key win', async () => {
    const { cli } = setup();
    const r = await cli([
      'eval',
      'billing',
      '--ruleset',
      'ruleset.json',
      '--context',
      '{"key":"a","n":1}',
      '--attr',
      'id=007',
      '--attr',
      'tags=["x"]',
      '--attr',
      'eq=a=b',
      '--key',
      'b',
      '--json',
    ]);
    expect(r.json().context).toEqual({ key: 'b', n: 1, id: '007', tags: ['x'], eq: 'a=b' });
  });
});
