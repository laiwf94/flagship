import { ROLLOUT_TOTAL, type Serve, type Variant } from '@flagship/core';
import { useId } from 'react';
import { Segmented } from '../components/ui';
import { percent } from '../format';
import { evenRollout } from './rules';

/** Picks a single variant or a percentage split between variants. */
export function ServeEditor({
  serve,
  variants,
  onChange,
  label,
}: {
  serve: Serve;
  variants: Variant[];
  onChange: (serve: Serve) => void;
  label: string;
}) {
  const id = useId();
  const mode = 'variant' in serve ? 'variant' : 'rollout';
  const total =
    'rollout' in serve ? serve.rollout.variants.reduce((n, v) => n + v.weight, 0) : ROLLOUT_TOTAL;
  const boolean = variants.length === 2 && variants.some((v) => v.value === true);

  return (
    <div className="serve">
      <Segmented
        label={`${label}: how to serve`}
        value={mode}
        options={[
          { value: 'variant', label: 'One variant' },
          { value: 'rollout', label: 'Percentage rollout' },
        ]}
        onChange={(m) => {
          if (m === mode) return;
          onChange(m === 'variant' ? { variant: variants[0]?.key ?? '' } : evenRollout(variants));
        }}
      />
      {'variant' in serve ? (
        <div className="field">
          <label htmlFor={`${id}-v`}>{label}</label>
          <select
            id={`${id}-v`}
            value={serve.variant}
            onChange={(e) => {
              onChange({ variant: e.target.value });
            }}
          >
            {variants.map((v) => (
              <option key={v.key} value={v.key}>
                {v.key} ({JSON.stringify(v.value)})
              </option>
            ))}
          </select>
        </div>
      ) : (
        <div className="rollout">
          {boolean && serve.rollout.variants.length === 2 && (
            <RolloutSlider
              serve={serve}
              onChange={onChange}
              onKey={variants.find((v) => v.value === true)?.key ?? ''}
              offKey={variants.find((v) => v.value === false)?.key ?? ''}
            />
          )}
          <div className="weights">
            {serve.rollout.variants.map((wv, i) => (
              <div className="weight-row" key={wv.variant}>
                <label htmlFor={`${id}-w${i}`} className="mono">
                  {wv.variant}
                </label>
                <input
                  id={`${id}-w${i}`}
                  type="number"
                  min={0}
                  max={100}
                  step={0.1}
                  inputMode="decimal"
                  value={wv.weight / 1000}
                  onChange={(e) => {
                    const p = Number(e.target.value);
                    const weight = Number.isFinite(p)
                      ? Math.round(Math.min(100, Math.max(0, p)) * 1000)
                      : 0;
                    onChange({
                      rollout: {
                        ...serve.rollout,
                        variants: serve.rollout.variants.map((x, j) =>
                          j === i ? { ...x, weight } : x,
                        ),
                      },
                    });
                  }}
                />
                <span aria-hidden="true">%</span>
              </div>
            ))}
          </div>
          {total !== ROLLOUT_TOTAL && (
            <p className="field-error" role="alert">
              Percentages add up to {percent(total)}; they need to add up to 100%.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function RolloutSlider({
  serve,
  onChange,
  onKey,
  offKey,
}: {
  serve: Extract<Serve, { rollout: unknown }>;
  onChange: (serve: Serve) => void;
  onKey: string;
  offKey: string;
}) {
  const id = useId();
  const on = serve.rollout.variants.find((v) => v.variant === onKey)?.weight ?? 0;
  return (
    <div className="field">
      <label htmlFor={id}>Turned on for {percent(on)} of users</label>
      <input
        id={id}
        type="range"
        min={0}
        max={100}
        step={1}
        value={Math.round(on / 1000)}
        aria-valuetext={`${percent(on)} on`}
        onChange={(e) => {
          const w = Number(e.target.value) * 1000;
          onChange({
            rollout: {
              ...serve.rollout,
              variants: [
                { variant: onKey, weight: w },
                { variant: offKey, weight: ROLLOUT_TOTAL - w },
              ],
            },
          });
        }}
      />
      <p className="hint">Raising the percentage only adds users; everyone already on stays on.</p>
    </div>
  );
}
