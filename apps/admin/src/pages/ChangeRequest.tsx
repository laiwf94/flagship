import type { Ruleset } from '@flagship/core';
import { useId, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ApiError, api, type ChangeRequest as Request, type Review } from '../api';
import { Dialog } from '../components/dialog';
import { Icon } from '../components/icons';
import { useToast } from '../components/toast';
import { Badge, Button, Card, ErrorState, Loading, type Tone } from '../components/ui';
import { DiffView, humanPath } from '../flags/DiffView';
import { applyBlocker, flagsUsingSegment, rulesetWith } from '../flags/proposal';
import { RolloutPreview } from '../flags/RolloutPreview';
import { fullDate, timeAgo } from '../format';
import { useResource } from '../hooks';
import { useSession } from '../session';
import { useScope } from './Layout';

const STATUS: Record<Request['status'], { tone: Tone; label: string }> = {
  open: { tone: 'info', label: 'Open' },
  applied: { tone: 'success', label: 'Applied' },
  closed: { tone: 'neutral', label: 'Closed' },
};

export function ChangeRequestStatus({
  status,
  stale,
}: {
  status: Request['status'];
  stale: boolean | null | undefined;
}) {
  if (status === 'open' && stale === true) return <Badge tone="warning">Out of date</Badge>;
  return <Badge tone={STATUS[status].tone}>{STATUS[status].label}</Badge>;
}

const DECISION: Record<Review['decision'], string> = {
  comment: 'commented',
  approve: 'approved',
  request_changes: 'requested changes',
};

function show(v: unknown): string {
  return v === undefined ? '(not set)' : JSON.stringify(v);
}

/** One change request: what it changes, who it moves, the discussion and the decision. */
export function ChangeRequest() {
  const { project, link } = useScope();
  const { id = '' } = useParams();
  const request = useResource(() => api.changeRequest(project.key, id), `${project.key}/cr/${id}`);

  const back = (
    <Link className="crumb" to={link('change-requests')}>
      <Icon name="back" size={16} /> Change requests
    </Link>
  );
  if (request.error !== undefined) {
    return (
      <div className="page">
        {back}
        <ErrorState
          message={
            request.error.code === 'not_found' || request.error.code === 'invalid_argument'
              ? `There is no change request "${id}" in ${project.name}.`
              : request.error.message
          }
          onRetry={request.reload}
        />
      </div>
    );
  }
  if (request.data === undefined) return <Loading rows={6} label="Loading change request" />;
  return (
    <div className="page">
      {back}
      <Review request={request.data} onChange={request.set} onReload={request.reload} />
    </div>
  );
}

