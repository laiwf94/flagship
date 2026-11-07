import type { DiffEntry, Flag, Rule, Ruleset, Segment, Serve, Variant } from '@flagship/core';

export type Role = 'viewer' | 'editor' | 'admin';
export type FlagStatus = 'on' | 'off' | 'rollout' | 'archived';

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface Project {
  key: string;
  name: string;
  environments: {
    key: string;
    name: string;
    /** Approvals a targeting or segment change needs here; 0 means unprotected. */
    requiredApprovals?: number;
  }[];
}

export interface FlagSummary {
  key: string;
  name: string;
  description: string;
  type: Flag['type'];
  clientSide: boolean;
  /** Metadata version. */
  version: number;
  /** Targeting version in the listed environment. */
  targetingVersion: number;
  updatedAt: string;
  status: FlagStatus;
  ruleCount: number;
}

export interface EnvConfig {
  enabled: boolean;
  offVariant: string;
  prerequisites: Flag['prerequisites'];
  rules: Rule[];
  fallthrough: Serve;
}

export interface FlagDetail {
  key: string;
  name: string;
  description: string;
  type: Flag['type'];
  variants: Variant[];
  clientSide: boolean;
  salt: string;
  archived: boolean;
  /** Metadata version: name, description, variants, client side, archived. */
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Each environment's targeting, with its own version. */
  environments: Record<string, EnvConfig & { version: number; updatedAt: string }>;
}

export interface SegmentView {
  key: string;
  name: string;
  description: string;
  included: string[];
  excluded: string[];
  rules: Segment['rules'];
  version: number;
  updatedAt: string;
}

export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  action: string;
  targetType: string;
  targetKey: string;
  environment: string | null;
  diff: DiffEntry[];
}

export interface Schedule {
  id: string;
  runAt: string;
  change: { enabled?: boolean; fallthrough?: Serve; rules?: Rule[] };
  status: 'pending' | 'applied' | 'failed' | 'cancelled';
  error: string | null;
  createdBy: string;
}

export interface ApiKey {
  id: string;
  kind: 'server' | 'client';
  name: string;
  displayPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
}

export interface ManagedUser extends User {
  disabled: boolean;
  createdAt: string;
}

export interface ExposureSummary {
  from: string;
  to: string;
  totals: { variant: string; count: number }[];
  series: { hour: string; counts: Record<string, number> }[];
}

export type ChangeRequestStatus = 'open' | 'applied' | 'closed';
export type ReviewDecision = 'comment' | 'approve' | 'request_changes';

/** Segment content as a change request proposes it; null means no segment. */
export type SegmentContent = Pick<
  SegmentView,
  'name' | 'description' | 'included' | 'excluded' | 'rules'
>;

export interface MergeConflict {
  path: string;
  base: unknown;
  ours: unknown;
  theirs: unknown;
}

export interface Approvals {
  required: number;
  approvedBy: string[];
  changesRequestedBy: string[];
}

export interface ChangeRequestSummary {
  id: string;
  target: 'flag' | 'segment';
  flag: string | null;
  segment: string | null;
  environment: string;
  title: string;
  status: ChangeRequestStatus;
  revision: number;
  author: string;
  createdAt: string;
  updatedAt: string;
  approvals: Approvals;
  stale: boolean | null;
}

export interface Review {
  id: number;
  revision: number;
  reviewer: string;
  decision: ReviewDecision;
  body: string;
  at: string;
}

export interface ChangeRequest {
  id: string;
  target: 'flag' | 'segment';
  flag: string | null;
  segment: string | null;
  environment: string;
  title: string;
  description: string;
  status: ChangeRequestStatus;
  revision: number;
  author: string;
  authorId: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  finishedBy: string | null;
  baseVersion: number;
  base: EnvConfig | SegmentContent | null;
  proposed: EnvConfig | SegmentContent | null;
  diff: DiffEntry[];
  approvals: Approvals;
  live: {
    version: number;
    stale: boolean;
    changedSinceBase: DiffEntry[];
    conflicts: MergeConflict[];
  } | null;
  canApply: boolean;
  reviews: Review[];
}

export interface FieldIssue {
  path: string;
  message: string;
}

/** An error answer from the server, with its stable code. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Field-level problems from a validation error. */
  get issues(): FieldIssue[] {
    return Array.isArray(this.details) ? (this.details as FieldIssue[]) : [];
  }

  get currentVersion(): number | undefined {
    const d = this.details as { currentVersion?: unknown } | undefined;
    return typeof d?.currentVersion === 'number' ? d.currentVersion : undefined;
  }
}

