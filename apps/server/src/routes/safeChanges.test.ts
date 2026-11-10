import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp, type TestApp } from '../../test/app.js';
import { PASSWORD, signIn, userWithRole, type Client } from '../../test/session.js';

/*
 * The guarantees of week 2 that span more than one feature: who may approve,
 * what happens when approved changes race each other, and restores across
 * segment and prerequisite changes made since the entry. Production needs one
 * approval throughout; development is unprotected.
 */

let t: TestApp;
let admin: Client;
let alice: Client;
let aliceAgain: Client;
let bob: Client;
let carol: Client;
let devKey: string;

const P = '/api/projects/default';
const CR = `${P}/change-requests`;
const target = (flag: string, env: string) => `${P}/flags/${flag}/environments/${env}`;
const SEG = (env: string) => `${P}/environments/${env}/segments`;
const restore = (id: number) => `${P}/audit/${id}/restore`;

const staff = {
  id: 'staff',
  clauses: [{ attribute: 'email', operator: 'endsWith', values: ['@acme.com'] }],
  serve: { variant: 'on' },
};
const inSegment = (segment: string, variant = 'on') => ({
  id: `in-${segment}`,
  clauses: [{ operator: 'inSegment', segments: [segment] }],
  serve: { variant },
});
const segment = (included: string[]) => ({
  name: 'Segment',
  description: '',
  included,
  excluded: [],
  rules: [],
});

interface Targeting {
  version: number;
  enabled: boolean;
  offVariant: string;
  prerequisites: unknown[];
  rules: unknown[];
  fallthrough: unknown;
}

async function flag(key: string, extra: Record<string, unknown> = { type: 'boolean' }) {
  const res = await alice.request('POST', `${P}/flags`, { key, name: key, ...extra });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

async function targeting(key: string, env: string): Promise<Targeting> {
  const res = await alice.request('GET', `${P}/flags/${key}`);
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

/** Edits the live targeting directly and returns the history entry it made. */
async function edit(key: string, env: string, change: Partial<Targeting>): Promise<number> {
  const live = await targeting(key, env);
  const res = await alice.request('PUT', target(key, env), { ...live, ...change });
  expect(res.statusCode, res.body).toBe(200);
  return latest(`flag=${key}`, 'flag.config.update');
}

/** The ids of the history entries matching `query` with `action`, newest first. */
async function all(query: string, action: string): Promise<number[]> {
  const res = await alice.request('GET', `${P}/audit?${query}`);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().entries as { id: number; action: string }[])
    .filter((e) => e.action === action)
    .map((e) => e.id);
}

async function latest(query: string, action: string): Promise<number> {
  const [id] = await all(query, action);
  expect(id, `${action} in ${query}`).toBeDefined();
  return id as number;
}

async function liveSegment(key: string, env: string) {
  const res = await alice.request('GET', `${SEG(env)}/${key}`);
  if (res.statusCode === 404) return null;
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ version: number; included: string[] }>();
}

/** Restores the state `to` an entry, reviewing the plan first, and returns the response. */
async function restoreTo(id: number, to: 'before' | 'after', as = alice) {
  const plan = await as.request('GET', `${restore(id)}?to=${to}`);
  expect(plan.statusCode, plan.body).toBe(200);
  return as.request('POST', restore(id), { to, baseVersion: plan.json().baseVersion });
}

/** The issue messages of a refused change, joined, so a test can say what was named. */
const issues = (res: { json: () => { error: { message: string; details?: unknown } } }) =>
  `${res.json().error.message} ${JSON.stringify(res.json().error.details ?? null)}`;

async function review(as: Client, id: string, revision = 1, decision = 'approve') {
  return as.request('POST', `${CR}/${id}/reviews`, { decision, revision });
}

async function approve(as: Client, id: string, revision = 1) {
  const res = await review(as, id, revision);
  expect(res.statusCode, res.body).toBe(201);
}

