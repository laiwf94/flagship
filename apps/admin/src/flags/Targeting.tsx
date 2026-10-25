import { diff, validateRuleset, type Flag, type Ruleset } from '@flagship/core';
import { useEffect, useMemo, useState } from 'react';
import { useBlocker } from 'react-router';
import { ApiError, api, type EnvConfig, type FlagDetail } from '../api';
import { Dialog } from '../components/dialog';
import { Icon } from '../components/icons';
import { useToast } from '../components/toast';
import { Button, Card, IconButton, Switch } from '../components/ui';
import { DiffView } from './DiffView';
import { RolloutPreview } from './RolloutPreview';
import { RuleEditor } from './RuleEditor';
import { newRule } from './rules';
import { ServeEditor } from './ServeEditor';

function configOf(flag: FlagDetail, env: string): EnvConfig {
  const c = flag.environments[env];
  if (c === undefined) throw new Error(`flag has no config for ${env}`);
  return {
    enabled: c.enabled,
    offVariant: c.offVariant,
    prerequisites: c.prerequisites,
    rules: c.rules,
    fallthrough: c.fallthrough,
  };
}

function asFlag(flag: FlagDetail, config: EnvConfig): Flag {
  return {
    key: flag.key,
    type: flag.type,
    variants: flag.variants,
    salt: flag.salt,
    clientSide: flag.clientSide,
    version: flag.version,
    ...config,
  };
}

/** Problems for this flag from whole-ruleset validation, keyed by local path. */
function localIssues(ruleset: Ruleset, key: string): Record<string, string> {
  const result = validateRuleset(ruleset);
  if (result.ok) return {};
  const prefix = `flags.${key}.`;
  const out: Record<string, string> = {};
  for (const i of result.issues) {
    const path = i.path.startsWith(prefix) ? i.path.slice(prefix.length) : i.path;
    if (!(path in out)) out[path] = i.message.charAt(0).toUpperCase() + i.message.slice(1);
  }
  return out;
}

function ruleErrors(issues: Record<string, string>, index: number): Record<string, string> {
  const out: Record<string, string> = {};
  const prefix = `rules[${index}].`;
  for (const [path, message] of Object.entries(issues)) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const clause = /^clauses\[(\d+)\]/.exec(rest);
    const field =
      clause !== null
        ? `clauses[${clause[1] ?? ''}]`
        : rest.startsWith('serve')
          ? 'serve'
          : undefined;
    if (field !== undefined && !(field in out)) out[field] = message;
  }
  return out;
}

