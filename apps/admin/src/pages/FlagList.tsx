import { describeReason } from '@flagship/core';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api, type FlagStatus } from '../api';
import { Icon } from '../components/icons';
import { useToast } from '../components/toast';
import { Button, Chip, EmptyState, ErrorState, Loading } from '../components/ui';
import { CreateFlagDialog } from '../flags/CreateFlagDialog';
import { LifecycleChip, StageBadge, StatusBadge, TYPE_LABEL } from '../flags/status';
import { fullDate, timeAgo } from '../format';
import { useResource } from '../hooks';
import { useSession } from '../session';
import { useScope } from './Layout';

const FILTERS: { value: FlagStatus | undefined; label: string }[] = [
  { value: undefined, label: 'All' },
  { value: 'on', label: 'On' },
  { value: 'rollout', label: 'Rolling out' },
  { value: 'off', label: 'Off' },
  { value: 'archived', label: 'Archived' },
];

export function FlagList() {
  const { project, env, link } = useScope();
  const { can } = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const status = (params.get('status') ?? undefined) as FlagStatus | undefined;
  const cleanup = params.get('view') === 'cleanup';
  const [search, setSearch] = useState(q);
  const [creating, setCreating] = useState(params.get('new') === '1');

  // Typing updates the URL a moment later, so the list doesn't refetch on every key.
  useEffect(() => {
    const t = setTimeout(() => {
      if (search !== q) {
        setParams(
          (p) => {
            if (search === '') p.delete('q');
            else p.set('q', search);
            return p;
          },
          { replace: true },
        );
      }
    }, 250);
    return () => {
      clearTimeout(t);
    };
  }, [search, q, setParams]);

  const flags = useResource(
    () =>
      cleanup
        ? Promise.resolve({ flags: [] })
        : api.flags(project.key, { environment: env, q, status, limit: '500' }),
    `${project.key}/${env}/${q}/${status ?? ''}/${String(cleanup)}`,
  );

  const setView = (next: 'all' | 'cleanup') => {
    setParams((p) => {
      if (next === 'cleanup') p.set('view', 'cleanup');
      else p.delete('view');
      return p;
    });
  };

  const setStatus = (s: FlagStatus | undefined) => {
    setParams((p) => {
      if (s === undefined) p.delete('status');
      else p.set('status', s);
      return p;
    });
  };

  const filtered = q !== '' || status !== undefined;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Flags</h1>
          <p className="muted">
            Turn features on, roll them out gradually, or switch them off in an emergency.
          </p>
        </div>
        {can('editor') && (
          <Button
            variant="primary"
            icon="plus"
            onClick={() => {
              setCreating(true);
            }}
          >
            Create flag
          </Button>
        )}
      </div>

      <div className="chips view-switch" role="group" aria-label="View">
        <Chip
          selected={!cleanup}
          onClick={() => {
            setView('all');
          }}
        >
          All flags
        </Chip>
        <Chip
          selected={cleanup}
          onClick={() => {
            setView('cleanup');
          }}
        >
          Cleanup
        </Chip>
      </div>

      {cleanup ? (
        <Cleanup />
      ) : (
        <>
          <div className="toolbar">
            <div className="search">
              <Icon name="search" />
              <label className="visually-hidden" htmlFor="flag-search">
                Search flags
              </label>
              <input
                id="flag-search"
                type="search"
                placeholder="Search by name or key"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                }}
              />
            </div>
            <div className="chips" role="group" aria-label="Filter by status">
              {FILTERS.map((f) => (
                <Chip
                  key={f.label}
                  selected={status === f.value}
                  onClick={() => {
                    setStatus(f.value);
                  }}
                >
                  {f.label}
                </Chip>
              ))}
            </div>
          </div>

          {flags.error !== undefined ? (
            <ErrorState message={flags.error.message} onRetry={flags.reload} />
          ) : flags.data === undefined ? (
            <Loading label="Loading flags" />
          ) : flags.data.flags.length === 0 ? (
            filtered ? (
              <EmptyState
                icon="search"
                title="No flags match"
                action={
                  <Button
                    onClick={() => {
                      setSearch('');
                      setParams({});
                    }}
                  >
                    Clear filters
                  </Button>
                }
              >
                Try another search, or show all statuses.
              </EmptyState>
            ) : (
              <EmptyState
                icon="flag"
                title="No flags yet"
                action={
                  can('editor') ? (
                    <Button
                      variant="primary"
                      icon="plus"
                      onClick={() => {
                        setCreating(true);
                      }}
                    >
                      Create your first flag
                    </Button>
                  ) : undefined
                }
              >
                A flag lets you ship code switched off and turn it on for some or all of your users
                later.
              </EmptyState>
            )
          ) : (
            <ul className="rows" aria-label="Flags">
              <li aria-hidden="true">
                <div className="row flag-row rows-head">
                  <span>Flag</span>
                  <span>Type</span>
                  <span>Status</span>
                  <span>Updated</span>
                </div>
              </li>
              {flags.data.flags.map((f) => (
                <li key={f.key}>
                  <Link className="row flag-row" to={link(`flags/${encodeURIComponent(f.key)}`)}>
                    <span className="row-title">
                      <strong>{f.name}</strong>
                      <span className="mono muted">{f.key}</span>
                    </span>
                    <span className="row-meta hide-narrow">{TYPE_LABEL[f.type]}</span>
                    <span className="badges">
                      <StatusBadge status={f.status} />
                      <LifecycleChip lifecycle={f.lifecycle} />
                    </span>
                    <span className="row-meta hide-narrow" title={fullDate(f.updatedAt)}>
                      {timeAgo(f.updatedAt)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {creating && (
        <CreateFlagDialog
          project={project.key}
          onClose={() => {
            setCreating(false);
          }}
          onCreated={(flag) => {
            setCreating(false);
            toast(`Created ${flag.name}. It's off in every environment until you turn it on.`);
            void navigate(link(`flags/${encodeURIComponent(flag.key)}`));
          }}
        />
      )}
    </div>
  );
}

/**
 * Flags that are stale in this environment, longest first, with the reason:
 * the list to work through when removing flags from code.
 */
function Cleanup() {
  const { project, env, link } = useScope();
  const stale = useResource(() => api.staleFlags(project.key, env), `${project.key}/${env}/stale`);
  const envName = project.environments.find((e) => e.key === env)?.name ?? env;

  if (stale.error !== undefined) {
    return <ErrorState message={stale.error.message} onRetry={stale.reload} />;
  }
  if (stale.data === undefined) return <Loading label="Loading stale flags" />;
  const days = stale.data.staleAfterDays;
  if (stale.data.flags.length === 0) {
    return (
      <EmptyState icon="check" title="Nothing to clean up">
        {`No flag in ${envName} has served one variant to everyone, or gone unevaluated, for ${days} days.`}
      </EmptyState>
    );
  }
  return (
    <>
      <p className="muted">
        {`These flags have served one variant to everyone, or not been evaluated, in ${envName} for ${days} days or more. Remove them from your code, then archive them.`}
      </p>
      <ul className="rows" aria-label="Stale flags">
        <li aria-hidden="true">
          <div className="row cleanup-row rows-head">
            <span>Flag</span>
            <span>Stage</span>
            <span>Why</span>
            <span>Last evaluated</span>
          </div>
        </li>
        {stale.data.flags.map((f) => (
          <li key={f.key}>
            <Link className="row cleanup-row" to={link(`flags/${encodeURIComponent(f.key)}`)}>
              <span className="row-title">
                <strong>{f.name}</strong>
                <span className="mono muted">{f.key}</span>
              </span>
              <span>
                <StageBadge stage={f.stage} />
              </span>
              <span className="reasons">
                {f.reasons.map((r) => (
                  <span key={r.kind}>{describeReason(r)}</span>
                ))}
              </span>
              <span
                className="row-meta hide-narrow"
                title={f.lastEvaluatedAt === null ? undefined : fullDate(f.lastEvaluatedAt)}
              >
                {f.lastEvaluatedAt === null ? 'Never' : timeAgo(f.lastEvaluatedAt)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
