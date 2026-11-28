import { execFileSync } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { CODE_REFERENCE_LIMITS, codeReferenceUrl, type CodeHunk } from '@flagship/core';
import { bool, int, str, strs, type Command, type Context, type Values } from '../command.js';
import { UsageError } from '../errors.js';
import { table, when } from '../output.js';
import { DEFAULT_MAX_FILE_BYTES, scan } from '../scan.js';

interface BranchSummary {
  repository: string;
  branch: string;
  commit: string | null;
  urlTemplate: string | null;
  filesScanned: number;
  scannedAt: string;
  uploadedBy: string;
  flags: number;
  references: number;
}

interface FlagBranch extends Omit<BranchSummary, 'flags' | 'references'> {
  count: number;
  hunks: CodeHunk[];
}

/** Runs git in `dir`, or returns undefined when git or the repository isn't there. */
function git(dir: string, args: string[]): string | undefined {
  try {
    const out = execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim();
    return out === '' ? undefined : out;
  } catch {
    return undefined;
  }
}

/**
 * A remote URL as "host/owner/name", without credentials, scheme, port or
 * ".git": git@github.com:acme/shop.git and https://x@github.com/acme/shop
 * are both github.com/acme/shop.
 */
export function repositoryName(remote: string): string | undefined {
  const scp = /^[^@/:]+@([^:/]+):(?!\/)(.+)$/.exec(remote);
  let host: string;
  let path: string;
  if (scp !== null) {
    host = scp[1] ?? '';
    path = scp[2] ?? '';
  } else {
    let url: URL;
    try {
      url = new URL(remote);
    } catch {
      return undefined;
    }
    if (url.hostname === '') return undefined;
    host = url.hostname;
    path = url.pathname;
  }
  path = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  return path === '' ? undefined : `${host.toLowerCase()}/${path}`;
}

/** A link to a line for the hosts whose URL layout is known. */
export function defaultUrlTemplate(repository: string): string | null {
  const host = repository.split('/')[0];
  if (host === 'github.com') return `https://${repository}/blob/{commit}/{path}#L{line}`;
  if (host === 'gitlab.com') return `https://${repository}/-/blob/{commit}/{path}#L{line}`;
  if (host === 'bitbucket.org') return `https://${repository}/src/{commit}/{path}#lines-{line}`;
  return null;
}

/** Where the scan ran: from options first, then the CI environment, then git. */
function describeCheckout(ctx: Context, root: string, values: Values) {
  const env = ctx.io.env;
  const nonEmpty = (v: string | undefined) => (v === undefined || v === '' ? undefined : v);
  const github =
    nonEmpty(env.GITHUB_REPOSITORY) === undefined
      ? undefined
      : `${new URL(env.GITHUB_SERVER_URL || 'https://github.com').hostname}/${env.GITHUB_REPOSITORY}`;
  const remote = git(root, ['config', '--get', 'remote.origin.url']);
  const repository =
    str(values, 'repository') ??
    github ??
    (remote === undefined ? undefined : repositoryName(remote)) ??
    basename(root);

  const branch =
    str(values, 'branch') ??
    nonEmpty(env.GITHUB_HEAD_REF) ??
    (env.GITHUB_REF_TYPE === 'branch' ? nonEmpty(env.GITHUB_REF_NAME) : undefined) ??
    git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branch === undefined) {
    throw new UsageError("can't tell which branch this is (a detached HEAD?): pass --branch NAME");
  }

  const commit =
    str(values, 'commit') ?? git(root, ['rev-parse', 'HEAD']) ?? nonEmpty(env.GITHUB_SHA) ?? null;
  if (commit !== null && !/^[0-9a-f]{7,64}$/.test(commit)) {
    throw new UsageError(`--commit must be a hexadecimal commit id, not "${commit}"`);
  }
  const given = str(values, 'url-template');
  const urlTemplate = given === undefined ? defaultUrlTemplate(repository) : given || null;
  if (urlTemplate !== null && !/^https?:\/\/\S+$/.test(urlTemplate)) {
    throw new UsageError(`--url-template must be an http or https URL, not "${urlTemplate}"`);
  }
  return { repository, branch, commit, urlTemplate };
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

function files(hunks: readonly CodeHunk[]): number {
  return new Set(hunks.map((h) => h.path)).size;
}

