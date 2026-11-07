import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, type ChangeRequestStatus as Status, type ChangeRequestSummary } from '../api';
import { Button, EmptyState, ErrorState, Loading, Segmented } from '../components/ui';
import { fullDate, timeAgo } from '../format';
import { useResource } from '../hooks';
import { ChangeRequestStatus } from './ChangeRequest';
import { useScope } from './Layout';

const STATUSES: { value: Status; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'applied', label: 'Applied' },
  { value: 'closed', label: 'Closed' },
];

const PAGE = 25;

/** Change requests in the current environment, newest first, by status. */
export function ChangeRequests() {
  const { project, env, link } = useScope();
  const [params, setParams] = useSearchParams();
  const envName = project.environments.find((e) => e.key === env)?.name ?? env;
  const required = project.environments.find((e) => e.key === env)?.requiredApprovals ?? 0;
  const status: Status = STATUSES.some((s) => s.value === params.get('status'))
    ? (params.get('status') as Status)
    : 'open';
  const flag = params.get('flag') ?? undefined;
  const segment = params.get('segment') ?? undefined;
  const filter = {
    status,
    environment: env,
    ...(flag === undefined ? {} : { flag }),
    ...(segment === undefined ? {} : { segment }),
  };
  const filterKey = `${project.key}/${env}/${status}/${flag ?? ''}/${segment ?? ''}`;
  const first = useResource(
    () => api.changeRequests(project.key, { ...filter, limit: PAGE }),
    filterKey,
  );
  const [more, setMore] = useState<{
    key: string;
    rows: ChangeRequestSummary[];
    next: string | null;
  }>();
  const [loadingMore, setLoadingMore] = useState(false);
  const extra = more?.key === filterKey ? more : undefined;

  const rows =
    first.data === undefined ? [] : [...first.data.changeRequests, ...(extra?.rows ?? [])];
  const cursor = extra === undefined ? first.data?.next : extra.next;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Change requests</h1>
          <p className="muted">
            {required > 0
              ? `Targeting and segment changes in ${envName} need ${required} ${required === 1 ? 'approval' : 'approvals'} before they go live.`
              : `${envName} takes changes directly; change requests are optional here.`}
          </p>
        </div>
      </div>
      <div className="toolbar">
        <Segmented
          label="Status"
          value={status}
          options={STATUSES}
          onChange={(s) => {
            const next = new URLSearchParams(params);
            next.set('status', s);
            setParams(next, { replace: true });
          }}
        />
        {(flag !== undefined || segment !== undefined) && (
          <span className="muted small">
            For {flag !== undefined ? 'flag' : 'segment'}{' '}
            <span className="mono">{flag ?? segment}</span> ·{' '}
            <Link to={`${link('change-requests')}?status=${status}`}>Show all</Link>
          </span>
        )}
      </div>
      {first.error !== undefined ? (
        <ErrorState message={first.error.message} onRetry={first.reload} />
      ) : first.data === undefined ? (
        <Loading label="Loading change requests" />
      ) : rows.length === 0 ? (
        <EmptyState icon="diff" title={`No ${status} change requests`}>
          {status === 'open'
            ? `Edits to targeting or segments in a protected environment show up here for review.`
            : `Requests that were ${status} in ${envName} show up here.`}
        </EmptyState>
      ) : (
        <>
          <ul className="rows" aria-label="Change requests">
            <li aria-hidden="true">
              <div className="row cr-row rows-head">
                <span>Request</span>
                <span>Approvals</span>
                <span>Status</span>
                <span>Updated</span>
              </div>
            </li>
            {rows.map((r) => (
              <li key={r.id}>
                <Link className="row cr-row" to={link(`change-requests/${r.id}`)}>
                  <span className="row-title">
                    <strong>{r.title}</strong>
                    <span className="muted small">
                      {r.target === 'flag' ? 'Flag' : 'Segment'}{' '}
                      <span className="mono">{r.flag ?? r.segment}</span> · by {r.author}
                    </span>
                  </span>
                  <span className="row-meta">
                    {r.approvals.approvedBy.length}/{r.approvals.required}
                    {r.approvals.changesRequestedBy.length > 0 && ' · changes requested'}
                  </span>
                  <span>
                    <ChangeRequestStatus status={r.status} stale={r.stale} />
                  </span>
                  <span className="row-meta hide-narrow" title={fullDate(r.updatedAt)}>
                    {timeAgo(r.updatedAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {cursor !== null && cursor !== undefined && (
            <div>
              <Button
                busy={loadingMore}
                onClick={() => {
                  setLoadingMore(true);
                  void api
                    .changeRequests(project.key, { ...filter, before: cursor, limit: PAGE })
                    .then((page) => {
                      setMore({
                        key: filterKey,
                        rows: [...(extra?.rows ?? []), ...page.changeRequests],
                        next: page.next,
                      });
                    })
                    .finally(() => {
                      setLoadingMore(false);
                    });
                }}
              >
                Show older requests
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
