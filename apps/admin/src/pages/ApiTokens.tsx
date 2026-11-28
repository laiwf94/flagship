import { useState, type SyntheticEvent } from 'react';
import {
  ApiError,
  api,
  type ApiToken,
  type ApiTokenInput,
  type Role,
  type TokenScope,
} from '../api';
import { Dialog } from '../components/dialog';
import { useToast } from '../components/toast';
import { Badge, Button, Card, EmptyState, ErrorState, Field, Loading } from '../components/ui';
import { fullDate, timeAgo } from '../format';
import { useResource } from '../hooks';
import { useSession } from '../session';
import { useScope } from './Layout';

/** Every scope, what it allows in a few words, and the least role that can grant it. */
export const SCOPE_CHOICES: { scope: TokenScope; label: string; role: Role }[] = [
  { scope: 'flags:read', label: 'Read flags and rulesets', role: 'viewer' },
  { scope: 'flags:write', label: 'Change flags, schedules and rollouts', role: 'editor' },
  { scope: 'segments:read', label: 'Read segments', role: 'viewer' },
  { scope: 'segments:write', label: 'Change segments', role: 'editor' },
  { scope: 'change-requests:read', label: 'Read change requests', role: 'viewer' },
  {
    scope: 'change-requests:write',
    label: 'Propose, review and apply change requests',
    role: 'editor',
  },
  { scope: 'experiments:read', label: 'Read experiments and results', role: 'viewer' },
  { scope: 'experiments:write', label: 'Start and stop experiments', role: 'editor' },
  { scope: 'audit:read', label: 'Read the change history', role: 'viewer' },
  { scope: 'audit:restore', label: 'Restore from the change history', role: 'editor' },
  { scope: 'projects:read', label: 'List projects', role: 'viewer' },
  { scope: 'projects:write', label: 'Create projects and change environment rules', role: 'admin' },
  { scope: 'sdk-keys:read', label: 'List SDK keys', role: 'admin' },
  { scope: 'sdk-keys:write', label: 'Create and revoke SDK keys', role: 'admin' },
  { scope: 'webhooks:read', label: 'Read webhooks and deliveries', role: 'admin' },
  { scope: 'webhooks:write', label: 'Manage and replay webhooks', role: 'admin' },
  { scope: 'code-references:write', label: 'Upload code references from scans', role: 'editor' },
];

const EXPIRY_DAYS = [7, 30, 90, 365] as const;

function where(t: ApiToken): string {
  if (t.project === null) return 'All projects';
  if (t.environments === null) return t.project;
  return `${t.project} · ${t.environments.join(', ')}`;
}

function state(t: ApiToken) {
  if (t.revoked) return <Badge tone="neutral">Revoked</Badge>;
  if (t.expired) return <Badge tone="neutral">Expired</Badge>;
  return <span title={fullDate(t.expiresAt)}>Expires {timeAgo(t.expiresAt)}</span>;
}

