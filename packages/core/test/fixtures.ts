import type { Flag, Ruleset, Segment } from '../src/model.js';

export function booleanFlag(key: string, overrides: Partial<Flag> = {}): Flag {
  return {
    key,
    type: 'boolean',
    variants: [
      { key: 'on', value: true },
      { key: 'off', value: false },
    ],
    enabled: true,
    offVariant: 'off',
    prerequisites: [],
    rules: [],
    fallthrough: { variant: 'off' },
    salt: key,
    clientSide: false,
    version: 1,
    ...overrides,
  };
}

export function segment(key: string, overrides: Partial<Segment> = {}): Segment {
  return { key, included: [], excluded: [], rules: [], version: 1, ...overrides };
}

export function ruleset(flags: Flag[], segments: Segment[] = []): Ruleset {
  return {
    environment: 'production',
    version: 1,
    flags: Object.fromEntries(flags.map((f) => [f.key, f])),
    segments: Object.fromEntries(segments.map((s) => [s.key, s])),
  };
}
