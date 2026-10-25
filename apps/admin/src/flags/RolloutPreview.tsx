import { evaluate, type Evaluation, type Ruleset } from '@flagship/core';
import { useId, useMemo, useState } from 'react';
import { formatValue } from '../format';

const SAMPLE = 10_000;
const sample = Array.from({ length: SAMPLE }, (_, i) => ({ key: `user-${i}` }));

function variantOf(e: Evaluation): string {
  return e.reason === 'ERROR' ? 'error' : e.variant;
}

function parseLine(line: string): Record<string, unknown> | undefined {
  const t = line.trim();
  if (t === '') return undefined;
  if (t.startsWith('{')) {
    try {
      const v: unknown = JSON.parse(t);
      return typeof v === 'object' && v !== null && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : { key: t };
    } catch {
      return { key: t };
    }
  }
  return { key: t };
}

/**
 * Shows who the draft would serve what, computed in the browser with the same
 * evaluator the SDKs run. Sample users have only a key, so this is the
 * picture for the default rule and key-based targeting; specific users can
 * be checked with any attributes.
 */
export function RolloutPreview({
  saved,
  draft,
  flagKey,
}: {
  saved: Ruleset;
  draft: Ruleset;
  flagKey: string;
}) {
  const id = useId();
  const [lines, setLines] = useState(
    'alice\n{"key": "bob", "email": "bob@acme.com", "country": "de"}',
  );

  const { counts, moved } = useMemo(() => {
    const c = new Map<string, number>();
    let changed = 0;
    for (const ctx of sample) {
      const now = variantOf(evaluate(draft, flagKey, ctx));
      c.set(now, (c.get(now) ?? 0) + 1);
      if (variantOf(evaluate(saved, flagKey, ctx)) !== now) changed++;
    }
    return { counts: [...c.entries()].sort((a, b) => b[1] - a[1]), moved: changed };
  }, [saved, draft, flagKey]);

  const checks = useMemo(
    () =>
      lines
        .split('\n')
        .map(parseLine)
        .filter((c): c is Record<string, unknown> => c !== undefined)
        .slice(0, 50)
        .map((ctx) => ({ ctx, result: evaluate(draft, flagKey, ctx) })),
    [lines, draft, flagKey],
  );

  return (
    <section className="card preview" aria-labelledby={`${id}-h`}>
      <header className="card-head">
        <h2 id={`${id}-h`}>Who gets what</h2>
      </header>
      <div
        className="bars"
        role="list"
        aria-label={`Variants for ${SAMPLE.toLocaleString()} sample users`}
      >
        {counts.map(([variant, n]) => (
          <div key={variant} className="bar-row" role="listitem">
            <span className="mono">{variant}</span>
            <span className="bar" aria-hidden="true">
              <span style={{ width: `${(n / SAMPLE) * 100}%` }} />
            </span>
            <span className="bar-value">{((n / SAMPLE) * 100).toFixed(1)}%</span>
          </div>
        ))}
      </div>
      <p className="hint" aria-live="polite">
        {moved === 0
          ? `None of ${SAMPLE.toLocaleString()} sample users would change variant.`
          : `${moved.toLocaleString()} of ${SAMPLE.toLocaleString()} sample users (${((moved / SAMPLE) * 100).toFixed(1)}%) would change variant if you save.`}
      </p>
      <div className="field">
        <label htmlFor={`${id}-u`}>Check specific users</label>
        <textarea
          id={`${id}-u`}
          className="mono"
          value={lines}
          onChange={(e) => {
            setLines(e.target.value);
          }}
        />
        <p className="hint">
          One per line: a user key, or a JSON object with a key and attributes.
        </p>
      </div>
      {checks.length > 0 && (
        <table className="checks">
          <thead>
            <tr>
              <th scope="col">User</th>
              <th scope="col">Gets</th>
              <th scope="col">Why</th>
            </tr>
          </thead>
          <tbody>
            {checks.map(({ ctx, result }, i) => (
              <tr key={i}>
                <td className="mono">{typeof ctx.key === 'string' ? ctx.key : '(no key)'}</td>
                <td>
                  {result.reason === 'ERROR'
                    ? '—'
                    : `${result.variant} (${formatValue(result.value)})`}
                </td>
                <td className="muted small">
                  {result.reason === 'ERROR' ? result.message : REASONS[result.reason]}
                  {result.reason !== 'ERROR' && result.ruleId !== undefined
                    ? ` (${result.ruleId})`
                    : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

const REASONS = {
  DISABLED: 'Flag is off',
  PREREQUISITE_FAILED: 'A prerequisite is not met',
  TARGETING_MATCH: 'Matched a rule',
  SPLIT: 'Percentage rollout',
  DEFAULT: 'Default rule',
} as const;
