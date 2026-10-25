import type { DiffEntry } from '@flagship/core';

/** "rules[0].clauses[1].values" becomes "Rule 1 › condition 2 › values". */
export function humanPath(path: string): string {
  if (path === '') return 'Whole item';
  return path
    .replace(/^rules\[(\d+)\]/, (_, i: string) => `Rule ${Number(i) + 1}`)
    .replace(/\.clauses\[(\d+)\]/g, (_, i: string) => ` › condition ${Number(i) + 1}`)
    .replace(/^prerequisites\[(\d+)\]/, (_, i: string) => `Prerequisite ${Number(i) + 1}`)
    .replace(/^variants\[(\d+)\]/, (_, i: string) => `Variant ${Number(i) + 1}`)
    .replace(/\.rollout\.variants\[(\d+)\]/g, (_, i: string) => ` › rollout ${Number(i) + 1}`)
    .replace(/^fallthrough/, 'Default rule')
    .replace(/^offVariant/, 'Variant when off')
    .replace(/^enabled/, 'Flag on')
    .replace(/\[(\d+)\]/g, (_, i: string) => ` ${Number(i) + 1}`)
    .replace(/\./g, ' › ');
}

function show(v: unknown): string {
  return v === undefined ? '' : JSON.stringify(v, null, 1).replace(/\n\s*/g, ' ');
}

export function DiffView({ entries }: { entries: DiffEntry[] }) {
  if (entries.length === 0) return <p className="muted">No changes.</p>;
  return (
    <ul className="diff" aria-label="Changes">
      {entries.map((e, i) => (
        <li key={i} className={`diff-${e.op}`}>
          <span className="diff-path">{humanPath(e.path)}</span>
          <span className="visually-hidden">{e.op}</span>
          {e.op !== 'added' && (
            <del className="mono" aria-label="before">
              {show(e.before)}
            </del>
          )}
          {e.op !== 'removed' && (
            <ins className="mono" aria-label="after">
              {show(e.after)}
            </ins>
          )}
        </li>
      ))}
    </ul>
  );
}
