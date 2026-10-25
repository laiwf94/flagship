import type { FastifyRequest } from 'fastify';
import type { KeyKind } from '../db/schema.js';
import { AppError } from '../errors.js';
import type { KeyAuthenticator, KeyIdentity } from '../services/apikeys.js';

/**
 * Authenticates an SDK request by API key. The key comes from
 * `Authorization: Bearer`, or from `?key=` where `allowQuery` is set: browser
 * EventSource can't send headers, and only client keys (public by design)
 * are accepted that way.
 */
export async function authenticateSdk(
  keys: KeyAuthenticator,
  request: FastifyRequest,
  allowed: readonly KeyKind[],
  allowQuery = false,
): Promise<KeyIdentity> {
  const header = request.headers.authorization;
  let raw: string | undefined;
  if (typeof header === 'string' && header.startsWith('Bearer ')) raw = header.slice(7).trim();
  else if (allowQuery) {
    const q = (request.query as Record<string, unknown> | undefined)?.key;
    if (typeof q === 'string' && q.startsWith('fsc_')) raw = q;
  }
  if (raw === undefined) throw new AppError('unauthenticated', 'an SDK key is required');
  const identity = await keys.authenticate(raw);
  if (identity === undefined) throw new AppError('unauthenticated', 'unknown or revoked SDK key');
  if (!allowed.includes(identity.kind)) {
    throw new AppError(
      'permission_denied',
      identity.kind === 'client'
        ? 'this endpoint needs a server key; client keys only get evaluated values'
        : 'this endpoint needs a client key',
    );
  }
  return identity;
}
