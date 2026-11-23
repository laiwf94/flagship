// Generated from openapi.json by `pnpm openapi`. Do not edit by hand.

export type ApplyChangeRequestBody = {
  revision: number;
};

export type ArchiveFlagBody = {
  version: number;
};

export type ChangePasswordBody = {
  currentPassword: string;
  newPassword: string;
};

export type CloseChangeRequestBody = {
  reason?: string;
};

export type CreateApiTokenBody = {
  name: string;
  scopes: (
    | 'flags:read'
    | 'flags:write'
    | 'segments:read'
    | 'segments:write'
    | 'change-requests:read'
    | 'change-requests:write'
    | 'experiments:read'
    | 'experiments:write'
    | 'audit:read'
    | 'audit:restore'
    | 'projects:read'
    | 'projects:write'
    | 'sdk-keys:read'
    | 'sdk-keys:write'
    | 'webhooks:read'
    | 'webhooks:write'
  )[];
  project?: Key;
  environments?: Key[];
  expiresInDays: number;
};

export type CreateEnvironmentBody = {
  key: Key;
  name: string;
};

export type CreateFlagBody = {
  key: Key;
  name: string;
  description?: string;
  type: 'boolean' | 'string' | 'number' | 'json';
  variants?: Variant[];
  clientSide?: boolean;
};

export type CreateProjectBody = {
  key: Key;
  name: string;
  environments?: CreateEnvironmentBody[];
};

export type CreateScheduleBody = {
  runAt: string;
  change: ScheduledChange;
};

export type CreateSdkKeyBody = {
  kind: 'server' | 'client';
  name: string;
};

export type CreateSegmentBody = {
  key: Key;
  name: string;
  description?: string;
  included: string[];
  excluded: string[];
  rules: SegmentRule[];
};

export type CreateUserBody = {
  email: string;
  name: string;
  role: 'viewer' | 'editor' | 'admin';
  password: string;
};

export type CreateWebhookBody = {
  name: string;
  url: string;
  environment?: Key | null;
  events?: string[];
  enabled?: boolean;
};

export type Error = {
  error: {
    code:
      | 'invalid_argument'
      | 'unauthenticated'
      | 'permission_denied'
      | 'not_found'
      | 'already_exists'
      | 'version_conflict'
      | 'failed_precondition'
      | 'payload_too_large'
      | 'unsupported_media_type'
      | 'resource_exhausted'
      | 'internal'
      | 'unavailable';
    message: string;
    request_id: string;
    /** For invalid_argument, one {path, message} entry per problem; other codes may carry an object describing the conflict. */
    details?:
      | ({
          path: string;
          message: string;
        } & { [key: string]: unknown }[])
      | { [key: string]: unknown };
  } & { [key: string]: unknown };
} & { [key: string]: unknown };

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type Key = string;

export type Prerequisite = {
  flag: Key;
  variant: Key;
};

export type ProjectExport = {
  format: 'flagship.project';
  formatVersion: 1;
  exportedAt?: string;
  project: {
    key: Key;
    name: string;
  };
  environments: {
    key: Key;
    name: string;
    requiredApprovals?: number;
    requireReason?: boolean;
    requireLink?: boolean;
  }[];
  flags: {
    key: Key;
    name: string;
    description?: string;
    type: 'boolean' | 'string' | 'number' | 'json';
    variants: Variant[];
    salt?: string;
    clientSide?: boolean;
    archived?: boolean;
    version?: number;
    environments: {
      [key: string]: {
        enabled: boolean;
        offVariant: Key;
        prerequisites: Prerequisite[];
        rules: Rule[];
        fallthrough: Serve;
        version?: number;
      };
    };
  }[];
  segments: {
    environment: Key;
    key: Key;
    name: string;
    description?: string;
    included: string[];
    excluded: string[];
    rules: SegmentRule[];
    version?: number;
  }[];
  checksums?: { [key: string]: string };
};

export type ProposeFlagChangeBody = {
  baseVersion: number;
  title: string;
  description?: string;
  enabled: boolean;
  offVariant: Key;
  prerequisites: Prerequisite[];
  rules: Rule[];
  fallthrough: Serve;
};

export type ProposeSegmentChangeBody = {
  baseVersion: number;
  title: string;
  description?: string;
  segment: {
    name: string;
    description?: string;
    included: string[];
    excluded: string[];
    rules: SegmentRule[];
  } | null;
};

export type ReplayWebhookDeliveriesBody = {
  from: string;
  to?: string;
  status?: ('succeeded' | 'failed')[];
};

export type RestoreAuditEntryBody = {
  to: 'before' | 'after';
  baseVersion: number;
  title?: string;
  description?: string;
};

export type ReviewChangeRequestBody = {
  revision: number;
  decision: 'comment' | 'approve' | 'request_changes';
  body?: string;
};

export type RolloutPlan = {
  target:
    | 'fallthrough'
    | {
        rule: Key;
      };
  variant: Key;
  baseline: Key;
  bucketBy?: string;
  steps: {
    weight: number;
    holdMinutes?: number;
  }[];
  guards?: {
    event: Key;
    kind?: 'conversion' | 'count' | 'value';
    worse?: 'higher' | 'lower';
    threshold?: number;
    minContexts?: number;
    action?: 'pause' | 'rollback';
  }[];
};

export type Rule = {
  id: Key;
  description?: string;
  clauses: (
    | {
        operator: 'inSegment';
        segments: Key[];
        negate?: boolean;
      }
    | {
        attribute: string;
        operator:
          | 'equals'
          | 'in'
          | 'contains'
          | 'startsWith'
          | 'endsWith'
          | 'matches'
          | 'lt'
          | 'lte'
          | 'gt'
          | 'gte'
          | 'semverEq'
          | 'semverLt'
          | 'semverGt';
        values: (string | number | boolean)[];
        negate?: boolean;
      }
  )[];
  serve: Serve;
};

export type ScheduledChange = {
  enabled?: boolean;
  fallthrough?: Serve;
  rules?: Rule[];
};

export type SegmentRule = {
  id: Key;
  clauses: {
    attribute: string;
    operator:
      | 'equals'
      | 'in'
      | 'contains'
      | 'startsWith'
      | 'endsWith'
      | 'matches'
      | 'lt'
      | 'lte'
      | 'gt'
      | 'gte'
      | 'semverEq'
      | 'semverLt'
      | 'semverGt';
    values: (string | number | boolean)[];
    negate?: boolean;
  }[];
};

