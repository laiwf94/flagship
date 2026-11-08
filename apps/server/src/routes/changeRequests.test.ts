import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp, type TestApp } from '../../test/app.js';
import { PASSWORD, signIn, userWithRole, type Client } from '../../test/session.js';

let t: TestApp;
let admin: Client;
let alice: Client;
let bob: Client;
let carol: Client;
let viewer: Client;

const P = '/api/projects/default';
const CR = `${P}/change-requests`;
const target = (flag: string, env = 'production') => `${P}/flags/${flag}/environments/${env}`;
const propose = (flag: string, env = 'production') => `${target(flag, env)}/change-requests`;

const staff = {
  id: 'staff',
  clauses: [{ attribute: 'email', operator: 'endsWith', values: ['@acme.com'] }],
  serve: { variant: 'on' },
};
const beta = {
  id: 'beta',
  clauses: [{ attribute: 'groups', operator: 'in', values: ['beta'] }],
  serve: { variant: 'on' },
};

interface Targeting {
  version: number;
  enabled: boolean;
  offVariant: string;
  prerequisites: unknown[];
  rules: unknown[];
  fallthrough: unknown;
}

async function targeting(flag: string, env = 'production'): Promise<Targeting> {
  const res = await alice.request('GET', `${P}/flags/${flag}`);
  expect(res.statusCode, res.body).toBe(200);
  const e = res.json().environments[env];
  return {
    version: e.version,
    enabled: e.enabled,
    offVariant: e.offVariant,
    prerequisites: e.prerequisites,
    rules: e.rules,
    fallthrough: e.fallthrough,
  };
}

async function flag(key: string) {
  const res = await alice.request('POST', `${P}/flags`, { key, name: key, type: 'boolean' });
  expect(res.statusCode, res.body).toBe(201);
}

