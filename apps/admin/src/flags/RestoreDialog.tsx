import { useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiError, api, type AuditEntry, type RestorePlan, type RestoreSide } from '../api';
import {
  checkNote,
  EMPTY_NOTE,
  noteErrorsOf,
  policyOf,
  type NoteErrors,
  type NotePolicy,
} from '../changeNote';
import { Dialog } from '../components/dialog';
import { Icon } from '../components/icons';
import { NoteFields } from '../components/NoteFields';
import { useToast } from '../components/toast';
import { Button, ErrorState, Field, Loading } from '../components/ui';
import { useResource } from '../hooks';
import { useScope } from '../pages/Layout';
import { DiffView } from './DiffView';

const NO_POLICY: NotePolicy = { requireReason: false, requireLink: false };

/** "the targeting of checkout in Production", for headings and messages. */
export function restoreTarget(plan: Pick<RestorePlan, 'kind' | 'target'>, envName: string): string {
  if (plan.kind === 'flag') return `the settings of ${plan.target}`;
  if (plan.kind === 'targeting') return `the targeting of ${plan.target} in ${envName}`;
  return `segment ${plan.target} in ${envName}`;
}

/**
 * Puts a flag's settings, its targeting or a segment back the way it was
 * before or after one history entry. Shows what would change against what
 * is live now, then writes it, or in a protected environment opens a
 * change request for it.
 */
export function RestoreDialog({
  entry,
  onClose,
  onRestored,
}: {
  entry: AuditEntry;
  onClose: () => void;
  onRestored: () => void;
}) {
  const { project, link } = useScope();
  const toast = useToast();
  const navigate = useNavigate();
  const [to, setTo] = useState<RestoreSide>('before');
  const plan = useResource(
    () => api.restorePlan(project.key, entry.id, to),
    `${project.key}/${entry.id}/${to}`,
  );
  const [title, setTitle] = useState('');
  const [noteDraft, setNoteDraft] = useState(EMPTY_NOTE);
  const [noteErrors, setNoteErrors] = useState<NoteErrors>({});
  const [failure, setFailure] = useState<ApiError | undefined>();
  const [busy, setBusy] = useState(false);

  const envKey = entry.environment;
  const envName =
    envKey === null ? '' : (project.environments.find((e) => e.key === envKey)?.name ?? envKey);
  const policy = envKey === null ? NO_POLICY : policyOf(project, envKey);
  const p = plan.data?.to === to ? plan.data : undefined;
  const guarded = p !== undefined && p.requiredApprovals > 0;

  const submit = async () => {
    if (p === undefined) return;
    // In a protected environment the title is the change request's reason.
    const checked = checkNote(noteDraft, policy, envName, { reason: !guarded });
    setNoteErrors(checked.ok ? {} : checked.errors);
    if (!checked.ok) return;
    setBusy(true);
    setFailure(undefined);
    try {
      const result = await api.restoreEntry(
        project.key,
        entry.id,
        {
          to,
          baseVersion: p.baseVersion,
          ...(guarded && title.trim() !== '' ? { title: title.trim() } : {}),
        },
        checked.note,
      );
      if (result.outcome === 'proposed') {
        toast(`Opened a change request to restore ${restoreTarget(p, envName)}.`);
        void navigate(link(`change-requests/${result.changeRequest.id}`));
        return;
      }
      toast(`Restored ${restoreTarget(p, envName)}.`);
      onRestored();
    } catch (err) {
      const e =
        err instanceof ApiError ? err : new ApiError(0, 'internal', 'Restore failed.', null);
      setNoteErrors(noteErrorsOf(e.issues));
      setFailure(e);
      // Someone changed it meanwhile: show the restore against what is live now.
      if (e.code === 'version_conflict') plan.reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={`Restore #${entry.id}`}
      wide
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            icon="restore"
            busy={busy}
            disabled={p === undefined || p.unchanged || plan.loading}
            onClick={() => void submit()}
          >
            {guarded ? 'Open change request' : 'Restore'}
          </Button>
        </>
      }
    >
      <fieldset className="choice">
        <legend>Go back to</legend>
        {(
          [
            ['before', 'Before this change', 'Undoes it, keeping nothing it did.'],
            ['after', 'Right after this change', 'Keeps it, undoing what came later.'],
          ] as const
        ).map(([side, label, hint]) => (
          <label key={side}>
            <input
              type="radio"
              name="restore-side"
              value={side}
              checked={to === side}
              onChange={() => {
                setTo(side);
                setFailure(undefined);
              }}
            />
            <span>
              <strong>{label}</strong> <span className="muted small">{hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {plan.error !== undefined && plan.data?.to !== to ? (
        <ErrorState message={plan.error.message} onRetry={plan.reload} />
      ) : p === undefined ? (
        <Loading rows={3} label="Comparing with what is live" />
      ) : (
        <>
          {failure !== undefined && (
            <div
              className={`banner${failure.code === 'version_conflict' ? ' banner-warning' : ''}`}
              role="alert"
            >
              <Icon name="alert" />
              <p>
                {failure.code === 'version_conflict'
                  ? 'This changed while you were reviewing. The changes below are against what is live now; check them and restore again.'
                  : failure.message}
              </p>
            </div>
          )}
          {p.unchanged ? (
            <div className="banner banner-info" role="status">
              <p>{restoreTarget(p, envName)} already matches this. There is nothing to restore.</p>
            </div>
          ) : (
            <>
              <h3 className="restore-heading">
                What changes in {restoreTarget(p, envName)}
                {p.restored === null && ' (it is deleted)'}
              </h3>
              <DiffView entries={p.diff} />
            </>
          )}
          {!p.unchanged && guarded && (
            <>
              <div className="banner banner-info" role="status">
                <p>
                  {envName} is protected: restoring opens a change request that needs{' '}
                  {p.requiredApprovals} {p.requiredApprovals === 1 ? 'approval' : 'approvals'}{' '}
                  before it goes live.
                </p>
              </div>
              <Field label="Title (optional)" hint="Shows on the request and in History.">
                {(fp) => (
                  <input
                    {...fp}
                    type="text"
                    maxLength={200}
                    placeholder={`Restore ${p.target} to ${to} change #${p.entry}`}
                    value={title}
                    onChange={(e) => {
                      setTitle(e.target.value);
                    }}
                  />
                )}
              </Field>
            </>
          )}
          {!p.unchanged && (
            <NoteFields
              value={noteDraft}
              onChange={setNoteDraft}
              policy={policy}
              envName={envName}
              errors={noteErrors}
              reason={!guarded}
            />
          )}
        </>
      )}
    </Dialog>
  );
}