const scanCommand: Command = {
  path: ['scan'],
  summary: 'Find flag keys in source code and upload where they are used',
  args: '[dir]',
  arity: [0, 1],
  details: [
    'Walks the directory (default: the current one) honouring .gitignore files and',
    '.git/info/exclude, and finds every flag key of the project in quotes or backticks,',
    'on worker threads. The references replace what this branch uploaded before, and the',
    'flag page shows them. Repository, branch and commit come from the options, then the',
    'GitHub Actions environment, then git. A token needs flags:read and',
    'code-references:write.',
  ].join('\n'),
  options: {
    repository: {
      type: 'string',
      value: 'NAME',
      description:
        'Repository name (default: GITHUB_REPOSITORY, the origin remote or the directory)',
    },
    branch: { type: 'string', value: 'NAME', description: 'Branch (default: the checked out one)' },
    commit: { type: 'string', value: 'SHA', description: 'Commit (default: HEAD)' },
    'url-template': {
      type: 'string',
      value: 'URL',
      description:
        'Link to a line, with {commit}, {branch}, {path} and {line}; empty for none (default for GitHub, GitLab and Bitbucket)',
    },
    context: {
      type: 'string',
      value: 'N',
      description: `Lines of source around each reference, 0 to ${CODE_REFERENCE_LIMITS.contextLines} (default 2)`,
    },
    'no-source': {
      type: 'boolean',
      description: 'Upload only paths and line numbers, no source lines',
    },
    exclude: {
      type: 'string',
      multiple: true,
      value: 'PATTERN',
      description: 'Also skip paths matching this .gitignore pattern (repeatable)',
    },
    'max-file-size': {
      type: 'string',
      value: 'BYTES',
      description: `Skip larger files (default ${DEFAULT_MAX_FILE_BYTES})`,
    },
    workers: {
      type: 'string',
      value: 'N',
      description: 'Worker threads at most (default: CPUs, up to 8)',
    },
    'dry-run': { type: 'boolean', description: 'Scan and print, without uploading' },
  },
  async run(ctx, values, args) {
    const project = ctx.project();
    const root = resolve(ctx.io.cwd, args[0] ?? '.');
    const context = bool(values, 'no-source')
      ? -1
      : (int(values, 'context', { min: 0, max: CODE_REFERENCE_LIMITS.contextLines }) ?? 2);
    const workers = int(values, 'workers', { min: 1, max: 64 });
    const maxFileBytes = int(values, 'max-file-size', { min: 1 });
    const checkout = describeCheckout(ctx, root, values);
    const dryRun = bool(values, 'dry-run');

    const { flagKeys } = await ctx.call<{ flagKeys: string[] }>((c) =>
      c.listCodeReferenceBranches({ path: { project } }),
    );
    const result = await scan({
      root,
      keys: flagKeys,
      context,
      exclude: strs(values, 'exclude'),
      ...(workers === undefined ? {} : { workers }),
      ...(maxFileBytes === undefined ? {} : { maxFileBytes }),
    });

    let uploaded: BranchSummary | null = null;
    if (!dryRun) {
      uploaded = await ctx.call<BranchSummary>((c) =>
        c.uploadCodeReferences({
          path: { project },
          body: { ...checkout, filesScanned: result.filesScanned, references: result.references },
        }),
      );
    }

    const keys = Object.keys(result.references);
    const total = keys.reduce((n, k) => n + (result.references[k]?.count ?? 0), 0);
    const lines = [
      `Scanned ${plural(result.filesScanned, 'file')} in ${(result.durationMs / 1000).toFixed(1)} s on ${plural(result.workers, 'thread')}: ${plural(total, 'reference')} to ${keys.length} of ${plural(flagKeys.length, 'flag')}.`,
    ];
    if (result.filesSkipped > 0) {
      lines.push(
        `Skipped ${plural(result.filesSkipped, 'file')}: binary, unreadable or over the size limit.`,
      );
    }
    if (keys.length > 0) {
      lines.push(
        '',
        table(
          ['FLAG', 'REFERENCES', 'FILES'],
          keys.map((k) => {
            const r = result.references[k];
            return [k, String(r?.count ?? 0), String(files(r?.hunks ?? []))];
          }),
        ),
      );
    }
    if (result.hunksDropped > 0) {
      lines.push(
        '',
        `Kept the first hunks of each flag; ${plural(result.hunksDropped, 'hunk')} left out.`,
      );
    }
    const at = `${checkout.repository} ${checkout.branch}${checkout.commit === null ? '' : ` @ ${checkout.commit.slice(0, 12)}`}`;
    lines.push(
      '',
      dryRun ? `Dry run: nothing uploaded for ${at}.` : `Uploaded ${at} to ${project}.`,
    );

    return {
      json: {
        project,
        ...checkout,
        uploaded: uploaded !== null,
        filesScanned: result.filesScanned,
        filesSkipped: result.filesSkipped,
        bytesScanned: result.bytesScanned,
        workers: result.workers,
        durationMs: result.durationMs,
        hunksDropped: result.hunksDropped,
        references: result.references,
      },
      text: lines.join('\n'),
    };
  },
};

