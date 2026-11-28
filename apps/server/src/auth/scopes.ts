import type { Role } from '../db/schema.js';

/**
 * What an API token may do, one resource and action per scope. Every route
 * under /api declares the one scope it needs, or that it is for signed-in
 * sessions only; a token can only reach routes whose scope it holds.
 */
export const SCOPES = [
  'flags:read',
  'flags:write',
  'segments:read',
  'segments:write',
  'change-requests:read',
  'change-requests:write',
  'experiments:read',
  'experiments:write',
  'audit:read',
  'audit:restore',
  'projects:read',
  'projects:write',
  'sdk-keys:read',
  'sdk-keys:write',
  'webhooks:read',
  'webhooks:write',
  'code-references:write',
] as const;

export type Scope = (typeof SCOPES)[number];

/**
 * The least role whose routes a scope reaches. A user can only create tokens
 * with scopes their role allows, and a request is still checked against the
 * owner's current role, so demoting a user narrows their tokens at once.
 */
export const SCOPE_ROLE: Record<Scope, Role> = {
  'flags:read': 'viewer',
  'flags:write': 'editor',
  'segments:read': 'viewer',
  'segments:write': 'editor',
  'change-requests:read': 'viewer',
  'change-requests:write': 'editor',
  'experiments:read': 'viewer',
  'experiments:write': 'editor',
  'audit:read': 'viewer',
  'audit:restore': 'editor',
  'projects:read': 'viewer',
  'projects:write': 'admin',
  'sdk-keys:read': 'admin',
  'sdk-keys:write': 'admin',
  'webhooks:read': 'admin',
  'webhooks:write': 'admin',
  'code-references:write': 'editor',
};

export function isScope(value: string): value is Scope {
  return (SCOPES as readonly string[]).includes(value);
}

/** Read scopes may use project-level routes from an environment-restricted token. */
export function isReadScope(scope: Scope): boolean {
  return scope.endsWith(':read');
}
