import type { Flag, Variant } from '@flagship/core';

export interface VariantDraft {
  key: string;
  value: string;
  name?: string | undefined;
}

export function toDraft(v: Variant, type: Flag['type']): VariantDraft {
  return {
    key: v.key,
    value: type === 'string' && typeof v.value === 'string' ? v.value : JSON.stringify(v.value),
    name: v.name,
  };
}

/** Parses one typed-in value; returns an error message instead of throwing. */
export function parseValue(
  type: Flag['type'],
  raw: string,
): { value: Variant['value'] } | { error: string } {
  if (type === 'string') return { value: raw };
  if (type === 'boolean') {
    if (raw === 'true' || raw === 'false') return { value: raw === 'true' };
    return { error: 'Use true or false' };
  }
  if (type === 'number') {
    const n = Number(raw.trim());
    if (raw.trim() === '' || !Number.isFinite(n))
      return { error: 'Enter a number, like 10 or 2.5' };
    return { value: n };
  }
  try {
    return { value: JSON.parse(raw) as Variant['value'] };
  } catch {
    return { error: 'Enter valid JSON, like {"theme": "dark"}' };
  }
}

export function defaultDrafts(type: Flag['type']): VariantDraft[] {
  switch (type) {
    case 'boolean':
      return [
        { key: 'on', value: 'true' },
        { key: 'off', value: 'false' },
      ];
    case 'string':
      return [
        { key: 'control', value: 'control' },
        { key: 'treatment', value: 'treatment' },
      ];
    case 'number':
      return [
        { key: 'low', value: '10' },
        { key: 'high', value: '50' },
      ];
    case 'json':
      return [
        { key: 'a', value: '{}' },
        { key: 'b', value: '{}' },
      ];
  }
}