const refsList: Command = {
  path: ['refs', 'list'],
  summary: 'List the branches with uploaded code references',
  async run(ctx) {
    const project = ctx.project();
    const { branches } = await ctx.call<{ branches: BranchSummary[] }>((c) =>
      c.listCodeReferenceBranches({ path: { project } }),
    );
    return {
      json: { branches },
      text:
        branches.length === 0
          ? `No code references in ${project}: run flagship scan in a repository.`
          : table(
              ['REPOSITORY', 'BRANCH', 'COMMIT', 'FLAGS', 'REFERENCES', 'SCANNED'],
              branches.map((b) => [
                b.repository,
                b.branch,
                b.commit?.slice(0, 12) ?? '-',
                String(b.flags),
                String(b.references),
                when(b.scannedAt),
              ]),
            ),
    };
  },
};

const refsGet: Command = {
  path: ['refs', 'get'],
  summary: 'Show where a flag is referenced in code, per branch',
  args: '<flag>',
  arity: [1, 1],
  options: {
    branch: { type: 'string', value: 'NAME', description: 'Only this branch' },
  },
  async run(ctx, values, args) {
    const project = ctx.project();
    const flag = args[0] ?? '';
    const only = str(values, 'branch');
    const { branches } = await ctx.call<{ branches: FlagBranch[] }>((c) =>
      c.getFlagCodeReferences({ path: { project, flag } }),
    );
    const shown = only === undefined ? branches : branches.filter((b) => b.branch === only);
    const text: string[] = [];
    for (const b of shown) {
      text.push(
        `${b.repository} ${b.branch}${b.commit === null ? '' : ` @ ${b.commit.slice(0, 12)}`}: ${plural(b.count, 'reference')} in ${plural(files(b.hunks), 'file')}, scanned ${when(b.scannedAt)}`,
      );
      for (const h of b.hunks) {
        for (const line of h.matchLines) {
          const url = codeReferenceUrl(b.urlTemplate, { ...b, path: h.path, line });
          const source = h.lines[line - h.startLine];
          text.push(
            `  ${h.path}:${line}${source === undefined ? '' : `  ${source.trim()}`}${url === null ? '' : `\n    ${url}`}`,
          );
        }
      }
    }
    return {
      json: { flag, branches: shown },
      text:
        text.length > 0
          ? text.join('\n')
          : `No code references to ${flag}${only === undefined ? '' : ` on ${only}`}.`,
    };
  },
};

const refsDelete: Command = {
  path: ['refs', 'delete'],
  summary: "Forget a branch's code references, e.g. once it is merged",
  options: {
    repository: {
      type: 'string',
      value: 'NAME',
      description: 'Repository name, as scan uploaded it',
    },
    branch: { type: 'string', value: 'NAME', description: 'Branch' },
  },
  async run(ctx, values) {
    const project = ctx.project();
    const repository = str(values, 'repository');
    const branch = str(values, 'branch');
    if (repository === undefined || branch === undefined) {
      throw new UsageError('pass --repository and --branch');
    }
    await ctx.call((c) =>
      c.deleteCodeReferenceBranch({ path: { project }, query: { repository, branch } }),
    );
    return {
      json: { deleted: { repository, branch } },
      text: `Deleted the code references of ${repository} ${branch}.`,
    };
  },
};

export const scanCommands: readonly Command[] = [scanCommand, refsList, refsGet, refsDelete];
