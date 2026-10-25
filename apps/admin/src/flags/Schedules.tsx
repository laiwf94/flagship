import { useState, type SyntheticEvent } from 'react';
import { ApiError, api, type FlagDetail, type Schedule } from '../api';
import { Dialog } from '../components/dialog';
import { useToast } from '../components/toast';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  Segmented,
  type Tone,
} from '../components/ui';
import { fullDate, timeAgo } from '../format';
import { useResource } from '../hooks';
import { describeServe, twoWay } from './rules';

const STATUS: Record<Schedule['status'], { tone: Tone; label: string }> = {
  pending: { tone: 'info', label: 'Scheduled' },
  applied: { tone: 'success', label: 'Applied' },
  failed: { tone: 'critical', label: 'Failed' },
  cancelled: { tone: 'neutral', label: 'Cancelled' },
};

function describe(change: Schedule['change']): string {
  const parts: string[] = [];
  if (change.enabled !== undefined) parts.push(change.enabled ? 'Turn on' : 'Turn off');
  if (change.fallthrough !== undefined)
    parts.push(`Default rule: ${describeServe(change.fallthrough)}`);
  if (change.rules !== undefined) parts.push(`Replace rules (${change.rules.length})`);
  return parts.join(' · ');
}

/** Value for a datetime-local input, one hour from now, in local time. */
function inAnHour(now = new Date()): string {
  const d = new Date(now.getTime() + 3_600_000);
  d.setSeconds(0, 0);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

type Kind = 'on' | 'off' | 'rollout';

export function Schedules({
  project,
  flag,
  env,
  envName,
  canEdit,
}: {
  project: string;
  flag: FlagDetail;
  env: string;
  envName: string;
  canEdit: boolean;
}) {
  const toast = useToast();
  const list = useResource(
    () => api.schedules(project, flag.key, env),
    `${project}/${flag.key}/${env}`,
  );
  const [adding, setAdding] = useState(false);
  const [cancelling, setCancelling] = useState<Schedule | undefined>();
  const boolean = flag.type === 'boolean';

  return (
    <Card
      title={`Scheduled changes in ${envName}`}
      actions={
        canEdit && !flag.archived ? (
          <Button
            icon="clock"
            onClick={() => {
              setAdding(true);
            }}
          >
            Schedule a change
          </Button>
        ) : undefined
      }
    >
      {list.error !== undefined ? (
        <ErrorState message={list.error.message} onRetry={list.reload} />
      ) : list.data === undefined ? (
        <Loading rows={2} label="Loading scheduled changes" />
      ) : list.data.schedules.length === 0 ? (
        <EmptyState icon="clock" title="Nothing scheduled">
          Schedule a launch or a rollout step, and it happens on time without anyone at a keyboard.
        </EmptyState>
      ) : (
        <ul className="rows" aria-label="Scheduled changes">
          {list.data.schedules.map((s) => (
            <li key={s.id} className="row schedule-row">
              <span className="row-title">
                <strong>{describe(s.change)}</strong>
                <span className="muted small" title={fullDate(s.runAt)}>
                  {fullDate(s.runAt)} ({timeAgo(s.runAt)}) · by {s.createdBy}
                </span>
                {s.error !== null && <span className="field-error">{s.error}</span>}
              </span>
              <span>
                <Badge tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Badge>
              </span>
              <span>
                {canEdit && s.status === 'pending' && (
                  <Button
                    variant="plain"
                    onClick={() => {
                      setCancelling(s);
                    }}
                  >
                    Cancel
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <ScheduleDialog
          boolean={boolean}
          onClose={() => {
            setAdding(false);
          }}
          onSubmit={async (runAt, kind, percent) => {
            const on = flag.variants.find((v) => v.value === true)?.key ?? '';
            const off = flag.variants.find((v) => v.value === false)?.key ?? '';
            const change: Schedule['change'] =
              kind === 'rollout'
                ? { enabled: true, fallthrough: twoWay(on, off, percent) }
                : { enabled: kind === 'on' };
            await api.createSchedule(project, flag.key, env, { runAt, change });
            setAdding(false);
            toast(`Scheduled for ${fullDate(runAt)}.`);
            list.reload();
          }}
        />
      )}
      {cancelling !== undefined && (
        <Dialog
          title="Cancel this scheduled change?"
          onClose={() => {
            setCancelling(undefined);
          }}
          footer={
            <>
              <Button
                onClick={() => {
                  setCancelling(undefined);
                }}
              >
                Keep it
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  void api
                    .cancelSchedule(project, flag.key, env, cancelling.id)
                    .then(() => {
                      toast('Scheduled change cancelled.');
                    })
                    .catch((err: unknown) => {
                      toast(err instanceof ApiError ? err.message : 'Could not cancel.', {
                        tone: 'critical',
                      });
                    })
                    .finally(() => {
                      setCancelling(undefined);
                      list.reload();
                    });
                }}
              >
                Cancel change
              </Button>
            </>
          }
        >
          <p>
            {describe(cancelling.change)} on {fullDate(cancelling.runAt)} will not happen.
          </p>
        </Dialog>
      )}
    </Card>
  );
}

function ScheduleDialog({
  boolean,
  onClose,
  onSubmit,
}: {
  boolean: boolean;
  onClose: () => void;
  onSubmit: (runAt: string, kind: Kind, percent: number) => Promise<void>;
}) {
  const [when, setWhen] = useState(inAnHour());
  const [kind, setKind] = useState<Kind>('on');
  const [percent, setPercent] = useState('50');
  const [errors, setErrors] = useState<{ when?: string; percent?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);

  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    const next: typeof errors = {};
    const at = new Date(when);
    if (when === '' || Number.isNaN(at.getTime())) next.when = 'Pick a date and time';
    else if (at.getTime() <= Date.now()) next.when = 'Pick a time in the future';
    const p = Number(percent);
    if (kind === 'rollout' && (!Number.isFinite(p) || p < 0 || p > 100))
      next.percent = 'Enter 0 to 100';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setBusy(true);
    try {
      await onSubmit(at.toISOString(), kind, p);
    } catch (err) {
      setErrors({ form: err instanceof ApiError ? err.message : 'Could not schedule the change.' });
    } finally {
      setBusy(false);
    }
  };

  const kinds: { value: Kind; label: string }[] = [
    { value: 'on', label: 'Turn on' },
    { value: 'off', label: 'Turn off' },
    ...(boolean ? [{ value: 'rollout' as const, label: 'Roll out to' }] : []),
  ];

  return (
    <Dialog
      title="Schedule a change"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="schedule-form" busy={busy}>
            Schedule
          </Button>
        </>
      }
    >
      <form id="schedule-form" className="form-grid" onSubmit={(e) => void submit(e)} noValidate>
        {errors.form !== undefined && (
          <div className="banner" role="alert">
            <p>{errors.form}</p>
          </div>
        )}
        <Field label="When" hint="Your local time." error={errors.when}>
          {(p) => (
            <input
              {...p}
              type="datetime-local"
              value={when}
              data-autofocus
              onChange={(e) => {
                setWhen(e.target.value);
              }}
            />
          )}
        </Field>
        <Segmented label="Change" value={kind} options={kinds} onChange={setKind} />
        {kind === 'rollout' && (
          <Field label="Percentage of users" error={errors.percent}>
            {(p) => (
              <input
                {...p}
                type="number"
                min={0}
                max={100}
                value={percent}
                onChange={(e) => {
                  setPercent(e.target.value);
                }}
              />
            )}
          </Field>
        )}
      </form>
    </Dialog>
  );
}
