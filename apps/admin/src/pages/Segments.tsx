import { keySchema, validateSegment, type AttributeClause, type SegmentRule } from '@flagship/core';
import { useState, type SyntheticEvent } from 'react';
import { ApiError, api, type SegmentView } from '../api';
import { Dialog } from '../components/dialog';
import { useToast } from '../components/toast';
import { Button, EmptyState, ErrorState, Field, IconButton, Loading } from '../components/ui';
import { History } from '../flags/History';
import { ClauseRow } from '../flags/RuleEditor';
import { newClause, newRuleId } from '../flags/rules';
import { fullDate, slugify, timeAgo } from '../format';
import { useResource } from '../hooks';
import { useSession } from '../session';
import { useScope } from './Layout';

const lines = (text: string) => [
  ...new Set(
    text
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter((s) => s !== ''),
  ),
];

export function Segments() {
  const { project, env } = useScope();
  const envName = project.environments.find((e) => e.key === env)?.name ?? env;
  const { can } = useSession();
  const list = useResource(() => api.segments(project.key, env), `${project.key}/${env}/segments`);
  const [editing, setEditing] = useState<SegmentView | 'new' | undefined>();

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Segments</h1>
          <p className="muted">Named groups of users in {envName}, reusable in any flag's rules.</p>
        </div>
        {can('editor') && (
          <Button
            variant="primary"
            icon="plus"
            onClick={() => {
              setEditing('new');
            }}
          >
            Create segment
          </Button>
        )}
      </div>
      {list.error !== undefined ? (
        <ErrorState message={list.error.message} onRetry={list.reload} />
      ) : list.data === undefined ? (
        <Loading label="Loading segments" />
      ) : list.data.segments.length === 0 ? (
        <EmptyState icon="segment" title="No segments yet">
          Make a segment like "Beta testers" or "Staff" once, then target it from any flag.
        </EmptyState>
      ) : (
        <ul className="rows" aria-label="Segments">
          {list.data.segments.map((s) => (
            <li key={s.key}>
              <button
                type="button"
                className="row row-button"
                onClick={() => {
                  setEditing(s);
                }}
              >
                <span className="row-title">
                  <strong>{s.name}</strong>
                  <span className="mono muted">{s.key}</span>
                </span>
                <span className="row-meta">
                  {s.included.length} included · {s.rules.length}{' '}
                  {s.rules.length === 1 ? 'rule' : 'rules'}
                </span>
                <span className="row-meta hide-narrow" title={fullDate(s.updatedAt)}>
                  {timeAgo(s.updatedAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {editing !== undefined && (
        <SegmentEditor
          project={project.key}
          env={env}
          segment={editing === 'new' ? undefined : editing}
          canEdit={can('editor')}
          onClose={() => {
            setEditing(undefined);
          }}
          onChanged={() => {
            setEditing(undefined);
            list.reload();
          }}
        />
      )}
    </div>
  );
}

function SegmentEditor({
  project,
  env,
  segment,
  canEdit,
  onClose,
  onChanged,
}: {
  project: string;
  env: string;
  segment: SegmentView | undefined;
  canEdit: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(segment?.name ?? '');
  const [key, setKey] = useState(segment?.key ?? '');
  const [keyEdited, setKeyEdited] = useState(segment !== undefined);
  const [description, setDescription] = useState(segment?.description ?? '');
  const [included, setIncluded] = useState(segment?.included.join('\n') ?? '');
  const [excluded, setExcluded] = useState(segment?.excluded.join('\n') ?? '');
  const [rules, setRules] = useState<SegmentRule[]>(segment?.rules ?? []);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<ApiError | undefined>();
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tab, setTab] = useState<'edit' | 'history'>('edit');
  const effectiveKey = keyEdited ? key : slugify(name);

  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (name.trim() === '') next.name = 'Give the segment a name';
    const k = keySchema.safeParse(effectiveKey);
    if (!k.success) next.key = k.error.issues[0]?.message ?? 'Invalid key';
    const body = {
      key: effectiveKey,
      name: name.trim(),
      description: description.trim(),
      included: lines(included),
      excluded: lines(excluded),
      rules,
    };
    const v = validateSegment({
      key: body.key,
      included: body.included,
      excluded: body.excluded,
      rules,
      version: 0,
    });
    if (!v.ok) {
      for (const issue of v.issues) {
        const m = /^rules\[(\d+)\]\.clauses\[(\d+)\]/.exec(issue.path);
        const field =
          m === null
            ? (issue.path.split('[')[0] ?? issue.path)
            : `rules.${m[1] ?? ''}.${m[2] ?? ''}`;
        next[field] ??= issue.message;
      }
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setBusy(true);
    setFailure(undefined);
    try {
      if (segment === undefined) await api.createSegment(project, env, body);
      else {
        const { key: _key, ...rest } = body;
        await api.updateSegment(project, env, segment.key, { ...rest, version: segment.version });
      }
      toast(segment === undefined ? `Created ${body.name}.` : `Saved ${body.name}.`);
      onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'already_exists')
        setErrors({ key: 'A segment with this key exists' });
      else setFailure(err instanceof ApiError ? err : undefined);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (segment === undefined) return;
    setBusy(true);
    try {
      await api.deleteSegment(project, env, segment.key, segment.version);
      toast(`Deleted ${segment.name}.`);
      onChanged();
    } catch (err) {
      setConfirmDelete(false);
      setFailure(err instanceof ApiError ? err : undefined);
    } finally {
      setBusy(false);
    }
  };

  const setClause = (r: number, c: number, clause: AttributeClause) => {
    setRules((all) =>
      all.map((rule, i) =>
        i === r ? { ...rule, clauses: rule.clauses.map((x, j) => (j === c ? clause : x)) } : rule,
      ),
    );
  };

  return (
    <Dialog
      title={segment === undefined ? 'Create segment' : segment.name}
      wide
      onClose={onClose}
      footer={
        tab === 'edit' && canEdit ? (
          <>
            {segment !== undefined && (
              <Button
                variant="danger"
                icon="trash"
                className="push-left"
                onClick={() => {
                  setConfirmDelete(true);
                }}
              >
                Delete
              </Button>
            )}
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" type="submit" form="segment-form" busy={busy}>
              {segment === undefined ? 'Create segment' : 'Save segment'}
            </Button>
          </>
        ) : undefined
      }
    >
      {segment !== undefined && (
        <div className="tabs" role="tablist" aria-label="Segment sections">
          {(['edit', 'history'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => {
                setTab(t);
              }}
            >
              {t === 'edit' ? 'Members and rules' : 'History'}
            </button>
          ))}
        </div>
      )}
      {tab === 'history' && segment !== undefined ? (
        <History project={project} segment={segment.key} />
      ) : (
        <form id="segment-form" className="form-grid" onSubmit={(e) => void submit(e)} noValidate>
          {failure !== undefined && (
            <div className="banner" role="alert">
              <div>
                <p>
                  {failure.code === 'version_conflict'
                    ? 'Someone else changed this segment. Close and reopen it to see the latest.'
                    : failure.message}
                </p>
                {failure.issues.length > 0 && (
                  <ul>
                    {failure.issues.map((i) => (
                      <li key={i.path + i.message}>{i.message}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
          <div className="form-row">
            <Field label="Name" error={errors.name}>
              {(p) => (
                <input
                  {...p}
                  type="text"
                  value={name}
                  disabled={!canEdit}
                  data-autofocus
                  onChange={(e) => {
                    setName(e.target.value);
                  }}
                />
              )}
            </Field>
            <Field
              label="Key"
              error={errors.key}
              hint={segment === undefined ? 'Used in flag rules.' : "Keys can't change."}
            >
              {(p) => (
                <input
                  {...p}
                  type="text"
                  className="mono"
                  value={effectiveKey}
                  disabled={segment !== undefined || !canEdit}
                  onChange={(e) => {
                    setKeyEdited(true);
                    setKey(e.target.value);
                  }}
                />
              )}
            </Field>
          </div>
          <Field label="Description">
            {(p) => (
              <input
                {...p}
                type="text"
                value={description}
                disabled={!canEdit}
                onChange={(e) => {
                  setDescription(e.target.value);
                }}
              />
            )}
          </Field>
          <div className="form-row">
            <Field label="Always include" hint="User keys, one per line." error={errors.included}>
              {(p) => (
                <textarea
                  {...p}
                  className="mono"
                  value={included}
                  disabled={!canEdit}
                  onChange={(e) => {
                    setIncluded(e.target.value);
                  }}
                />
              )}
            </Field>
            <Field label="Always exclude" hint="Wins over everything else." error={errors.excluded}>
              {(p) => (
                <textarea
                  {...p}
                  className="mono"
                  value={excluded}
                  disabled={!canEdit}
                  onChange={(e) => {
                    setExcluded(e.target.value);
                  }}
                />
              )}
            </Field>
          </div>
          <div className="form-grid">
            <h3>Also include users who match</h3>
            {rules.length === 0 && (
              <p className="muted small">
                No rules: only the keys listed above are in this segment.
              </p>
            )}
            {rules.map((rule, r) => (
              <div key={rule.id} className="rule" role="group" aria-label={`Segment rule ${r + 1}`}>
                <div className="rule-head">
                  <strong>Rule {r + 1}</strong>
                  {canEdit && (
                    <IconButton
                      icon="trash"
                      label={`Delete segment rule ${r + 1}`}
                      onClick={() => {
                        setRules((all) => all.filter((_, i) => i !== r));
                      }}
                    />
                  )}
                </div>
                {rule.clauses.map((c, i) => (
                  <ClauseRow
                    key={i}
                    clause={c}
                    index={i}
                    segments={[]}
                    allowSegments={false}
                    canRemove={rule.clauses.length > 1}
                    error={errors[`rules.${r}.${i}`]}
                    onChange={(next) => {
                      if (next.operator !== 'inSegment') setClause(r, i, next);
                    }}
                    onRemove={() => {
                      setRules((all) =>
                        all.map((x, j) =>
                          j === r ? { ...x, clauses: x.clauses.filter((_, k) => k !== i) } : x,
                        ),
                      );
                    }}
                  />
                ))}
                {canEdit && (
                  <div>
                    <Button
                      variant="plain"
                      icon="plus"
                      onClick={() => {
                        setRules((all) =>
                          all.map((x, j) =>
                            j === r ? { ...x, clauses: [...x.clauses, newClause()] } : x,
                          ),
                        );
                      }}
                    >
                      Add condition
                    </Button>
                  </div>
                )}
              </div>
            ))}
            {canEdit && (
              <div>
                <Button
                  variant="plain"
                  icon="plus"
                  onClick={() => {
                    setRules((all) => [...all, { id: newRuleId(all), clauses: [newClause()] }]);
                  }}
                >
                  Add rule
                </Button>
              </div>
            )}
          </div>
        </form>
      )}
      {confirmDelete && segment !== undefined && (
        <Dialog
          title={`Delete ${segment.name}?`}
          onClose={() => {
            setConfirmDelete(false);
          }}
          footer={
            <>
              <Button
                onClick={() => {
                  setConfirmDelete(false);
                }}
              >
                Cancel
              </Button>
              <Button variant="danger" busy={busy} onClick={() => void remove()}>
                Delete segment
              </Button>
            </>
          }
        >
          <p>Flags that target this segment must stop using it first; you'll be told which.</p>
        </Dialog>
      )}
    </Dialog>
  );
}