export function Targeting({
  project,
  flag,
  env,
  envName,
  ruleset,
  canEdit,
  onSaved,
  onReload,
}: {
  project: string;
  flag: FlagDetail;
  env: string;
  envName: string;
  ruleset: Ruleset;
  canEdit: boolean;
  onSaved: (flag: FlagDetail) => void;
  onReload: () => void;
}) {
  const toast = useToast();
  const saved = configOf(flag, env);
  const [draft, setDraft] = useState<EnvConfig>(saved);
  const [base, setBase] = useState(flag.version);
  const [reviewing, setReviewing] = useState(false);
  const [confirmKill, setConfirmKill] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<ApiError | undefined>();

  const savedJson = JSON.stringify(saved);
  const dirty = JSON.stringify(draft) !== savedJson;

  // A newer version from elsewhere (reload, kill switch) resets the draft if
  // there are no local edits.
  const [seen, setSeen] = useState(`${flag.version}/${savedJson}`);
  if (seen !== `${flag.version}/${savedJson}`) {
    setSeen(`${flag.version}/${savedJson}`);
    if (!dirty) setDraft(saved);
    setBase(flag.version);
  }

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
    };
  }, [dirty]);

  const savedRuleset = useMemo<Ruleset>(
    () => ({ ...ruleset, flags: { ...ruleset.flags, [flag.key]: asFlag(flag, saved) } }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ruleset, flag, savedJson],
  );
  const draftRuleset = useMemo<Ruleset>(
    () => ({ ...ruleset, flags: { ...ruleset.flags, [flag.key]: asFlag(flag, draft) } }),
    [ruleset, flag, draft],
  );
  const issues = useMemo(() => localIssues(draftRuleset, flag.key), [draftRuleset, flag.key]);
  const valid = Object.keys(issues).length === 0;
  const changes = useMemo(() => diff(saved, draft), [savedJson, draft]); // eslint-disable-line react-hooks/exhaustive-deps

  const segments = Object.keys(ruleset.segments).sort();
  const otherFlags = Object.values(ruleset.flags).filter((f) => f.key !== flag.key);
  const variants = flag.variants;

  const update = (patch: Partial<EnvConfig>) => {
    setDraft((d) => ({ ...d, ...patch }));
  };

  const save = async () => {
    setBusy(true);
    setSaveError(undefined);
    try {
      const next = await api.saveTargeting(project, flag.key, env, { ...draft, version: base });
      setReviewing(false);
      onSaved(next);
      setDraft(configOf(next, env));
      toast(`Saved targeting for ${flag.name} in ${envName}.`);
    } catch (err) {
      setSaveError(
        err instanceof ApiError ? err : new ApiError(0, 'internal', 'Save failed.', undefined),
      );
    } finally {
      setBusy(false);
    }
  };

  const kill = async (enabled: boolean) => {
    setBusy(true);
    try {
      const next = await api.killSwitch(project, flag.key, env, enabled);
      onSaved(next);
      update({ enabled });
      setConfirmKill(null);
      toast(`${flag.name} is now ${enabled ? 'on' : 'off'} in ${envName}.`, {
        action: {
          label: 'Undo',
          run: () => {
            void api.killSwitch(project, flag.key, env, !enabled).then((back) => {
              onSaved(back);
              update({ enabled: !enabled });
            });
          },
        },
      });
    } catch (err) {
      setConfirmKill(null);
      toast(err instanceof ApiError ? err.message : 'Could not change the flag.', {
        tone: 'critical',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="targeting">
      <div className="targeting-main">
        <Card>
          <Switch
            checked={draft.enabled}
            disabled={!canEdit || busy}
            onChange={(next) => {
              setConfirmKill(next);
            }}
            label={draft.enabled ? `On in ${envName}` : `Off in ${envName}`}
            description={
              draft.enabled
                ? 'Rules below decide what each user gets.'
                : `Everyone gets "${draft.offVariant}". Rules are kept but not used.`
            }
          />
          <div className="field">
            <label htmlFor="off-variant">Serve when off or a prerequisite fails</label>
            <select
              id="off-variant"
              value={draft.offVariant}
              disabled={!canEdit}
              onChange={(e) => {
                update({ offVariant: e.target.value });
              }}
            >
              {variants.map((v) => (
                <option key={v.key} value={v.key}>
                  {v.key} ({JSON.stringify(v.value)})
                </option>
              ))}
            </select>
          </div>
        </Card>

        <Card
          title="Prerequisites"
          actions={
            canEdit && otherFlags.length > 0 ? (
              <Button
                variant="plain"
                icon="plus"
                disabled={draft.prerequisites.length >= 10}
                onClick={() => {
                  const f = otherFlags.find(
                    (o) => !draft.prerequisites.some((p) => p.flag === o.key),
                  );
                  if (f !== undefined) {
                    update({
                      prerequisites: [
                        ...draft.prerequisites,
                        { flag: f.key, variant: f.variants[0]?.key ?? '' },
                      ],
                    });
                  }
                }}
              >
                Add prerequisite
              </Button>
            ) : undefined
          }
        >
          {draft.prerequisites.length === 0 ? (
            <p className="muted small">None. This flag doesn't depend on another flag.</p>
          ) : (
            <ul className="plain-list">
              {draft.prerequisites.map((p, i) => {
                const target = otherFlags.find((f) => f.key === p.flag);
                return (
                  <li key={i} className="prereq">
                    <label className="visually-hidden" htmlFor={`pf-${i}`}>
                      Prerequisite flag {i + 1}
                    </label>
                    <select
                      id={`pf-${i}`}
                      value={p.flag}
                      disabled={!canEdit}
                      onChange={(e) => {
                        const f = otherFlags.find((o) => o.key === e.target.value);
                        update({
                          prerequisites: draft.prerequisites.map((x, j) =>
                            j === i
                              ? { flag: e.target.value, variant: f?.variants[0]?.key ?? '' }
                              : x,
                          ),
                        });
                      }}
                    >
                      {otherFlags.map((f) => (
                        <option key={f.key} value={f.key}>
                          {f.key}
                        </option>
                      ))}
                    </select>
                    <span className="muted small">is on and serves</span>
                    <label className="visually-hidden" htmlFor={`pv-${i}`}>
                      Required variant {i + 1}
                    </label>
                    <select
                      id={`pv-${i}`}
                      value={p.variant}
                      disabled={!canEdit}
                      onChange={(e) => {
                        update({
                          prerequisites: draft.prerequisites.map((x, j) =>
                            j === i ? { ...x, variant: e.target.value } : x,
                          ),
                        });
                      }}
                    >
                      {(target?.variants ?? []).map((v) => (
                        <option key={v.key} value={v.key}>
                          {v.key}
                        </option>
                      ))}
                    </select>
                    {canEdit && (
                      <IconButton
                        icon="trash"
                        label={`Remove prerequisite ${i + 1}`}
                        onClick={() => {
                          update({ prerequisites: draft.prerequisites.filter((_, j) => j !== i) });
                        }}
                      />
                    )}
                    {issues[`prerequisites[${i}].flag`] !== undefined && (
                      <p className="field-error">{issues[`prerequisites[${i}].flag`]}</p>
                    )}
                  </li>
                );
              })}
              {issues.prerequisites !== undefined && (
                <p className="field-error">{issues.prerequisites}</p>
              )}
            </ul>
          )}
        </Card>

        <Card
          title="Rules"
          actions={
            canEdit ? (
              <Button
                variant="plain"
                icon="plus"
                disabled={draft.rules.length >= 100}
                onClick={() => {
                  update({ rules: [...draft.rules, newRule(draft.rules, variants)] });
                }}
              >
                Add rule
              </Button>
            ) : undefined
          }
        >
          {draft.rules.length === 0 ? (
            <p className="muted small">No rules. Everyone gets the default rule below.</p>
          ) : (
            <>
              <p className="hint">Checked top to bottom; the first rule that matches decides.</p>
              <ol className="rules">
                {draft.rules.map((r, i) => (
                  <RuleEditor
                    key={r.id}
                    rule={r}
                    index={i}
                    count={draft.rules.length}
                    variants={variants}
                    segments={segments}
                    errors={ruleErrors(issues, i)}
                    onChange={(next) => {
                      update({ rules: draft.rules.map((x, j) => (j === i ? next : x)) });
                    }}
                    onRemove={() => {
                      update({ rules: draft.rules.filter((_, j) => j !== i) });
                    }}
                    onMove={(delta) => {
                      const rules = [...draft.rules];
                      const [moved] = rules.splice(i, 1);
                      if (moved !== undefined) rules.splice(i + delta, 0, moved);
                      update({ rules });
                    }}
                  />
                ))}
              </ol>
            </>
          )}
        </Card>

        <Card title="Default rule">
          <p className="hint">For everyone no rule matched.</p>
          <ServeEditor
            label="Default rule serves"
            serve={draft.fallthrough}
            variants={variants}
            onChange={(fallthrough) => {
              update({ fallthrough });
            }}
          />
          {issues['fallthrough.variant'] !== undefined && (
            <p className="field-error">{issues['fallthrough.variant']}</p>
          )}
        </Card>
      </div>

      <aside className="targeting-side">
        <RolloutPreview saved={savedRuleset} draft={draftRuleset} flagKey={flag.key} />
      </aside>

      {dirty && canEdit && (
        <div className="savebar" role="region" aria-label="Unsaved changes">
          <span>
            <Icon name="alert" /> Unsaved changes in {envName}
          </span>
          <div className="savebar-actions">
            <Button
              onClick={() => {
                setDraft(saved);
                setSaveError(undefined);
              }}
            >
              Discard
            </Button>
            <Button
              variant="primary"
              icon="diff"
              onClick={() => {
                setSaveError(undefined);
                setReviewing(true);
              }}
            >
              Review and save
            </Button>
          </div>
        </div>
      )}

      {reviewing && (
        <Dialog
          title={`Review changes to ${flag.name} in ${envName}`}
          wide
          onClose={() => {
            setReviewing(false);
          }}
          footer={
            <>
              <Button
                onClick={() => {
                  setReviewing(false);
                }}
              >
                Keep editing
              </Button>
              <Button
                variant="primary"
                busy={busy}
                disabled={!valid}
                onClick={() => void save()}
                data-autofocus
              >
                Save to {envName}
              </Button>
            </>
          }
        >
          {!valid && (
            <div className="banner" role="alert">
              <Icon name="alert" />
              <div>
                <strong>Fix these before saving</strong>
                <ul>
                  {Object.entries(issues).map(([path, message]) => (
                    <li key={path}>{message}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          {saveError?.code === 'version_conflict' && (
            <div className="banner banner-warning" role="alert">
              <Icon name="alert" />
              <div>
                <p>
                  Someone else saved this flag while you were editing. Reload to see their version;
                  your changes here will be discarded.
                </p>
                <div>
                  <Button
                    onClick={() => {
                      setReviewing(false);
                      setDraft(saved);
                      onReload();
                    }}
                  >
                    Reload latest
                  </Button>
                </div>
              </div>
            </div>
          )}
          {saveError !== undefined && saveError.code !== 'version_conflict' && (
            <div className="banner" role="alert">
              <Icon name="alert" />
              <div>
                <p>{saveError.message}</p>
                {saveError.issues.length > 0 && (
                  <ul>
                    {saveError.issues.map((i) => (
                      <li key={i.path}>
                        <span className="mono">{i.path}</span>: {i.message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
          <DiffView entries={changes} />
        </Dialog>
      )}

      {confirmKill !== null && (
        <Dialog
          title={
            confirmKill
              ? `Turn on ${flag.name} in ${envName}?`
              : `Turn off ${flag.name} in ${envName}?`
          }
          onClose={() => {
            setConfirmKill(null);
          }}
          footer={
            <>
              <Button
                onClick={() => {
                  setConfirmKill(null);
                }}
              >
                Cancel
              </Button>
              <Button
                variant={confirmKill ? 'primary' : 'danger'}
                icon="power"
                busy={busy}
                data-autofocus
                onClick={() => void kill(confirmKill)}
              >
                {confirmKill ? 'Turn on' : 'Turn off'}
              </Button>
            </>
          }
        >
          <p>
            {confirmKill
              ? 'Rules start deciding what each user gets, within seconds, for every connected app.'
              : `Every user gets "${draft.offVariant}" within seconds, for every connected app.`}{' '}
            This takes effect immediately and doesn't wait for your other edits.
          </p>
        </Dialog>
      )}

      {blocker.state === 'blocked' && (
        <Dialog
          title="Leave without saving?"
          onClose={() => {
            blocker.reset();
          }}
          footer={
            <>
              <Button
                onClick={() => {
                  blocker.reset();
                }}
                data-autofocus
              >
                Stay
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  blocker.proceed();
                }}
              >
                Discard changes
              </Button>
            </>
          }
        >
          <p>
            Your changes to {flag.name} in {envName} haven't been saved.
          </p>
        </Dialog>
      )}
    </div>
  );
}