export type Serve =
  | {
      variant: Key;
    }
  | {
      rollout: {
        bucketBy?: string;
        variants: {
          variant: Key;
          weight: number;
        }[];
      };
    };

export type SetChangeNotesBody = {
  requireReason: boolean;
  requireLink: boolean;
};

export type SetFlagManagedByBody = {
  version: number;
  source: string;
  environments: { [key: string]: number };
};

export type SetKillSwitchBody = {
  enabled: boolean;
};

export type SetRequiredApprovalsBody = {
  requiredApprovals: number;
};

export type SignInBody = {
  email: string;
  password: string;
};

export type StartExperimentBody = {
  key: Key;
  name: string;
  hypothesis?: string;
  flag: Key;
  environment: Key;
  target?:
    | 'fallthrough'
    | {
        rule: Key;
      };
  control: Key;
  metrics: {
    event: Key;
    kind?: 'conversion' | 'count' | 'value';
  }[];
};

export type UpdateFlagBody = {
  version: number;
  name?: string;
  description?: string;
  variants?: Variant[];
  clientSide?: boolean;
};

export type UpdateSegmentBody = {
  version: number;
  name: string;
  description?: string;
  included: string[];
  excluded: string[];
  rules: SegmentRule[];
};

export type UpdateTargetingBody = {
  version: number;
  enabled: boolean;
  offVariant: Key;
  prerequisites: Prerequisite[];
  rules: Rule[];
  fallthrough: Serve;
};

export type UpdateUserBody = {
  name?: string;
  role?: 'viewer' | 'editor' | 'admin';
  disabled?: boolean;
};

export type UpdateWebhookBody = {
  name?: string;
  url?: string;
  environment?: Key | null;
  events?: string[];
  enabled?: boolean;
};

export type Variant = {
  key: Key;
  value: JsonValue;
  name?: string;
};

export type ApplyChangeRequestPath = {
  project: Key;
  id: string;
};

export type ArchiveFlagPath = {
  project: Key;
  flag: Key;
};

export type CancelSchedulePath = {
  project: Key;
  flag: Key;
  environment: Key;
  id: string;
};

export type ChangeRolloutPlanPath = {
  project: Key;
  flag: Key;
  environment: Key;
  id: string;
  action: 'pause' | 'resume' | 'cancel';
};

export type CloseChangeRequestPath = {
  project: Key;
  id: string;
};

export type CreateEnvironmentPath = {
  project: Key;
};

export type CreateFlagPath = {
  project: Key;
};

export type CreateSchedulePath = {
  project: Key;
  flag: Key;
  environment: Key;
};

export type CreateSdkKeyPath = {
  project: Key;
  environment: Key;
};

export type CreateSegmentPath = {
  project: Key;
  environment: Key;
};

export type CreateWebhookPath = {
  project: Key;
};

export type DeleteSegmentPath = {
  project: Key;
  environment: Key;
  segment: Key;
};

export type DeleteSegmentQuery = {
  version: number;
};

export type DeleteWebhookPath = {
  project: Key;
  id: string;
};

export type ExportProjectPath = {
  project: Key;
};

export type GetChangeRequestPath = {
  project: Key;
  id: string;
};

export type GetExperimentPath = {
  project: Key;
  experiment: Key;
};

export type GetExperimentResultsPath = {
  project: Key;
  experiment: Key;
};

export type GetExperimentResultsQuery = {
  showMismatched?: 'true' | 'false' | undefined;
};

export type GetExposuresPath = {
  project: Key;
  flag: Key;
};

export type GetExposuresQuery = {
  environment: Key;
  hours?: number | undefined;
};

export type GetFlagPath = {
  project: Key;
  flag: Key;
};

export type GetProjectPath = {
  project: Key;
};

export type GetRolloutGuardsPath = {
  project: Key;
  flag: Key;
  environment: Key;
  id: string;
};

export type GetRulesetPath = {
  project: Key;
  environment: Key;
};

export type GetSegmentPath = {
  project: Key;
  environment: Key;
  segment: Key;
};

export type GetWebhookPath = {
  project: Key;
  id: string;
};

export type GetWebhookDeliveryPath = {
  project: Key;
  id: string;
  delivery: string;
};

export type ImportProjectQuery = {
  key?: Key | undefined;
  name?: string | undefined;
};

export type ListChangeRequestsPath = {
  project: Key;
};

export type ListChangeRequestsQuery = {
  status?: 'open' | 'applied' | 'closed' | undefined;
  environment?: Key | undefined;
  flag?: Key | undefined;
  segment?: Key | undefined;
  before?: string | undefined;
  limit?: number | undefined;
};

export type ListExperimentsPath = {
  project: Key;
};

export type ListExperimentsQuery = {
  environment?: Key | undefined;
  flag?: Key | undefined;
  status?: 'running' | 'stopped' | undefined;
  limit?: number | undefined;
};

export type ListFlagsPath = {
  project: Key;
};

export type ListFlagsQuery = {
  environment: Key;
  q?: string | undefined;
  status?: 'on' | 'off' | 'rollout' | 'archived' | undefined;
  type?: 'boolean' | 'string' | 'number' | 'json' | undefined;
  limit?: number | undefined;
  after?: Key | undefined;
};

export type ListRolloutPlansPath = {
  project: Key;
  flag: Key;
  environment: Key;
};

export type ListSchedulesPath = {
  project: Key;
  flag: Key;
  environment: Key;
};

export type ListSdkKeysPath = {
  project: Key;
  environment: Key;
};

export type ListSegmentsPath = {
  project: Key;
  environment: Key;
};

export type ListStaleFlagsPath = {
  project: Key;
  environment: Key;
};

export type ListWebhookDeliveriesPath = {
  project: Key;
  id: string;
};

export type ListWebhookDeliveriesQuery = {
  status?: 'pending' | 'succeeded' | 'failed' | undefined;
  event?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
};

export type ListWebhooksPath = {
  project: Key;
};

export type PlanRestorePath = {
  project: Key;
  id: number;
};

export type PlanRestoreQuery = {
  to?: 'before' | 'after' | undefined;
};

export type ProposeFlagChangePath = {
  project: Key;
  flag: Key;
  environment: Key;
};

