import { FLAG_TYPES, keySchema, validateFlag, type Flag, type Variant } from '@flagship/core';
import { useState, type SyntheticEvent } from 'react';
import { ApiError, api, type FlagDetail } from '../api';
import { Dialog } from '../components/dialog';
import { Button, Field, IconButton, Segmented, Switch } from '../components/ui';
import { slugify } from '../format';
import { TYPE_LABEL } from './status';
import { defaultDrafts, parseValue, type VariantDraft } from './variants';

type Errors = Record<string, string>;

export function CreateFlagDialog({
  project,
  onClose,
  onCreated,
}: {
  project: string;
  onClose: () => void;
  onCreated: (flag: FlagDetail) => void;
}) {
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const [description, setDescription] = useState('');
  const [type, setType] = useState<Flag['type']>('boolean');
  const [variants, setVariants] = useState<VariantDraft[]>(defaultDrafts('boolean'));
  const [clientSide, setClientSide] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const effectiveKey = keyEdited ? key : slugify(name);

  const check = (): { ok: true; variants: Variant[] } | { ok: false; errors: Errors } => {
    const e: Errors = {};
    if (name.trim() === '') e.name = 'Give the flag a name';
    const k = keySchema.safeParse(effectiveKey);
    if (!k.success)
      e.key =
        effectiveKey === '' ? 'A key is required' : (k.error.issues[0]?.message ?? 'Invalid key');
    const parsed: Variant[] = [];
    variants.forEach((v, i) => {
      if (v.key.trim() === '') e[`variants.${i}.key`] = 'Name this variant';
      const p = parseValue(type, v.value);
      if ('error' in p) e[`variants.${i}.value`] = p.error;
      else parsed.push({ key: v.key.trim(), value: p.value });
    });
    if (Object.keys(e).length === 0) {
      const off = parsed[0]?.key ?? '';
      const result = validateFlag({
        key: effectiveKey,
        type,
        variants: parsed,
        enabled: false,
        offVariant: off,
        prerequisites: [],
        rules: [],
        fallthrough: { variant: off },
        salt: effectiveKey,
        clientSide,
        version: 0,
      });
      if (!result.ok) {
        for (const issue of result.issues) {
          const m = /^variants\[(\d+)\]\.(\w+)/.exec(issue.path);
          const field =
            m === null ? 'variants' : `variants.${m[1] ?? ''}.${m[2] === 'key' ? 'key' : 'value'}`;
          e[field] ??= issue.message.charAt(0).toUpperCase() + issue.message.slice(1);
        }
      }
    }
    return Object.keys(e).length === 0 ? { ok: true, variants: parsed } : { ok: false, errors: e };
  };

  const submit = async (ev: SyntheticEvent) => {
    ev.preventDefault();
    const c = check();
    if (!c.ok) {
      setErrors(c.errors);
      return;
    }
    setErrors({});
    setFormError(undefined);
    setBusy(true);
    try {
      const flag = await api.createFlag(project, {
        key: effectiveKey,
        name: name.trim(),
        description: description.trim(),
        type,
        ...(type === 'boolean' ? {} : { variants: c.variants }),
        clientSide,
      });
      onCreated(flag);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'already_exists') {
        setErrors({ key: 'A flag with this key already exists in this project' });
      } else {
        setFormError(err instanceof ApiError ? err.message : 'Could not create the flag.');
      }
    } finally {
      setBusy(false);
    }
  };

  const setVariant = (i: number, patch: Partial<VariantDraft>) => {
    setVariants((all) => all.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  };

  return (
    <Dialog
      title="Create flag"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="create-flag" busy={busy}>
            Create flag
          </Button>
        </>
      }
    >
      <form id="create-flag" className="form-grid" onSubmit={(e) => void submit(e)} noValidate>
        {formError !== undefined && (
          <div className="banner" role="alert">
            <p>{formError}</p>
          </div>
        )}
        <Field label="Name" error={errors.name}>
          {(p) => (
            <input
              {...p}
              type="text"
              value={name}
              data-autofocus
              maxLength={100}
              onChange={(e) => {
                setName(e.target.value);
              }}
            />
          )}
        </Field>
        <Field
          label="Key"
          hint="Used in code. Letters, digits, dots, dashes and underscores."
          error={errors.key}
        >
          {(p) => (
            <input
              {...p}
              type="text"
              className="mono"
              value={effectiveKey}
              maxLength={100}
              onChange={(e) => {
                setKeyEdited(true);
                setKey(e.target.value);
              }}
            />
          )}
        </Field>
        <Field label="Description" hint="Optional. What it controls and when it can be removed.">
          {(p) => (
            <textarea
              {...p}
              value={description}
              maxLength={500}
              onChange={(e) => {
                setDescription(e.target.value);
              }}
            />
          )}
        </Field>
        <div className="field">
          <span id="type-label" className="small" style={{ fontWeight: 550 }}>
            Type
          </span>
          <Segmented
            label="Type"
            value={type}
            options={FLAG_TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] }))}
            onChange={(t) => {
              setType(t);
              setVariants(defaultDrafts(t));
              setErrors({});
            }}
          />
        </div>
        {type !== 'boolean' && (
          <fieldset className="form-grid" style={{ border: 'none', padding: 0, margin: 0 }}>
            <legend className="small" style={{ fontWeight: 550, marginBottom: 8 }}>
              Variants
            </legend>
            {errors.variants !== undefined && <p className="field-error">{errors.variants}</p>}
            {variants.map((v, i) => (
              <div
                key={i}
                className="form-row"
                style={{ alignItems: 'start', gridTemplateColumns: '1fr 2fr auto' }}
              >
                <Field label={`Variant ${i + 1} name`} error={errors[`variants.${i}.key`]}>
                  {(p) => (
                    <input
                      {...p}
                      type="text"
                      className="mono"
                      value={v.key}
                      onChange={(e) => {
                        setVariant(i, { key: e.target.value });
                      }}
                    />
                  )}
                </Field>
                <Field label={`Variant ${i + 1} value`} error={errors[`variants.${i}.value`]}>
                  {(p) => (
                    <input
                      {...p}
                      type="text"
                      className={type === 'string' ? undefined : 'mono'}
                      value={v.value}
                      onChange={(e) => {
                        setVariant(i, { value: e.target.value });
                      }}
                    />
                  )}
                </Field>
                <div style={{ paddingTop: 26 }}>
                  <IconButton
                    icon="trash"
                    label={`Remove variant ${i + 1}`}
                    disabled={variants.length <= 2}
                    onClick={() => {
                      setVariants((all) => all.filter((_, j) => j !== i));
                    }}
                  />
                </div>
              </div>
            ))}
            <div>
              <Button
                icon="plus"
                variant="plain"
                disabled={variants.length >= 20}
                onClick={() => {
                  setVariants((all) => [
                    ...all,
                    { key: `v${all.length + 1}`, value: type === 'json' ? '{}' : '' },
                  ]);
                }}
              >
                Add variant
              </Button>
            </div>
          </fieldset>
        )}
        <Switch
          checked={clientSide}
          onChange={setClientSide}
          label="Available to browser and mobile apps"
          description="Client-side SDKs can read this flag's value. They never see its rules."
        />
      </form>
    </Dialog>
  );
}
