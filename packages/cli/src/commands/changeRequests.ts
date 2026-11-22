import type { DiffEntry } from '@flagship/core';
import { bool, int, oneOf, str, type Command, type Context, type Option } from '../command.js';
import { UsageError } from '../errors.js';
import { compact, fields, list, table, when } from '../output.js';
import { getFlag, targetingFile, targetingIn } from './flags.js';
import { contentOf, getSegment, segmentContent, type SegmentView } from './segments.js';

interface Approvals {
  required: number;
  approvedBy: string[];
  changesRequestedBy: string[];
}

interface Summary {
  id: string;
  target: 'flag' | 'segment';
  flag: string | null;
  segment: string | null;
  environment: string;
  title: string;
  status: 'open' | 'applied' | 'closed';
  revision: number;
  author: string;
  createdAt: string;
  updatedAt: string;
  approvals: Approvals;
  stale: boolean | null;
}

export interface ChangeRequestView extends Omit<Summary, 'stale'> {
  description: string;
  reason: string | null;
  link: string | null;
  finishedAt: string | null;
  finishedBy: string | null;
  baseVersion: number;
  diff: DiffEntry[];
  live: { version: number; stale: boolean; conflicts: { path: string }[] } | null;
  canApply: boolean;
  reviews: { revision: number; reviewer: string; decision: string; body: string; at: string }[];
}

const ROOT = 'change-request';

function targetOf(r: Pick<Summary, 'target' | 'flag' | 'segment'>): string {
  return r.target === 'flag' ? `flag ${r.flag ?? '?'}` : `segment ${r.segment ?? '?'}`;
}

function approvalText(a: Approvals): string {
  const text = `${a.approvedBy.length}/${a.required}`;
  return a.changesRequestedBy.length > 0 ? `${text}, changes requested` : text;
}

function diffLine(d: DiffEntry): string {
  const at = d.path === '' ? '(whole)' : d.path;
  if (d.op === 'added') return `  + ${at}: ${compact(d.after)}`;
  if (d.op === 'removed') return `  - ${at}: ${compact(d.before)}`;
  return `  ~ ${at}: ${compact(d.before)} -> ${compact(d.after)}`;
}

export function changeRequestText(r: ChangeRequestView): string {
  const lines = [
    fields([
      ['id', r.id],
      ['title', r.title],
      ['target', `${targetOf(r)} in ${r.environment}`],
      [
        'status',
        r.status === 'open'
          ? `open, revision ${r.revision}`
          : `${r.status} ${when(r.finishedAt)} by ${r.finishedBy ?? '?'}`,
      ],
      ['author', `${r.author}, ${when(r.createdAt)}`],
      ['approvals', `${approvalText(r.approvals)}; approved by ${list(r.approvals.approvedBy)}`],
      ['can apply', r.status === 'open' ? (r.canApply ? 'yes' : 'no') : '-'],
    ]),
  ];
  if (r.reason) lines.push(`reason:    ${r.reason}`);
  if (r.link) lines.push(`link:      ${r.link}`);
  if (r.description) lines.push('', r.description);
  if (r.live?.stale) {
    lines.push(
      '',
      `The live ${r.target} moved on to version ${r.live.version} since this was proposed${
        r.live.conflicts.length > 0
          ? `, with conflicts at ${list(r.live.conflicts.map((c) => c.path))}`
          : '; rebase it to carry the change forward'
      }.`,
    );
  }
  lines.push('', 'Changes:', ...(r.diff.length === 0 ? ['  (none)'] : r.diff.map(diffLine)));
  if (r.reviews.length > 0) {
    lines.push('', 'Reviews:');
    for (const v of r.reviews) {
      lines.push(
        `  ${when(v.at)} ${v.reviewer} ${v.decision.replace('_', ' ')} (revision ${v.revision})${v.body ? `: ${v.body}` : ''}`,
      );
    }
  }
  return lines.join('\n');
}

async function getRequest(ctx: Context, id: string): Promise<ChangeRequestView> {
  return ctx.call<ChangeRequestView>((c) =>
    c.getChangeRequest({ path: { project: ctx.project(), id } }),
  );
}

const revisionOption: Option = {
  type: 'string',
  value: 'N',
  description: 'The revision you reviewed (default: the latest, read just before)',
};

async function revisionOf(ctx: Context, id: string, pinned: number | undefined): Promise<number> {
  return pinned ?? (await getRequest(ctx, id)).revision;
}

