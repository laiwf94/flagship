import type { Clause, Rule, Variant } from '@flagship/core';
import { useId } from 'react';
import { Button, IconButton } from '../components/ui';
import {
  ATTRIBUTE_SUGGESTIONS,
  OPERATORS,
  newClause,
  operatorKind,
  type OperatorKey,
} from './rules';
import { ServeEditor } from './ServeEditor';

function valuesText(clause: Clause): string {
  return clause.operator === 'inSegment' ? '' : clause.values.map(String).join(', ');
}

function parseValues(
  kind: ReturnType<typeof operatorKind>,
  text: string,
): (string | number | boolean)[] {
  if (kind === 'number') {
    const n = Number(text.trim());
    return [text.trim() === '' || !Number.isFinite(n) ? text : n];
  }
  if (kind === 'one' || kind === 'pattern' || kind === 'version') return [text];
  const parts = text.split(',').map((s) => s.trim());
  return parts.length === 0
    ? ['']
    : parts.map((p) => (p === 'true' ? true : p === 'false' ? false : p));
}

export function ClauseRow({
  clause,
  index,
  segments,
  onChange,
  onRemove,
  canRemove,
  error,
  allowSegments = true,
}: {
  allowSegments?: boolean;
  clause: Clause;
  index: number;
  segments: string[];
  onChange: (c: Clause) => void;
  onRemove: () => void;
  canRemove: boolean;
  error: string | undefined;
}) {
  const id = useId();
  const op: OperatorKey = clause.operator;
  const kind = operatorKind(op);
  const negate = clause.negate === true;
  return (
    <div className="clause" role="group" aria-label={`Condition ${index + 1}`}>
      <span className="clause-lead muted small">{index === 0 ? 'If' : 'and'}</span>
      {clause.operator !== 'inSegment' ? (
        <>
          <label className="visually-hidden" htmlFor={`${id}-a`}>
            Attribute
          </label>
          <input
            id={`${id}-a`}
            type="text"
            className="mono"
            list={`${id}-attrs`}
            value={clause.attribute}
            onChange={(e) => {
              onChange({ ...clause, attribute: e.target.value });
            }}
          />
          <datalist id={`${id}-attrs`}>
            {ATTRIBUTE_SUGGESTIONS.map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
        </>
      ) : (
        <span className="clause-subject">the user</span>
      )}
      <label className="visually-hidden" htmlFor={`${id}-n`}>
        Negate
      </label>
      <select
        id={`${id}-n`}
        value={negate ? 'not' : 'is'}
        onChange={(e) => {
          onChange({ ...clause, negate: e.target.value === 'not' });
        }}
      >
        <option value="is">does</option>
        <option value="not">does not</option>
      </select>
      <label className="visually-hidden" htmlFor={`${id}-o`}>
        Operator
      </label>
      <select
        id={`${id}-o`}
        value={op}
        onChange={(e) => {
          const next = e.target.value as OperatorKey;
          const n = negate ? { negate: true } : {};
          if (next === 'inSegment')
            onChange({ operator: 'inSegment', segments: segments.slice(0, 1), ...n });
          else {
            const attribute = clause.operator === 'inSegment' ? 'key' : clause.attribute;
            const values =
              operatorKind(next) === 'number'
                ? [0]
                : clause.operator === 'inSegment'
                  ? ['']
                  : clause.values;
            onChange({ attribute, operator: next, values, ...n });
          }
        }}
      >
        {OPERATORS.filter((o) => allowSegments || o.value !== 'inSegment').map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {clause.operator === 'inSegment' ? (
        <>
          <label className="visually-hidden" htmlFor={`${id}-s`}>
            Segment
          </label>
          <select
            id={`${id}-s`}
            value={clause.segments[0] ?? ''}
            onChange={(e) => {
              onChange({ ...clause, segments: [e.target.value] });
            }}
          >
            {segments.length === 0 && <option value="">No segments in this environment</option>}
            {segments.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </>
      ) : (
        <>
          <label className="visually-hidden" htmlFor={`${id}-v`}>
            Values
          </label>
          <input
            id={`${id}-v`}
            type={kind === 'number' ? 'number' : 'text'}
            className={kind === 'pattern' || kind === 'version' ? 'mono' : undefined}
            placeholder={
              kind === 'list' ? 'Comma separated' : kind === 'version' ? '2.4.0' : undefined
            }
            value={valuesText(clause)}
            aria-invalid={error === undefined ? undefined : true}
            aria-describedby={error === undefined ? undefined : `${id}-e`}
            onChange={(e) => {
              onChange({ ...clause, values: parseValues(kind, e.target.value) });
            }}
          />
        </>
      )}
      <IconButton
        icon="close"
        label={`Remove condition ${index + 1}`}
        disabled={!canRemove}
        onClick={onRemove}
      />
      {error !== undefined && (
        <p className="field-error clause-error" id={`${id}-e`}>
          {error}
        </p>
      )}
    </div>
  );
}

export function RuleEditor({
  rule,
  index,
  count,
  variants,
  segments,
  errors,
  onChange,
  onRemove,
  onMove,
}: {
  rule: Rule;
  index: number;
  count: number;
  variants: Variant[];
  segments: string[];
  errors: Record<string, string>;
  onChange: (r: Rule) => void;
  onRemove: () => void;
  onMove: (delta: number) => void;
}) {
  const setClause = (i: number, c: Clause) => {
    onChange({ ...rule, clauses: rule.clauses.map((x, j) => (j === i ? c : x)) });
  };
  return (
    <li className="rule">
      <div className="rule-head">
        <h3>Rule {index + 1}</h3>
        <div className="rule-actions">
          <IconButton
            icon="up"
            label={`Move rule ${index + 1} up`}
            disabled={index === 0}
            onClick={() => {
              onMove(-1);
            }}
          />
          <IconButton
            icon="down"
            label={`Move rule ${index + 1} down`}
            disabled={index === count - 1}
            onClick={() => {
              onMove(1);
            }}
          />
          <IconButton icon="trash" label={`Delete rule ${index + 1}`} onClick={onRemove} />
        </div>
      </div>
      {rule.clauses.map((c, i) => (
        <ClauseRow
          key={i}
          clause={c}
          index={i}
          segments={segments}
          error={errors[`clauses[${i}]`]}
          canRemove={rule.clauses.length > 1}
          onChange={(next) => {
            setClause(i, next);
          }}
          onRemove={() => {
            onChange({ ...rule, clauses: rule.clauses.filter((_, j) => j !== i) });
          }}
        />
      ))}
      <div>
        <Button
          variant="plain"
          icon="plus"
          disabled={rule.clauses.length >= 20}
          onClick={() => {
            onChange({ ...rule, clauses: [...rule.clauses, newClause()] });
          }}
        >
          Add condition
        </Button>
      </div>
      <ServeEditor
        label={`Rule ${index + 1} serves`}
        serve={rule.serve}
        variants={variants}
        onChange={(serve) => {
          onChange({ ...rule, serve });
        }}
      />
      {errors.serve !== undefined && <p className="field-error">{errors.serve}</p>}
    </li>
  );
}