async function proposeTargeting(as: Client, key: string, change: Partial<Targeting>) {
  const { version, ...live } = await targeting(key, 'production');
  const res = await as.request('POST', `${target(key, 'production')}/change-requests`, {
    baseVersion: version,
    title: `change ${key}`,
    ...live,
    ...change,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: string }>();
}

async function proposeSegment(as: Client, key: string, content: unknown) {
  const live = await liveSegment(key, 'production');
  const res = await as.request('POST', `${SEG('production')}/${key}/change-requests`, {
    baseVersion: live?.version ?? 0,
    title: `change ${key}`,
    segment: content,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: string }>();
}

const apply = (as: Client, id: string, revision = 1) =>
  as.request('POST', `${CR}/${id}/apply`, { revision });

/** The variant a development server SDK gets; the ruleset cache drops changes on NOTIFY, so poll. */
async function variantFor(flagKey: string, context: Record<string, unknown>): Promise<string> {
  const res = await t.app.server.inject({
    method: 'POST',
    url: '/sdk/v1/evaluate',
    headers: { authorization: `Bearer ${devKey}` },
    payload: { context },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().flags[flagKey].variant;
}

beforeAll(async () => {
  t = await testApp({ bootstrapAdmin: { email: 'root@example.com', password: PASSWORD } });
  admin = await signIn(t.app.server, 'root@example.com');
  alice = await userWithRole(t.app.server, t.db, 'alice@example.com', 'editor');
  aliceAgain = await signIn(t.app.server, 'alice@example.com');
  bob = await userWithRole(t.app.server, t.db, 'bob@example.com', 'editor');
  carol = await userWithRole(t.app.server, t.db, 'carol@example.com', 'editor');
  devKey = (
    await admin.request('POST', `${P}/environments/development/api-keys`, {
      kind: 'server',
      name: 'svc',
    })
  ).json().secret;

  // History made in production before it was protected, restored later through review.
  await flag('pilot-only');
  const pilot = await alice.request('POST', SEG('production'), {
    key: 'pilot',
    ...segment(['p1']),
  });
  expect(pilot.statusCode, pilot.body).toBe(201);
  await edit('pilot-only', 'production', { enabled: true, rules: [inSegment('pilot')] });
  await edit('pilot-only', 'production', { rules: [] });
  await flag('undo-me');
  await edit('undo-me', 'production', { enabled: true, rules: [staff] });

  const protect = await admin.request('PUT', `${P}/environments/production/approvals`, {
    requiredApprovals: 1,
  });
  expect(protect.statusCode, protect.body).toBe(200);
});
afterAll(() => t.close());

describe('self-approval', () => {
  it('is refused by user, not session, for flag and segment requests and for admins', async () => {
    await flag('solo');
    const own = await proposeTargeting(alice, 'solo', { enabled: true });
    // A second session of the same person is still the author.
    for (const decision of ['approve', 'request_changes']) {
      const res = await review(aliceAgain, own.id, 1, decision);
      expect(res.statusCode).toBe(403);
    }
    const seg = await proposeSegment(alice, 'crew', segment(['c1']));
    const selfSeg = await review(alice, seg.id);
    expect(selfSeg.statusCode).toBe(403);
    expect(selfSeg.json().error.message).toBe('authors cannot approve their own change request');

    // Being an admin is no way around it.
    await flag('admins-own');
    const byAdmin = await proposeTargeting(admin, 'admins-own', { enabled: true });
    expect((await review(admin, byAdmin.id)).statusCode).toBe(403);
    expect((await apply(admin, byAdmin.id)).statusCode).toBe(409);
    await approve(bob, byAdmin.id);
    const applied = await apply(admin, byAdmin.id);
    expect(applied.statusCode, applied.body).toBe(200);

    // Nothing the author tried counts as a decision.
    const view = (await alice.request('GET', `${CR}/${own.id}`)).json();
    expect(view.approvals).toMatchObject({ approvedBy: [], changesRequestedBy: [] });
    expect(view.canApply).toBe(false);
  });

  it('still holds after someone else rebases the request', async () => {
    await flag('rebased');
    const cr = await proposeTargeting(alice, 'rebased', { rules: [staff] });
    await approve(bob, cr.id);
    // The kill switch works directly in a protected environment, which makes the request stale.
    const flip = await bob.request('POST', `${target('rebased', 'production')}/kill-switch`, {
      enabled: true,
    });
    expect(flip.statusCode, flip.body).toBe(200);
    const rebased = await bob.request('POST', `${CR}/${cr.id}/rebase`, { revision: 1 });
    expect(rebased.statusCode, rebased.body).toBe(200);
    expect(rebased.json()).toMatchObject({ revision: 2, author: 'alice' });

    expect((await review(alice, cr.id, 2)).statusCode).toBe(403);
    // Bob's approval was for revision 1, so it no longer counts.
    const early = await apply(alice, cr.id, 2);
    expect(early.statusCode).toBe(409);
    expect(early.json().error.message).toBe('this change request needs 1 approval, it has 0');
    await approve(carol, cr.id, 2);
    const done = await apply(alice, cr.id, 2);
    expect(done.statusCode, done.body).toBe(200);
    expect(await targeting('rebased', 'production')).toMatchObject({
      enabled: true,
      rules: [staff],
    });
  });

  it('makes whoever restores the author, so the person whose change is undone may approve', async () => {
    const entry = await latest('flag=undo-me', 'flag.config.update');
    const res = await restoreTo(entry, 'before', admin);
    expect(res.statusCode, res.body).toBe(201);
    const { changeRequest } = res.json();
    expect(changeRequest.author).toBe('Admin');
    expect((await review(admin, changeRequest.id)).statusCode).toBe(403);
    // Alice made the change being undone; she didn't propose undoing it.
    await approve(alice, changeRequest.id);
    const applied = await apply(alice, changeRequest.id);
    expect(applied.statusCode, applied.body).toBe(200);
    expect(await targeting('undo-me', 'production')).toMatchObject({ enabled: false, rules: [] });
  });
});

describe('concurrent applies', () => {
  it('lets a flag request that uses a segment or a request deleting it win, never both', async () => {
    const winners: string[] = [];
    for (let round = 0; round < 6; round++) {
      const seg = `shared-${round}`;
      const key = `uses-${round}`;
      const created = await proposeSegment(carol, seg, segment(['s1']));
      await approve(bob, created.id);
      expect((await apply(carol, created.id)).statusCode).toBe(200);
      await flag(key);

      const use = await proposeTargeting(alice, key, { enabled: true, rules: [inSegment(seg)] });
      const drop = await proposeSegment(carol, seg, null);
      await approve(bob, use.id);
      await approve(bob, drop.id);
      const [useRes, dropRes] = await Promise.all([apply(alice, use.id), apply(carol, drop.id)]);
      expect([useRes.statusCode, dropRes.statusCode].sort()).toEqual([200, 400]);
      const loser = useRes.statusCode === 400 ? useRes : dropRes;
      expect(loser.json().error.message).toBe(
        'this change would leave the production ruleset invalid',
      );
      expect(issues(loser)).toContain(seg);

      // The live ruleset is one of the two outcomes, never a rule on a missing segment.
      const live = await targeting(key, 'production');
      const exists = (await liveSegment(seg, 'production')) !== null;
      if (useRes.statusCode === 200) {
        expect(live.rules).toEqual([inSegment(seg)]);
        expect(exists).toBe(true);
        winners.push('flag');
      } else {
        expect(live.rules).toEqual([]);
        expect(exists).toBe(false);
        winners.push('segment');
      }
      const loserId = useRes.statusCode === 400 ? use.id : drop.id;
      expect((await alice.request('GET', `${CR}/${loserId}`)).json().status).toBe('open');
    }
    expect(winners).toHaveLength(6);
  });

  it('gives one winner when the same restore is sent three times at once', async () => {
    await flag('thrice');
    const entry = await edit('thrice', 'development', { enabled: true });
    await edit('thrice', 'development', { rules: [staff] });
    const plan = (await alice.request('GET', `${restore(entry)}?to=before`)).json();
    const results = await Promise.all(
      [alice, bob, carol].map((c) =>
        c.request('POST', restore(entry), { to: 'before', baseVersion: plan.baseVersion }),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409, 409]);
    const live = await targeting('thrice', 'development');
    expect(live).toMatchObject({ version: plan.baseVersion + 1, enabled: false, rules: [] });
    const restores = (await alice.request('GET', `${P}/audit?flag=thrice`))
      .json()
      .entries.filter((e: { action: string }) => e.action === 'flag.config.restore');
    expect(restores).toHaveLength(1);
  });

  it('gives one winner when a restore races a direct edit from the same version', async () => {
    await flag('contested');
    const entry = await edit('contested', 'development', { enabled: true });
    const plan = (await alice.request('GET', `${restore(entry)}?to=before`)).json();
    const live = await targeting('contested', 'development');
    const [restored, edited] = await Promise.all([
      alice.request('POST', restore(entry), { to: 'before', baseVersion: plan.baseVersion }),
      bob.request('PUT', target('contested', 'development'), { ...live, rules: [staff] }),
    ]);
    expect([restored.statusCode, edited.statusCode].sort()).toEqual([200, 409]);
    const after = await targeting('contested', 'development');
    expect(after.version).toBe(live.version + 1);
    expect(after).toMatchObject(
      restored.statusCode === 200
        ? { enabled: false, rules: [] }
        : { enabled: true, rules: [staff] },
    );
  });
});

describe('restoring across segment and prerequisite changes', () => {
  it('restores targeting that uses a segment without rolling back its members', async () => {
    const created = await alice.request('POST', SEG('development'), {
      key: 'testers',
      ...segment(['u1']),
    });
    expect(created.statusCode, created.body).toBe(201);
    await flag('by-segment');
    const withRule = await edit('by-segment', 'development', {
      enabled: true,
      rules: [inSegment('testers')],
    });
    await edit('by-segment', 'development', { rules: [] });
    const moved = await alice.request('PUT', `${SEG('development')}/testers`, {
      version: 1,
      ...segment(['u2']),
    });
    expect(moved.statusCode, moved.body).toBe(200);
    const membersChanged = await latest('segment=testers', 'segment.update');

    const res = await restoreTo(withRule, 'after');
    expect(res.statusCode, res.body).toBe(200);
    expect((await targeting('by-segment', 'development')).rules).toEqual([inSegment('testers')]);
    // The segment is today's: u2 is in it and u1 no longer is.
    expect(await liveSegment('testers', 'development')).toMatchObject({
      version: 2,
      included: ['u2'],
    });
    await expect.poll(() => variantFor('by-segment', { key: 'u2' })).toBe('on');
    await expect.poll(() => variantFor('by-segment', { key: 'u1' })).toBe('off');

    // Restoring the segment is its own step, and the flag follows it.
    const back = await restoreTo(membersChanged, 'before');
    expect(back.statusCode, back.body).toBe(200);
    await expect.poll(() => variantFor('by-segment', { key: 'u1' })).toBe('on');
    await expect.poll(() => variantFor('by-segment', { key: 'u2' })).toBe('off');
  });

  it('brings back a deleted segment first, then the targeting that used it', async () => {
    const created = await alice.request('POST', SEG('development'), {
      key: 'gone',
      ...segment(['g1']),
    });
    expect(created.statusCode, created.body).toBe(201);
    await flag('needs-gone');
    const withRule = await edit('needs-gone', 'development', {
      enabled: true,
      rules: [inSegment('gone')],
    });
    await edit('needs-gone', 'development', { rules: [] });
    const del = await alice.request('DELETE', `${SEG('development')}/gone?version=1`);
    expect(del.statusCode, del.body).toBe(204);
    const deleted = await latest('segment=gone', 'segment.delete');

    const early = await restoreTo(withRule, 'after');
    expect(early.statusCode).toBe(400);
    expect(issues(early)).toContain('gone');
    expect((await restoreTo(deleted, 'before')).statusCode).toBe(200);
    expect(await liveSegment('gone', 'development')).toMatchObject({ included: ['g1'] });
    const res = await restoreTo(withRule, 'after');
    expect(res.statusCode, res.body).toBe(200);
    await expect.poll(() => variantFor('needs-gone', { key: 'g1' })).toBe('on');

    // Now the segment is in use, undoing its creation is refused.
    const create = await latest('segment=gone', 'segment.restore');
    const undo = await restoreTo(create, 'before');
    expect(undo.statusCode).toBe(400);
    expect(await liveSegment('gone', 'development')).not.toBeNull();
  });

  it('refuses a restore that would close a prerequisite cycle until the cycle is gone', async () => {
    await flag('parent');
    await flag('child');
    const linked = await edit('child', 'development', {
      enabled: true,
      prerequisites: [{ flag: 'parent', variant: 'on' }],
    });
    await edit('child', 'development', { prerequisites: [] });
    await edit('parent', 'development', {
      enabled: true,
      prerequisites: [{ flag: 'child', variant: 'on' }],
    });

    const cyclic = await restoreTo(linked, 'after');
    expect(cyclic.statusCode).toBe(400);
    expect(issues(cyclic)).toMatch(
      /prerequisites form a cycle: (child -> parent -> child|parent -> child -> parent)/,
    );
    expect((await targeting('child', 'development')).prerequisites).toEqual([]);

    await edit('parent', 'development', { prerequisites: [] });
    const res = await restoreTo(linked, 'after');
    expect(res.statusCode, res.body).toBe(200);
    expect((await targeting('child', 'development')).prerequisites).toEqual([
      { flag: 'parent', variant: 'on' },
    ]);
  });

  it('refuses a prerequisite on a variant removed since, and restores the variant first', async () => {
    const colour = await flag('colour', {
      type: 'string',
      variants: [
        { key: 'red', value: 'red' },
        { key: 'blue', value: 'blue' },
        { key: 'green', value: 'green' },
      ],
    });
    await flag('paint');
    const onGreen = await edit('paint', 'development', {
      enabled: true,
      prerequisites: [{ flag: 'colour', variant: 'green' }],
    });
    await edit('paint', 'development', { prerequisites: [{ flag: 'colour', variant: 'red' }] });
    const trimmed = await alice.request('PUT', `${P}/flags/colour`, {
      version: colour.version,
      variants: [
        { key: 'red', value: 'red' },
        { key: 'blue', value: 'blue' },
      ],
    });
    expect(trimmed.statusCode, trimmed.body).toBe(200);
    const removed = await latest('flag=colour', 'flag.update');

    const early = await restoreTo(onGreen, 'after');
    expect(early.statusCode).toBe(400);
    expect(issues(early)).toContain('green');

    expect((await restoreTo(removed, 'before')).statusCode).toBe(200);
    const res = await restoreTo(onGreen, 'after');
    expect(res.statusCode, res.body).toBe(200);
    expect((await targeting('paint', 'development')).prerequisites).toEqual([
      { flag: 'colour', variant: 'green' },
    ]);
    // With paint depending on green again, removing it once more is refused.
    const again = await restoreTo(removed, 'after');
    expect(again.statusCode).toBe(400);
    expect(issues(again)).toContain('green');
    const variants = (await alice.request('GET', `${P}/flags/colour`)).json().variants;
    expect(variants.map((v: { key: string }) => v.key)).toEqual(['red', 'blue', 'green']);
  });

  it('refuses a prerequisite on a flag archived since, until it is unarchived', async () => {
    await flag('gate');
    await flag('behind');
    const gated = await edit('behind', 'development', {
      enabled: true,
      prerequisites: [{ flag: 'gate', variant: 'on' }],
    });
    await edit('behind', 'development', { prerequisites: [] });
    let gate = (await alice.request('GET', `${P}/flags/gate`)).json();
    const archived = await alice.request('POST', `${P}/flags/gate/archive`, {
      version: gate.version,
    });
    expect(archived.statusCode, archived.body).toBe(200);

    const refused = await restoreTo(gated, 'after');
    expect(refused.statusCode).toBe(400);
    expect(issues(refused)).toContain('gate');

    gate = (await alice.request('GET', `${P}/flags/gate`)).json();
    const back = await alice.request('POST', `${P}/flags/gate/restore`, { version: gate.version });
    expect(back.statusCode, back.body).toBe(200);
    expect((await restoreTo(gated, 'after')).statusCode).toBe(200);
  });

  it('checks a restore proposed in a protected environment again when it is applied', async () => {
    // Newest first: the rule removed, then the rule added.
    const [, withRule] = await all('flag=pilot-only', 'flag.config.update');
    const proposed = await restoreTo(withRule as number, 'after');
    expect(proposed.statusCode, proposed.body).toBe(201);
    const restoreCr = proposed.json().changeRequest as { id: string };

    // Meanwhile the segment is deleted through its own approved request.
    const drop = await proposeSegment(carol, 'pilot', null);
    await approve(bob, drop.id);
    await approve(bob, restoreCr.id);
    expect((await apply(carol, drop.id)).statusCode).toBe(200);

    const refused = await apply(alice, restoreCr.id);
    expect(refused.statusCode).toBe(400);
    expect(issues(refused)).toContain('pilot');
    expect((await targeting('pilot-only', 'production')).rules).toEqual([]);
    expect((await alice.request('GET', `${CR}/${restoreCr.id}`)).json().status).toBe('open');
  });
});
