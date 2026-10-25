import { useState, type SyntheticEvent } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { ApiError } from '../api';
import { Icon } from '../components/icons';
import { Button, Field } from '../components/ui';
import { useSession } from '../session';

/** Only same-site paths are honoured, so ?next= can't send people elsewhere. */
function safeNext(next: string | null): string {
  return next !== null && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

export function SignIn() {
  const { user, signIn } = useSession();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  if (user !== null) return <Navigate to={safeNext(params.get('next'))} replace />;

  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    if (email.trim() === '' || password === '') {
      setError('Enter your email and password.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await signIn(email.trim(), password);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'resource_exhausted'
          ? 'Too many attempts. Wait a few minutes and try again.'
          : err instanceof ApiError
            ? err.message.charAt(0).toUpperCase() + err.message.slice(1) + '.'
            : 'Sign-in failed.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="signin" id="main">
      <form
        onSubmit={(e) => void submit(e)}
        noValidate
        aria-describedby={error === undefined ? undefined : 'signin-error'}
      >
        <div className="brand">
          <span className="brand-mark">
            <Icon name="flag" size={18} />
          </span>
          flagship
        </div>
        <div>
          <h1>Sign in</h1>
          <p className="muted small">Manage feature flags and rollouts.</p>
        </div>
        {error !== undefined && (
          <div className="banner" role="alert" id="signin-error">
            <Icon name="alert" />
            <p>{error}</p>
          </div>
        )}
        <Field label="Email">
          {(p) => (
            <input
              {...p}
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
              }}
              data-autofocus
            />
          )}
        </Field>
        <Field label="Password">
          {(p) => (
            <input
              {...p}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
              }}
            />
          )}
        </Field>
        <Button type="submit" variant="primary" busy={busy}>
          Sign in
        </Button>
      </form>
    </main>
  );
}