function Review({
  request: r,
  onChange,
  onReload,
}: {
  request: Request;
  onChange: (next: Request) => void;
  onReload: () => void;
}) {
  const { project } = useScope();
  const { user, can } = useSession();
  const toast = useToast();
  const ruleset = useResource(
    () => api.ruleset(project.key, r.environment),
    `${project.key}/${r.environment}/ruleset`,
  );
  const [busy, setBusy] = useState<string | undefined>();
  const [failure, setFailure] = useState<ApiError | undefined>();
  const [closing, setClosing] = useState(false);

  const envName = project.environments.find((e) => e.key === r.environment)?.name ?? r.environment;
  const key = r.flag ?? r.segment ?? '';
  const targetPath =
    r.target === 'flag'
      ? `/p/${project.key}/${r.environment}/flags/${encodeURIComponent(key)}`
      : `/p/${project.key}/${r.environment}/segments`;
  const mine = user !== null && r.authorId === user.id;
  const editor = can('editor');
  const open = r.status === 'open';
  const blocker = applyBlocker(r);

  const act = async (what: string, run: () => Promise<Request>, done: string) => {
    setBusy(what);
    setFailure(undefined);
    try {
      const next = await run();
      onChange(next);
      ruleset.reload();
      toast(done);
      return true;
    } catch (err) {
      const e =
        err instanceof ApiError
          ? err
          : new ApiError(0, 'internal', 'Something went wrong.', undefined);
      setFailure(e);
      // Someone else moved it on: show the request as it is now.
      if (e.code === 'failed_precondition' || e.code === 'version_conflict') onReload();
      return false;
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="title-row">
            <h1>{r.title}</h1>
            <ChangeRequestStatus status={r.status} stale={r.live?.stale} />
          </div>
          <p className="muted">
            <strong>{r.author}</strong>{' '}
            {r.target === 'flag' ? 'wants to change the targeting of flag' : 'wants to'}{' '}
            {r.target === 'segment' &&
              (r.base === null
                ? 'create segment'
                : r.proposed === null
                  ? 'delete segment'
                  : 'edit segment')}{' '}
            <Link className="mono" to={targetPath}>
              {key}
            </Link>{' '}
            in {envName} · <span title={fullDate(r.createdAt)}>{timeAgo(r.createdAt)}</span>
            {r.revision > 1 && ` · revision ${r.revision}`}
          </p>
          {r.description !== '' && <p className="cr-description">{r.description}</p>}
        </div>
      </div>

      {r.status !== 'open' && (
        <div className={`banner ${r.status === 'applied' ? 'banner-info' : 'banner-warning'}`}>
          <Icon name={r.status === 'applied' ? 'check' : 'close'} />
          <p>
            {r.status === 'applied' ? 'Applied' : 'Closed'}
            {r.finishedBy !== null && ` by ${r.finishedBy}`}
            {r.finishedAt !== null && (
              <>
                {' '}
                <span title={fullDate(r.finishedAt)}>{timeAgo(r.finishedAt)}</span>
              </>
            )}
            .
          </p>
        </div>
      )}

      {r.live?.stale === true && (
        <div className="banner banner-warning" role="status">
          <Icon name="alert" />
          <div>
            <strong>
              {r.target === 'flag' ? 'The targeting' : 'The segment'} in {envName} changed since
              this was proposed
            </strong>
            {r.live.conflicts.length > 0 ? (
              <>
                <p>
                  These parts changed both here and live, differently, so this request can&rsquo;t
                  be rebased. Close it and propose again from the live version.
                </p>
                <ul className="cr-conflicts" aria-label="Conflicts">
                  {r.live.conflicts.map((c) => (
                    <li key={c.path}>
                      <span className="diff-path">{humanPath(c.path)}</span>: this request sets{' '}
                      <code className="mono">{show(c.ours)}</code>, live is now{' '}
                      <code className="mono">{show(c.theirs)}</code>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p>
                The changes don&rsquo;t overlap. Rebasing puts this request on top of the live
                version as a new revision, and reviewers approve it again.
              </p>
            )}
            <details>
              <summary>What changed live</summary>
              <DiffView entries={r.live.changedSinceBase} />
            </details>
            {r.live.conflicts.length === 0 && editor && (
              <div>
                <Button
                  icon="restore"
                  busy={busy === 'rebase'}
                  onClick={() =>
                    void act(
                      'rebase',
                      () => api.rebaseChange(project.key, r.id, r.revision),
                      'Rebased onto the live version. It needs approving again.',
                    )
                  }
                >
                  Rebase
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {failure !== undefined && (
        <div className="banner" role="alert">
          <Icon name="alert" />
          <div>
            <p>{failure.message.charAt(0).toUpperCase() + failure.message.slice(1)}</p>
            {failure.issues.length > 0 && (
              <ul>
                {failure.issues.map((i) => (
                  <li key={i.path}>
                    <span className="mono">{i.path}</span>: {i.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <div className="targeting">
        <div className="targeting-main">
          <Card title="Changes">
            <DiffView entries={r.diff} />
          </Card>

          <Decision
            request={r}
            blocker={blocker}
            canApply={editor && open}
            canClose={open && (mine || can('admin'))}
            busy={busy}
            onApply={() =>
              void act(
                'apply',
                () => api.applyChange(project.key, r.id, r.revision),
                `Applied to ${envName}.`,
              )
            }
            onClose={() => {
              setClosing(true);
            }}
          />

          <Discussion
            request={r}
            canReview={editor && open}
            mine={mine}
            busy={busy}
            onReview={(decision, body) =>
              act(
                decision,
                () =>
                  api.reviewChange(project.key, r.id, {
                    revision: r.revision,
                    decision,
                    ...(body === '' ? {} : { body }),
                  }),
                decision === 'approve'
                  ? 'Approved.'
                  : decision === 'request_changes'
                    ? 'Requested changes.'
                    : 'Comment added.',
              )
            }
          />
        </div>

        <aside className="targeting-side">
          {ruleset.error !== undefined ? (
            <ErrorState message={ruleset.error.message} onRetry={ruleset.reload} />
          ) : ruleset.data === undefined ? (
            <Loading rows={3} label="Loading preview" />
          ) : (
            <Preview request={r} ruleset={ruleset.data} />
          )}
        </aside>
      </div>

      {closing && (
        <CloseDialog
          busy={busy === 'close'}
          onCancel={() => {
            setClosing(false);
          }}
          onConfirm={(reason) => {
            void act(
              'close',
              () => api.closeChange(project.key, r.id, reason),
              'Closed the change request.',
            ).then(() => {
              setClosing(false);
            });
          }}
        />
      )}
    </>
  );
}

function Decision({
  request: r,
  blocker,
  canApply,
  canClose,
  busy,
  onApply,
  onClose,
}: {
  request: Request;
  blocker: string | undefined;
  canApply: boolean;
  canClose: boolean;
  busy: string | undefined;
  onApply: () => void;
  onClose: () => void;
}) {
  const id = useId();
  const { required, approvedBy, changesRequestedBy } = r.approvals;
  return (
    <Card title="Approvals">
      <div className="cr-approvals">
        <p>
          <strong>
            {approvedBy.length} of {required}
          </strong>{' '}
          {required === 1 ? 'approval' : 'approvals'}
          {approvedBy.length > 0 && <span className="muted"> · {approvedBy.join(', ')}</span>}
        </p>
        {changesRequestedBy.length > 0 && (
          <p>
            <Badge tone="critical">Changes requested</Badge>{' '}
            <span className="muted">by {changesRequestedBy.join(', ')}</span>
          </p>
        )}
        {r.status === 'open' && (canApply || canClose) && (
          <div className="cr-actions">
            {canApply && (
              <Button
                variant="primary"
                icon="check"
                busy={busy === 'apply'}
                disabled={blocker !== undefined}
                aria-describedby={blocker === undefined ? undefined : `${id}-why`}
                onClick={onApply}
              >
                Apply change
              </Button>
            )}
            {canClose && (
              <Button icon="close" onClick={onClose}>
                Close without applying
              </Button>
            )}
          </div>
        )}
        {r.status === 'open' && blocker !== undefined && (
          <p className="hint" id={`${id}-why`}>
            {blocker}
          </p>
        )}
      </div>
    </Card>
  );
}

function Discussion({
  request: r,
  canReview,
  mine,
  busy,
  onReview,
}: {
  request: Request;
  canReview: boolean;
  mine: boolean;
  busy: string | undefined;
  onReview: (decision: Review['decision'], body: string) => Promise<boolean>;
}) {
  const id = useId();
  const [body, setBody] = useState('');
  const [empty, setEmpty] = useState(false);

  const send = (decision: Review['decision']) => {
    const text = body.trim();
    if (decision === 'comment' && text === '') {
      setEmpty(true);
      return;
    }
    setEmpty(false);
    void onReview(decision, text).then((ok) => {
      if (ok) setBody('');
    });
  };

  return (
    <Card title="Discussion">
      {r.reviews.length === 0 ? (
        <p className="muted">No reviews yet.</p>
      ) : (
        <ol className="cr-reviews" aria-label="Reviews">
          {r.reviews.map((v) => (
            <li key={v.id} className={`cr-review cr-review-${v.decision}`}>
              <div className="history-line">
                <span>
                  <strong>{v.reviewer}</strong> {DECISION[v.decision]}
                </span>
                {v.revision < r.revision && <Badge tone="neutral">On revision {v.revision}</Badge>}
                <span className="muted small" title={fullDate(v.at)}>
                  {timeAgo(v.at)}
                </span>
              </div>
              {v.body !== '' && <p className="cr-review-body">{v.body}</p>}
            </li>
          ))}
        </ol>
      )}
      {canReview && (
        <div className="cr-review-form">
          <div className="field">
            <label htmlFor={`${id}-c`}>Your review</label>
            <textarea
              id={`${id}-c`}
              value={body}
              maxLength={4000}
              aria-invalid={empty || undefined}
              aria-describedby={`${id}-h`}
              onChange={(e) => {
                setBody(e.target.value);
              }}
            />
            {empty ? (
              <p className="field-error" id={`${id}-h`}>
                <Icon name="alert" size={14} />
                Write something to comment
              </p>
            ) : (
              <p className="hint" id={`${id}-h`}>
                {mine
                  ? 'You can comment on your own change request, but someone else has to approve it.'
                  : 'Optional for approvals. Requesting changes blocks applying until you approve.'}
              </p>
            )}
          </div>
          <div className="cr-actions">
            <Button
              busy={busy === 'comment'}
              onClick={() => {
                send('comment');
              }}
            >
              Comment
            </Button>
            {!mine && (
              <>
                <Button
                  variant="danger"
                  busy={busy === 'request_changes'}
                  onClick={() => {
                    send('request_changes');
                  }}
                >
                  Request changes
                </Button>
                <Button
                  variant="primary"
                  icon="check"
                  busy={busy === 'approve'}
                  onClick={() => {
                    send('approve');
                  }}
                >
                  Approve
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function Preview({ request: r, ruleset }: { request: Request; ruleset: Ruleset }) {
  const id = useId();
  const before = rulesetWith(ruleset, r, r.base);
  const after = rulesetWith(ruleset, r, r.proposed);
  const affected = r.target === 'segment' ? flagsUsingSegment(ruleset, r.segment ?? '') : [];
  const [chosen, setChosen] = useState<string | undefined>();
  const when = r.status === 'open' ? 'if this is applied' : 'with this change';

  if (before === undefined || after === undefined) {
    return (
      <Card title="Who gets what">
        <p className="muted">
          The flag isn&rsquo;t served in this environment (it may be archived), so there is no
          preview.
        </p>
      </Card>
    );
  }
  if (r.target === 'flag') {
    return <RolloutPreview saved={before} draft={after} flagKey={r.flag ?? ''} when={when} />;
  }
  if (affected.length === 0) {
    return (
      <Card title="Who gets what">
        <p className="muted">
          No flag targets this segment, so no one&rsquo;s variant changes {when}.
        </p>
      </Card>
    );
  }
  const flag = chosen !== undefined && affected.includes(chosen) ? chosen : (affected[0] ?? '');
  return (
    <div className="cr-preview">
      <div className="field">
        <label htmlFor={`${id}-f`}>Preview for flag</label>
        <select
          id={`${id}-f`}
          value={flag}
          onChange={(e) => {
            setChosen(e.target.value);
          }}
        >
          {affected.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <p className="hint">
          {affected.length === 1
            ? 'The one flag whose variants depend on this segment.'
            : `${affected.length} flags have variants that depend on this segment.`}
        </p>
      </div>
      <RolloutPreview key={flag} saved={before} draft={after} flagKey={flag} when={when} />
    </div>
  );
}

function CloseDialog({
  busy,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const id = useId();
  const [reason, setReason] = useState('');
  return (
    <Dialog
      title="Close this change request?"
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>Keep it open</Button>
          <Button
            variant="danger"
            busy={busy}
            onClick={() => {
              onConfirm(reason.trim());
            }}
          >
            Close request
          </Button>
        </>
      }
    >
      <p>Nothing changes live. The request and its discussion stay in the history.</p>
      <div className="field">
        <label htmlFor={`${id}-r`}>Reason (optional)</label>
        <textarea
          id={`${id}-r`}
          value={reason}
          maxLength={4000}
          data-autofocus
          onChange={(e) => {
            setReason(e.target.value);
          }}
        />
      </div>
    </Dialog>
  );
}