export type ProposeSegmentChangePath = {
  project: Key;
  environment: Key;
  segment: Key;
};

export type RebaseChangeRequestPath = {
  project: Key;
  id: string;
};

export type ReleaseFlagManagedByPath = {
  project: Key;
  flag: Key;
};

export type ReplayWebhookDeliveriesPath = {
  project: Key;
  id: string;
};

export type ReplayWebhookDeliveryPath = {
  project: Key;
  id: string;
  delivery: string;
};

export type RestoreAuditEntryPath = {
  project: Key;
  id: number;
};

export type RestoreFlagPath = {
  project: Key;
  flag: Key;
};

export type ReviewChangeRequestPath = {
  project: Key;
  id: string;
};

export type RevokeApiTokenPath = {
  id: string;
};

export type RevokeSdkKeyPath = {
  project: Key;
  environment: Key;
  id: string;
};

export type RotateWebhookSecretPath = {
  project: Key;
  id: string;
};

export type SearchAuditPath = {
  project: Key;
};

export type SearchAuditQuery = {
  flag?: Key | undefined;
  segment?: Key | undefined;
  actor?: string | undefined;
  q?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
};

export type SetChangeNotesPath = {
  project: Key;
  environment: Key;
};

export type SetFlagManagedByPath = {
  project: Key;
  flag: Key;
};

export type SetKillSwitchPath = {
  project: Key;
  flag: Key;
  environment: Key;
};

export type SetRequiredApprovalsPath = {
  project: Key;
  environment: Key;
};

export type StartExperimentPath = {
  project: Key;
};

export type StartRolloutPlanPath = {
  project: Key;
  flag: Key;
  environment: Key;
};

export type StopExperimentPath = {
  project: Key;
  experiment: Key;
};

export type UpdateFlagPath = {
  project: Key;
  flag: Key;
};

export type UpdateSegmentPath = {
  project: Key;
  environment: Key;
  segment: Key;
};

export type UpdateTargetingPath = {
  project: Key;
  flag: Key;
  environment: Key;
};

export type UpdateUserPath = {
  id: string;
};

export type UpdateWebhookPath = {
  project: Key;
  id: string;
};

/** How each operation is sent. */
export interface OperationSpec {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Relative to the server URL, with {name} placeholders for path parameters. */
  path: string;
  /** Path parameter names, in order. */
  params: readonly string[];
  /** The success response has no body. */
  empty: boolean;
}

