import { z } from 'zod';

/**
 * Hard limits on ruleset size. They bound evaluation cost in every SDK and the
 * size of a snapshot on the wire, so the server enforces them on write and the
 * SDKs enforce them again on receipt.
 */
export const LIMITS = {
  keyLength: 100,
  variantsPerFlag: 20,
  stringValueLength: 4096,
  jsonValueBytes: 32_768,
  rulesPerFlag: 100,
  clausesPerRule: 20,
  valuesPerClause: 1000,
  clauseValueLength: 1024,
  segmentsPerClause: 20,
  prerequisitesPerFlag: 10,
  prerequisiteDepth: 10,
  segmentMembers: 10_000,
  segmentMemberLength: 256,
  segmentRules: 50,
  attributeNameLength: 64,
  descriptionLength: 500,
  regexPatternLength: 256,
  regexInputLength: 1024,
  contextAttributes: 100,
  contextStringLength: 1024,
  contextArrayLength: 100,
  flagsPerRuleset: 5000,
  segmentsPerRuleset: 1000,
  rolloutSteps: 20,
  /** Longest hold on one rollout step: 30 days. */
  rolloutHoldMinutes: 43_200,
} as const;

/** Rollout weights are integers out of this total, so 1 unit is 0.001%. */
export const ROLLOUT_TOTAL = 100_000;

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const KEY_MESSAGE =
  'must start with a letter or digit and use only letters, digits, ".", "_" and "-"';

export const keySchema = z.string().min(1).max(LIMITS.keyLength).regex(KEY_PATTERN, KEY_MESSAGE);

export const attributeNameSchema = z
  .string()
  .min(1)
  .max(LIMITS.attributeNameLength)
  .regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/, 'must be a plain attribute name such as "country"');

export const ATTRIBUTE_OPERATORS = [
  'equals',
  'in',
  'contains',
  'startsWith',
  'endsWith',
  'matches',
  'lt',
  'lte',
  'gt',
  'gte',
  'semverEq',
  'semverLt',
  'semverGt',
] as const;
export type AttributeOperator = (typeof ATTRIBUTE_OPERATORS)[number];

export const clauseValueSchema = z.union([
  z.string().max(LIMITS.clauseValueLength),
  z.number(),
  z.boolean(),
]);
export type ClauseValue = z.infer<typeof clauseValueSchema>;

export const attributeClauseSchema = z.strictObject({
  attribute: attributeNameSchema,
  operator: z.enum(ATTRIBUTE_OPERATORS),
  values: z.array(clauseValueSchema).min(1).max(LIMITS.valuesPerClause),
  negate: z.boolean().optional(),
});
export type AttributeClause = z.infer<typeof attributeClauseSchema>;

export const segmentClauseSchema = z.strictObject({
  operator: z.literal('inSegment'),
  segments: z.array(keySchema).min(1).max(LIMITS.segmentsPerClause),
  negate: z.boolean().optional(),
});
export type SegmentClause = z.infer<typeof segmentClauseSchema>;

export const clauseSchema = z.union([segmentClauseSchema, attributeClauseSchema]);
export type Clause = z.infer<typeof clauseSchema>;

export const weightedVariantSchema = z.strictObject({
  variant: keySchema,
  weight: z.int().min(0).max(ROLLOUT_TOTAL),
});

export const rolloutSchema = z
  .strictObject({
    bucketBy: attributeNameSchema.optional(),
    variants: z.array(weightedVariantSchema).min(1).max(LIMITS.variantsPerFlag),
  })
  .refine((r) => r.variants.reduce((sum, v) => sum + v.weight, 0) === ROLLOUT_TOTAL, {
    message: `weights must add up to ${ROLLOUT_TOTAL} (100%)`,
    path: ['variants'],
  });
export type Rollout = z.infer<typeof rolloutSchema>;

export const serveSchema = z.union([
  z.strictObject({ variant: keySchema }),
  z.strictObject({ rollout: rolloutSchema }),
]);
export type Serve = z.infer<typeof serveSchema>;

const ruleIdSchema = keySchema.max(64);

export const ruleSchema = z.strictObject({
  id: ruleIdSchema,
  description: z.string().max(LIMITS.descriptionLength).optional(),
  clauses: z.array(clauseSchema).min(1).max(LIMITS.clausesPerRule),
  serve: serveSchema,
});
export type Rule = z.infer<typeof ruleSchema>;

/** Where a rollout plan writes its split: the default rule or one rule, by id. */
export const rolloutTargetSchema = z.union([
  z.literal('fallthrough'),
  z.strictObject({ rule: ruleIdSchema }),
]);
export type RolloutTarget = z.infer<typeof rolloutTargetSchema>;

export const rolloutStepSchema = z.strictObject({
  /** Share of contexts on the rolled-out variant, out of ROLLOUT_TOTAL. */
  weight: z.int().min(1).max(ROLLOUT_TOTAL),
  /** Minutes to stay on this step before the next one; not used on the last step. */
  holdMinutes: z.int().min(1).max(LIMITS.rolloutHoldMinutes).optional(),
});
export type RolloutStep = z.infer<typeof rolloutStepSchema>;

