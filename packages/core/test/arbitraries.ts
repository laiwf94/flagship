import fc from 'fast-check';
import {
  ROLLOUT_TOTAL,
  type AttributeClause,
  type Clause,
  type Flag,
  type Prerequisite,
  type Ruleset,
  type Segment,
  type Serve,
  type Variant,
} from '../src/model.js';

export const ATTRIBUTES = ['country', 'plan', 'age', 'version', 'email', 'groups'] as const;

const word = fc.constantFrom('us', 'de', 'jp', 'free', 'pro', 'beta', 'staff', 'acme');

export const attributeClause: fc.Arbitrary<AttributeClause> = fc.oneof(
  fc.record({
    attribute: fc.constantFrom('country', 'plan', 'groups'),
    operator: fc.constantFrom('equals', 'contains', 'startsWith', 'endsWith'),
    values: word.map((w) => [w]),
    negate: fc.boolean(),
  }),
  fc.record({
    attribute: fc.constantFrom('country', 'plan', 'groups'),
    operator: fc.constant('in'),
    values: fc.uniqueArray(word, { minLength: 1, maxLength: 4 }),
    negate: fc.boolean(),
  }),
  fc.record({
    attribute: fc.constant('age'),
    operator: fc.constantFrom('lt', 'lte', 'gt', 'gte'),
    values: fc.integer({ min: 0, max: 100 }).map((n) => [n]),
    negate: fc.boolean(),
  }),
  fc.record({
    attribute: fc.constant('version'),
    operator: fc.constantFrom('semverEq', 'semverLt', 'semverGt'),
    values: fc.tuple(fc.nat(3), fc.nat(3), fc.nat(3)).map(([a, b, c]) => [`${a}.${b}.${c}`]),
    negate: fc.boolean(),
  }),
  fc.record({
    attribute: fc.constant('email'),
    operator: fc.constant('matches'),
    values: fc.constantFrom('@acme\\.com$', '^[a-m]', 'test').map((p) => [p]),
    negate: fc.boolean(),
  }),
);

function serve(variants: readonly string[]): fc.Arbitrary<Serve> {
  const fixed = fc.constantFrom(...variants).map((variant) => ({ variant }));
  const rollout = fc
    .array(fc.nat(ROLLOUT_TOTAL), {
      minLength: variants.length - 1,
      maxLength: variants.length - 1,
    })
    .map((cuts) => {
      const points = [0, ...cuts.sort((a, b) => a - b), ROLLOUT_TOTAL];
      return {
        rollout: {
          variants: variants.map((variant, i) => ({
            variant,
            weight: (points[i + 1] ?? 0) - (points[i] ?? 0),
          })),
        },
      };
    });
  return fc.oneof(fixed, rollout);
}

const segmentArb = (key: string): fc.Arbitrary<Segment> =>
  fc.record({
    key: fc.constant(key),
    included: fc.uniqueArray(fc.constantFrom('alice', 'bob', 'carol', 'dave'), { maxLength: 3 }),
    excluded: fc.uniqueArray(fc.constantFrom('erin', 'frank', 'alice'), { maxLength: 2 }),
    rules: fc
      .array(fc.array(attributeClause, { minLength: 1, maxLength: 3 }), { maxLength: 2 })
      .map((rules) => rules.map((clauses, i) => ({ id: `r${i}`, clauses }))),
    version: fc.constant(1),
  });

function flagArb(
  key: string,
  earlier: readonly Flag[],
  segments: readonly string[],
): fc.Arbitrary<Flag> {
  const clause: fc.Arbitrary<Clause> =
    segments.length === 0
      ? attributeClause
      : fc.oneof(
          attributeClause,
          fc.record({
            operator: fc.constant('inSegment' as const),
            segments: fc.uniqueArray(fc.constantFrom(...segments), { minLength: 1, maxLength: 2 }),
            negate: fc.boolean(),
          }),
        );
  const kinds = fc.constantFrom('boolean', 'string', 'number', 'json');
  return kinds.chain((type) => {
    const variants: fc.Arbitrary<Variant[]> =
      type === 'boolean'
        ? fc.constant<Variant[]>([
            { key: 'on', value: true },
            { key: 'off', value: false },
          ])
        : fc.integer({ min: 2, max: 4 }).map((n) =>
            Array.from({ length: n }, (_, i) => ({
              key: `v${i}`,
              value: type === 'string' ? `value-${i}` : type === 'number' ? i * 1.5 : { tier: i },
            })),
          );
    return variants.chain((vs) => {
      const keys = vs.map((v) => v.key);
      const prereq: fc.Arbitrary<Prerequisite[]> =
        earlier.length === 0
          ? fc.constant([])
          : fc
              .uniqueArray(fc.constantFrom(...earlier), {
                maxLength: 2,
                selector: (f) => f.key,
              })
              .chain((fs) =>
                fc.tuple(
                  ...fs.map((f) =>
                    fc.constantFrom(...f.variants.map((v) => v.key)).map((variant) => ({
                      flag: f.key,
                      variant,
                    })),
                  ),
                ),
              )
              .map((ps) => [...ps]);
      return fc.record({
        key: fc.constant(key),
        type: fc.constant(type),
        variants: fc.constant(vs),
        enabled: fc.boolean(),
        offVariant: fc.constantFrom(...keys),
        prerequisites: prereq,
        rules: fc
          .array(
            fc.record({
              clauses: fc.array(clause, { minLength: 1, maxLength: 3 }),
              serve: serve(keys),
            }),
            { maxLength: 4 },
          )
          .map((rs) => rs.map((r, i) => ({ id: `rule-${i}`, ...r }))),
        fallthrough: serve(keys),
        salt: fc.constant(key),
        clientSide: fc.boolean(),
        version: fc.nat(1000),
      });
    });
  });
}

/** Valid rulesets: prerequisites only point at earlier flags, so there are no cycles. */
export const rulesetArb: fc.Arbitrary<Ruleset> = fc
  .tuple(fc.integer({ min: 0, max: 3 }), fc.integer({ min: 1, max: 6 }))
  .chain(([segmentCount, flagCount]) => {
    const segmentKeys = Array.from({ length: segmentCount }, (_, i) => `segment-${i}`);
    const segments = fc.tuple(...segmentKeys.map(segmentArb));
    const flags = Array.from({ length: flagCount }, (_, i) => `flag-${i}`).reduce<
      fc.Arbitrary<Flag[]>
    >(
      (acc, key) =>
        acc.chain((built) => flagArb(key, built, segmentKeys).map((f) => [...built, f])),
      fc.constant([]),
    );
    return fc.tuple(segments, flags).map(([ss, fs]) => ({
      environment: 'production',
      version: 1,
      flags: Object.fromEntries(fs.map((f) => [f.key, f])),
      segments: Object.fromEntries(ss.map((s) => [s.key, s])),
    }));
  });