export const OPERATIONS = {
  applyChangeRequest: {
    method: 'POST',
    path: '/projects/{project}/change-requests/{id}/apply',
    params: ['project', 'id'],
    empty: false,
  },
  archiveFlag: {
    method: 'POST',
    path: '/projects/{project}/flags/{flag}/archive',
    params: ['project', 'flag'],
    empty: false,
  },
  cancelSchedule: {
    method: 'DELETE',
    path: '/projects/{project}/flags/{flag}/environments/{environment}/schedules/{id}',
    params: ['project', 'flag', 'environment', 'id'],
    empty: false,
  },
  changePassword: { method: 'PUT', path: '/session/password', params: [], empty: true },
  changeRolloutPlan: {
    method: 'POST',
    path: '/projects/{project}/flags/{flag}/environments/{environment}/rollout-plans/{id}/{action}',
    params: ['project', 'flag', 'environment', 'id', 'action'],
    empty: false,
  },
  closeChangeRequest: {
    method: 'POST',
    path: '/projects/{project}/change-requests/{id}/close',
    params: ['project', 'id'],
    empty: false,
  },
  createApiToken: { method: 'POST', path: '/tokens', params: [], empty: false },
  createEnvironment: {
    method: 'POST',
    path: '/projects/{project}/environments',
    params: ['project'],
    empty: false,
  },
  createFlag: {
    method: 'POST',
    path: '/projects/{project}/flags',
    params: ['project'],
    empty: false,
  },
  createProject: { method: 'POST', path: '/projects', params: [], empty: false },
  createSchedule: {
    method: 'POST',
    path: '/projects/{project}/flags/{flag}/environments/{environment}/schedules',
    params: ['project', 'flag', 'environment'],
    empty: false,
  },
  createSdkKey: {
    method: 'POST',
    path: '/projects/{project}/environments/{environment}/api-keys',
    params: ['project', 'environment'],
    empty: false,
  },
  createSegment: {
    method: 'POST',
    path: '/projects/{project}/environments/{environment}/segments',
    params: ['project', 'environment'],
    empty: false,
  },
  createUser: { method: 'POST', path: '/users', params: [], empty: false },
  createWebhook: {
    method: 'POST',
    path: '/projects/{project}/webhooks',
    params: ['project'],
    empty: false,
  },
  deleteSegment: {
    method: 'DELETE',
    path: '/projects/{project}/environments/{environment}/segments/{segment}',
    params: ['project', 'environment', 'segment'],
    empty: true,
  },
  deleteWebhook: {
    method: 'DELETE',
    path: '/projects/{project}/webhooks/{id}',
    params: ['project', 'id'],
    empty: true,
  },
  exportProject: {
    method: 'GET',
    path: '/projects/{project}/export',
    params: ['project'],
    empty: false,
  },
  getChangeRequest: {
    method: 'GET',
    path: '/projects/{project}/change-requests/{id}',
    params: ['project', 'id'],
    empty: false,
  },
  getExperiment: {
    method: 'GET',
    path: '/projects/{project}/experiments/{experiment}',
    params: ['project', 'experiment'],
    empty: false,
  },
  getExperimentResults: {
    method: 'GET',
    path: '/projects/{project}/experiments/{experiment}/results',
    params: ['project', 'experiment'],
    empty: false,
  },
  getExposures: {
    method: 'GET',
    path: '/projects/{project}/flags/{flag}/exposures',
    params: ['project', 'flag'],
    empty: false,
  },
  getFlag: {
    method: 'GET',
    path: '/projects/{project}/flags/{flag}',
    params: ['project', 'flag'],
    empty: false,
  },
  getOpenApiDocument: { method: 'GET', path: '/openapi.json', params: [], empty: false },
  getProject: { method: 'GET', path: '/projects/{project}', params: ['project'], empty: false },
  getRolloutGuards: {
    method: 'GET',
    path: '/projects/{project}/flags/{flag}/environments/{environment}/rollout-plans/{id}/guards',
    params: ['project', 'flag', 'environment', 'id'],
    empty: false,
  },
  getRuleset: {
    method: 'GET',
    path: '/projects/{project}/environments/{environment}/ruleset',
    params: ['project', 'environment'],
    empty: false,
  },
  getSegment: {
    method: 'GET',
    path: '/projects/{project}/environments/{environment}/segments/{segment}',
    params: ['project', 'environment', 'segment'],
    empty: false,
  },
  getSession: { method: 'GET', path: '/session', params: [], empty: false },
  getWebhook: {
    method: 'GET',
    path: '/projects/{project}/webhooks/{id}',
    params: ['project', 'id'],
    empty: false,
  },
  getWebhookDelivery: {
    method: 'GET',
    path: '/projects/{project}/webhooks/{id}/deliveries/{delivery}',
    params: ['project', 'id', 'delivery'],
    empty: false,
  },
  importProject: { method: 'POST', path: '/projects/import', params: [], empty: false },
  listApiTokens: { method: 'GET', path: '/tokens', params: [], empty: false },
  listChangeRequests: {
    method: 'GET',
    path: '/projects/{project}/change-requests',
    params: ['project'],
    empty: false,
  },
  listExperiments: {
    method: 'GET',
    path: '/projects/{project}/experiments',
    params: ['project'],
    empty: false,
  },
  listFlags: {
    method: 'GET',
    path: '/projects/{project}/flags',
    params: ['project'],
    empty: false,
  },
  listProjects: { method: 'GET', path: '/projects', params: [], empty: false },
  listRolloutPlans: {
    method: 'GET',
    path: '/projects/{project}/flags/{flag}/environments/{environment}/rollout-plans',
    params: ['project', 'flag', 'environment'],
    empty: false,
  },
  listSchedules: {
    method: 'GET',
    path: '/projects/{project}/flags/{flag}/environments/{environment}/schedules',
    params: ['project', 'flag', 'environment'],
    empty: false,
  },
  listSdkKeys: {
    method: 'GET',
    path: '/projects/{project}/environments/{environment}/api-keys',
    params: ['project', 'environment'],
    empty: false,
  },
  listSegments: {
    method: 'GET',
    path: '/projects/{project}/environments/{environment}/segments',
    params: ['project', 'environment'],
    empty: false,
  },
  listStaleFlags: {
    method: 'GET',
    path: '/projects/{project}/environments/{environment}/stale-flags',
    params: ['project', 'environment'],
    empty: false,
  },
  listUsers: { method: 'GET', path: '/users', params: [], empty: false },
  listWebhookDeliveries: {
    method: 'GET',
    path: '/projects/{project}/webhooks/{id}/deliveries',
    params: ['project', 'id'],
    empty: false,
  },
  listWebhooks: {
    method: 'GET',
    path: '/projects/{project}/webhooks',
    params: ['project'],
    empty: false,
  },
  planRestore: {
    method: 'GET',
    path: '/projects/{project}/audit/{id}/restore',
    params: ['project', 'id'],
    empty: false,
  },
  proposeFlagChange: {
    method: 'POST',
    path: '/projects/{project}/flags/{flag}/environments/{environment}/change-requests',
    params: ['project', 'flag', 'environment'],
    empty: false,
  },
  proposeSegmentChange: {
    method: 'POST',
    path: '/projects/{project}/environments/{environment}/segments/{segment}/change-requests',
    params: ['project', 'environment', 'segment'],
    empty: false,
  },
  rebaseChangeRequest: {
    method: 'POST',
    path: '/projects/{project}/change-requests/{id}/rebase',
    params: ['project', 'id'],
    empty: false,
  },
  releaseFlagManagedBy: {
    method: 'DELETE',
    path: '/projects/{project}/flags/{flag}/managed-by',
    params: ['project', 'flag'],
    empty: false,
  },
  replayWebhookDeliveries: {
    method: 'POST',
    path: '/projects/{project}/webhooks/{id}/replay',
    params: ['project', 'id'],
    empty: false,
  },
  replayWebhookDelivery: {
    method: 'POST',
    path: '/projects/{project}/webhooks/{id}/deliveries/{delivery}/replay',
    params: ['project', 'id', 'delivery'],
    empty: false,
  },
  restoreAuditEntry: {
    method: 'POST',
    path: '/projects/{project}/audit/{id}/restore',
    params: ['project', 'id'],
    empty: false,
  },
  restoreFlag: {
    method: 'POST',
    path: '/projects/{project}/flags/{flag}/restore',
    params: ['project', 'flag'],
    empty: false,
  },
  reviewChangeRequest: {
    method: 'POST',
    path: '/projects/{project}/change-requests/{id}/reviews',
    params: ['project', 'id'],
    empty: false,
  },
  revokeApiToken: { method: 'DELETE', path: '/tokens/{id}', params: ['id'], empty: true },
  revokeSdkKey: {
    method: 'DELETE',
    path: '/projects/{project}/environments/{environment}/api-keys/{id}',
    params: ['project', 'environment', 'id'],
    empty: true,
  },
  rotateWebhookSecret: {
    method: 'POST',
    path: '/projects/{project}/webhooks/{id}/secret',
    params: ['project', 'id'],
    empty: false,
  },
  searchAudit: {
    method: 'GET',
    path: '/projects/{project}/audit',
    params: ['project'],
    empty: false,
  },
  setChangeNotes: {
    method: 'PUT',
    path: '/projects/{project}/environments/{environment}/change-notes',
    params: ['project', 'environment'],
    empty: false,
  },
  setFlagManagedBy: {
    method: 'PUT',
    path: '/projects/{project}/flags/{flag}/managed-by',
    params: ['project', 'flag'],
    empty: false,
  },
  setKillSwitch: {
    method: 'POST',
    path: '/projects/{project}/flags/{flag}/environments/{environment}/kill-switch',
    params: ['project', 'flag', 'environment'],
    empty: false,
  },
  setRequiredApprovals: {
    method: 'PUT',
    path: '/projects/{project}/environments/{environment}/approvals',
    params: ['project', 'environment'],
    empty: false,
  },
  signIn: { method: 'POST', path: '/session', params: [], empty: false },
  signOut: { method: 'DELETE', path: '/session', params: [], empty: true },
  startExperiment: {
    method: 'POST',
    path: '/projects/{project}/experiments',
    params: ['project'],
    empty: false,
  },
  startRolloutPlan: {
    method: 'POST',
    path: '/projects/{project}/flags/{flag}/environments/{environment}/rollout-plans',
    params: ['project', 'flag', 'environment'],
    empty: false,
  },
  stopExperiment: {
    method: 'POST',
    path: '/projects/{project}/experiments/{experiment}/stop',
    params: ['project', 'experiment'],
    empty: false,
  },
  updateFlag: {
    method: 'PUT',
    path: '/projects/{project}/flags/{flag}',
    params: ['project', 'flag'],
    empty: false,
  },
  updateSegment: {
    method: 'PUT',
    path: '/projects/{project}/environments/{environment}/segments/{segment}',
    params: ['project', 'environment', 'segment'],
    empty: false,
  },
  updateTargeting: {
    method: 'PUT',
    path: '/projects/{project}/flags/{flag}/environments/{environment}',
    params: ['project', 'flag', 'environment'],
    empty: false,
  },
  updateUser: { method: 'PATCH', path: '/users/{id}', params: ['id'], empty: false },
  updateWebhook: {
    method: 'PATCH',
    path: '/projects/{project}/webhooks/{id}',
    params: ['project', 'id'],
    empty: false,
  },
} as const satisfies Record<string, OperationSpec>;

