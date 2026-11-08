import { useState, type SyntheticEvent } from 'react';
import { useSearchParams } from 'react-router';
import { Button, Field } from '../components/ui';
import { History } from '../flags/History';
import {
  draftFromParams,
  NO_FILTERS,
  paramsFromDraft,
  toAuditFilters,
  type FilterDraft,
} from '../flags/historyFilters';
import { useSession } from '../session';
import { useScope } from './Layout';

export function HistoryPage() {
  const { project } = useScope();
  const { user } = useSession();
  const [params, setParams] = useSearchParams();
  const applied = draftFromParams(params);
  const appliedFilters = toAuditFilters(applied);
  const [draft, setDraft] = useState<FilterDraft>(applied);
  const [errors, setErrors] = useState<Partial<FilterDraft>>(
    appliedFilters.ok ? {} : appliedFilters.errors,
  );
  // Back and forward change the address: show what it now says.
  const [seen, setSeen] = useState(params.toString());
  if (seen !== params.toString()) {
    setSeen(params.toString());
    setDraft(applied);
    setErrors(appliedFilters.ok ? {} : appliedFilters.errors);
  }
  const filtered = params.toString() !== '';

  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    const checked = toAuditFilters(draft);
    setErrors(checked.ok ? {} : checked.errors);
    if (checked.ok) setParams(paramsFromDraft(draft));
  };

  const field = (k: keyof FilterDraft) => ({
    value: draft[k],
    onChange: (e: { target: { value: string } }) => {
      setDraft((d) => ({ ...d, [k]: e.target.value }));
    },
  });

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>History</h1>
          <p className="muted">
            Every change in {project.name}: who made it, when, why, and exactly what changed.
          </p>
        </div>
      </div>
      <form
        className="history-filters"
        role="search"
        aria-label="Search history"
        onSubmit={submit}
        noValidate
      >
        <div className="history-filter-text">
          <Field
            label="Search"
            hint='Words in the change, its reason or link. Use "quotes" for a phrase, -word to leave out.'
            error={errors.q}
          >
            {(p) => <input {...p} type="search" maxLength={200} {...field('q')} />}
          </Field>
        </div>
        <div>
          <Field label="Changed by" error={errors.actor}>
            {(p) => (
              <input
                {...p}
                type="text"
                maxLength={100}
                list="history-actors"
                placeholder="Full name"
                {...field('actor')}
              />
            )}
          </Field>
          {user !== null && (
            <datalist id="history-actors">
              <option value={user.name} />
            </datalist>
          )}
        </div>
        <div>
          <Field label="From" error={errors.from}>
            {(p) => <input {...p} type="date" {...field('from')} />}
          </Field>
        </div>
        <div>
          <Field label="To" error={errors.to}>
            {(p) => <input {...p} type="date" min={draft.from || undefined} {...field('to')} />}
          </Field>
        </div>
        <div className="history-filters-actions">
          <Button variant="primary" type="submit" icon="search">
            Search
          </Button>
          {filtered && (
            <Button
              onClick={() => {
                setDraft(NO_FILTERS);
                setErrors({});
                setParams(new URLSearchParams());
              }}
            >
              Clear
            </Button>
          )}
        </div>
      </form>
      {appliedFilters.ok && <History project={project.key} filters={appliedFilters.filters} />}
    </div>
  );
}