/** The signed-in user's API tokens, for scripts and CI to call the admin API. */
export function ApiTokens() {
  const toast = useToast();
  const tokens = useResource(() => api.apiTokens(), 'api-tokens');
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<(ApiToken & { secret: string }) | undefined>();
  const [revoking, setRevoking] = useState<ApiToken | undefined>();

  return (
    <Card
      title="Your API tokens"
      actions={
        <Button
          icon="key"
          onClick={() => {
            setCreating(true);
          }}
        >
          Create token
        </Button>
      }
    >
      <p className="muted small">
        Tokens let scripts and CI call the admin API as you, limited to the scopes, project and
        environments you pick. Send one as <code>Authorization: Bearer</code>; it needs no CSRF
        token, and it can never do more than your role allows.
      </p>
      {tokens.error !== undefined ? (
        <ErrorState message={tokens.error.message} onRetry={tokens.reload} />
      ) : tokens.data === undefined ? (
        <Loading rows={2} label="Loading tokens" />
      ) : tokens.data.tokens.length === 0 ? (
        <EmptyState icon="key" title="No tokens yet">
          Create one for a deploy script or a CI job.
        </EmptyState>
      ) : (
        <ul className="rows" aria-label="API tokens">
          {tokens.data.tokens.map((t) => (
            <li key={t.id} className="row token-row">
              <span className="row-title">
                <strong>{t.name}</strong>
                <span className="mono muted">{t.displayPrefix}…</span>
                <span className="muted small token-scopes">{t.scopes.join(', ')}</span>
              </span>
              <span className="row-meta">{where(t)}</span>
              <span className="row-meta hide-narrow">
                {t.lastUsedAt === null ? (
                  'Never used'
                ) : (
                  <span title={fullDate(t.lastUsedAt)}>Used {timeAgo(t.lastUsedAt)}</span>
                )}
              </span>
              <span className="row-meta">{state(t)}</span>
              <span>
                {!t.revoked && !t.expired && (
                  <Button
                    variant="plain"
                    aria-label={`Revoke ${t.name}`}
                    onClick={() => {
                      setRevoking(t);
                    }}
                  >
                    Revoke
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {creating && (
        <CreateTokenDialog
          onClose={() => {
            setCreating(false);
          }}
          onCreate={async (input) => {
            const created = await api.createApiToken(input);
            setCreating(false);
            setRevealed(created);
            tokens.reload();
          }}
        />
      )}
      {revealed !== undefined && (
        <Dialog
          title="Copy your new token"
          onClose={() => {
            setRevealed(undefined);
          }}
          footer={
            <Button
              variant="primary"
              onClick={() => {
                setRevealed(undefined);
              }}
            >
              I've copied it
            </Button>
          }
        >
          <p>
            This is the only time the full token is shown. Store it in your secrets manager now.
          </p>
          <div className="secret">
            <code aria-label="New token">{revealed.secret}</code>
            <Button
              icon="copy"
              data-autofocus
              onClick={() => {
                void navigator.clipboard.writeText(revealed.secret).then(
                  () => {
                    toast('Token copied.');
                  },
                  () => {
                    toast('Copy failed; select the token and copy it.', { tone: 'critical' });
                  },
                );
              }}
            >
              Copy
            </Button>
          </div>
        </Dialog>
      )}
      {revoking !== undefined && (
        <Dialog
          title={`Revoke ${revoking.name}?`}
          onClose={() => {
            setRevoking(undefined);
          }}
          footer={
            <>
              <Button
                onClick={() => {
                  setRevoking(undefined);
                }}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  void api
                    .revokeApiToken(revoking.id)
                    .then(() => {
                      toast(`Revoked ${revoking.name}.`);
                    })
                    .catch((err: unknown) => {
                      toast(err instanceof ApiError ? err.message : 'Could not revoke.', {
                        tone: 'critical',
                      });
                    })
                    .finally(() => {
                      setRevoking(undefined);
                      tokens.reload();
                    });
                }}
              >
                Revoke token
              </Button>
            </>
          }
        >
          <p>Anything using this token is refused from its next request.</p>
        </Dialog>
      )}
    </Card>
  );
}

function CreateTokenDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (input: ApiTokenInput) => Promise<void>;
}) {
  const { project } = useScope();
  const { can } = useSession();
  const choices = SCOPE_CHOICES.filter((c) => can(c.role));
  const [name, setName] = useState('');
  const [days, setDays] = useState<number>(30);
  const [allProjects, setAllProjects] = useState(false);
  const [envs, setEnvs] = useState<string[]>(project.environments.map((e) => e.key));
  const [scopes, setScopes] = useState<TokenScope[]>(['flags:read']);
  const [errors, setErrors] = useState<{ name?: string; scopes?: string; envs?: string }>({});
  const [failure, setFailure] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const toggle = <T,>(list: T[], value: T, on: boolean): T[] =>
    on ? [...list, value] : list.filter((v) => v !== value);

  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    const found: typeof errors = {};
    if (name.trim() === '') found.name = 'Name the token after what uses it, like "deploy job"';
    if (scopes.length === 0) found.scopes = 'Pick at least one scope';
    if (!allProjects && envs.length === 0) found.envs = 'Pick at least one environment';
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const input: ApiTokenInput = { name: name.trim(), scopes, expiresInDays: days };
    if (!allProjects) {
      input.project = project.key;
      // Every environment ticked means all of them, including ones added later.
      if (envs.length < project.environments.length) input.environments = envs;
    }
    setBusy(true);
    setFailure(undefined);
    try {
      await onCreate(input);
    } catch (err) {
      setFailure(err instanceof ApiError ? err.message : 'Could not create the token');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Create API token"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="token-form" busy={busy}>
            Create token
          </Button>
        </>
      }
    >
      <form id="token-form" className="form-grid" onSubmit={(e) => void submit(e)} noValidate>
        <Field label="Name" error={errors.name}>
          {(p) => (
            <input
              {...p}
              type="text"
              value={name}
              maxLength={100}
              data-autofocus
              onChange={(e) => {
                setName(e.target.value);
              }}
            />
          )}
        </Field>
        <Field label="Expires after">
          {(p) => (
            <select
              {...p}
              value={days}
              onChange={(e) => {
                setDays(Number(e.target.value));
              }}
            >
              {EXPIRY_DAYS.map((d) => (
                <option key={d} value={d}>
                  {d === 365 ? '1 year' : `${d} days`}
                </option>
              ))}
            </select>
          )}
        </Field>
        <fieldset className="choice">
          <legend>Projects</legend>
          <label>
            <input
              type="radio"
              name="token-projects"
              checked={!allProjects}
              onChange={() => {
                setAllProjects(false);
              }}
            />
            Only {project.name}
          </label>
          <label>
            <input
              type="radio"
              name="token-projects"
              checked={allProjects}
              onChange={() => {
                setAllProjects(true);
              }}
            />
            All projects
          </label>
        </fieldset>
        {!allProjects && (
          <fieldset
            className="choice"
            aria-describedby={errors.envs === undefined ? undefined : 'token-envs-err'}
          >
            <legend>Environments it may change</legend>
            {project.environments.map((env) => (
              <label key={env.key}>
                <input
                  type="checkbox"
                  checked={envs.includes(env.key)}
                  onChange={(e) => {
                    setEnvs(toggle(envs, env.key, e.target.checked));
                  }}
                />
                {env.name}
              </label>
            ))}
            {errors.envs !== undefined && (
              <p className="field-error" id="token-envs-err">
                {errors.envs}
              </p>
            )}
          </fieldset>
        )}
        <fieldset
          className="choice"
          aria-describedby={errors.scopes === undefined ? undefined : 'token-scopes-err'}
        >
          <legend>Scopes</legend>
          {choices.map((c) => (
            <label key={c.scope}>
              <input
                type="checkbox"
                checked={scopes.includes(c.scope)}
                onChange={(e) => {
                  setScopes(toggle(scopes, c.scope, e.target.checked));
                }}
              />
              <span>
                {c.label} <span className="mono muted small">{c.scope}</span>
              </span>
            </label>
          ))}
          {errors.scopes !== undefined && (
            <p className="field-error" id="token-scopes-err">
              {errors.scopes}
            </p>
          )}
        </fieldset>
        {failure !== undefined && (
          <p className="field-error" role="alert">
            {failure}
          </p>
        )}
      </form>
    </Dialog>
  );
}