export type OperationId = keyof typeof OPERATIONS;

/** What one call sends; each part is left out when the operation has none. */
export interface OperationArgs {
  path?: Record<string, string | number>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

/** One method per admin API operation; AdminClient supplies the transport. */
export abstract class AdminOperations {
  protected abstract send(spec: OperationSpec, args: OperationArgs): Promise<unknown>;

  /**
   * Apply an approved revision
   *
   * POST /projects/{project}/change-requests/{id}/apply
   *
   * Token scope: change-requests:write.
   */
  applyChangeRequest(args: {
    path: ApplyChangeRequestPath;
    body: ApplyChangeRequestBody;
  }): Promise<unknown> {
    return this.send(OPERATIONS.applyChangeRequest, args);
  }

  /**
   * Archive a flag
   *
   * POST /projects/{project}/flags/{flag}/archive
   *
   * Token scope: flags:write.
   */
  archiveFlag(args: { path: ArchiveFlagPath; body: ArchiveFlagBody }): Promise<unknown> {
    return this.send(OPERATIONS.archiveFlag, args);
  }

  /**
   * Cancel a scheduled change
   *
   * DELETE /projects/{project}/flags/{flag}/environments/{environment}/schedules/{id}
   *
   * Token scope: flags:write.
   */
  cancelSchedule(args: { path: CancelSchedulePath }): Promise<unknown> {
    return this.send(OPERATIONS.cancelSchedule, args);
  }

  /**
   * Change your password and end your other sessions
   *
   * PUT /session/password
   */
  changePassword(args: { body: ChangePasswordBody }): Promise<void> {
    return this.send(OPERATIONS.changePassword, args).then(() => undefined);
  }

  /**
   * Pause, resume or cancel a rollout plan
   *
   * POST /projects/{project}/flags/{flag}/environments/{environment}/rollout-plans/{id}/{action}
   *
   * Token scope: flags:write.
   */
  changeRolloutPlan(args: { path: ChangeRolloutPlanPath }): Promise<unknown> {
    return this.send(OPERATIONS.changeRolloutPlan, args);
  }

  /**
   * Close a change request without applying it
   *
   * POST /projects/{project}/change-requests/{id}/close
   *
   * Token scope: change-requests:write.
   */
  closeChangeRequest(args: {
    path: CloseChangeRequestPath;
    body?: CloseChangeRequestBody;
  }): Promise<unknown> {
    return this.send(OPERATIONS.closeChangeRequest, args);
  }

  /**
   * Create an API token; the secret is shown once
   *
   * POST /tokens
   */
  createApiToken(args: { body: CreateApiTokenBody }): Promise<unknown> {
    return this.send(OPERATIONS.createApiToken, args);
  }

  /**
   * Add an environment to a project
   *
   * POST /projects/{project}/environments
   *
   * Token scope: projects:write.
   */
  createEnvironment(args: {
    path: CreateEnvironmentPath;
    body: CreateEnvironmentBody;
  }): Promise<unknown> {
    return this.send(OPERATIONS.createEnvironment, args);
  }

  /**
   * Create a flag
   *
   * POST /projects/{project}/flags
   *
   * Token scope: flags:write.
   */
  createFlag(args: { path: CreateFlagPath; body: CreateFlagBody }): Promise<unknown> {
    return this.send(OPERATIONS.createFlag, args);
  }

  /**
   * Create a project with its environments
   *
   * POST /projects
   *
   * Token scope: projects:write.
   */
  createProject(args: { body: CreateProjectBody }): Promise<unknown> {
    return this.send(OPERATIONS.createProject, args);
  }

  /**
   * Schedule a change to a flag
   *
   * POST /projects/{project}/flags/{flag}/environments/{environment}/schedules
   *
   * Token scope: flags:write.
   */
  createSchedule(args: { path: CreateSchedulePath; body: CreateScheduleBody }): Promise<unknown> {
    return this.send(OPERATIONS.createSchedule, args);
  }

  /**
   * Create an SDK key; the secret is shown once
   *
   * POST /projects/{project}/environments/{environment}/api-keys
   *
   * Token scope: sdk-keys:write.
   */
  createSdkKey(args: { path: CreateSdkKeyPath; body: CreateSdkKeyBody }): Promise<unknown> {
    return this.send(OPERATIONS.createSdkKey, args);
  }

  /**
   * Create a segment
   *
   * POST /projects/{project}/environments/{environment}/segments
   *
   * Token scope: segments:write.
   */
  createSegment(args: { path: CreateSegmentPath; body: CreateSegmentBody }): Promise<unknown> {
    return this.send(OPERATIONS.createSegment, args);
  }

  /**
   * Create a user
   *
   * POST /users
   */
  createUser(args: { body: CreateUserBody }): Promise<unknown> {
    return this.send(OPERATIONS.createUser, args);
  }

  /**
   * Create a webhook; the signing secret is shown once
   *
   * POST /projects/{project}/webhooks
   *
   * Token scope: webhooks:write.
   */
  createWebhook(args: { path: CreateWebhookPath; body: CreateWebhookBody }): Promise<unknown> {
    return this.send(OPERATIONS.createWebhook, args);
  }

