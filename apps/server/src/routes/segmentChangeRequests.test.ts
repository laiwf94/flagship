import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp, type TestApp } from '../../test/app.js';
import { PASSWORD, signIn, userWithRole, type Client } from '../../test/session.js';

let t: TestApp;
let admin: Client;
let alice: Client;
let bob: Client;
let carol: Client;

const P = '/api/projects/default';
const CR = `${P}/change-requests`;
const segments = (env = 'production') => `${P}/environments/${env}/segments`;
const propose = (key: string, env = 'production') => `${segments(env)}/${key}/change-requests`;

interface Content {
  name: string;
  description: string;
  included: string[];
  excluded: string[];
  rules: unknown[];
}

const staffRule = {
  id: 'staff',
  clauses: [{ attribute: 'email', operator: 'endsWith', values: ['@acme.com'] }],
};

const content = (over: Partial<Content> = {}): Content => ({
  name: 'Beta testers',
  description: '',
  included: ['u1'],
  excluded: [],
  rules: [],
  ...over,
});

/** The live segment's version and content, or version 0 and null when there is none. */
async function live(
  key: string,
  env = 'production',
): Promise<{ version: number; content: Content | null }> {
  const res = await alice.request('GET', `${segments(env)}/${key}`);
  if (res.statusCode === 404) return { version: 0, content: null };
  expect(res.statusCode, res.body).toBe(200);
  const s = res.json();
  return {
    version: s.version,
    content: {
      name: s.name,
      description: s.description,
      included: s.included,
      excluded: s.excluded,
      rules: s.rules,
    },
  };
}

