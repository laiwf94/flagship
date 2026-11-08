import { useState } from 'react';
import { api, type AuditEntry } from '../api';
import { Badge, Button, EmptyState, ErrorState, Loading } from '../components/ui';
import { fullDate, timeAgo } from '../format';
import { useResource } from '../hooks';
import { DiffView } from './DiffView';

const ACTIONS: Record<string, string> = {
  'flag.create': 'created flag',
  'flag.update': 'edited flag settings of',
  'flag.config.update': 'changed targeting of',
  'flag.kill_switch': 'flipped the kill switch of',
  'flag.archive': 'archived',
  'flag.restore': 'restored',
  'flag.schedule.create': 'scheduled a change to',
  'flag.schedule.cancel': 'cancelled a scheduled change to',
  'flag.schedule.apply': 'applied a scheduled change to',
  'flag.change_request.open': 'opened a change request for',
  'flag.change_request.approve': 'approved a change request for',
  'flag.change_request.request_changes': 'requested changes to a change request for',
  'flag.change_request.apply': 'applied a change request to',
  'flag.change_request.rebase': 'rebased a change request for',
  'flag.change_request.close': 'closed a change request for',
  'segment.create': 'created segment',
  'segment.update': 'edited segment',
  'segment.delete': 'deleted segment',
  'segment.change_request.open': 'opened a change request for segment',
  'segment.change_request.approve': 'approved a change request for segment',
  'segment.change_request.request_changes': 'requested changes to a change request for segment',
  'segment.change_request.apply': 'applied a change request to segment',
  'segment.change_request.rebase': 'rebased a change request for segment',
  'segment.change_request.close': 'closed a change request for segment',
  'project.create': 'created project',
  'environment.create': 'created environment',
  'environment.approvals': 'changed the approvals needed in',
  'environment.change_notes': 'changed the reasons and links needed in',
  'api_key.create': 'created SDK key',
  'api_key.revoke': 'revoked SDK key',
};

export function describeAction(e: AuditEntry): string {
  return ACTIONS[e.action] ?? e.action;
}

function Entry({ entry }: { entry: AuditEntry }) {
  const [open, setOpen] = useState(false);
  const reason = entry.reason ?? null;
  const link = entry.link ?? null;
  return (
    <li className="history-entry">
      <div className="history-line">
        <span>
          <strong>{entry.actor}</strong> {describeAction(entry)}{' '}
          <span className="mono">{entry.targetKey}</span>
        </span>
        {entry.environment !== null && <Badge tone="neutral">{entry.environment}</Badge>}
        <span className="muted small" title={fullDate(entry.at)}>
          {timeAgo(entry.at)}
        </span>
        {entry.diff.length > 0 && (
          <Button
            variant="plain"
            aria-expanded={open}
            onClick={() => {
              setOpen((o) => !o);
            }}
          >
            {open
              ? 'Hide changes'
              : `Show ${entry.diff.length} ${entry.diff.length === 1 ? 'change' : 'changes'}`}
          </Button>
        )}
      </div>
      {(reason !== null || link !== null) && (
        <p className="history-note small">
          {reason !== null && <span>{reason}</span>}
          {link !== null && (
            <a href={link} target="_blank" rel="noreferrer noopener">
              {link}
            </a>
          )}
        </p>
      )}
      {open && <DiffView entries={entry.diff} />}
    </li>
  );
}

/** Newest first, 25 at a time. */
export function History({
  project,
  flag,
  segment,
}: {
  project: string;
  flag?: string;
  segment?: string;
}) {
  const first = useResource(
    () =>
      api.audit(project, {
        ...(flag === undefined ? {} : { flag }),
        ...(segment === undefined ? {} : { segment }),
        limit: 25,
      }),
    `${project}/${flag ?? ''}/${segment ?? ''}`,
  );
  const [more, setMore] = useState<AuditEntry[]>([]);
  const [next, setNext] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);

  if (first.error !== undefined)
    return <ErrorState message={first.error.message} onRetry={first.reload} />;
  if (first.data === undefined) return <Loading rows={4} label="Loading history" />;
  const entries = [...first.data.entries, ...more];
  const cursor = next === undefined ? first.data.next : next;
  if (entries.length === 0) {
    return (
      <EmptyState icon="history" title="No changes yet">
        Every change to flags, segments and keys is recorded here with who made it.
      </EmptyState>
    );
  }
  return (
    <div className="history">
      <ul className="history-list" aria-label="Change history">
        {entries.map((e) => (
          <Entry key={e.id} entry={e} />
        ))}
      </ul>
      {cursor !== null && (
        <div>
          <Button
            busy={loadingMore}
            onClick={() => {
              setLoadingMore(true);
              void api
                .audit(project, {
                  ...(flag === undefined ? {} : { flag }),
                  ...(segment === undefined ? {} : { segment }),
                  cursor,
                  limit: 25,
                })
                .then((page) => {
                  setMore((m) => [...m, ...page.entries]);
                  setNext(page.next);
                })
                .finally(() => {
                  setLoadingMore(false);
                });
            }}
          >
            Show older changes
          </Button>
        </div>
      )}
    </div>
  );
}