  /**
   * Delete a segment no flag uses
   *
   * DELETE /projects/{project}/environments/{environment}/segments/{segment}
   *
   * Token scope: segments:write.
   */
  deleteSegment(args: { path: DeleteSegmentPath; query: DeleteSegmentQuery }): Promise<void> {
    return this.send(OPERATIONS.deleteSegment, args).then(() => undefined);
  }

  /**
   * Delete a webhook
   *
   * DELETE /projects/{project}/webhooks/{id}
   *
   * Token scope: webhooks:write.
   */
  deleteWebhook(args: { path: DeleteWebhookPath }): Promise<void> {
    return this.send(OPERATIONS.deleteWebhook, args).then(() => undefined);
  }

  /**
   * Download a project as one JSON document
   *
   * GET /projects/{project}/export
   *
   * Token scope: projects:read.
   */
  exportProject(args: { path: ExportProjectPath }): Promise<unknown> {
    return this.send(OPERATIONS.exportProject, args);
  }

  /**
   * A change request with its revisions and reviews
   *
   * GET /projects/{project}/change-requests/{id}
   *
   * Token scope: change-requests:read.
   */
  getChangeRequest(args: { path: GetChangeRequestPath }): Promise<unknown> {
    return this.send(OPERATIONS.getChangeRequest, args);
  }

  /**
   * An experiment
   *
   * GET /projects/{project}/experiments/{experiment}
   *
   * Token scope: experiments:read.
   */
  getExperiment(args: { path: GetExperimentPath }): Promise<unknown> {
    return this.send(OPERATIONS.getExperiment, args);
  }

  /**
   * Per-variant results with intervals and the sample ratio check
   *
   * GET /projects/{project}/experiments/{experiment}/results
   *
   * Token scope: experiments:read.
   */
  getExperimentResults(args: {
    path: GetExperimentResultsPath;
    query?: GetExperimentResultsQuery;
  }): Promise<unknown> {
    return this.send(OPERATIONS.getExperimentResults, args);
  }

  /**
   * Hourly exposure counts per variant
   *
   * GET /projects/{project}/flags/{flag}/exposures
   *
   * Token scope: flags:read.
   */
  getExposures(args: { path: GetExposuresPath; query: GetExposuresQuery }): Promise<unknown> {
    return this.send(OPERATIONS.getExposures, args);
  }

  /**
   * A flag with its targeting in every environment
   *
   * GET /projects/{project}/flags/{flag}
   *
   * Token scope: flags:read.
   */
  getFlag(args: { path: GetFlagPath }): Promise<unknown> {
    return this.send(OPERATIONS.getFlag, args);
  }

  /**
   * This OpenAPI 3.1 document
   *
   * GET /openapi.json
   */
  getOpenApiDocument(): Promise<unknown> {
    return this.send(OPERATIONS.getOpenApiDocument, {});
  }

  /**
   * A project with its environments and their protection
   *
   * GET /projects/{project}
   *
   * Token scope: projects:read.
   */
  getProject(args: { path: GetProjectPath }): Promise<unknown> {
    return this.send(OPERATIONS.getProject, args);
  }

  /**
   * A rollout plan's guard metrics and their latest values
   *
   * GET /projects/{project}/flags/{flag}/environments/{environment}/rollout-plans/{id}/guards
   *
   * Token scope: flags:read.
   */
  getRolloutGuards(args: { path: GetRolloutGuardsPath }): Promise<unknown> {
    return this.send(OPERATIONS.getRolloutGuards, args);
  }

  /**
   * An environment's full ruleset, as SDKs receive it
   *
   * GET /projects/{project}/environments/{environment}/ruleset
   *
   * Token scope: flags:read.
   */
  getRuleset(args: { path: GetRulesetPath }): Promise<unknown> {
    return this.send(OPERATIONS.getRuleset, args);
  }

  /**
   * A segment
   *
   * GET /projects/{project}/environments/{environment}/segments/{segment}
   *
   * Token scope: segments:read.
   */
  getSegment(args: { path: GetSegmentPath }): Promise<unknown> {
    return this.send(OPERATIONS.getSegment, args);
  }

  /**
   * The signed-in user and CSRF token
   *
   * GET /session
   */
  getSession(): Promise<unknown> {
    return this.send(OPERATIONS.getSession, {});
  }

  /**
   * A webhook
   *
   * GET /projects/{project}/webhooks/{id}
   *
   * Token scope: webhooks:read.
   */
  getWebhook(args: { path: GetWebhookPath }): Promise<unknown> {
    return this.send(OPERATIONS.getWebhook, args);
  }

  /**
   * One delivery with its attempts
   *
   * GET /projects/{project}/webhooks/{id}/deliveries/{delivery}
   *
   * Token scope: webhooks:read.
   */
  getWebhookDelivery(args: { path: GetWebhookDeliveryPath }): Promise<unknown> {
    return this.send(OPERATIONS.getWebhookDelivery, args);
  }

  /**
   * Create a project from an export document
   *
   * POST /projects/import
   *
   * Token scope: projects:write.
   */
  importProject(args: { query?: ImportProjectQuery; body: ProjectExport }): Promise<unknown> {
    return this.send(OPERATIONS.importProject, args);
  }

  /**
   * List your API tokens and the scopes they can hold
   *
   * GET /tokens
   */
  listApiTokens(): Promise<unknown> {
    return this.send(OPERATIONS.listApiTokens, {});
  }

  /**
   * List change requests, newest first
   *
   * GET /projects/{project}/change-requests
   *
   * Token scope: change-requests:read.
   */
  listChangeRequests(args: {
    path: ListChangeRequestsPath;
    query?: ListChangeRequestsQuery;
  }): Promise<unknown> {
    return this.send(OPERATIONS.listChangeRequests, args);
  }

  /**
   * List experiments
   *
   * GET /projects/{project}/experiments
   *
   * Token scope: experiments:read.
   */
  listExperiments(args: {
    path: ListExperimentsPath;
    query?: ListExperimentsQuery;
  }): Promise<unknown> {
    return this.send(OPERATIONS.listExperiments, args);
  }

  /**
   * List flags with their state in one environment
   *
   * GET /projects/{project}/flags
   *
   * Token scope: flags:read.
   */
  listFlags(args: { path: ListFlagsPath; query: ListFlagsQuery }): Promise<unknown> {
    return this.send(OPERATIONS.listFlags, args);
  }