function done(r: ChangeRequestView, text: string) {
  return { json: r, text: `${text}\n\n${changeRequestText(r)}` };
}

const crList: Command = {
  path: [ROOT, 'list'],
  summary: 'List change requests, newest first',
  details:
    'Lists every environment unless --environment (or FLAGSHIP_ENVIRONMENT) is given; the profile default is not applied here.',
  options: {
    status: { type: 'string', value: 'STATUS', description: 'open, applied or closed' },
    flag: { type: 'string', value: 'KEY', description: 'Only requests for this flag' },
    segment: { type: 'string', value: 'KEY', description: 'Only requests for this segment' },
    limit: { type: 'string', value: 'N', description: 'At most this many (1 to 200, default 50)' },
  },
  async run(ctx, values) {
    const environment = ctx.explicitEnvironment();
    const { changeRequests } = await ctx.call<{ changeRequests: Summary[] }>((c) =>
      c.listChangeRequests({
        path: { project: ctx.project() },
        query: {
          status: oneOf(values, 'status', ['open', 'applied', 'closed'] as const),
          environment,
          flag: str(values, 'flag'),
          segment: str(values, 'segment'),
          limit: int(values, 'limit', { min: 1, max: 200 }),
        },
      }),
    );
    return {
      json: { changeRequests },
      text:
        changeRequests.length === 0
          ? 'No change requests.'
          : table(
              ['ID', 'STATUS', 'TARGET', 'ENV', 'APPROVALS', 'AUTHOR', 'CREATED', 'TITLE'],
              changeRequests.map((r) => [
                r.id,
                r.stale === true ? `${r.status} (stale)` : r.status,
                targetOf(r),
                r.environment,
                approvalText(r.approvals),
                r.author,
                when(r.createdAt),
                r.title,
              ]),
            ),
    };
  },
};

const crGet: Command = {
  path: [ROOT, 'get'],
  summary: 'Show a change request with its diff and reviews',
  args: '<id>',
  arity: [1, 1],
  async run(ctx, _values, [id = '']) {
    const r = await getRequest(ctx, id);
    return { json: r, text: changeRequestText(r) };
  },
};

const crPropose: Command = {
  path: [ROOT, 'propose'],
  summary: 'Propose a targeting change to a flag, or a change to a segment, for review',
  args: '<flag|segment> <key>',
  arity: [2, 2],
  details: [
    'flag: --file holds the targeting, as for flag target.',
    'segment: starts from the live segment (or an empty one) and takes the segment create',
    'options; --delete proposes deleting it instead.',
  ].join('\n'),
  options: {
    title: { type: 'string', value: 'TEXT', description: 'What the change does (required)' },
    description: { type: 'string', value: 'TEXT', description: 'More detail for reviewers' },
    file: {
      type: 'string',
      value: 'PATH',
      description: 'The proposed content as JSON, or - for stdin',
    },
    'base-version': {
      type: 'string',
      value: 'N',
      description: 'The version the proposal is based on (default: the live one, read just before)',
    },
    name: { type: 'string', value: 'NAME', description: 'segment: display name' },
    include: {
      type: 'string',
      multiple: true,
      value: 'KEYS',
      description: 'segment: add to the include list',
    },
    exclude: {
      type: 'string',
      multiple: true,
      value: 'KEYS',
      description: 'segment: add to the exclude list',
    },
    unlist: {
      type: 'string',
      multiple: true,
      value: 'KEYS',
      description: 'segment: remove from both lists',
    },
    delete: { type: 'boolean', description: 'segment: propose deleting it' },
  },
  async run(ctx, values, [kind = '', key = '']) {
    const title = str(values, 'title');
    if (title === undefined || title.trim() === '') throw new UsageError('pass --title TEXT');
    const description = str(values, 'description');
    const project = ctx.project();
    const environment = ctx.environment();
    const pinned = int(values, 'base-version', { min: 0 });
    let r: ChangeRequestView;
    if (kind === 'flag') {
      const file = str(values, 'file');
      if (file === undefined) throw new UsageError('pass --file PATH with the proposed targeting');
      const targeting = await targetingFile(ctx, file);
      const baseVersion = pinned ?? targetingIn(await getFlag(ctx, key), environment).version;
      r = await ctx.call<ChangeRequestView>((c) =>
        c.proposeFlagChange({
          path: { project, flag: key, environment },
          body: {
            baseVersion,
            title,
            ...(description === undefined ? {} : { description }),
            ...targeting,
          },
        }),
      );
    } else if (kind === 'segment') {
      let live: SegmentView | undefined;
      try {
        live = await getSegment(ctx, key);
      } catch (e) {
        if ((e as { status?: unknown }).status !== 404) throw e;
      }
      const segment = bool(values, 'delete')
        ? null
        : await segmentContent(
            ctx,
            values,
            live === undefined
              ? { name: key, included: [], excluded: [], rules: [] }
              : contentOf(live),
          );
      if (segment === null && live === undefined) {
        throw new UsageError(
          `segment "${key}" doesn't exist in ${environment}, so there is nothing to delete`,
        );
      }
      const baseVersion = pinned ?? live?.version ?? 0;
      r = await ctx.call<ChangeRequestView>((c) =>
        c.proposeSegmentChange({
          path: { project, segment: key, environment },
          body: {
            baseVersion,
            title,
            ...(description === undefined ? {} : { description }),
            segment,
          },
        }),
      );
    } else {
      throw new UsageError(`propose takes "flag" or "segment", not "${kind}"`);
    }
    return done(r, `Proposed change request ${r.id}.`);
  },
};

