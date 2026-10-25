import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api, type FlagStatus } from '../api';
import { Icon } from '../components/icons';
import { useToast } from '../components/toast';
import { Button, Chip, EmptyState, ErrorState, Loading } from '../components/ui';
import { CreateFlagDialog } from '../flags/CreateFlagDialog';
import { StatusBadge, TYPE_LABEL } from '../flags/status';
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
    () => api.flags(project.key, { environment: env, q, status, limit: '500' }),
    `${project.key}/${env}/${q}/${status ?? ''}`,
  );

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
            <div className="row rows-head">
              <span>Flag</span>
              <span>Type</span>
              <span>Status</span>
              <span>Updated</span>
            </div>
          </li>
          {flags.data.flags.map((f) => (
            <li key={f.key}>
              <Link className="row" to={link(`flags/${encodeURIComponent(f.key)}`)}>
                <span className="row-title">
                  <strong>{f.name}</strong>
                  <span className="mono muted">{f.key}</span>
                </span>
                <span className="row-meta hide-narrow">{TYPE_LABEL[f.type]}</span>
                <span>
                  <StatusBadge status={f.status} />
                </span>
                <span className="row-meta hide-narrow" title={fullDate(f.updatedAt)}>
                  {timeAgo(f.updatedAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
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