/** Proposes `change` on top of the live production targeting of `key`, as alice. */
async function open(key: string, change: Partial<Targeting>, title = `change ${key}`) {
  const { version, ...live } = await targeting(key);
  const res = await alice.request('POST', propose(key), {
    baseVersion: version,
    title,
    ...live,
    ...change,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

async function approve(as: Client, id: string, revision = 1) {
  const res = await as.request('POST', `${CR}/${id}/reviews`, { decision: 'approve', revision });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

async function setApprovals(env: string, requiredApprovals: number) {
  const res = await admin.request('PUT', `${P}/environments/${env}/approvals`, {
    requiredApprovals,
  });
  expect(res.statusCode, res.body).toBe(200);
}

beforeAll(async () => {
  t = await testApp({ bootstrapAdmin: { email: 'root@example.com', password: PASSWORD } });
  admin = await signIn(t.app.server, 'root@example.com');
  alice = await userWithRole(t.app.server, t.db, 'alice@example.com', 'editor');
  bob = await userWithRole(t.app.server, t.db, 'bob@example.com', 'editor');
  carol = await userWithRole(t.app.server, t.db, 'carol@example.com', 'editor');
  viewer = await userWithRole(t.app.server, t.db, 'vera@example.com', 'viewer');
  for (const key of [
    'checkout',
    'stale',
    'conflict',
    'race',
    'rivals',
    'blocked',
    'closing',
    'guarded',
    'ordered',
  ]) {
    await flag(key);
  }
});
afterAll(() => t.close());

describe('protected environments', () => {
  it('lets only admins set the approvals an environment needs, and lists the setting', async () => {
    const denied = await alice.request('PUT', `${P}/environments/production/approvals`, {
      requiredApprovals: 1,
    });
    expect(denied.statusCode).toBe(403);
    const tooMany = await admin.request('PUT', `${P}/environments/production/approvals`, {
      requiredApprovals: 6,
    });
    expect(tooMany.statusCode).toBe(400);
    await setApprovals('production', 1);
    const projects = (await viewer.request('GET', '/api/projects')).json().projects;
    expect(projects[0].environments).toEqual([
      {
        key: 'development',
        name: 'Development',
        requiredApprovals: 0,
        requireReason: false,
        requireLink: false,
      },
      {
        key: 'production',
        name: 'Production',
        requiredApprovals: 1,
        requireReason: false,
        requireLink: false,
      },
    ]);
    const audit = await t.db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'environment.approvals')
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({
      target_key: 'production',
      before: { requiredApprovals: 0 },
      after: { requiredApprovals: 1 },
    });
  });

  it('refuses direct targeting edits and scheduled changes there, but not elsewhere', async () => {
    const { version, ...live } = await targeting('guarded');
    const direct = await alice.request('PUT', target('guarded'), {
      version,
      ...live,
      enabled: true,
    });
    expect(direct.statusCode).toBe(403);
    expect(direct.json().error).toMatchObject({
      code: 'permission_denied',
      message: 'production is protected: targeting changes go through an approved change request',
      details: { requiredApprovals: 1 },
    });
    const schedule = await alice.request('POST', `${target('guarded')}/schedules`, {
      runAt: new Date(Date.now() + 3_600_000).toISOString(),
      change: { enabled: true },
    });
    expect(schedule.statusCode).toBe(403);
    expect((await targeting('guarded')).version).toBe(version);

    const dev = await targeting('guarded', 'development');
    const { version: devVersion, ...devLive } = dev;
    const unprotected = await alice.request('PUT', target('guarded', 'development'), {
      version: devVersion,
      ...devLive,
      enabled: true,
    });
    expect(unprotected.statusCode, unprotected.body).toBe(200);
  });

  it('keeps the kill switch working there, so an incident never waits for a review', async () => {
    const res = await alice.request('POST', `${target('guarded')}/kill-switch`, { enabled: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().environments.production.enabled).toBe(true);
  });
});

describe('change requests', () => {
  it('goes from proposal through approval to the live targeting, recording each step', async () => {
    const before = await targeting('checkout');
    const created = await open('checkout', { enabled: true, rules: [staff] }, 'Staff first');
    expect(created).toMatchObject({
      flag: 'checkout',
      environment: 'production',
      title: 'Staff first',
      status: 'open',
      revision: 1,
      author: 'alice',
      authorId: (await alice.request('GET', '/api/session')).json().user.id,
      baseVersion: before.version,
      approvals: { required: 1, approvedBy: [], changesRequestedBy: [] },
      live: { version: before.version, stale: false, conflicts: [], changedSinceBase: [] },
      canApply: false,
      reviews: [],
    });
    expect(created.diff).toEqual([
      { path: 'enabled', op: 'changed', before: false, after: true },
      { path: 'rules[0]', op: 'added', after: staff },
    ]);
    // Proposing changes nothing live.
    expect(await targeting('checkout')).toEqual(before);

    const notYet = await alice.request('POST', `${CR}/${created.id}/apply`, { revision: 1 });
    expect(notYet.statusCode).toBe(409);
    expect(notYet.json().error).toMatchObject({
      code: 'failed_precondition',
      message: 'this change request needs 1 approval, it has 0',
    });

    const commented = await bob.request('POST', `${CR}/${created.id}/reviews`, {
      decision: 'comment',
      body: 'Does this include contractors?',
      revision: 1,
    });
    expect(commented.statusCode).toBe(201);
    const reply = await alice.request('POST', `${CR}/${created.id}/reviews`, {
      decision: 'comment',
      body: 'No, only @acme.com.',
      revision: 1,
    });
    expect(reply.statusCode).toBe(201);
    const approved = await approve(bob, created.id);
    expect(approved).toMatchObject({
      approvals: { approvedBy: ['bob'] },
      canApply: true,
    });
    expect(approved.reviews.map((r: { reviewer: string; decision: string }) => r.decision)).toEqual(
      ['comment', 'comment', 'approve'],
    );

    // The author can apply once someone else approved.
    const applied = await alice.request('POST', `${CR}/${created.id}/apply`, { revision: 1 });
    expect(applied.statusCode, applied.body).toBe(200);
    expect(applied.json()).toMatchObject({
      status: 'applied',
      finishedBy: 'alice',
      live: null,
      canApply: false,
    });
    const after = await targeting('checkout');
    expect(after).toMatchObject({ version: before.version + 1, enabled: true, rules: [staff] });

    const actions = await t.db
      .selectFrom('audit_log')
      .select(['action', 'actor_name'])
      .where('target_key', '=', 'checkout')
      .where('action', 'like', 'flag.change_request.%')
      .orderBy('id')
      .execute();
    expect(actions).toEqual([
      { action: 'flag.change_request.open', actor_name: 'alice' },
      { action: 'flag.change_request.approve', actor_name: 'bob' },
      { action: 'flag.change_request.apply', actor_name: 'alice' },
    ]);
    const patch = await t.db
      .selectFrom('ruleset_changes')
      .innerJoin('environments', 'environments.id', 'ruleset_changes.environment_id')
      .select(['ruleset_changes.key', 'ruleset_changes.value'])
      .where('environments.key', '=', 'production')
      .orderBy('ruleset_changes.version', 'desc')
      .executeTakeFirstOrThrow();
    expect(patch).toMatchObject({ key: 'checkout', value: { enabled: true } });

    const again = await bob.request('POST', `${CR}/${created.id}/apply`, { revision: 1 });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.message).toBe('change request is applied');
  });

  it('refuses self-approval and self-rejection, viewers, and bad input', async () => {
    const cr = await open('blocked', { enabled: true });
    const self = await alice.request('POST', `${CR}/${cr.id}/reviews`, {
      decision: 'approve',
      revision: 1,
    });
    expect(self.statusCode).toBe(403);
    expect(self.json().error.message).toBe('authors cannot approve their own change request');
    const selfReject = await alice.request('POST', `${CR}/${cr.id}/reviews`, {
      decision: 'request_changes',
      revision: 1,
    });
    expect(selfReject.statusCode).toBe(403);
    const byViewer = await viewer.request('POST', `${CR}/${cr.id}/reviews`, {
      decision: 'approve',
      revision: 1,
    });
    expect(byViewer.statusCode).toBe(403);
    const empty = await bob.request('POST', `${CR}/${cr.id}/reviews`, {
      decision: 'comment',
      body: '  ',
      revision: 1,
    });
    expect(empty.statusCode).toBe(400);
    const wrongRevision = await bob.request('POST', `${CR}/${cr.id}/reviews`, {
      decision: 'approve',
      revision: 2,
    });
    expect(wrongRevision.statusCode).toBe(409);
    expect(wrongRevision.json().error).toMatchObject({
      code: 'version_conflict',
      details: { currentRevision: 1 },
    });

    const { version, ...live } = await targeting('blocked');
    const noop = await alice.request('POST', propose('blocked'), {
      baseVersion: version,
      title: 'nothing',
      ...live,
    });
    expect(noop.statusCode).toBe(400);
    const old = await alice.request('POST', propose('blocked'), {
      baseVersion: version + 5,
      title: 'old',
      ...live,
      enabled: true,
    });
    expect(old.statusCode).toBe(409);
    expect(old.json().error.details).toEqual({ currentVersion: version });
    const invalid = await alice.request('POST', propose('blocked'), {
      baseVersion: version,
      title: 'bad',
      ...live,
      fallthrough: { variant: 'nope' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.message).toBe(
      'this change would leave the production ruleset invalid',
    );
    const missing = await alice.request('POST', propose('no-such-flag'), {
      baseVersion: 1,
      title: 'x',
      ...live,
    });
    expect(missing.statusCode).toBe(404);
    const byViewerPropose = await viewer.request('POST', propose('blocked'), {
      baseVersion: version,
      title: 'x',
      ...live,
      enabled: true,
    });
    expect(byViewerPropose.statusCode).toBe(403);
    expect(
      (await viewer.request('GET', `${CR}/00000000-0000-4000-8000-000000000000`)).statusCode,
    ).toBe(404);
  });

  it('blocks apply while a reviewer requests changes, until they approve', async () => {
    const cr = await open('blocked', { enabled: true, rules: [beta] }, 'beta group');
    await approve(bob, cr.id);
    const asked = await carol.request('POST', `${CR}/${cr.id}/reviews`, {
      decision: 'request_changes',
      body: 'Ship to staff first',
      revision: 1,
    });
    expect(asked.json()).toMatchObject({
      approvals: { approvedBy: ['bob'], changesRequestedBy: ['carol'] },
      canApply: false,
    });
    const blocked = await alice.request('POST', `${CR}/${cr.id}/apply`, { revision: 1 });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toMatchObject({
      message: 'changes were requested by carol',
      details: { changesRequestedBy: ['carol'] },
    });
    // A comment doesn't change carol's standing decision; an approval does.
    await carol.request('POST', `${CR}/${cr.id}/reviews`, {
      decision: 'comment',
      body: 'Let me check',
      revision: 1,
    });
    expect((await viewer.request('GET', `${CR}/${cr.id}`)).json().canApply).toBe(false);
    const both = await approve(carol, cr.id);
    expect(both.approvals).toEqual({
      required: 1,
      approvedBy: ['bob', 'carol'],
      changesRequestedBy: [],
    });
    const applied = await bob.request('POST', `${CR}/${cr.id}/apply`, { revision: 1 });
    expect(applied.statusCode, applied.body).toBe(200);
  });

  it('needs as many distinct approvers as the environment asks for', async () => {
    await setApprovals('production', 2);
    try {
      const cr = await open('ordered', { enabled: true });
      expect(cr.approvals.required).toBe(2);
      await approve(bob, cr.id);
      // Approving twice is still one approver.
      await approve(bob, cr.id);
      const short = await alice.request('POST', `${CR}/${cr.id}/apply`, { revision: 1 });
      expect(short.statusCode).toBe(409);
      expect(short.json().error.message).toBe('this change request needs 2 approvals, it has 1');
      await approve(carol, cr.id);
      const applied = await alice.request('POST', `${CR}/${cr.id}/apply`, { revision: 1 });
      expect(applied.statusCode, applied.body).toBe(200);
    } finally {
      await setApprovals('production', 1);
    }
  });

  it('gives one winner when the same request is applied twice at once', async () => {
    const cr = await open('race', { enabled: true });
    await approve(bob, cr.id);
    const before = await targeting('race');
    const results = await Promise.all(
      [alice, bob, carol].map((c) => c.request('POST', `${CR}/${cr.id}/apply`, { revision: 1 })),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409, 409]);
    expect((await targeting('race')).version).toBe(before.version + 1);
  });

  it('gives one winner when two requests from the same base are applied at once', async () => {
    const first = await open('rivals', { enabled: true }, 'turn on');
    const second = await open('rivals', { fallthrough: { variant: 'on' } }, 'serve on');
    await approve(bob, first.id);
    await approve(bob, second.id);
    const before = await targeting('rivals');
    const results = await Promise.all([
      alice.request('POST', `${CR}/${first.id}/apply`, { revision: 1 }),
      carol.request('POST', `${CR}/${second.id}/apply`, { revision: 1 }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const loser = results.find((r) => r.statusCode === 409);
    expect(loser?.json().error).toMatchObject({
      code: 'version_conflict',
      details: { currentVersion: before.version + 1, conflicts: [] },
    });
    expect((await targeting('rivals')).version).toBe(before.version + 1);
  });

  it('detects a stale request, rebases it by three-way merge and asks for review again', async () => {
    const cr = await open('stale', { rules: [staff] }, 'staff rule');
    await approve(bob, cr.id);
    // Meanwhile someone else turns the flag on through the kill switch.
    await alice.request('POST', `${target('stale')}/kill-switch`, { enabled: true });
    const live = await targeting('stale');

    const view = (await viewer.request('GET', `${CR}/${cr.id}`)).json();
    expect(view.live).toEqual({
      version: live.version,
      stale: true,
      changedSinceBase: [{ path: 'enabled', op: 'changed', before: false, after: true }],
      conflicts: [],
    });
    expect(view.canApply).toBe(false);
    const listed = (await viewer.request('GET', `${CR}?flag=stale`)).json().changeRequests;
    expect(listed).toEqual([expect.objectContaining({ id: cr.id, stale: true })]);

    const refused = await alice.request('POST', `${CR}/${cr.id}/apply`, { revision: 1 });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toMatch(/rebase it/);
    expect(await targeting('stale')).toEqual(live);

    const rebased = await alice.request('POST', `${CR}/${cr.id}/rebase`, { revision: 1 });
    expect(rebased.statusCode, rebased.body).toBe(200);
    expect(rebased.json()).toMatchObject({
      revision: 2,
      baseVersion: live.version,
      base: { enabled: true, rules: [] },
      proposed: { enabled: true, rules: [staff] },
      approvals: { approvedBy: [], changesRequestedBy: [] },
      live: { stale: false },
      canApply: false,
    });
    expect(rebased.json().diff).toEqual([{ path: 'rules[0]', op: 'added', after: staff }]);
    const upToDate = await alice.request('POST', `${CR}/${cr.id}/rebase`, { revision: 2 });
    expect(upToDate.statusCode).toBe(400);
    const oldApproval = await bob.request('POST', `${CR}/${cr.id}/reviews`, {
      decision: 'approve',
      revision: 1,
    });
    expect(oldApproval.statusCode).toBe(409);
    await approve(bob, cr.id, 2);
    const applied = await alice.request('POST', `${CR}/${cr.id}/apply`, { revision: 2 });
    expect(applied.statusCode, applied.body).toBe(200);
    expect(await targeting('stale')).toMatchObject({ enabled: true, rules: [staff] });
  });

  it('refuses to rebase over a conflicting change and shows all three sides', async () => {
    const cr = await open('conflict', { enabled: true, fallthrough: { variant: 'on' } });
    // Someone else rolls the default rule out to half, through another request.
    const other = await open('conflict', {
      fallthrough: {
        rollout: {
          variants: [
            { variant: 'on', weight: 50_000 },
            { variant: 'off', weight: 50_000 },
          ],
        },
      },
    });
    await approve(bob, other.id);
    expect(
      (await carol.request('POST', `${CR}/${other.id}/apply`, { revision: 1 })).statusCode,
    ).toBe(200);
    const view = (await viewer.request('GET', `${CR}/${cr.id}`)).json();
    expect(view.live.stale).toBe(true);
    expect(view.live.conflicts).toEqual([{ path: 'fallthrough.variant', base: 'off', ours: 'on' }]);
    const rebase = await alice.request('POST', `${CR}/${cr.id}/rebase`, { revision: 1 });
    expect(rebase.statusCode).toBe(409);
    expect(rebase.json().error).toMatchObject({
      code: 'failed_precondition',
      message: 'the proposal and the live targeting both changed one part differently',
    });
    expect(rebase.json().error.details.conflicts).toHaveLength(1);
    expect((await viewer.request('GET', `${CR}/${cr.id}`)).json().revision).toBe(1);
  });

  it('can be closed by its author or an admin, with a reason', async () => {
    const mine = await open('closing', { enabled: true }, 'mine');
    const notYours = await bob.request('POST', `${CR}/${mine.id}/close`, {});
    expect(notYours.statusCode).toBe(403);
    const closed = await alice.request('POST', `${CR}/${mine.id}/close`, {
      reason: 'Superseded',
    });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json()).toMatchObject({
      status: 'closed',
      finishedBy: 'alice',
      live: null,
      reviews: [{ decision: 'comment', body: 'Superseded', reviewer: 'alice' }],
    });
    const late = await bob.request('POST', `${CR}/${mine.id}/reviews`, {
      decision: 'approve',
      revision: 1,
    });
    expect(late.statusCode).toBe(409);
    const second = await open('closing', { enabled: true }, 'second');
    const byAdmin = await admin.request('POST', `${CR}/${second.id}/close`);
    expect(byAdmin.statusCode, byAdmin.body).toBe(200);
    const twice = await admin.request('POST', `${CR}/${second.id}/close`, {});
    expect(twice.statusCode).toBe(409);
  });

  it('refuses a rebase that would leave nothing to change', async () => {
    const cr = await open('closing', { rules: [beta] }, 'beta');
    const same = await open('closing', { rules: [beta] }, 'beta again');
    await approve(bob, same.id);
    await alice.request('POST', `${CR}/${same.id}/apply`, { revision: 1 });
    const rebase = await alice.request('POST', `${CR}/${cr.id}/rebase`, { revision: 1 });
    expect(rebase.statusCode).toBe(409);
    expect(rebase.json().error.message).toBe(
      'everything this request proposes is already live; close it',
    );
  });

  it('lists requests newest first with filters and keyset pages', async () => {
    const all = (await viewer.request('GET', `${CR}?limit=200`)).json();
    expect(all.next).toBeNull();
    const times = all.changeRequests.map((r: { createdAt: string }) => r.createdAt);
    expect([...times].sort().reverse()).toEqual(times);

    const pages: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await viewer.request(
        'GET',
        `${CR}?limit=3${cursor === null ? '' : `&before=${cursor}`}`,
      );
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      pages.push(...body.changeRequests.map((r: { id: string }) => r.id));
      cursor = body.next;
    } while (cursor !== null);
    expect(pages).toEqual(all.changeRequests.map((r: { id: string }) => r.id));

    const open = (await viewer.request('GET', `${CR}?status=open&environment=production`)).json();
    expect(open.changeRequests.length).toBeGreaterThan(0);
    for (const r of open.changeRequests) {
      expect(r).toMatchObject({ status: 'open', environment: 'production' });
      expect(typeof r.stale).toBe('boolean');
    }
    const applied = (await viewer.request('GET', `${CR}?status=applied&flag=checkout`)).json();
    expect(applied.changeRequests).toEqual([
      expect.objectContaining({ flag: 'checkout', status: 'applied', stale: null }),
    ]);
    expect((await viewer.request('GET', `${CR}?environment=nowhere`)).statusCode).toBe(404);
    expect((await viewer.request('GET', `${CR}?status=merged`)).statusCode).toBe(400);
  });

  it('refuses to apply a request once its flag is archived', async () => {
    await flag('retiring');
    const cr = await open('retiring', { enabled: true });
    await approve(bob, cr.id);
    const meta = (await alice.request('GET', `${P}/flags/retiring`)).json();
    await alice.request('POST', `${P}/flags/retiring/archive`, { version: meta.version });
    const res = await alice.request('POST', `${CR}/${cr.id}/apply`, { revision: 1 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('flag "retiring" is archived; restore it first');
  });

  it('round-trips the approval setting through export and import', async () => {
    const exported = await admin.request('GET', `${P}/export`);
    expect(exported.statusCode).toBe(200);
    const doc = exported.json();
    expect(doc.environments).toEqual([
      { key: 'development', name: 'Development' },
      { key: 'production', name: 'Production', requiredApprovals: 1 },
    ]);
    const imported = await admin.request('POST', '/api/projects/import?key=copy', doc);
    expect(imported.statusCode, imported.body).toBe(201);
    const copy = (await viewer.request('GET', '/api/projects'))
      .json()
      .projects.find((p: { key: string }) => p.key === 'copy');
    expect(copy.environments).toContainEqual({
      key: 'production',
      name: 'Production',
      requiredApprovals: 1,
      requireReason: false,
      requireLink: false,
    });
  });
});