function review(
  sub: string,
  decision: 'approve' | 'request_changes' | 'comment',
  summary: string,
): Command {
  return {
    path: [ROOT, sub],
    summary,
    args: '<id>',
    arity: [1, 1],
    options: {
      comment: {
        type: 'string',
        value: 'TEXT',
        description: decision === 'approve' ? 'A note with the approval' : 'The comment (required)',
      },
      revision: revisionOption,
    },
    async run(ctx, values, [id = '']) {
      const body = str(values, 'comment');
      if (decision !== 'approve' && (body === undefined || body.trim() === '')) {
        throw new UsageError('pass --comment TEXT');
      }
      const revision = await revisionOf(ctx, id, int(values, 'revision', { min: 1 }));
      const r = await ctx.call<ChangeRequestView>((c) =>
        c.reviewChangeRequest({
          path: { project: ctx.project(), id },
          body: { revision, decision, ...(body === undefined ? {} : { body }) },
        }),
      );
      const verb = {
        approve: 'Approved',
        request_changes: 'Requested changes on',
        comment: 'Commented on',
      };
      return done(r, `${verb[decision]} revision ${revision} of ${id}.`);
    },
  };
}

const crApply: Command = {
  path: [ROOT, 'apply'],
  summary: 'Apply an approved change request',
  args: '<id>',
  arity: [1, 1],
  options: { revision: revisionOption },
  async run(ctx, values, [id = '']) {
    const revision = await revisionOf(ctx, id, int(values, 'revision', { min: 1 }));
    const r = await ctx.call<ChangeRequestView>((c) =>
      c.applyChangeRequest({ path: { project: ctx.project(), id }, body: { revision } }),
    );
    return done(r, `Applied ${id}.`);
  },
};

const crRebase: Command = {
  path: [ROOT, 'rebase'],
  summary: 'Carry a stale proposal forward onto the live version (a new revision)',
  args: '<id>',
  arity: [1, 1],
  options: { revision: revisionOption },
  async run(ctx, values, [id = '']) {
    const revision = await revisionOf(ctx, id, int(values, 'revision', { min: 1 }));
    const r = await ctx.call<ChangeRequestView>((c) =>
      c.rebaseChangeRequest({ path: { project: ctx.project(), id }, body: { revision } }),
    );
    return done(r, `Rebased ${id}; it is now revision ${r.revision}.`);
  },
};

const crClose: Command = {
  path: [ROOT, 'close'],
  summary: 'Close a change request without applying it',
  details: 'The global --reason is recorded on the request as well as on the audit entry.',
  args: '<id>',
  arity: [1, 1],
  async run(ctx, _values, [id = '']) {
    const reason = str(ctx.globals, 'reason');
    const r = await ctx.call<ChangeRequestView>((c) =>
      c.closeChangeRequest({
        path: { project: ctx.project(), id },
        body: reason === undefined ? {} : { reason },
      }),
    );
    return done(r, `Closed ${id}.`);
  },
};

export const changeRequestCommands: Command[] = [
  crList,
  crGet,
  crPropose,
  review('approve', 'approve', 'Approve the latest revision of a change request'),
  review(
    'request-changes',
    'request_changes',
    'Ask the author for changes before it can be applied',
  ),
  review('comment', 'comment', 'Comment on a change request without approving it'),
  crApply,
  crRebase,
  crClose,
];
