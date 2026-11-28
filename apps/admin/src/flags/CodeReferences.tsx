import { codeReferenceUrl } from '@flagship/core';
import { useState } from 'react';
import { api, type CodeHunk, type FlagCodeBranch, type FlagDetail } from '../api';
import { Card, EmptyState, ErrorState, Field, Loading } from '../components/ui';
import { fullDate, timeAgo } from '../format';
import { useResource } from '../hooks';

const DEFAULT_BRANCHES = ['main', 'master', 'trunk', 'develop'];

function branchId(b: FlagCodeBranch): string {
  return `${b.repository}\u0000${b.branch}`;
}

/** The branch shown first: a default branch if one was scanned, else the latest scan. */
function preferred(branches: FlagCodeBranch[]): FlagCodeBranch | undefined {
  for (const name of DEFAULT_BRANCHES) {
    const b = branches.find((x) => x.branch === name);
    if (b !== undefined) return b;
  }
  return [...branches].sort((a, b) => b.scannedAt.localeCompare(a.scannedAt))[0];
}

/** Hunks grouped by file, in the order the scan found them. */
function byFile(hunks: CodeHunk[]): [string, CodeHunk[]][] {
  const files = new Map<string, CodeHunk[]>();
  for (const h of hunks) {
    let list = files.get(h.path);
    if (list === undefined) files.set(h.path, (list = []));
    list.push(h);
  }
  return [...files];
}

function LineLink({ branch, path, line }: { branch: FlagCodeBranch; path: string; line: number }) {
  const url = codeReferenceUrl(branch.urlTemplate, { ...branch, path, line });
  return url === null ? (
    <>{line}</>
  ) : (
    <a href={url} target="_blank" rel="noreferrer noopener" aria-label={`${path} line ${line}`}>
      {line}
    </a>
  );
}

function Hunk({ branch, hunk }: { branch: FlagCodeBranch; hunk: CodeHunk }) {
  if (hunk.lines.length === 0) {
    return (
      <p className="code-lines mono small">
        Lines{' '}
        {hunk.matchLines.map((line, i) => (
          <span key={line}>
            {i > 0 && ', '}
            <LineLink branch={branch} path={hunk.path} line={line} />
          </span>
        ))}
      </p>
    );
  }
  const matches = new Set(hunk.matchLines);
  return (
    <pre className="code-hunk">
      {hunk.lines.map((text, i) => {
        const line = hunk.startLine + i;
        const match = matches.has(line);
        return (
          <span key={line} className={match ? 'code-line code-match' : 'code-line'}>
            <span className="code-no">
              {match ? <LineLink branch={branch} path={hunk.path} line={line} /> : line}
            </span>
            <code>{text === '' ? ' ' : text}</code>
            {'\n'}
          </span>
        );
      })}
    </pre>
  );
}

/** Where the flag is used in code, from `flagship scan` uploads, one branch at a time. */
export function CodeReferences({ project, flag }: { project: string; flag: FlagDetail }) {
  const data = useResource(
    () => api.codeReferences(project, flag.key),
    `${project}/${flag.key}/code-references`,
  );
  const [chosen, setChosen] = useState<string | undefined>();
  const branches = data.data?.branches ?? [];
  const branch =
    branches.find((b) => branchId(b) === chosen) ??
    (branches.length > 0 ? preferred(branches) : undefined);

  if (data.error !== undefined) {
    return (
      <Card title="Code references">
        <ErrorState message={data.error.message} onRetry={data.reload} />
      </Card>
    );
  }
  if (data.data === undefined) {
    return (
      <Card title="Code references">
        <Loading rows={3} label="Loading code references" />
      </Card>
    );
  }
  if (branch === undefined) {
    return (
      <Card title="Code references">
        <EmptyState icon="code" title="No references in scanned code">
          Run <code>flagship scan</code> in CI on each branch to see where this flag is used. Keys
          in quotes or backticks are found; files your .gitignore lists are skipped.
          {flag.archived && ' Once no branch references this archived flag, its cleanup is done.'}
        </EmptyState>
      </Card>
    );
  }

  const files = byFile(branch.hunks);
  const shown = branch.hunks.reduce((n, h) => n + h.matchLines.length, 0);
  const repositories = new Set(branches.map((b) => b.repository)).size;

  return (
    <Card
      title="Code references"
      actions={
        branches.length > 1 ? (
          <Field label="Branch">
            {(p) => (
              <select
                {...p}
                value={branchId(branch)}
                onChange={(e) => {
                  setChosen(e.target.value);
                }}
              >
                {branches.map((b) => (
                  <option key={branchId(b)} value={branchId(b)}>
                    {repositories > 1 ? `${b.repository} · ${b.branch}` : b.branch} ({b.count})
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : undefined
      }
    >
      {flag.archived && (
        <p className="banner banner-warning" role="note">
          This flag is archived but code on {branch.branch} still references it.
        </p>
      )}
      <p className="muted small">
        {branch.count.toLocaleString()} {branch.count === 1 ? 'reference' : 'references'} in{' '}
        {files.length.toLocaleString()} {files.length === 1 ? 'file' : 'files'} on{' '}
        <span className="mono">{branch.repository}</span>{' '}
        <span className="mono">{branch.branch}</span>
        {branch.commit !== null && (
          <>
            {' '}
            at <span className="mono">{branch.commit.slice(0, 12)}</span>
          </>
        )}
        , scanned{' '}
        <time dateTime={branch.scannedAt} title={fullDate(branch.scannedAt)}>
          {timeAgo(branch.scannedAt)}
        </time>{' '}
        by {branch.uploadedBy}.
        {shown < branch.count && ` Showing the first ${shown.toLocaleString()}.`}
      </p>
      <ul className="code-files" aria-label={`Files referencing ${flag.key}`}>
        {files.map(([path, hunks]) => (
          <li key={path}>
            <h3 className="code-path mono">{path}</h3>
            {hunks.map((h) => (
              <Hunk key={h.startLine} branch={branch} hunk={h} />
            ))}
          </li>
        ))}
      </ul>
    </Card>
  );
}
