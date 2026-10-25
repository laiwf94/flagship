import { keySchema } from '@flagship/core';
import { useState, type SyntheticEvent } from 'react';
import { ApiError, api, type ApiKey, type ManagedUser, type Role } from '../api';
import { Dialog } from '../components/dialog';
import { useToast } from '../components/toast';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  Segmented,
  Switch,
} from '../components/ui';
import { fullDate, slugify, timeAgo } from '../format';
import { useResource } from '../hooks';
import { useSession } from '../session';
import { useScope } from './Layout';

export function Settings() {
  const { can } = useSession();
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="muted">Environments, SDK keys and who can change flags.</p>
        </div>
      </div>
      <Environments />
      {can('admin') ? (
        <>
          <ApiKeys />
          <Users />
        </>
      ) : (
        <p className="muted">Only admins can manage SDK keys and users.</p>
      )}
    </div>
  );
}

function Environments() {
  const { project } = useScope();
  const { can } = useSession();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    const key = slugify(name);
    if (name.trim() === '' || !keySchema.safeParse(key).success) {
      setError('Name the environment, like Staging');
      return;
    }
    setBusy(true);
    try {
      await api.createEnvironment(project.key, { key, name: name.trim() });
      toast(`Created ${name.trim()}. Reload to switch to it.`);
      setAdding(false);
      window.location.reload();
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'already_exists'
          ? 'That environment already exists'
          : 'Could not create it',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Environments"
      actions={
        can('admin') ? (
          <Button
            icon="plus"
            onClick={() => {
              setAdding(true);
            }}
          >
            Add environment
          </Button>
        ) : undefined
      }
    >
      <ul className="plain-list">
        {project.environments.map((e) => (
          <li key={e.key} className="env-row">
            <strong>{e.name}</strong> <span className="mono muted">{e.key}</span>
          </li>
        ))}
      </ul>
      {adding && (
        <Dialog
          title="Add environment"
          onClose={() => {
            setAdding(false);
          }}
          footer={
            <>
              <Button
                onClick={() => {
                  setAdding(false);
                }}
              >
                Cancel
              </Button>
              <Button variant="primary" type="submit" form="env-form" busy={busy}>
                Add environment
              </Button>
            </>
          }
        >
          <form id="env-form" onSubmit={(e) => void submit(e)} noValidate>
            <Field
              label="Name"
              hint={`Key: ${slugify(name) || '…'}. Every flag starts off in a new environment.`}
              error={error}
            >
              {(p) => (
                <input
                  {...p}
                  type="text"
                  value={name}
                  data-autofocus
                  onChange={(e) => {
                    setName(e.target.value);
                  }}
                />
              )}
            </Field>
          </form>
        </Dialog>
      )}
    </Card>
  );
}