/**
 * A progressive rollout of one variant over another on one serve of a flag.
 * Steps only grow, so with the sticky bucketing in bucket.ts nobody who got
 * `variant` at one step loses it at the next; the last step is 100%.
 */
export const rolloutPlanSchema = z
  .strictObject({
    target: rolloutTargetSchema,
    variant: keySchema,
    baseline: keySchema,
    bucketBy: attributeNameSchema.optional(),
    steps: z.array(rolloutStepSchema).min(1).max(LIMITS.rolloutSteps),
  })
  .superRefine((plan, ctx) => {
    if (plan.variant === plan.baseline) {
      ctx.addIssue({
        code: 'custom',
        path: ['baseline'],
        message: 'must differ from the rolled-out variant',
      });
    }
    plan.steps.forEach((step, i) => {
      const prev = plan.steps[i - 1];
      if (prev !== undefined && step.weight <= prev.weight) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps', i, 'weight'],
          message: 'must be larger than the step before',
        });
      }
      if (i < plan.steps.length - 1 && step.holdMinutes === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps', i, 'holdMinutes'],
          message: 'is required on every step but the last',
        });
      }
    });
    if (plan.steps.at(-1)?.weight !== ROLLOUT_TOTAL) {
      ctx.addIssue({
        code: 'custom',
        path: ['steps', plan.steps.length - 1, 'weight'],
        message: `the last step must be ${ROLLOUT_TOTAL} (100%)`,
      });
    }
  });
export type RolloutPlan = z.infer<typeof rolloutPlanSchema>;

export const prerequisiteSchema = z.strictObject({
  flag: keySchema,
  variant: keySchema,
});
export type Prerequisite = z.infer<typeof prerequisiteSchema>;

export const FLAG_TYPES = ['boolean', 'string', 'number', 'json'] as const;
export type FlagType = (typeof FLAG_TYPES)[number];

export const variantSchema = z.strictObject({
  key: keySchema,
  value: z.json(),
  name: z.string().max(100).optional(),
});
export type Variant = z.infer<typeof variantSchema>;

export const flagSchema = z.strictObject({
  key: keySchema,
  type: z.enum(FLAG_TYPES),
  variants: z.array(variantSchema).min(2).max(LIMITS.variantsPerFlag),
  /** Kill switch. When false every context gets `offVariant` and nothing else runs. */
  enabled: z.boolean(),
  offVariant: keySchema,
  prerequisites: z.array(prerequisiteSchema).max(LIMITS.prerequisitesPerFlag),
  rules: z.array(ruleSchema).max(LIMITS.rulesPerFlag),
  fallthrough: serveSchema,
  /** Mixed into the bucketing hash so two flags at 50% split users independently. */
  salt: z.string().min(1).max(LIMITS.keyLength),
  /** Whether client-side keys may see this flag's evaluated value. */
  clientSide: z.boolean(),
  version: z.int().min(0),
});
export type Flag = z.infer<typeof flagSchema>;

export const segmentRuleSchema = z.strictObject({
  id: ruleIdSchema,
  clauses: z.array(attributeClauseSchema).min(1).max(LIMITS.clausesPerRule),
});
export type SegmentRule = z.infer<typeof segmentRuleSchema>;

const memberSchema = z.string().min(1).max(LIMITS.segmentMemberLength);

export const segmentSchema = z.strictObject({
  key: keySchema,
  included: z.array(memberSchema).max(LIMITS.segmentMembers),
  excluded: z.array(memberSchema).max(LIMITS.segmentMembers),
  rules: z.array(segmentRuleSchema).max(LIMITS.segmentRules),
  version: z.int().min(0),
});
export type Segment = z.infer<typeof segmentSchema>;

export const rulesetSchema = z.strictObject({
  environment: keySchema,
  version: z.int().min(0),
  flags: z.record(keySchema, flagSchema),
  segments: z.record(keySchema, segmentSchema),
  /** RulesetDigest checksum of flags and segments, sent by the server for SDKs to verify. */
  checksum: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hex digits')
    .optional(),
});
export type Ruleset = z.infer<typeof rulesetSchema>;

const contextValueSchema = z.union([
  z.string().max(LIMITS.contextStringLength),
  z.number(),
  z.boolean(),
  z.null(),
  z
    .array(z.union([z.string().max(LIMITS.contextStringLength), z.number(), z.boolean()]))
    .max(LIMITS.contextArrayLength),
]);
export type ContextValue = z.infer<typeof contextValueSchema>;

/**
 * The attributes of whoever a flag is evaluated for. `key` identifies them and
 * is what percentage rollouts hash by default.
 */
export const contextSchema = z
  .record(attributeNameSchema, contextValueSchema)
  .refine((c) => typeof c.key === 'string' && c.key.length > 0, {
    message: 'key is required and must be a non-empty string',
    path: ['key'],
  })
  .refine((c) => Object.keys(c).length <= LIMITS.contextAttributes, {
    message: `at most ${LIMITS.contextAttributes} attributes`,
  });
export type Context = { key: string } & Record<string, ContextValue>;

/** Own-property lookup, so a key like "constructor" never reaches Object.prototype. */
export function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}
