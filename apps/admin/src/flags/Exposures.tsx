import { useState } from 'react';
import { api, type FlagDetail } from '../api';
import { Card, EmptyState, ErrorState, Loading, Segmented } from '../components/ui';
import { formatValue } from '../format';
import { useResource } from '../hooks';

const RANGES = [
  { value: '24', label: '24 hours' },
  { value: '168', label: '7 days' },
  { value: '720', label: '30 days' },
] as const;

type Range = (typeof RANGES)[number]['value'];

/** How often each variant was served, as reported by SDKs. */
export function Exposures({
  project,
  flag,
  env,
  envName,
}: {
  project: string;
  flag: FlagDetail;
  env: string;
  envName: string;
}) {
  const [range, setRange] = useState<Range>('24');
  const data = useResource(
    () => api.exposures(project, flag.key, env, Number(range)),
    `${project}/${flag.key}/${env}/${range}`,
  );
  const total = data.data?.totals.reduce((n, v) => n + v.count, 0) ?? 0;

  return (
    <Card
      title={`Variants served in ${envName}`}
      actions={
        <Segmented label="Time range" value={range} options={[...RANGES]} onChange={setRange} />
      }
    >
      {data.error !== undefined ? (
        <ErrorState message={data.error.message} onRetry={data.reload} />
      ) : data.data === undefined ? (
        <Loading rows={2} label="Loading counts" />
      ) : total === 0 ? (
        <EmptyState icon="chart" title="No evaluations reported">
          Counts appear here once apps using an SDK evaluate this flag. They arrive within about a
          minute.
        </EmptyState>
      ) : (
        <>
          <p className="muted small">
            {total.toLocaleString()} evaluations reported by SDKs. Browser SDKs report only flags
            available to client-side apps.
          </p>
          <div className="bars" role="list" aria-label="Evaluations by variant">
            {data.data.totals.map((t) => {
              const variant = flag.variants.find((v) => v.key === t.variant);
              return (
                <div className="bar-row exposures-row" role="listitem" key={t.variant}>
                  <span>
                    <span className="mono">{t.variant}</span>
                    {variant !== undefined && (
                      <span className="muted small"> {formatValue(variant.value)}</span>
                    )}
                  </span>
                  <span className="bar" aria-hidden="true">
                    <span style={{ width: `${(t.count / total) * 100}%` }} />
                  </span>
                  <span className="bar-value">
                    {t.count.toLocaleString()} · {((t.count / total) * 100).toFixed(1)}%
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </Card>
  );
}
