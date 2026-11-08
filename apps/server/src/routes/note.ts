import type { FastifyRequest } from 'fastify';
import { currentUser } from '../auth/guard.js';
import { AppError, type FieldIssue } from '../errors.js';
import type { Actor, ChangeNote } from '../services/audit.js';

/**
 * Every write takes an optional reason and ticket link in these headers, so
 * no request body has to change shape and a DELETE can carry them too. The
 * reason is percent-encoded UTF-8 (encodeURIComponent), since a header value
 * is otherwise limited to Latin-1. Both end up on the audit entry.
 */
export const REASON_HEADER = 'flagship-reason';
export const LINK_HEADER = 'flagship-link';

export const MAX_REASON = 1000;
export const MAX_LINK = 2000;

function header(request: FastifyRequest, name: string): string | undefined {
  const v = request.headers[name];
  return Array.isArray(v) ? v.join(',') : v;
}

/** Reads the reason and link headers, or throws invalid_argument. Undefined when neither is given. */
export function changeNote(request: FastifyRequest): ChangeNote | undefined {
  const rawReason = header(request, REASON_HEADER);
  const rawLink = header(request, LINK_HEADER);
  if (rawReason === undefined && rawLink === undefined) return undefined;
  const issues: FieldIssue[] = [];
  let reason: string | null = null;
  if (rawReason !== undefined) {
    let text: string | undefined;
    try {
      text = decodeURIComponent(rawReason).trim();
    } catch {
      issues.push({ path: `header.${REASON_HEADER}`, message: 'must be percent-encoded UTF-8' });
    }
    if (text !== undefined) {
      if (text.length === 0) issues.push({ path: `header.${REASON_HEADER}`, message: 'is empty' });
      else if (text.length > MAX_REASON) {
        issues.push({
          path: `header.${REASON_HEADER}`,
          message: `must be at most ${MAX_REASON} characters`,
        });
      } else reason = text;
    }
  }
  let link: string | null = null;
  if (rawLink !== undefined) {
    const text = rawLink.trim();
    const url = URL.parse(text);
    const ok =
      url !== null &&
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      text.length <= MAX_LINK;
    if (ok) link = text;
    else {
      issues.push({
        path: `header.${LINK_HEADER}`,
        message: `must be an http or https URL of at most ${MAX_LINK} characters`,
      });
    }
  }
  if (issues.length > 0) throw new AppError('invalid_argument', 'invalid change note', issues);
  return { reason, link };
}

/** The signed-in user as the actor of a change, with the reason and link they gave. */
export function actorOf(request: FastifyRequest): Actor {
  const user = currentUser(request);
  return { id: user.id, name: user.name, note: changeNote(request) };
}
