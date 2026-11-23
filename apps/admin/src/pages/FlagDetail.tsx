import { useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router';
import { api, ApiError, type FlagDetail as Detail } from '../api';
import { Icon } from '../components/icons';
import { useToast } from '../components/toast';
import { Button, ErrorState, Loading } from '../components/ui';
import { Exposures } from '../flags/Exposures';
import { FlagSettings } from '../flags/FlagSettings';
import { History } from '../flags/History';
import { RolloutPlan } from '../flags/RolloutPlan';
import { Schedules } from '../flags/Schedules';
import { StatusBadge, TYPE_LABEL } from '../flags/status';
import { Targeting } from '../flags/Targeting';
import { useResource } from '../hooks';
import { useSession } from '../session';
import { useScope } from './Layout';

const TABS = [
  { key: 'targeting', label: 'Targeting' },
  { key: 'schedules', label: 'Schedules' },
  { key: 'rollout', label: 'Rollout' },
  { key: 'exposures', label: 'Evaluations' },
  { key: 'history', label: 'History' },
  { key: 'settings', label: 'Settings' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

function statusIn(flag: Detail, env: string) {
  const c = flag.environments[env];
  if (flag.archived) return 'archived' as const;
  if (c === undefined || !c.enabled) return 'off' as const;
  const rolling = 'rollout' in c.fallthrough || c.rules.some((r) => 'rollout' in r.serve);
  return rolling ? ('rollout' as const) : ('on' as const);
}

export function FlagDetail() {
  const { project, env, link } = useScope();
  const { flag: key = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const { can } = useSession();
  const toast = useToast();
  const [releasing, setReleasing] = useState(false);
  const tab: TabKey = TABS.some((t) => t.key === params.get('tab'))
    ? (params.get('tab') as TabKey)
    : 'targeting';
  const envName = project.environments.find((e) => e.key === env)?.name ?? env;

  const flag = useResource(() => api.flag(project.key, key), `${project.key}/${key}`);
  const ruleset = useResource(() => api.ruleset(project.key, env), `${project.key}/${env}/ruleset`);

  if (flag.error !== undefined) {
    return (
      <div className="page">
        <Link className="crumb" to={link('flags')}>
          <Icon name="back" size={16} /> Flags
        </Link>
        <ErrorState
          message={
            flag.error.code === 'not_found'
              ? `There is no flag "${key}" in ${project.name}.`
              : flag.error.message
          }
          onRetry={flag.reload}
        />
      </div>
    );
  }
  if (flag.data === undefined) return <Loading rows={6} label="Loading flag" />;
  const f = flag.data;
  const managed = f.managedBy ?? null;
  // A flag managed as code is edited in its file; the kill switch still works here.
  const canToggle = can('editor') && !f.archived;
  const canEdit = canToggle && managed === null;

  return (
    <div className="page">
      <div>
        <Link className="crumb" to={link('flags')}>
          <Icon name="back" size={16} /> Flags
        </Link>
        <div className="page-head">
          <div>
            <div className="title-row">
              <h1>{f.name}</h1>
              <StatusBadge status={statusIn(f, env)} />
            </div>
            <p className="muted">
              <span className="mono">{f.key}</span> · {TYPE_LABEL[f.type]}
              {f.clientSide ? ' · visible to browser apps' : ''}
            </p>
            {f.description !== '' && <p>{f.description}</p>}
          </div>
        </div>
      </div>

      {f.archived && (
        <div className="banner banner-warning" role="status">
          <Icon name="archive" />
          <p>
            This flag is archived: SDKs no longer receive it. Restore it from Settings to edit it
            again.
          </p>
        </div>
      )}

      {managed !== null && (
        <div className="banner banner-info" role="status">
          <Icon name="diff" />
          <div>
            <p>
              Managed as code by <span className="mono">{managed.source}</span>: edit the file and
              run <span className="mono">flagship apply</span>. Editing is locked here; the on and
              off switch still works for incidents, and the next plan reports it as drift.
            </p>
            {can('editor') && (
              <Button
                busy={releasing}
                onClick={() => {
                  setReleasing(true);
                  void api
                    .releaseManagedBy(project.key, f.key)
                    .then((next) => {
                      flag.set(next);
                      toast(`${f.key} is now edited here. Remove it from ${managed.source} too.`);
                    })
                    .catch((err: unknown) => {
                      toast(err instanceof ApiError ? err.message : 'Could not unlock the flag.', {
                        tone: 'critical',
                      });
                    })
                    .finally(() => {
                      setReleasing(false);
                    });
                }}
              >
                Edit here instead
              </Button>
            )}
          </div>
        </div>
      )}

      <div className="tabs" role="tablist" aria-label="Flag sections">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            id={`tab-${t.key}`}
            aria-selected={tab === t.key}
            aria-controls={`panel-${t.key}`}
            tabIndex={tab === t.key ? 0 : -1}
            onClick={() => {
              setParams({ tab: t.key }, { replace: true });
            }}
            onKeyDown={(e) => {
              const i = TABS.findIndex((x) => x.key === tab);
              const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
              if (d !== 0) {
                const next = TABS[(i + d + TABS.length) % TABS.length];
                if (next !== undefined) {
                  setParams({ tab: next.key }, { replace: true });
                  document.getElementById(`tab-${next.key}`)?.focus();
                }
              }
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'targeting' &&
          (ruleset.error !== undefined ? (
            <ErrorState message={ruleset.error.message} onRetry={ruleset.reload} />
          ) : ruleset.data === undefined ? (
            <Loading rows={4} label="Loading targeting" />
          ) : (
            <Targeting
              key={`${f.key}/${env}`}
              project={project.key}
              flag={f}
              env={env}
              envName={envName}
              ruleset={ruleset.data}
              canEdit={canEdit}
              canToggle={canToggle}
              onSaved={(next) => {
                flag.set(next);
                ruleset.reload();
              }}
              onReload={() => {
                flag.reload();
                ruleset.reload();
              }}
            />
          ))}
        {tab === 'schedules' && (
          <Schedules project={project.key} flag={f} env={env} envName={envName} canEdit={canEdit} />
        )}
        {tab === 'rollout' && (
          <RolloutPlan
            project={project.key}
            flag={f}
            env={env}
            envName={envName}
            canEdit={canEdit}
            onChanged={() => {
              flag.reload();
              ruleset.reload();
            }}
          />
        )}
        {tab === 'exposures' && (
          <Exposures project={project.key} flag={f} env={env} envName={envName} />
        )}
        {tab === 'history' && <History project={project.key} flag={f.key} />}
        {tab === 'settings' && (
          <FlagSettings
            key={f.version}
            project={project.key}
            flag={f}
            canEdit={can('editor') && managed === null}
            onSaved={(next) => {
              flag.set(next);
              ruleset.reload();
            }}
            onReload={flag.reload}
          />
        )}
      </div>
    </div>
  );
}