let csrfToken = '';
let onUnauthenticated: () => void = () => undefined;

export function setCsrfToken(token: string): void {
  csrfToken = token;
}

export function setUnauthenticatedHandler(fn: () => void): void {
  onUnauthenticated = fn;
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-csrf-token'] = csrfToken;
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(
      0,
      'unavailable',
      "Can't reach the server. Check your connection.",
      undefined,
    );
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data: unknown = text === '' ? undefined : JSON.parse(text);
  if (!res.ok) {
    const e = (
      data as { error?: { code?: string; message?: string; details?: unknown } } | undefined
    )?.error;
    if (res.status === 401 && path !== '/api/session') onUnauthenticated();
    throw new ApiError(res.status, e?.code ?? 'internal', e?.message ?? res.statusText, e?.details);
  }
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  session: () => request<{ user: User; csrfToken: string }>('GET', '/api/session'),
  signIn: (email: string, password: string) =>
    request<{ user: User; csrfToken: string }>('POST', '/api/session', { email, password }),
  signOut: () => request<undefined>('DELETE', '/api/session'),
  projects: () => request<{ projects: Project[] }>('GET', '/api/projects'),

  flags: (project: string, params: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, v);
    return request<{ flags: FlagSummary[] }>(
      'GET',
      `/api/projects/${enc(project)}/flags?${q.toString()}`,
    );
  },
  flag: (project: string, key: string) =>
    request<FlagDetail>('GET', `/api/projects/${enc(project)}/flags/${enc(key)}`),
  createFlag: (
    project: string,
    input: {
      key: string;
      name: string;
      description?: string;
      type: Flag['type'];
      variants?: Variant[];
      clientSide: boolean;
    },
  ) => request<FlagDetail>('POST', `/api/projects/${enc(project)}/flags`, input),
  updateFlag: (
    project: string,
    key: string,
    input: {
      version: number;
      name?: string;
      description?: string;
      variants?: Variant[];
      clientSide?: boolean;
    },
  ) => request<FlagDetail>('PUT', `/api/projects/${enc(project)}/flags/${enc(key)}`, input),
  saveTargeting: (
    project: string,
    key: string,
    env: string,
    config: EnvConfig & { version: number },
  ) =>
    request<FlagDetail>(
      'PUT',
      `/api/projects/${enc(project)}/flags/${enc(key)}/environments/${enc(env)}`,
      config,
    ),
  killSwitch: (project: string, key: string, env: string, enabled: boolean) =>
    request<FlagDetail>(
      'POST',
      `/api/projects/${enc(project)}/flags/${enc(key)}/environments/${enc(env)}/kill-switch`,
      { enabled },
    ),
  archive: (project: string, key: string, version: number) =>
    request<FlagDetail>('POST', `/api/projects/${enc(project)}/flags/${enc(key)}/archive`, {
      version,
    }),
  restore: (project: string, key: string, version: number) =>
    request<FlagDetail>('POST', `/api/projects/${enc(project)}/flags/${enc(key)}/restore`, {
      version,
    }),
  ruleset: (project: string, env: string) =>
    request<Ruleset>('GET', `/api/projects/${enc(project)}/environments/${enc(env)}/ruleset`),

  schedules: (project: string, key: string, env: string) =>
    request<{ schedules: Schedule[] }>(
      'GET',
      `/api/projects/${enc(project)}/flags/${enc(key)}/environments/${enc(env)}/schedules`,
    ),
  createSchedule: (
    project: string,
    key: string,
    env: string,
    input: { runAt: string; change: Schedule['change'] },
  ) =>
    request<Schedule>(
      'POST',
      `/api/projects/${enc(project)}/flags/${enc(key)}/environments/${enc(env)}/schedules`,
      input,
    ),
  cancelSchedule: (project: string, key: string, env: string, id: string) =>
    request<Schedule>(
      'DELETE',
      `/api/projects/${enc(project)}/flags/${enc(key)}/environments/${enc(env)}/schedules/${enc(id)}`,
    ),
  exposures: (project: string, key: string, env: string, hours: number) =>
    request<ExposureSummary>(
      'GET',
      `/api/projects/${enc(project)}/flags/${enc(key)}/exposures?environment=${enc(env)}&hours=${hours}`,
    ),
  audit: (
    project: string,
    params: { flag?: string; segment?: string; before?: number; limit?: number },
  ) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) q.set(k, String(v));
    return request<{ entries: AuditEntry[]; next: number | null }>(
      'GET',
      `/api/projects/${enc(project)}/audit?${q.toString()}`,
    );
  },

  segments: (project: string, env: string) =>
    request<{ segments: SegmentView[] }>(
      'GET',
      `/api/projects/${enc(project)}/environments/${enc(env)}/segments`,
    ),
  createSegment: (
    project: string,
    env: string,
    input: Omit<SegmentView, 'version' | 'updatedAt'>,
  ) =>
    request<SegmentView>(
      'POST',
      `/api/projects/${enc(project)}/environments/${enc(env)}/segments`,
      input,
    ),
  updateSegment: (
    project: string,
    env: string,
    key: string,
    input: Omit<SegmentView, 'key' | 'updatedAt'>,
  ) =>
    request<SegmentView>(
      'PUT',
      `/api/projects/${enc(project)}/environments/${enc(env)}/segments/${enc(key)}`,
      input,
    ),
  deleteSegment: (project: string, env: string, key: string, version: number) =>
    request<undefined>(
      'DELETE',
      `/api/projects/${enc(project)}/environments/${enc(env)}/segments/${enc(key)}?version=${version}`,
    ),

  changeRequests: (
    project: string,
    params: {
      status?: ChangeRequestStatus;
      environment?: string;
      flag?: string;
      segment?: string;
      before?: string;
      limit?: number;
    },
  ) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) q.set(k, String(v));
    return request<{ changeRequests: ChangeRequestSummary[]; next: string | null }>(
      'GET',
      `/api/projects/${enc(project)}/change-requests?${q.toString()}`,
    );
  },
  changeRequest: (project: string, id: string) =>
    request<ChangeRequest>('GET', `/api/projects/${enc(project)}/change-requests/${enc(id)}`),
  proposeTargeting: (
    project: string,
    key: string,
    env: string,
    input: EnvConfig & { baseVersion: number; title: string; description?: string },
  ) =>
    request<ChangeRequest>(
      'POST',
      `/api/projects/${enc(project)}/flags/${enc(key)}/environments/${enc(env)}/change-requests`,
      input,
    ),
  proposeSegment: (
    project: string,
    env: string,
    key: string,
    input: {
      baseVersion: number;
      title: string;
      description?: string;
      segment: SegmentContent | null;
    },
  ) =>
    request<ChangeRequest>(
      'POST',
      `/api/projects/${enc(project)}/environments/${enc(env)}/segments/${enc(key)}/change-requests`,
      input,
    ),
  reviewChange: (
    project: string,
    id: string,
    input: { revision: number; decision: ReviewDecision; body?: string },
  ) =>
    request<ChangeRequest>(
      'POST',
      `/api/projects/${enc(project)}/change-requests/${enc(id)}/reviews`,
      input,
    ),
  applyChange: (project: string, id: string, revision: number) =>
    request<ChangeRequest>(
      'POST',
      `/api/projects/${enc(project)}/change-requests/${enc(id)}/apply`,
      { revision },
    ),
  rebaseChange: (project: string, id: string, revision: number) =>
    request<ChangeRequest>(
      'POST',
      `/api/projects/${enc(project)}/change-requests/${enc(id)}/rebase`,
      { revision },
    ),
  closeChange: (project: string, id: string, reason?: string) =>
    request<ChangeRequest>(
      'POST',
      `/api/projects/${enc(project)}/change-requests/${enc(id)}/close`,
      reason === undefined || reason === '' ? {} : { reason },
    ),

  apiKeys: (project: string, env: string) =>
    request<{ keys: ApiKey[] }>(
      'GET',
      `/api/projects/${enc(project)}/environments/${enc(env)}/api-keys`,
    ),
  createApiKey: (project: string, env: string, input: { kind: ApiKey['kind']; name: string }) =>
    request<ApiKey & { secret: string }>(
      'POST',
      `/api/projects/${enc(project)}/environments/${enc(env)}/api-keys`,
      input,
    ),
  revokeApiKey: (project: string, env: string, id: string) =>
    request<undefined>(
      'DELETE',
      `/api/projects/${enc(project)}/environments/${enc(env)}/api-keys/${enc(id)}`,
    ),
  createEnvironment: (project: string, input: { key: string; name: string }) =>
    request<{ key: string; name: string }>(
      'POST',
      `/api/projects/${enc(project)}/environments`,
      input,
    ),
  users: () => request<{ users: ManagedUser[] }>('GET', '/api/users'),
  createUser: (input: { email: string; name: string; role: Role; password: string }) =>
    request<ManagedUser>('POST', '/api/users', input),
  updateUser: (id: string, input: { role?: Role; disabled?: boolean }) =>
    request<ManagedUser>('PATCH', `/api/users/${enc(id)}`, input),
};
