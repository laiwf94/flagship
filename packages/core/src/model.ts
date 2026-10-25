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