  /**
   * List projects
   *
   * GET /projects
   *
   * Token scope: projects:read.
   */
  listProjects(): Promise<unknown> {
    return this.send(OPERATIONS.listProjects, {});
  }

  /**
   * A flag's progressive rollout plans in one environment
   *
   * GET /projects/{project}/flags/{flag}/environments/{environment}/rollout-plans
   *
   * Token scope: flags:read.
   */
  listRolloutPlans(args: { path: ListRolloutPlansPath }): Promise<unknown> {
    return this.send(OPERATIONS.listRolloutPlans, args);
  }

  /**
   * A flag's scheduled changes in one environment
   *
   * GET /projects/{project}/flags/{flag}/environments/{environment}/schedules
   *
   * Token scope: flags:read.
   */
  listSchedules(args: { path: ListSchedulesPath }): Promise<unknown> {
    return this.send(OPERATIONS.listSchedules, args);
  }

  /**
   * List an environment's SDK keys
   *
   * GET /projects/{project}/environments/{environment}/api-keys
   *
   * Token scope: sdk-keys:read.
   */
  listSdkKeys(args: { path: ListSdkKeysPath }): Promise<unknown> {
    return this.send(OPERATIONS.listSdkKeys, args);
  }

  /**
   * An environment's segments
   *
   * GET /projects/{project}/environments/{environment}/segments
   *
   * Token scope: segments:read.
   */
  listSegments(args: { path: ListSegmentsPath }): Promise<unknown> {
    return this.send(OPERATIONS.listSegments, args);
  }

  /**
   * Flags that look finished or unused in an environment
   *
   * GET /projects/{project}/environments/{environment}/stale-flags
   *
   * Token scope: flags:read.
   */
  listStaleFlags(args: { path: ListStaleFlagsPath }): Promise<unknown> {
    return this.send(OPERATIONS.listStaleFlags, args);
  }

  /**
   * List users
   *
   * GET /users
   */
  listUsers(): Promise<unknown> {
    return this.send(OPERATIONS.listUsers, {});
  }

  /**
   * A webhook's delivery log
   *
   * GET /projects/{project}/webhooks/{id}/deliveries
   *
   * Token scope: webhooks:read.
   */
  listWebhookDeliveries(args: {
    path: ListWebhookDeliveriesPath;
    query?: ListWebhookDeliveriesQuery;
  }): Promise<unknown> {
    return this.send(OPERATIONS.listWebhookDeliveries, args);
  }

  /**
   * A project's webhooks
   *
   * GET /projects/{project}/webhooks
   *
   * Token scope: webhooks:read.
   */
  listWebhooks(args: { path: ListWebhooksPath }): Promise<unknown> {
    return this.send(OPERATIONS.listWebhooks, args);
  }

  /**
   * Preview restoring the state before or after an audit entry
   *
   * GET /projects/{project}/audit/{id}/restore
   *
   * Token scope: audit:read.
   */
  planRestore(args: { path: PlanRestorePath; query?: PlanRestoreQuery }): Promise<unknown> {
    return this.send(OPERATIONS.planRestore, args);
  }

  /**
   * Propose new targeting for a flag in a protected environment
   *
   * POST /projects/{project}/flags/{flag}/environments/{environment}/change-requests
   *
   * Token scope: change-requests:write.
   */
  proposeFlagChange(args: {
    path: ProposeFlagChangePath;
    body: ProposeFlagChangeBody;
  }): Promise<unknown> {
    return this.send(OPERATIONS.proposeFlagChange, args);
  }

  /**
   * Propose creating, editing or deleting a segment
   *
   * POST /projects/{project}/environments/{environment}/segments/{segment}/change-requests
   *
   * Token scope: change-requests:write.
   */
  proposeSegmentChange(args: {
    path: ProposeSegmentChangePath;
    body: ProposeSegmentChangeBody;
  }): Promise<unknown> {
    return this.send(OPERATIONS.proposeSegmentChange, args);
  }

  /**
   * Rebase a revision onto the current version
   *
   * POST /projects/{project}/change-requests/{id}/rebase
   *
   * Token scope: change-requests:write.
   */
  rebaseChangeRequest(args: {
    path: RebaseChangeRequestPath;
    body: ApplyChangeRequestBody;
  }): Promise<unknown> {
    return this.send(OPERATIONS.rebaseChangeRequest, args);
  }

  /**
   * Hand a flag managed by code back to the console
   *
   * DELETE /projects/{project}/flags/{flag}/managed-by
   *
   * Token scope: flags:write.
   */
  releaseFlagManagedBy(args: { path: ReleaseFlagManagedByPath }): Promise<unknown> {
    return this.send(OPERATIONS.releaseFlagManagedBy, args);
  }

  /**
   * Send failed deliveries in a time range again
   *
   * POST /projects/{project}/webhooks/{id}/replay
   *
   * Token scope: webhooks:write.
   */
  replayWebhookDeliveries(args: {
    path: ReplayWebhookDeliveriesPath;
    body: ReplayWebhookDeliveriesBody;
  }): Promise<unknown> {
    return this.send(OPERATIONS.replayWebhookDeliveries, args);
  }

  /**
   * Send one delivery again
   *
   * POST /projects/{project}/webhooks/{id}/deliveries/{delivery}/replay
   *
   * Token scope: webhooks:write.
   */
  replayWebhookDelivery(args: { path: ReplayWebhookDeliveryPath }): Promise<unknown> {
    return this.send(OPERATIONS.replayWebhookDelivery, args);
  }

  /**
   * Restore the state before or after an audit entry, or propose it
   *
   * POST /projects/{project}/audit/{id}/restore
   *
   * Token scope: audit:restore.
   */
  restoreAuditEntry(args: {
    path: RestoreAuditEntryPath;
    body: RestoreAuditEntryBody;
  }): Promise<unknown> {
    return this.send(OPERATIONS.restoreAuditEntry, args);
  }

  /**
   * Restore an archived flag
   *
   * POST /projects/{project}/flags/{flag}/restore
   *
   * Token scope: flags:write.
   */
  restoreFlag(args: { path: RestoreFlagPath; body: ArchiveFlagBody }): Promise<unknown> {
    return this.send(OPERATIONS.restoreFlag, args);
  }

