import type { ChangeNote, Project } from './api';

/** What an environment asks every change to carry. */
export interface NotePolicy {
  requireReason: boolean;
  requireLink: boolean;
}

/** The reason and link fields as typed. */
export interface NoteDraft {
  reason: string;
  link: string;
}

export interface NoteErrors {
  reason?: string;
  link?: string;
}

export const EMPTY_NOTE: NoteDraft = { reason: '', link: '' };

/** The server's limits, so the form says no before the server does. */
export const MAX_REASON = 1000;
export const MAX_LINK = 2000;

export function policyOf(project: Project, env: string): NotePolicy {
  const e = project.environments.find((x) => x.key === env);
  return { requireReason: e?.requireReason === true, requireLink: e?.requireLink === true };
}

/**
 * Checks a draft against the environment's policy. With `reason: false` the
 * form has no reason field, because something else stands in for it (a change
 * request's title), so only the link is checked.
 */
export function checkNote(
  draft: NoteDraft,
  policy: NotePolicy,
  envName: string,
  fields: { reason: boolean } = { reason: true },
): { ok: true; note: ChangeNote } | { ok: false; errors: NoteErrors } {
  const errors: NoteErrors = {};
  const note: ChangeNote = {};
  const reason = draft.reason.trim();
  if (fields.reason) {
    if (reason === '') {
      if (policy.requireReason) errors.reason = `${envName} needs a reason for every change`;
    } else if (reason.length > MAX_REASON) {
      errors.reason = `Keep it under ${MAX_REASON} characters`;
    } else note.reason = reason;
  }
  const link = draft.link.trim();
  if (link === '') {
    if (policy.requireLink) errors.link = `${envName} needs a ticket link for every change`;
  } else {
    const url = parseUrl(link);
    if (url === null || (url.protocol !== 'https:' && url.protocol !== 'http:'))
      errors.link = 'Enter a link that starts with https://';
    else if (link.length > MAX_LINK) errors.link = `Keep it under ${MAX_LINK} characters`;
    // A header carries only Latin-1, so a link with other characters goes as its encoded form.
    else note.link = /^[\x21-\x7e]+$/.test(link) ? link : url.href;
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, note };
}

function parseUrl(text: string): URL | null {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

/** The server's word on a missing or malformed note, as field errors. */
export function noteErrorsOf(issues: { path: string; message: string }[]): NoteErrors {
  const out: NoteErrors = {};
  for (const i of issues) {
    if (i.path === 'header.flagship-reason') out.reason ??= `Reason ${i.message}`;
    if (i.path === 'header.flagship-link') out.link ??= `Ticket link ${i.message}`;
  }
  return out;
}
