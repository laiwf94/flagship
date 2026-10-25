// Local evaluation cost: ns per evaluate() call for three ruleset shapes.
// Run with `pnpm bench` (builds @flagship/core first).
import { evaluate, evaluateAll, validateRuleset } from '../packages/core/dist/index.js';

const variants = [
  { key: 'on', value: true },
  { key: 'off', value: false },
];
const flag = (key, extra = {}) => ({
  key,
  type: 'boolean',
  variants,
  enabled: true,
  offVariant: 'off',
  prerequisites: [],
  rules: [],
  fallthrough: { variant: 'on' },
  salt: key,
  clientSide: true,
  version: 1,
  ...extra,
});
const rollout = (on) => ({
  rollout: {
    variants: [
      { variant: 'on', weight: on },
      { variant: 'off', weight: 100_000 - on },
    ],
  },
});
const members = Array.from({ length: 1000 }, (_, i) => `member-${i}`);

function ruleset(flags, segments = []) {
  const rs = {
    environment: 'bench',
    version: 1,
    flags: Object.fromEntries(flags.map((f) => [f.key, f])),
    segments: Object.fromEntries(segments.map((s) => [s.key, s])),
  };
  const v = validateRuleset(rs);
  if (!v.ok) throw new Error(JSON.stringify(v.issues));
  return v.value;
}

const typicalRules = Array.from({ length: 5 }, (_, i) => ({
  id: `r${i}`,
  clauses: [
    { attribute: 'country', operator: 'in', values: ['us', 'ca', 'gb', `x${i}`] },
    { attribute: 'email', operator: 'endsWith', values: [`@corp${i}.com`] },
    { attribute: 'appVersion', operator: 'semverGt', values: ['4.2.0'] },
  ],
  serve: { variant: 'on' },
}));

const largeRules = Array.from({ length: 50 }, (_, i) => ({
  id: `r${i}`,
  clauses: [
    { attribute: 'email', operator: 'matches', values: [`^[a-z]+\\.${i}@example\\.(?:com|io)$`] },
    { attribute: 'plan', operator: 'in', values: ['free', 'pro', `p${i}`] },
    { attribute: 'seats', operator: 'gte', values: [i * 10] },
  ],
  serve: { variant: i % 2 === 0 ? 'on' : 'off' },
}));

const segment = {
  key: 'beta',
  included: members,
  excluded: [],
  rules: [
    { id: 's', clauses: [{ attribute: 'email', operator: 'endsWith', values: ['@acme.com'] }] },
  ],
  version: 1,
};

const cases = [
  ['small: one flag, no rules', ruleset([flag('f')])],
  [
    'typical: 5 rules x 3 clauses, 1k-member segment, 10% rollout',
    ruleset(
      [
        flag('f', {
          rules: [
            {
              id: 'seg',
              clauses: [{ operator: 'inSegment', segments: ['beta'] }],
              serve: { variant: 'on' },
            },
            ...typicalRules,
          ],
          fallthrough: rollout(10_000),
        }),
      ],
      [segment],
    ),
  ],
  [
    'large: 50 rules with regex, 2 prerequisites',
    ruleset([
      flag('p1'),
      flag('p2', { prerequisites: [{ flag: 'p1', variant: 'on' }] }),
      flag('f', {
        prerequisites: [
          { flag: 'p2', variant: 'on' },
          { flag: 'p1', variant: 'on' },
        ],
        rules: largeRules,
        fallthrough: rollout(50_000),
      }),
    ]),
  ],
];

// The worst path: the context matches no rule, so every clause is checked.
const contexts = Array.from({ length: 1024 }, (_, i) => ({
  key: `user-${i}`,
  country: 'de',
  email: `person.${i}@shop.example`,
  appVersion: '4.1.9',
  plan: 'enterprise',
  seats: 3,
}));

function measure(fn, iterations) {
  for (let i = 0; i < iterations / 10; i++) fn(i);
  const runs = [];
  for (let r = 0; r < 5; r++) {
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) fn(i);
    runs.push(Number(process.hrtime.bigint() - start) / iterations);
  }
  runs.sort((a, b) => a - b);
  return runs[2];
}

let sink = 0;
const rows = [];
for (const [name, rs] of cases) {
  const ns = measure((i) => {
    const e = evaluate(rs, 'f', contexts[i & 1023]);
    sink += e.reason.length;
  }, 200_000);
  rows.push([name, ns]);
}

const many = ruleset(
  Array.from({ length: 200 }, (_, i) =>
    flag(`f${i}`, { rules: typicalRules, fallthrough: rollout(i * 500) }),
  ),
);
rows.push([
  'evaluateAll: 200 typical flags (one client-side request)',
  measure((i) => {
    sink += Object.keys(evaluateAll(many, contexts[i & 1023])).length;
  }, 10_000),
]);

const fmt = (ns) =>
  ns >= 1e6
    ? `${(ns / 1e6).toFixed(2)} ms`
    : ns >= 1e3
      ? `${(ns / 1e3).toFixed(2)} µs`
      : `${ns.toFixed(0)} ns`;
console.log(`node ${process.version}, ${process.arch}\n`);
console.log('| Case | Time per evaluation |');
console.log('|---|---|');
for (const [name, ns] of rows) console.log(`| ${name} | ${fmt(ns)} |`);
if (sink === 0) console.log('');
