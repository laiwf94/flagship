import {
  DEFAULT_ROLLOUT_STEPS,
  LIMITS,
  ROLLOUT_TOTAL,
  type RolloutPlan as Plan,
  type RolloutTarget,
} from '@flagship/core';
import { useState, type SyntheticEvent } from 'react';
import {
  ApiError,
  api,
  type ChangeNote,
  type FlagDetail,
  type RolloutAction,
  type RolloutPlanView,
} from '../api';
import {
  checkNote,
  EMPTY_NOTE,
  noteErrorsOf,
  policyOf,
  type NoteDraft,
  type NoteErrors,
  type NotePolicy,
} from '../changeNote';
import { Dialog } from '../components/dialog';
import { NoteFields } from '../components/NoteFields';
import { useToast } from '../components/toast';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Loading,
  type Tone,
} from '../components/ui';
import { fullDate, percent, timeAgo } from '../format';
import { useResource } from '../hooks';
import { useScope } from '../pages/Layout';

/** A plan step as typed into the editor: a percentage and a hold in minutes. */
export interface StepDraft {
  percent: string;
  hold: string;
}

export interface PlanDraft {
  /** "fallthrough", or a rule id. */
  target: string;
  variant: string;
  baseline: string;
  bucketBy: string;
  /** Every step before the last; the last is always everyone. */
  steps: StepDraft[];
}

export type DraftErrors = Partial<Record<'bucketBy' | 'baseline' | `step${number}`, string>>;

const MAX_STEPS = LIMITS.rolloutSteps - 1;