/** Proposes `segment` (null to delete) on top of the live segment `key`, as `as`. */
async function open(key: string, segment: Content | null, as: Client = alice, title?: string) {
  const { version } = await live(key);
  const res = await as.request('POST', propose(key), {
    baseVersion: version,
    title: title ?? `change ${key}`,
    segment,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

async function approve(as: Client, id: string, revision = 1) {
  const res = await as.request('POST', `${CR}/${id}/reviews`, { decision: 'approve', revision });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

async function apply(id: string, revision = 1) {
  return alice.request('POST', `${CR}/${id}/apply`, { revision });
}

/** Opens, approves (as bob) and applies a change, for setting up live state. */
async function land(key: string, segment: Content | null) {
  const cr = await open(key, segment, carol, `land ${key}`);
  await approve(bob, cr.id);
  const res = await apply(cr.id);
  expect(res.statusCode, res.body).toBe(200);
}

beforeAll(async () => {
  t = await testApp({ bootstrapAdmin: { email: 'root@example.com', password: PASSWORD } });
  admin = await signIn(t.app.server, 'root@example.com');
  alice = await userWithRole(t.app.server, t.db, 'alice@example.com', 'editor');
  bob = await userWithRole(t.app.server, t.db, 'bob@example.com', 'editor');
  carol = await userWithRole(t.app.server, t.db, 'carol@example.com', 'editor');
  // A segment a flag depends on, set up before production is protected.
  const used = await alice.request('POST', segments(), { key: 'used', ...content() });
  expect(used.statusCode, used.body).toBe(201);
  const flag = await alice.request('POST', `${P}/flags`, {
    key: 'gated',
    name: 'gated',
    type: 'boolean',
  });
  expect(flag.statusCode, flag.body).toBe(201);
  const targeting = await alice.request('PUT', `${P}/flags/gated/environments/production`, {
    version: 1,
    enabled: true,
    offVariant: 'off',
    prerequisites: [],
    rules: [
      {
        id: 'used',
        clauses: [{ operator: 'inSegment', segments: ['used'] }],
        serve: { variant: 'on' },
      },
    ],
    fallthrough: { variant: 'off' },
  });
  expect(targeting.statusCode, targeting.body).toBe(200);
  const protect = await admin.request('PUT', `${P}/environments/production/approvals`, {
    requiredApprovals: 1,
  });
  expect(protect.statusCode, protect.body).toBe(200);
});
afterAll(() => t.close());

describe('direct segment writes', () => {
  it('are refused in a protected environment and allowed elsewhere', async () => {
    const created = await alice.request('POST', segments(), { key: 'direct', ...content() });
    expect(created.statusCode).toBe(403);
    expect(created.json().error.message).toBe(
      'production is protected: segment changes go through an approved change request',
    );
    const updated = await alice.request('PUT', `${segments()}/used`, {
      version: 1,
      ...content({ included: ['u2'] }),
    });
    expect(updated.statusCode).toBe(403);
    const deleted = await alice.request('DELETE', `${segments()}/used?version=1`);
    expect(deleted.statusCode).toBe(403);
    expect(await live('used')).toEqual({ version: 1, content: content() });

    const dev = await alice.request('POST', segments('development'), {
      key: 'direct',
      ...content(),
    });
    expect(dev.statusCode, dev.body).toBe(201);
    const devUpdate = await alice.request('PUT', `${segments('development')}/direct`, {
      version: 1,
      ...content({ included: ['u2'] }),
    });
    expect(devUpdate.statusCode, devUpdate.body).toBe(200);
    // Version 0 means "no segment" inside; to an edit or delete it is just out of date.
    const zero = await alice.request('PUT', `${segments('development')}/direct`, {
      version: 0,
      ...content(),
    });
    expect(zero.statusCode).toBe(409);
    expect(zero.json().error.details).toEqual({ currentVersion: 2 });
    const zeroGhost = await alice.request('DELETE', `${segments('development')}/ghost?version=0`);
    expect(zeroGhost.statusCode).toBe(404);
  });
});

describe('segment change requests', () => {
  it('create, edit and delete a segment through review, recording each step', async () => {
    const created = await open('beta', content({ rules: [staffRule] }));
    expect(created).toMatchObject({
      target: 'segment',
      segment: 'beta',
      flag: null,
      environment: 'production',
      baseVersion: 0,
      base: null,
      status: 'open',
      live: { version: 0, stale: false, conflicts: [] },
      canApply: false,
    });
    expect(created.diff).toEqual([
      { path: '', op: 'added', after: content({ rules: [staffRule] }) },
    ]);
    const self = await alice.request('POST', `${CR}/${created.id}/reviews`, {
      decision: 'approve',
      revision: 1,
    });
    expect(self.statusCode).toBe(403);
    expect((await apply(created.id)).statusCode).toBe(409);
    expect((await approve(bob, created.id)).canApply).toBe(true);
    const applied = await apply(created.id);
    expect(applied.statusCode, applied.body).toBe(200);
    expect(applied.json()).toMatchObject({ status: 'applied', finishedBy: 'alice', live: null });
    expect(await live('beta')).toEqual({ version: 1, content: content({ rules: [staffRule] }) });
    const ruleset = (await alice.request('GET', `${P}/environments/production/ruleset`)).json();
    expect(ruleset.segments.beta).toEqual({
      key: 'beta',
      included: ['u1'],
      excluded: [],
      rules: [staffRule],
      version: 1,
    });

    const edit = await open('beta', content({ included: ['u1', 'u2'], rules: [staffRule] }));
    expect(edit.diff).toEqual([{ path: 'included[1]', op: 'added', after: 'u2' }]);
    await approve(bob, edit.id);
    expect((await apply(edit.id)).statusCode).toBe(200);
    expect((await live('beta')).version).toBe(2);

    const removal = await open('beta', null);
    expect(removal.diff).toEqual([
      { path: '', op: 'removed', before: content({ included: ['u1', 'u2'], rules: [staffRule] }) },
    ]);
    await approve(bob, removal.id);
    expect((await apply(removal.id)).statusCode).toBe(200);
    expect(await live('beta')).toEqual({ version: 0, content: null });

    const history = (await alice.request('GET', `${P}/audit?segment=beta&limit=50`)).json();
    expect(history.entries.map((e: { action: string }) => e.action).reverse()).toEqual([
      'segment.change_request.open',
      'segment.change_request.approve',
      'segment.change_request.apply',
      'segment.change_request.open',
      'segment.change_request.approve',
      'segment.change_request.apply',
      'segment.change_request.open',
      'segment.change_request.approve',
      'segment.change_request.apply',
    ]);
  });

  it('refuses proposals that are stale, empty, unknown or would break the ruleset', async () => {
    const stale = await alice.request('POST', propose('used'), {
      baseVersion: 0,
      title: 'stale',
      segment: content({ name: 'Renamed' }),
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.details).toEqual({ currentVersion: 1 });
    const same = await alice.request('POST', propose('used'), {
      baseVersion: 1,
      title: 'same',
      segment: content(),
    });
    expect(same.statusCode).toBe(400);
    const ghost = await alice.request('POST', propose('ghost'), {
      baseVersion: 3,
      title: 'ghost',
      segment: content(),
    });
    expect(ghost.statusCode).toBe(404);
    const nothing = await alice.request('POST', propose('ghost'), {
      baseVersion: 0,
      title: 'nothing',
      segment: null,
    });
    expect(nothing.statusCode).toBe(400);
    // The flag "gated" targets this segment, so deleting it would leave the ruleset invalid.
    const inUse = await alice.request('POST', propose('used'), {
      baseVersion: 1,
      title: 'drop used',
      segment: null,
    });
    expect(inUse.statusCode).toBe(400);
    expect(inUse.json().error.details[0].message).toBe('unknown segment "used"');
    const badRule = await alice.request('POST', propose('used'), {
      baseVersion: 1,
      title: 'bad',
      segment: content({
        rules: [{ id: 'r', clauses: [{ attribute: 'email', operator: 'matches', values: ['('] }] }],
      }),
    });
    expect(badRule.statusCode).toBe(400);
    const extra = await alice.request('POST', propose('used'), {
      baseVersion: 1,
      title: 'extra',
      segment: { ...content(), key: 'used' },
    });
    expect(extra.statusCode).toBe(400);
  });

  it('detects a stale request, merges members as sets and asks for review again', async () => {
    await land('members', content({ included: ['a', 'b'], rules: [staffRule] }));
    const mine = await open('members', content({ included: ['a', 'b', 'mine'], excluded: ['x'] }));
    await approve(bob, mine.id);
    await land('members', content({ included: ['b', 'theirs'], rules: [staffRule] }));

    const view = (await alice.request('GET', `${CR}/${mine.id}`)).json();
    expect(view.live).toMatchObject({ version: 2, stale: true, conflicts: [] });
    expect(view.live.changedSinceBase).toEqual([
      { path: 'included[0]', op: 'changed', before: 'a', after: 'b' },
      { path: 'included[1]', op: 'changed', before: 'b', after: 'theirs' },
    ]);
    expect(view.canApply).toBe(false);
    const listed = (await alice.request('GET', `${CR}?segment=members&status=open`)).json();
    expect(listed.changeRequests).toMatchObject([
      { id: mine.id, target: 'segment', segment: 'members', flag: null, stale: true },
    ]);

    const refused = await apply(mine.id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toBe(
      'segment "members" in production changed since this request was proposed; rebase it and have it reviewed again',
    );

    const rebased = await alice.request('POST', `${CR}/${mine.id}/rebase`, { revision: 1 });
    expect(rebased.statusCode, rebased.body).toBe(200);
    expect(rebased.json()).toMatchObject({
      revision: 2,
      baseVersion: 2,
      live: { stale: false },
      canApply: false,
      approvals: { approvedBy: [] },
    });
    // Theirs removed "a" and added "theirs", mine added "mine" and "x" and
    // dropped the rule: all of it survives.
    expect(rebased.json().proposed).toEqual(
      content({ included: ['b', 'theirs', 'mine'], excluded: ['x'], rules: [] }),
    );
    await approve(bob, mine.id, 2);
    expect((await apply(mine.id, 2)).statusCode).toBe(200);
    expect((await live('members')).content).toEqual(
      content({ included: ['b', 'theirs', 'mine'], excluded: ['x'] }),
    );
  });

  it('refuses to rebase a delete over a live edit, and shows all three sides', async () => {
    await land('doomed', content());
    const drop = await open('doomed', null);
    await land('doomed', content({ included: ['u1', 'u9'] }));
    const res = await alice.request('POST', `${CR}/${drop.id}/rebase`, { revision: 1 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details.conflicts).toEqual([
      {
        path: 'segment',
        base: content(),
        ours: null,
        theirs: content({ included: ['u1', 'u9'] }),
      },
    ]);
    const view = (await alice.request('GET', `${CR}/${drop.id}`)).json();
    expect(view.live.conflicts).toHaveLength(1);
  });

  it('refuses a rebase when everything proposed is already live', async () => {
    await land('twice', content());
    const first = await open('twice', content({ name: 'Same' }));
    await land('twice', content({ name: 'Same' }));
    const res = await alice.request('POST', `${CR}/${first.id}/rebase`, { revision: 1 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe(
      'everything this request proposes is already live; close it',
    );
  });

  it('notices a segment deleted and created again at the same version', async () => {
    await land('phoenix', content());
    const edit = await open('phoenix', content({ name: 'Edited' }));
    await approve(bob, edit.id);
    // A flag doesn't use it, so it can go and come back as version 1 again.
    await land('phoenix', null);
    await land('phoenix', content({ included: ['new'] }));
    const view = (await alice.request('GET', `${CR}/${edit.id}`)).json();
    expect(view.live).toMatchObject({ version: 1, stale: true });
    const listed = (await alice.request('GET', `${CR}?segment=phoenix&status=open`)).json();
    expect(listed.changeRequests[0].stale).toBe(true);
    expect((await apply(edit.id)).statusCode).toBe(409);
    expect((await live('phoenix')).content).toEqual(content({ included: ['new'] }));
  });

  it('gives one winner when two requests from the same base are applied at once', async () => {
    await land('race', content());
    const one = await open('race', content({ included: ['one'] }));
    const two = await open('race', content({ included: ['two'] }), carol);
    await approve(bob, one.id);
    await approve(bob, two.id);
    const results = await Promise.all([apply(one.id), apply(two.id)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await live('race')).version).toBe(2);
  });

  it('gives one winner when the same request is applied twice at once', async () => {
    const cr = await open('double', content());
    await approve(bob, cr.id);
    const results = await Promise.all([apply(cr.id), apply(cr.id)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await live('double')).version).toBe(1);
  });

  it('refuses a request whose segment was created by someone else first', async () => {
    const mine = await open('claimed', content());
    await approve(bob, mine.id);
    await land('claimed', content({ name: 'Theirs' }));
    const res = await apply(mine.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details.conflicts).toEqual([
      { path: 'segment', base: null, ours: content(), theirs: content({ name: 'Theirs' }) },
    ]);
  });

  it('can be reviewed, closed and listed next to flag requests', async () => {
    const cr = await open('closing', content());
    const comment = await bob.request('POST', `${CR}/${cr.id}/reviews`, {
      decision: 'request_changes',
      body: 'not yet',
      revision: 1,
    });
    expect(comment.statusCode).toBe(201);
    const closed = await alice.request('POST', `${CR}/${cr.id}/close`, { reason: 'later' });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().status).toBe('closed');
    const actions = (await alice.request('GET', `${P}/audit?segment=closing`))
      .json()
      .entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual([
      'segment.change_request.close',
      'segment.change_request.request_changes',
      'segment.change_request.open',
    ]);

    const flagCr = await alice.request(
      'POST',
      `${P}/flags/gated/environments/production/change-requests`,
      {
        baseVersion: 2,
        title: 'turn off gated',
        enabled: false,
        offVariant: 'off',
        prerequisites: [],
        rules: [
          {
            id: 'used',
            clauses: [{ operator: 'inSegment', segments: ['used'] }],
            serve: { variant: 'on' },
          },
        ],
        fallthrough: { variant: 'off' },
      },
    );
    expect(flagCr.statusCode, flagCr.body).toBe(201);
    expect(flagCr.json()).toMatchObject({ target: 'flag', flag: 'gated', segment: null });
    const all = (await alice.request('GET', `${CR}?status=open&limit=200`)).json().changeRequests;
    expect(all[0]).toMatchObject({ target: 'flag', flag: 'gated', segment: null, stale: false });
    expect(all.some((r: { segment: string | null }) => r.segment === 'doomed')).toBe(true);
    const byFlag = (await alice.request('GET', `${CR}?flag=gated`)).json().changeRequests;
    expect(byFlag).toHaveLength(1);
  });
});
