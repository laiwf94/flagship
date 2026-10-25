import { useState, type SyntheticEvent } from 'react';
import { ApiError, api, type FlagDetail } from '../api';
import { Dialog } from '../components/dialog';
import { useToast } from '../components/toast';
import { Button, Card, Field, Switch } from '../components/ui';
import { formatValue } from '../format';

export function FlagSettings({
  project,
  flag,
  canEdit,
  onSaved,
  onReload,
}: {
  project: string;
  flag: FlagDetail;
  canEdit: boolean;
  onSaved: (flag: FlagDetail) => void;
  onReload: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(flag.name);
  const [description, setDescription] = useState(flag.description);
  const [clientSide, setClientSide] = useState(flag.clientSide);
  const [error, setError] = useState<ApiError | undefined>();
  const [nameError, setNameError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const editable = canEdit && !flag.archived;
  const dirty =
    name !== flag.name || description !== flag.description || clientSide !== flag.clientSide;

  const save = async (e: SyntheticEvent) => {
    e.preventDefault();
    if (name.trim() === '') {
      setNameError('Give the flag a name');
      return;
    }
    setNameError(undefined);
    setBusy(true);
    setError(undefined);
    try {
      const next = await api.updateFlag(project, flag.key, {
        version: flag.version,
        name: name.trim(),
        description: description.trim(),
        clientSide,
      });
      onSaved(next);
      toast('Flag settings saved.');
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    setBusy(true);
    try {
      const next = flag.archived
        ? await api.restore(project, flag.key, flag.version)
        : await api.archive(project, flag.key, flag.version);
      onSaved(next);
      setConfirm(false);
      toast(next.archived ? `${flag.name} archived.` : `${flag.name} restored.`);
    } catch (err) {
      setConfirm(false);
      setError(err instanceof ApiError ? err : undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <Card title="Details">
        <form className="form-grid" onSubmit={(e) => void save(e)} noValidate>
          {error !== undefined && (
            <div className="banner" role="alert">
              <div>
                <p>
                  {error.code === 'version_conflict'
                    ? 'Someone else changed this flag. Reload to see the latest before editing.'
                    : error.message}
                </p>
                {error.issues.length > 0 && (
                  <ul>
                    {error.issues.map((i) => (
                      <li key={i.path}>{i.message}</li>
                    ))}
                  </ul>
                )}
                {error.code === 'version_conflict' && (
                  <div>
                    <Button onClick={onReload}>Reload latest</Button>
                  </div>
                )}
              </div>
            </div>
          )}
          <Field label="Name" error={nameError}>
            {(p) => (
              <input
                {...p}
                type="text"
                value={name}
                disabled={!editable}
                maxLength={100}
                onChange={(e) => {
                  setName(e.target.value);
                }}
              />
            )}
          </Field>
          <Field label="Description">
            {(p) => (
              <textarea
                {...p}
                value={description}
                disabled={!editable}
                maxLength={500}
                onChange={(e) => {
                  setDescription(e.target.value);
                }}
              />
            )}
          </Field>
          <Switch
            checked={clientSide}
            onChange={setClientSide}
            disabled={!editable}
            label="Available to browser and mobile apps"
            description="Client-side SDKs can read this flag's value. They never see its rules."
          />
          <div>
            <h3>Variants</h3>
            <ul className="plain-list small">
              {flag.variants.map((v) => (
                <li key={v.key}>
                  <span className="mono">{v.key}</span>{' '}
                  <span className="muted">{formatValue(v.value)}</span>
                </li>
              ))}
            </ul>
          </div>
          {editable && (
            <div>
              <Button type="submit" variant="primary" busy={busy} disabled={!dirty}>
                Save details
              </Button>
            </div>
          )}
        </form>
      </Card>
      {canEdit && (
        <Card title={flag.archived ? 'Restore' : 'Archive'}>
          <p className="muted">
            {flag.archived
              ? 'Restoring puts the flag back in every environment with the targeting it had.'
              : 'Archiving removes the flag from every environment; SDKs fall back to the default in your code. History is kept and you can restore it.'}
          </p>
          <div>
            <Button
              variant={flag.archived ? 'secondary' : 'danger'}
              icon={flag.archived ? 'restore' : 'archive'}
              onClick={() => {
                setConfirm(true);
              }}
            >
              {flag.archived ? 'Restore flag' : 'Archive flag'}
            </Button>
          </div>
        </Card>
      )}
      {confirm && (
        <Dialog
          title={flag.archived ? `Restore ${flag.name}?` : `Archive ${flag.name}?`}
          onClose={() => {
            setConfirm(false);
          }}
          footer={
            <>
              <Button
                onClick={() => {
                  setConfirm(false);
                }}
              >
                Cancel
              </Button>
              <Button
                variant={flag.archived ? 'primary' : 'danger'}
                busy={busy}
                onClick={() => void archive()}
                data-autofocus
              >
                {flag.archived ? 'Restore' : 'Archive'}
              </Button>
            </>
          }
        >
          <p>
            {flag.archived
              ? 'SDKs will receive this flag again within seconds.'
              : 'SDKs stop receiving this flag within seconds. Flags that list it as a prerequisite must be changed first.'}
          </p>
        </Dialog>
      )}
    </div>
  );
}