/** "1 h", "90 min", "2 d": a hold the way people say it. */
export function holdLabel(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} d`;
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}

export function defaultDraft(flag: Pick<FlagDetail, 'type' | 'variants'>): PlanDraft {
  const boolean = flag.type === 'boolean';
  const on = boolean ? flag.variants.find((v) => v.value === true) : flag.variants[1];
  const off = boolean ? flag.variants.find((v) => v.value === false) : flag.variants[0];
  return {
    target: 'fallthrough',
    variant: on?.key ?? '',
    baseline: off?.key ?? '',
    bucketBy: '',
    steps: DEFAULT_ROLLOUT_STEPS.slice(0, -1).map((s) => ({
      percent: String(s.weight / 1000),
      hold: String(s.holdMinutes ?? 60),
    })),
  };
}

/**
 * Turns the editor's text into a plan, or the problems to show. Percentages
 * take up to three decimals (a weight unit is 0.001%) and must grow; the
 * server checks the same rules, this only says so before the round trip.
 */
export function planFromDraft(
  d: PlanDraft,
): { ok: true; plan: Plan } | { ok: false; errors: DraftErrors } {
  const errors: DraftErrors = {};
  if (d.variant === d.baseline) errors.baseline = 'Pick a different variant';
  const bucketBy = d.bucketBy.trim();
  if (bucketBy !== '' && !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(bucketBy))
    errors.bucketBy = 'Use an attribute name such as "org"';
  let previous = 0;
  const steps: Plan['steps'] = [];
  d.steps.forEach((s, i) => {
    const p = Number(s.percent);
    const weight = Math.round(p * 1000);
    const hold = Number(s.hold);
    if (s.percent.trim() === '' || !Number.isFinite(p) || p <= 0 || p >= 100) {
      errors[`step${i}`] = 'Enter a percentage above 0 and below 100';
    } else if (Math.abs(weight - p * 1000) > 1e-6) {
      errors[`step${i}`] = 'Use at most three decimals';
    } else if (weight <= previous) {
      errors[`step${i}`] = 'Each step must be larger than the one before';
    } else {
      // Only a valid step sets the bar for the next one, so one typo reports once.
      previous = weight;
      if (!Number.isInteger(hold) || hold < 1 || hold > LIMITS.rolloutHoldMinutes) {
        errors[`step${i}`] = 'Hold for 1 minute to 30 days';
      }
    }
    steps.push({ weight, holdMinutes: hold });
  });
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const target: RolloutTarget = d.target === 'fallthrough' ? 'fallthrough' : { rule: d.target };
  return {
    ok: true,
    plan: {
      target,
      variant: d.variant,
      baseline: d.baseline,
      ...(bucketBy === '' ? {} : { bucketBy }),
      steps: [...steps, { weight: ROLLOUT_TOTAL }],
    },
  };
}

const STATUS: Record<RolloutPlanView['status'], { tone: Tone; label: string }> = {
  active: { tone: 'info', label: 'Rolling out' },
  paused: { tone: 'warning', label: 'Paused' },
  completed: { tone: 'success', label: 'Completed' },
  cancelled: { tone: 'neutral', label: 'Cancelled' },
  failed: { tone: 'critical', label: 'Failed' },
};

const PAUSED: Record<NonNullable<RolloutPlanView['pausedReason']>, string> = {
  manual: 'Paused by hand.',
  kill_switch: 'Paused because the flag was turned off. Turn it on, then resume.',
  edited:
    'Paused because the targeted serve was edited outside the plan. Cancel it and start a new one to continue.',
};

function targetLabel(flag: FlagDetail, env: string, target: RolloutTarget): string {
  if (target === 'fallthrough') return 'the default rule';
  const rules = flag.environments[env]?.rules ?? [];
  const i = rules.findIndex((r) => r.id === target.rule);
  const rule = rules[i];
  if (rule === undefined) return `rule ${target.rule}`;
  return `rule ${i + 1}${rule.description === undefined ? '' : ` (${rule.description})`}`;
}

export function RolloutPlan({
  project,
  flag,
  env,
  envName,
  canEdit,
  onChanged,
}: {
  project: string;
  flag: FlagDetail;
  env: string;
  envName: string;
  canEdit: boolean;
  /** Called after a change that moved the flag's targeting. */
  onChanged: () => void;
}) {
  const toast = useToast();
  const { project: scopeProject } = useScope();
  const policy = policyOf(scopeProject, env);
  const list = useResource(
    () => api.rolloutPlans(project, flag.key, env),
    `${project}/${flag.key}/${env}`,
  );
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState<RolloutPlanView | undefined>();
  const [busy, setBusy] = useState<RolloutAction | undefined>();
  const live = list.data?.plans.find((p) => p.status === 'active' || p.status === 'paused');
  const past = list.data?.plans.filter((p) => p !== live) ?? [];
  const enabled = flag.environments[env]?.enabled === true;

  const act = async (plan: RolloutPlanView, action: RolloutAction) => {
    setBusy(action);
    try {
      await api.changeRolloutPlan(project, flag.key, env, plan.id, action);
      toast(
        action === 'pause'
          ? 'Rollout paused.'
          : action === 'resume'
            ? 'Rollout resumed.'
            : 'Rollout cancelled.',
      );
    } catch (err) {
      toast(err instanceof ApiError ? err.message : `Could not ${action} the rollout.`, {
        tone: 'critical',
      });
    } finally {
      setBusy(undefined);
      list.reload();
    }
  };

  return (
    <Card
      title={`Progressive rollout in ${envName}`}
      actions={
        canEdit && !flag.archived && list.data !== undefined && live === undefined ? (
          <Button
            icon="chart"
            onClick={() => {
              setStarting(true);
            }}
          >
            Start a rollout
          </Button>
        ) : undefined
      }
    >
      {list.error !== undefined ? (
        <ErrorState message={list.error.message} onRetry={list.reload} />
      ) : list.data === undefined ? (
        <Loading rows={2} label="Loading rollouts" />
      ) : (
        <>
          {live === undefined ? (
            <EmptyState icon="chart" title="No rollout running">
              A rollout steps a variant from a few users to everyone on its own, holding each step
              for as long as you choose. Turning the flag off pauses it.
            </EmptyState>
          ) : (
            <section className="rollout-live" aria-label="Current rollout">
              <p className="rollout-summary">
                <Badge tone={STATUS[live.status].tone}>{STATUS[live.status].label}</Badge>{' '}
                <strong>{live.plan.variant}</strong> over <strong>{live.plan.baseline}</strong> on{' '}
                {targetLabel(flag, env, live.plan.target)}, now at{' '}
                <strong>{percent(live.weight)}</strong>
              </p>
              {live.pausedReason !== null && <p className="muted">{PAUSED[live.pausedReason]}</p>}
              {live.nextAt !== null && (
                <p className="muted small" title={fullDate(live.nextAt)}>
                  Next step {timeAgo(live.nextAt)}, at {fullDate(live.nextAt)}.
                </p>
              )}
              <ol className="rollout-steps" aria-label="Steps">
                {live.plan.steps.map((s, i) => (
                  <li
                    key={i}
                    className={i < live.step ? 'done' : i === live.step ? 'current' : undefined}
                    aria-current={i === live.step ? 'step' : undefined}
                  >
                    <span className="rollout-step-pct">{percent(s.weight)}</span>
                    <span className="muted small">
                      {s.holdMinutes === undefined
                        ? 'everyone'
                        : `hold ${holdLabel(s.holdMinutes)}`}
                    </span>
                  </li>
                ))}
              </ol>
              {canEdit && (
                <div className="rollout-actions">
                  {live.status === 'active' ? (
                    <Button busy={busy === 'pause'} onClick={() => void act(live, 'pause')}>
                      Pause
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      busy={busy === 'resume'}
                      disabled={!enabled || live.pausedReason === 'edited'}
                      onClick={() => void act(live, 'resume')}
                    >
                      Resume
                    </Button>
                  )}
                  <Button
                    variant="plain"
                    onClick={() => {
                      setCancelling(live);
                    }}
                  >
                    Cancel rollout
                  </Button>
                </div>
              )}
            </section>
          )}
          {past.length > 0 && (
            <ul className="rows rollout-past" aria-label="Earlier rollouts">
              {past.map((p) => (
                <li key={p.id} className="row schedule-row">
                  <span className="row-title">
                    <strong>
                      {p.plan.variant} over {p.plan.baseline}, reached {percent(p.weight)}
                    </strong>
                    <span className="muted small">
                      Started {fullDate(p.createdAt)} by {p.createdBy}
                      {p.finishedAt === null ? '' : ` · ended ${timeAgo(p.finishedAt)}`}
                    </span>
                    {p.error !== null && <span className="field-error">{p.error}</span>}
                  </span>
                  <span>
                    <Badge tone={STATUS[p.status].tone}>{STATUS[p.status].label}</Badge>
                  </span>
                  <span />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {starting && (
        <StartDialog
          flag={flag}
          env={env}
          envName={envName}
          enabled={enabled}
          policy={policy}
          onClose={() => {
            setStarting(false);
          }}
          onSubmit={async (plan, note) => {
            await api.startRolloutPlan(project, flag.key, env, plan, note);
            setStarting(false);
            toast(`Rollout started at ${percent(plan.steps[0]?.weight ?? 0)}.`);
            list.reload();
            onChanged();
          }}
        />
      )}
      {cancelling !== undefined && (
        <Dialog
          title="Cancel this rollout?"
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
                busy={busy === 'cancel'}
                onClick={() => {
                  void act(cancelling, 'cancel').finally(() => {
                    setCancelling(undefined);
                  });
                }}
              >
                Cancel rollout
              </Button>
            </>
          }
        >
          <p>
            The flag stays at {percent(cancelling.weight)} and no further steps run. Edit its
            targeting to change that.
          </p>
        </Dialog>
      )}
    </Card>
  );
}

function StartDialog({
  flag,
  env,
  envName,
  enabled,
  policy,
  onClose,
  onSubmit,
}: {
  flag: FlagDetail;
  env: string;
  envName: string;
  enabled: boolean;
  policy: NotePolicy;
  onClose: () => void;
  onSubmit: (plan: Plan, note: ChangeNote) => Promise<void>;
}) {
  const [draft, setDraft] = useState<PlanDraft>(() => defaultDraft(flag));
  const [errors, setErrors] = useState<DraftErrors & { form?: string }>({});
  const [noteDraft, setNoteDraft] = useState<NoteDraft>(EMPTY_NOTE);
  const [noteErrors, setNoteErrors] = useState<NoteErrors>({});
  const [busy, setBusy] = useState(false);
  const rules = flag.environments[env]?.rules ?? [];
  const set = (patch: Partial<PlanDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
  };
  const setStep = (i: number, patch: Partial<StepDraft>) => {
    setDraft((d) => ({ ...d, steps: d.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  };

  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    const parsed = planFromDraft(draft);
    setErrors(parsed.ok ? {} : parsed.errors);
    const checked = checkNote(noteDraft, policy, envName);
    setNoteErrors(checked.ok ? {} : checked.errors);
    if (!parsed.ok || !checked.ok) return;
    setBusy(true);
    try {
      await onSubmit(parsed.plan, checked.note);
    } catch (err) {
      const issues = err instanceof ApiError ? err.issues : [];
      const fieldErrors = noteErrorsOf(issues);
      if (Object.keys(fieldErrors).length > 0) setNoteErrors(fieldErrors);
      else {
        const detail = issues.map((i) => `${i.path}: ${i.message}`).join('; ');
        const message = err instanceof ApiError ? err.message : 'Could not start the rollout.';
        setErrors({ form: detail === '' ? message : `${message}: ${detail}` });
      }
    } finally {
      setBusy(false);
    }
  };

  const variantSelect = (label: string, value: string, onChange: (v: string) => void) => (
    <Field label={label} error={label === 'Everyone else gets' ? errors.baseline : undefined}>
      {(p) => (
        <select
          {...p}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
          }}
        >
          {flag.variants.map((v) => (
            <option key={v.key} value={v.key}>
              {v.name ?? v.key}
            </option>
          ))}
        </select>
      )}
    </Field>
  );

  return (
    <Dialog
      title="Start a rollout"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            form="rollout-form"
            busy={busy}
            disabled={!enabled}
          >
            Start rollout
          </Button>
        </>
      }
    >
      <form id="rollout-form" className="form-grid" onSubmit={(e) => void submit(e)} noValidate>
        {!enabled && (
          <div className="banner" role="status">
            <p>The flag is off in {envName}. Turn it on before starting a rollout.</p>
          </div>
        )}
        {errors.form !== undefined && (
          <div className="banner" role="alert">
            <p>{errors.form}</p>
          </div>
        )}
        <Field label="Roll out on">
          {(p) => (
            <select
              {...p}
              value={draft.target}
              data-autofocus
              onChange={(e) => {
                set({ target: e.target.value });
              }}
            >
              <option value="fallthrough">Default rule</option>
              {rules.map((r, i) => (
                <option key={r.id} value={r.id}>
                  Rule {i + 1}
                  {r.description === undefined ? '' : `: ${r.description}`}
                </option>
              ))}
            </select>
          )}
        </Field>
        {variantSelect('Variant to roll out', draft.variant, (variant) => {
          set({ variant });
        })}
        {variantSelect('Everyone else gets', draft.baseline, (baseline) => {
          set({ baseline });
        })}
        <Field
          label="Keep together by"
          hint='Optional attribute, such as "org", so a whole company moves at once. Defaults to the context key.'
          error={errors.bucketBy}
        >
          {(p) => (
            <input
              {...p}
              value={draft.bucketBy}
              placeholder="key"
              onChange={(e) => {
                set({ bucketBy: e.target.value });
              }}
            />
          )}
        </Field>
        <fieldset className="rollout-editor">
          <legend>Steps</legend>
          <ol className="rollout-editor-steps">
            {draft.steps.map((s, i) => (
              <li key={i}>
                <Field label={`Step ${i + 1} percentage`} error={errors[`step${i}`]}>
                  {(p) => (
                    <input
                      {...p}
                      type="number"
                      inputMode="decimal"
                      min={0}
                      max={100}
                      step="any"
                      value={s.percent}
                      onChange={(e) => {
                        setStep(i, { percent: e.target.value });
                      }}
                    />
                  )}
                </Field>
                <Field label={`Step ${i + 1} hold in minutes`}>
                  {(p) => (
                    <input
                      {...p}
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={LIMITS.rolloutHoldMinutes}
                      value={s.hold}
                      onChange={(e) => {
                        setStep(i, { hold: e.target.value });
                      }}
                    />
                  )}
                </Field>
                <IconButton
                  icon="trash"
                  label={`Remove step ${i + 1}`}
                  onClick={() => {
                    setDraft((d) => ({ ...d, steps: d.steps.filter((_, j) => j !== i) }));
                    setErrors({});
                  }}
                />
              </li>
            ))}
            <li className="rollout-editor-last">
              <strong>100%</strong> <span className="muted">everyone, and the rollout ends</span>
            </li>
          </ol>
          {draft.steps.length < MAX_STEPS && (
            <Button
              variant="plain"
              icon="plus"
              onClick={() => {
                setDraft((d) => {
                  const last = Number(d.steps.at(-1)?.percent ?? 0);
                  const next = Number.isFinite(last) ? Math.min(99, Math.max(1, last * 2)) : 1;
                  return {
                    ...d,
                    steps: [
                      ...d.steps,
                      { percent: String(next), hold: d.steps.at(-1)?.hold ?? '60' },
                    ],
                  };
                });
              }}
            >
              Add a step
            </Button>
          )}
        </fieldset>
        <NoteFields
          value={noteDraft}
          onChange={setNoteDraft}
          policy={policy}
          envName={envName}
          errors={noteErrors}
        />
      </form>
    </Dialog>
  );
}
