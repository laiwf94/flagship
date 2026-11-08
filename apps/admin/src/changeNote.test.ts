import { describe, expect, it } from 'vitest';
import { checkNote, MAX_LINK, MAX_REASON, noteErrorsOf, policyOf } from './changeNote';

const none = { requireReason: false, requireLink: false };
const both = { requireReason: true, requireLink: true };

describe('checkNote', () => {
  it('sends nothing when nothing is typed and nothing is required', () => {
    expect(checkNote({ reason: '  ', link: '' }, none, 'Production')).toEqual({
      ok: true,
      note: {},
    });
  });

  it('trims what is typed', () => {
    expect(
      checkNote({ reason: ' Roll back INC-42 ', link: ' https://t.example/INC-42 ' }, none, 'P'),
    ).toEqual({ ok: true, note: { reason: 'Roll back INC-42', link: 'https://t.example/INC-42' } });
  });

  it('names the environment for each missing field', () => {
    expect(checkNote({ reason: '', link: '' }, both, 'Production')).toEqual({
      ok: false,
      errors: {
        reason: 'Production needs a reason for every change',
        link: 'Production needs a ticket link for every change',
      },
    });
  });

  it('asks only for the link when the form has no reason field', () => {
    expect(checkNote({ reason: '', link: '' }, both, 'Production', { reason: false })).toEqual({
      ok: false,
      errors: { link: 'Production needs a ticket link for every change' },
    });
    expect(
      checkNote({ reason: 'ignored', link: 'https://t.example/1' }, both, 'P', { reason: false }),
    ).toEqual({ ok: true, note: { link: 'https://t.example/1' } });
  });

  it('refuses links that are not http or https, and overlong values', () => {
    for (const link of ['INC-42', 'javascript:alert(1)', 'ftp://t.example/1', 'https://']) {
      const r = checkNote({ reason: '', link }, none, 'P');
      expect(r.ok, link).toBe(false);
    }
    expect(checkNote({ reason: 'x'.repeat(MAX_REASON + 1), link: '' }, none, 'P')).toEqual({
      ok: false,
      errors: { reason: `Keep it under ${MAX_REASON} characters` },
    });
    const long = `https://t.example/${'a'.repeat(MAX_LINK)}`;
    expect(checkNote({ reason: '', link: long }, none, 'P').ok).toBe(false);
    expect(
      checkNote({ reason: 'x'.repeat(MAX_REASON), link: 'http://t.example' }, none, 'P').ok,
    ).toBe(true);
  });

  it('encodes a link with characters a header cannot carry', () => {
    expect(
      checkNote({ reason: '', link: 'https://tracker.example/ticket/café' }, none, 'P'),
    ).toEqual({
      ok: true,
      note: { link: 'https://tracker.example/ticket/caf%C3%A9' },
    });
  });
});

describe('policyOf', () => {
  it('reads the environment and treats missing settings as off', () => {
    const project = {
      key: 'p',
      name: 'P',
      environments: [
        { key: 'production', name: 'Production', requireReason: true, requireLink: false },
        { key: 'development', name: 'Development' },
      ],
    };
    expect(policyOf(project, 'production')).toEqual({ requireReason: true, requireLink: false });
    expect(policyOf(project, 'development')).toEqual(none);
    expect(policyOf(project, 'missing')).toEqual(none);
  });
});

describe('noteErrorsOf', () => {
  it('maps the header paths to fields and ignores the rest', () => {
    expect(
      noteErrorsOf([
        { path: 'header.flagship-reason', message: 'required in production' },
        { path: 'header.flagship-link', message: 'required in production' },
        { path: 'rules[0]', message: 'bad' },
      ]),
    ).toEqual({
      reason: 'Reason required in production',
      link: 'Ticket link required in production',
    });
    expect(noteErrorsOf([])).toEqual({});
  });
});