function ApiKeys() {
  const { project, env } = useScope();
  const envName = project.environments.find((e) => e.key === env)?.name ?? env;
  const toast = useToast();
  const keys = useResource(() => api.apiKeys(project.key, env), `${project.key}/${env}/keys`);
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<(ApiKey & { secret: string }) | undefined>();
  const [revoking, setRevoking] = useState<ApiKey | undefined>();

  return (
    <Card
      title={`SDK keys for ${envName}`}
      actions={
        <Button
          icon="key"
          onClick={() => {
            setCreating(true);
          }}
        >
          Create key
        </Button>
      }
    >
      <p className="muted small">
        Server keys see every rule; keep them on your servers. Client keys only get evaluated values
        and are safe to ship in a web page or app.
      </p>
      {keys.error !== undefined ? (
        <ErrorState message={keys.error.message} onRetry={keys.reload} />
      ) : keys.data === undefined ? (
        <Loading rows={2} label="Loading keys" />
      ) : keys.data.keys.length === 0 ? (
        <EmptyState icon="key" title="No keys yet">
          Create a server key for your backend, or a client key for a browser app.
        </EmptyState>
      ) : (
        <ul className="rows" aria-label="SDK keys">
          {keys.data.keys.map((k) => (
            <li key={k.id} className="row key-row">
              <span className="row-title">
                <strong>{k.name}</strong>
                <span className="mono muted">{k.displayPrefix}…</span>
              </span>
              <span>
                <Badge tone={k.kind === 'server' ? 'warning' : 'info'}>
                  {k.kind === 'server' ? 'Server' : 'Client'}
                </Badge>
              </span>
              <span className="row-meta hide-narrow">
                {k.lastUsedAt === null ? (
                  'Never used'
                ) : (
                  <span title={fullDate(k.lastUsedAt)}>Used {timeAgo(k.lastUsedAt)}</span>
                )}
              </span>
              <span>
                {k.revoked ? (
                  <Badge tone="neutral">Revoked</Badge>
                ) : (
                  <Button
                    variant="plain"
                    onClick={() => {
                      setRevoking(k);
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
        <CreateKeyDialog
          onClose={() => {
            setCreating(false);
          }}
          onCreate={async (kind, name) => {
            const created = await api.createApiKey(project.key, env, { kind, name });
            setCreating(false);
            setRevealed(created);
            keys.reload();
          }}
        />
      )}
      {revealed !== undefined && (
        <Dialog
          title="Copy your new key"
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
          <p>This is the only time the full key is shown. Store it in your secrets manager now.</p>
          <div className="secret">
            <code aria-label="New key">{revealed.secret}</code>
            <Button
              icon="copy"
              data-autofocus
              onClick={() => {
                void navigator.clipboard.writeText(revealed.secret).then(
                  () => {
                    toast('Key copied.');
                  },
                  () => {
                    toast('Copy failed; select the key and copy it.', { tone: 'critical' });
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
                    .revokeApiKey(project.key, env, revoking.id)
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
                      keys.reload();
                    });
                }}
              >
                Revoke key
              </Button>
            </>
          }
        >
          <p>
            Apps using this key stop receiving flags immediately and fall back to the defaults in
            their code.
          </p>
        </Dialog>
      )}
    </Card>
  );
}

function CreateKeyDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (kind: ApiKey['kind'], name: string) => Promise<void>;
}) {
  const [kind, setKind] = useState<ApiKey['kind']>('server');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    if (name.trim() === '') {
      setError('Name the key after what uses it, like "checkout service"');
      return;
    }
    setBusy(true);
    try {
      await onCreate(kind, name.trim());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the key');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Create SDK key"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="key-form" busy={busy}>
            Create key
          </Button>
        </>
      }
    >
      <form id="key-form" className="form-grid" onSubmit={(e) => void submit(e)} noValidate>
        <Segmented
          label="Key type"
          value={kind}
          options={[
            { value: 'server', label: 'Server' },
            { value: 'client', label: 'Client (browser)' },
          ]}
          onChange={setKind}
        />
        <Field label="Name" error={error}>
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
      </form>
    </Dialog>
  );
}

const ROLES: { value: Role; label: string }[] = [
  { value: 'viewer', label: 'Viewer' },
  { value: 'editor', label: 'Editor' },
  { value: 'admin', label: 'Admin' },
];

function Users() {
  const { user: me } = useSession();
  const toast = useToast();
  const users = useResource(() => api.users(), 'users');
  const [adding, setAdding] = useState(false);

  const change = (u: ManagedUser, patch: { role?: Role; disabled?: boolean }) => {
    void api
      .updateUser(u.id, patch)
      .then(() => {
        toast(`Updated ${u.name}.`);
        users.reload();
      })
      .catch((err: unknown) => {
        toast(err instanceof ApiError ? err.message : 'Could not update.', { tone: 'critical' });
      });
  };

  return (
    <Card
      title="People"
      actions={
        <Button
          icon="user"
          onClick={() => {
            setAdding(true);
          }}
        >
          Add person
        </Button>
      }
    >
      <p className="muted small">
        Viewers can look. Editors change flags and segments. Admins also manage keys and people.
      </p>
      {users.error !== undefined ? (
        <ErrorState message={users.error.message} onRetry={users.reload} />
      ) : users.data === undefined ? (
        <Loading rows={2} label="Loading people" />
      ) : (
        <ul className="rows" aria-label="People">
          {users.data.users.map((u) => (
            <li key={u.id} className="row user-row">
              <span className="row-title">
                <strong>{u.name}</strong>
                <span className="muted small">{u.email}</span>
              </span>
              <span>
                <label className="visually-hidden" htmlFor={`role-${u.id}`}>
                  Role for {u.name}
                </label>
                <select
                  id={`role-${u.id}`}
                  value={u.role}
                  disabled={u.id === me?.id}
                  onChange={(e) => {
                    change(u, { role: e.target.value as Role });
                  }}
                >
                  {ROLES.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </span>
              <span>
                <Switch
                  checked={!u.disabled}
                  disabled={u.id === me?.id}
                  label={u.disabled ? 'Disabled' : 'Active'}
                  onChange={(active) => {
                    change(u, { disabled: !active });
                  }}
                />
              </span>
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <AddUserDialog
          onClose={() => {
            setAdding(false);
          }}
          onAdded={(u) => {
            setAdding(false);
            toast(`Added ${u.name}. Share their password with them privately.`);
            users.reload();
          }}
        />
      )}
    </Card>
  );
}

function AddUserDialog({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (u: ManagedUser) => void;
}) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('editor');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) next.email = 'Enter an email address';
    if (name.trim() === '') next.name = 'Enter their name';
    if (password.length < 12) next.password = 'Use at least 12 characters';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setBusy(true);
    try {
      onAdded(await api.createUser({ email: email.trim(), name: name.trim(), role, password }));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'already_exists')
        setErrors({ email: 'Someone with this email already has access' });
      else setErrors({ form: err instanceof ApiError ? err.message : 'Could not add them' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Add person"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="user-form" busy={busy}>
            Add person
          </Button>
        </>
      }
    >
      <form id="user-form" className="form-grid" onSubmit={(e) => void submit(e)} noValidate>
        {errors.form !== undefined && (
          <div className="banner" role="alert">
            <p>{errors.form}</p>
          </div>
        )}
        <Field label="Email" error={errors.email}>
          {(p) => (
            <input
              {...p}
              type="email"
              value={email}
              data-autofocus
              autoComplete="off"
              onChange={(e) => {
                setEmail(e.target.value);
              }}
            />
          )}
        </Field>
        <Field label="Name" error={errors.name}>
          {(p) => (
            <input
              {...p}
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
            />
          )}
        </Field>
        <Segmented label="Role" value={role} options={ROLES} onChange={setRole} />
        <Field
          label="Temporary password"
          hint="They can change it after signing in."
          error={errors.password}
        >
          {(p) => (
            <input
              {...p}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
              }}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