  /**
   * Comment on, approve or request changes to a revision
   *
   * POST /projects/{project}/change-requests/{id}/reviews
   *
   * Token scope: change-requests:write.
   */
  reviewChangeRequest(args: {
    path: ReviewChangeRequestPath;
    body: ReviewChangeRequestBody;
  }): Promise<unknown> {
    return this.send(OPERATIONS.reviewChangeRequest, args);
  }

  /**
   * Revoke one of your API tokens
   *
   * DELETE /tokens/{id}
   */
  revokeApiToken(args: { path: RevokeApiTokenPath }): Promise<void> {
    return this.send(OPERATIONS.revokeApiToken, args).then(() => undefined);
  }

  /**
   * Revoke an SDK key
   *
   * DELETE /projects/{project}/environments/{environment}/api-keys/{id}
   *
   * Token scope: sdk-keys:write.
   */
  revokeSdkKey(args: { path: RevokeSdkKeyPath }): Promise<void> {
    return this.send(OPERATIONS.revokeSdkKey, args).then(() => undefined);
  }

  /**
   * Rotate the signing secret; the old one is honoured for 24 hours
   *
   * POST /projects/{project}/webhooks/{id}/secret
   *
   * Token scope: webhooks:write.
   */
  rotateWebhookSecret(args: { path: RotateWebhookSecretPath }): Promise<unknown> {
    return this.send(OPERATIONS.rotateWebhookSecret, args);
  }

  /**
   * Search the audit log
   *
   * GET /projects/{project}/audit
   *
   * Token scope: audit:read.
   */
  searchAudit(args: { path: SearchAuditPath; query?: SearchAuditQuery }): Promise<unknown> {
    return this.send(OPERATIONS.searchAudit, args);
  }

  /**
   * Require a reason or a ticket link on every change
   *
   * PUT /projects/{project}/environments/{environment}/change-notes
   *
   * Token scope: projects:write.
   */
  setChangeNotes(args: { path: SetChangeNotesPath; body: SetChangeNotesBody }): Promise<unknown> {
    return this.send(OPERATIONS.setChangeNotes, args);
  }

  /**
   * Mark a flag as managed by a flags file, with the versions its apply left
   *
   * PUT /projects/{project}/flags/{flag}/managed-by
   *
   * Token scope: flags:write.
   */
  setFlagManagedBy(args: {
    path: SetFlagManagedByPath;
    body: SetFlagManagedByBody;
  }): Promise<unknown> {
    return this.send(OPERATIONS.setFlagManagedBy, args);
  }

  /**
   * Turn a flag on or off in one environment
   *
   * POST /projects/{project}/flags/{flag}/environments/{environment}/kill-switch
   *
   * Token scope: flags:write.
   */
  setKillSwitch(args: { path: SetKillSwitchPath; body: SetKillSwitchBody }): Promise<unknown> {
    return this.send(OPERATIONS.setKillSwitch, args);
  }

  /**
   * Set how many approvals a change request needs
   *
   * PUT /projects/{project}/environments/{environment}/approvals
   *
   * Token scope: projects:write.
   */
  setRequiredApprovals(args: {
    path: SetRequiredApprovalsPath;
    body: SetRequiredApprovalsBody;
  }): Promise<unknown> {
    return this.send(OPERATIONS.setRequiredApprovals, args);
  }

  /**
   * Sign in; sets the session cookie and returns the CSRF token
   *
   * POST /session
   */
  signIn(args: { body: SignInBody }): Promise<unknown> {
    return this.send(OPERATIONS.signIn, args);
  }

  /**
   * Sign out
   *
   * DELETE /session
   */
  signOut(): Promise<void> {
    return this.send(OPERATIONS.signOut, {}).then(() => undefined);
  }

  /**
   * Start an experiment on a flag
   *
   * POST /projects/{project}/experiments
   *
   * Token scope: experiments:write.
   */
  startExperiment(args: {
    path: StartExperimentPath;
    body: StartExperimentBody;
  }): Promise<unknown> {
    return this.send(OPERATIONS.startExperiment, args);
  }

  /**
   * Start a progressive rollout
   *
   * POST /projects/{project}/flags/{flag}/environments/{environment}/rollout-plans
   *
   * Token scope: flags:write.
   */
  startRolloutPlan(args: { path: StartRolloutPlanPath; body: RolloutPlan }): Promise<unknown> {
    return this.send(OPERATIONS.startRolloutPlan, args);
  }

  /**
   * Stop an experiment
   *
   * POST /projects/{project}/experiments/{experiment}/stop
   *
   * Token scope: experiments:write.
   */
  stopExperiment(args: { path: StopExperimentPath }): Promise<unknown> {
    return this.send(OPERATIONS.stopExperiment, args);
  }

  /**
   * Change a flag's name, description, variants or client-side exposure
   *
   * PUT /projects/{project}/flags/{flag}
   *
   * Token scope: flags:write.
   */
  updateFlag(args: { path: UpdateFlagPath; body: UpdateFlagBody }): Promise<unknown> {
    return this.send(OPERATIONS.updateFlag, args);
  }

  /**
   * Replace a segment
   *
   * PUT /projects/{project}/environments/{environment}/segments/{segment}
   *
   * Token scope: segments:write.
   */
  updateSegment(args: { path: UpdateSegmentPath; body: UpdateSegmentBody }): Promise<unknown> {
    return this.send(OPERATIONS.updateSegment, args);
  }

  /**
   * Replace a flag's targeting in one environment
   *
   * PUT /projects/{project}/flags/{flag}/environments/{environment}
   *
   * Token scope: flags:write.
   */
  updateTargeting(args: {
    path: UpdateTargetingPath;
    body: UpdateTargetingBody;
  }): Promise<unknown> {
    return this.send(OPERATIONS.updateTargeting, args);
  }

  /**
   * Change a user's name or role, or disable them
   *
   * PATCH /users/{id}
   */
  updateUser(args: { path: UpdateUserPath; body: UpdateUserBody }): Promise<unknown> {
    return this.send(OPERATIONS.updateUser, args);
  }

  /**
   * Change a webhook
   *
   * PATCH /projects/{project}/webhooks/{id}
   *
   * Token scope: webhooks:write.
   */
  updateWebhook(args: { path: UpdateWebhookPath; body: UpdateWebhookBody }): Promise<unknown> {
    return this.send(OPERATIONS.updateWebhook, args);
  }
}
