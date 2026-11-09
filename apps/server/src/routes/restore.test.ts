import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp, type TestApp } from '../../test/app.js';
import { PASSWORD, signIn, userWithRole, type Client } from '../../test/session.js';

let t: TestApp;
let admin: Client;
let alice: Client;
let bob: Client;
let viewer: Client;

const P = '/api/projects/default';
const target = (flag: string, env = 'production') => `${P}/flags/${flag}/environments/${env}`;
const SEG = (env = 'production') => `${P}/environments/${env}/segments`;
const restore = (id: number) => `${P}/audit/${id}/restore`;

const note = (reason?: string, link?: string) => ({
  headers: {
    ...(reason === undefined ? {} : { 'flagship-reason': encodeURIComponent(reason) }),
    ...(link === undefined ? {} : { 'flagship-link': link }),
  },
});

const staff = {
  id: 'staff',
  clauses: [{ attribute: 'email', operator: 'endsWith', values: ['@acme.com'] }],
  serve: { variant: 'on' },
};
const half = {
  rollout: {
    variants: [
      { variant: 'on', weight: 50000 },
      { variant: 'off', weight: 50000 },
    ],
  },
};

interface Entry {
  id: number;
  action: string;
  targetKey: string;
  environment: string | null;
  reason: string | null;
  restorable: boolean;
}

interface Targeting {
  version: number;
  enabled: boolean;
  offVariant: string;
  prerequisites: unknown[];
  rules: unknown[];
  fallthrough: unknown;
}

async function entries(query: string): Promise<Entry[]> {
  const res = await viewer.request('GET', `${P}/audit?${query}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().entries;
}

async function latest(query: string, action: string): Promise<Entry> {
  const found = (await entries(query)).find((e) => e.action === action);
  expect(found, `${action} in ${query}`).toBeDefined();
  return found as Entry;
}

async function flag(key: string) {
  const res = await alice.request('POST', `${P}/flags`, { key, name: key, type: 'boolean' });
  expect(res.statusCode, res.body).toBe(201);
}

async function targeting(key: string, env = 'production'): Promise<Targeting> {
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

async function edit(key: string, change: Partial<Targeting>, env = 'production', as = alice) {
  const live = await targeting(key, env);
  const res = await as.request('PUT', target(key, env), { ...live, ...change });
  expect(res.statusCode, res.body).toBe(200);
}

async function plan(id: number, to: 'before' | 'after', as = viewer) {
  const res = await as.request('GET', `${restore(id)}?to=${to}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

async function setApprovals(env: string, requiredApprovals: number) {
  const res = await admin.request('PUT', `${P}/environments/${env}/approvals`, {
    requiredApprovals,
  });
  expect(res.statusCode, res.body).toBe(200);
}

const strip = ({ version: _v, ...rest }: Targeting) => rest;

beforeAll(async () => {
  t = await testApp({ bootstrapAdmin: { email: 'root@example.com', password: PASSWORD } });
  admin = await signIn(t.app.server, 'root@example.com');
  alice = await userWithRole(t.app.server, t.db, 'alice@example.com', 'editor');
  bob = await userWithRole(t.app.server, t.db, 'bob@example.com', 'editor');
  viewer = await userWithRole(t.app.server, t.db, 'vera@example.com', 'viewer');
});
afterAll(() => t.close());

describe('restoring targeting', () => {
  it('puts a broken rollout back after showing the diff, and records the restore', async () => {
    await flag('checkout');
    await edit('checkout', { enabled: true, rules: [staff] });
    const good = await targeting('checkout');
    await edit('checkout', { rules: [], fallthrough: half });
    const broken = await latest('flag=checkout', 'flag.config.update');
    expect(broken.restorable).toBe(true);

    const p = await plan(broken.id, 'before');
    expect(p).toMatchObject({
      entry: broken.id,
      kind: 'targeting',
      target: 'checkout',
      environment: 'production',
      to: 'before',
      baseVersion: good.version + 1,
      requiredApprovals: 0,
      unchanged: false,
      restored: strip(good),
    });
    expect(p.diff.map((d: { path: string }) => d.path).sort()).toEqual([
      'fallthrough.rollout',
      'fallthrough.variant',
      'rules[0]',
    ]);

    const res = await alice.request(
      'POST',
      restore(broken.id),
      { to: 'before', baseVersion: p.baseVersion },
      note('Rollout broke checkout', 'https://tickets.example.com/INC-9'),
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ outcome: 'applied', plan: { unchanged: true } });
    expect(strip(await targeting('checkout'))).toEqual(strip(good));

    const done = await latest('flag=checkout', 'flag.config.restore');
    expect(done).toMatchObject({
      reason: 'Rollout broke checkout',
      environment: 'production',
      restorable: true,
    });

    // Again is a no-op, refused rather than recorded.
    const again = await alice.request('POST', restore(broken.id), {
      to: 'before',
      baseVersion: p.baseVersion + 1,
    });
    expect(again.statusCode).toBe(400);
    expect(again.json().error.message).toMatch(/nothing to restore/);
    // The state after the bad change is also there to go forward to.
    const forward = await plan(broken.id, 'after');
    expect(forward).toMatchObject({ unchanged: false, restored: { rules: [], fallthrough: half } });
  });

  it('refuses a restore computed against a version that is no longer live', async () => {
    await flag('moving');
    await edit('moving', { enabled: true });
    const entry = await latest('flag=moving', 'flag.config.update');
    const p = await plan(entry.id, 'before');
    await edit('moving', { rules: [staff] }, 'production', bob);
    const res = await alice.request('POST', restore(entry.id), {
      to: 'before',
      baseVersion: p.baseVersion,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('version_conflict');
    expect((await targeting('moving')).rules).toEqual([staff]);
  });

  it('lets viewers review a restore but only editors make it', async () => {
    await flag('viewed');
    await edit('viewed', { enabled: true });
    const entry = await latest('flag=viewed', 'flag.config.update');
    const p = await plan(entry.id, 'before', viewer);
    const res = await viewer.request('POST', restore(entry.id), {
      to: 'before',
      baseVersion: p.baseVersion,
    });
    expect(res.statusCode).toBe(403);
    expect((await targeting('viewed')).enabled).toBe(true);
  });

  it('restores the kill switch and needs the reason the environment asks for', async () => {
    await flag('noted');
    const off = await alice.request('POST', `${target('noted')}/kill-switch`, { enabled: true });
    expect(off.statusCode, off.body).toBe(200);
    const flip = await latest('flag=noted', 'flag.kill_switch');
    expect(flip.restorable).toBe(true);
    const policy = await admin.request('PUT', `${P}/environments/production/change-notes`, {
      requireReason: true,
      requireLink: false,
    });
    expect(policy.statusCode).toBe(200);
    try {
      const p = await plan(flip.id, 'before');
      const bare = await alice.request('POST', restore(flip.id), {
        to: 'before',
        baseVersion: p.baseVersion,
      });
      expect(bare.statusCode).toBe(400);
      expect(bare.json().error.details).toEqual([
        expect.objectContaining({ path: 'header.flagship-reason' }),
      ]);
      const ok = await alice.request(
        'POST',
        restore(flip.id),
        { to: 'before', baseVersion: p.baseVersion },
        note('Back off'),
      );
      expect(ok.statusCode, ok.body).toBe(200);
      expect((await targeting('noted')).enabled).toBe(false);
    } finally {
      await admin.request('PUT', `${P}/environments/production/change-notes`, {
        requireReason: false,
        requireLink: false,
      });
    }
  });

  it('refuses entries that changed nothing restorable, and unknown or malformed ids', async () => {
    await flag('reviewed');
    await setApprovals('development', 1);
    try {
      const live = await targeting('reviewed', 'development');
      const { version, ...rest } = live;
      const opened = await alice.request(
        'POST',
        `${target('reviewed', 'development')}/change-requests`,
        { baseVersion: version, title: 'turn on', ...rest, enabled: true },
      );
      expect(opened.statusCode, opened.body).toBe(201);
    } finally {
      await setApprovals('development', 0);
    }
    const proposal = await latest('flag=reviewed', 'flag.change_request.open');
    expect(proposal.restorable).toBe(false);
    const res = await viewer.request('GET', `${restore(proposal.id)}?to=after`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/nothing to restore/);

    const settings = await latest('', 'environment.approvals');
    expect(settings.restorable).toBe(false);
    expect((await viewer.request('GET', restore(settings.id))).statusCode).toBe(400);

    expect((await viewer.request('GET', restore(999999999))).statusCode).toBe(404);
    expect((await viewer.request('GET', `${P}/audit/abc/restore`)).statusCode).toBe(400);
    expect((await viewer.request('GET', `${restore(1)}?to=sideways`)).statusCode).toBe(400);
    const extra = await alice.request('POST', restore(proposal.id), {
      to: 'after',
      baseVersion: 1,
      force: true,
    });
    expect(extra.statusCode).toBe(400);
  });

  it('refuses targeting that refers to a segment deleted since, saying why', async () => {
    const seg = await alice.request('POST', SEG(), {
      key: 'insiders',
      name: 'Insiders',
      included: ['u1'],
      excluded: [],
      rules: [],
    });
    expect(seg.statusCode, seg.body).toBe(201);
    await flag('insider-only');
    const rule = {
      id: 'insiders',
      clauses: [{ operator: 'inSegment', segments: ['insiders'] }],
      serve: { variant: 'on' },
    };
    await edit('insider-only', { enabled: true, rules: [rule] });
    const withRule = await latest('flag=insider-only', 'flag.config.update');
    await edit('insider-only', { rules: [] });
    const del = await alice.request('DELETE', `${SEG()}/insiders?version=1`);
    expect(del.statusCode, del.body).toBe(204);

    const p = await plan(withRule.id, 'after');
    expect(p.unchanged).toBe(false);
    const res = await alice.request('POST', restore(withRule.id), {
      to: 'after',
      baseVersion: p.baseVersion,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json().error)).toMatch(/insiders/);
    expect((await targeting('insider-only')).rules).toEqual([]);
  });
});

describe('restoring segments', () => {
  it('brings back a deleted segment and refuses to delete one a flag still uses', async () => {
    const created = await alice.request('POST', SEG(), {
      key: 'vip',
      name: 'VIP',
      included: ['a'],
      excluded: [],
      rules: [],
    });
    expect(created.statusCode, created.body).toBe(201);
    const updated = await alice.request('PUT', `${SEG()}/vip`, {
      version: 1,
      name: 'VIP',
      included: ['a', 'b'],
      excluded: [],
      rules: [],
    });
    expect(updated.statusCode, updated.body).toBe(200);
    const edited = await latest('segment=vip', 'segment.update');
    const del = await alice.request('DELETE', `${SEG()}/vip?version=2`);
    expect(del.statusCode).toBe(204);

    const p = await plan(edited.id, 'after');
    expect(p).toMatchObject({ kind: 'segment', baseVersion: 0, current: null, unchanged: false });
    const res = await alice.request('POST', restore(edited.id), {
      to: 'after',
      baseVersion: 0,
    });
    expect(res.statusCode, res.body).toBe(200);
    const live = await alice.request('GET', `${SEG()}/vip`);
    expect(live.json()).toMatchObject({ included: ['a', 'b'], version: 1 });
    expect((await latest('segment=vip', 'segment.restore')).restorable).toBe(true);

    // Restoring the state before the segment existed deletes it, unless a flag uses it.
    await flag('vip-only');
    await edit('vip-only', {
      rules: [
        {
          id: 'vip',
          clauses: [{ operator: 'inSegment', segments: ['vip'] }],
          serve: { variant: 'on' },
        },
      ],
    });
    const create = await latest('segment=vip', 'segment.create');
    const gone = await plan(create.id, 'before');
    expect(gone).toMatchObject({ restored: null, baseVersion: 1 });
    const refused = await alice.request('POST', restore(create.id), {
      to: 'before',
      baseVersion: 1,
    });
    expect(refused.statusCode).toBe(400);
    expect((await alice.request('GET', `${SEG()}/vip`)).statusCode).toBe(200);
  });
});

describe('restoring in protected environments', () => {
  it('opens a change request that someone else must approve before anything changes', async () => {
    await flag('guarded');
    await edit('guarded', { enabled: true, rules: [staff] });
    const good = await targeting('guarded');
    await edit('guarded', { rules: [], fallthrough: half });
    const broken = await latest('flag=guarded', 'flag.config.update');
    await setApprovals('production', 1);
    try {
      const p = await plan(broken.id, 'before');
      expect(p.requiredApprovals).toBe(1);
      const res = await alice.request(
        'POST',
        restore(broken.id),
        { to: 'before', baseVersion: p.baseVersion },
        note(undefined, 'https://tickets.example.com/INC-11'),
      );
      expect(res.statusCode, res.body).toBe(201);
      const { outcome, changeRequest } = res.json();
      expect(outcome).toBe('proposed');
      expect(changeRequest).toMatchObject({
        status: 'open',
        title: `Restore targeting of guarded to before change #${broken.id}`,
        link: 'https://tickets.example.com/INC-11',
      });
      expect(changeRequest.description).toMatch(new RegExp(`change #${broken.id}, made by alice`));
      // Nothing is live yet.
      expect((await targeting('guarded')).rules).toEqual([]);

      const CR = `${P}/change-requests/${changeRequest.id}`;
      const self = await alice.request('POST', `${CR}/reviews`, {
        decision: 'approve',
        revision: 1,
      });
      expect(self.statusCode).toBe(403);
      const ok = await bob.request('POST', `${CR}/reviews`, { decision: 'approve', revision: 1 });
      expect(ok.statusCode, ok.body).toBe(201);
      const applied = await bob.request('POST', `${CR}/apply`, { revision: 1 });
      expect(applied.statusCode, applied.body).toBe(200);
      expect(strip(await targeting('guarded'))).toEqual(strip(good));
      expect((await latest('flag=guarded', 'flag.change_request.apply')).restorable).toBe(true);
    } finally {
      await setApprovals('production', 0);
    }
  });

  it('proposes segment restores too', async () => {
    const created = await alice.request('POST', SEG('development'), {
      key: 'staff',
      name: 'Staff',
      included: ['s1'],
      excluded: [],
      rules: [],
    });
    expect(created.statusCode, created.body).toBe(201);
    const entry = await latest('segment=staff', 'segment.create');
    await setApprovals('development', 1);
    try {
      const res = await alice.request('POST', restore(entry.id), { to: 'before', baseVersion: 1 });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().changeRequest).toMatchObject({ target: 'segment', segment: 'staff' });
      expect((await alice.request('GET', `${SEG('development')}/staff`)).statusCode).toBe(200);
    } finally {
      await setApprovals('development', 0);
    }
  });
});

describe('restoring flag settings', () => {
  it('puts back a name and variants, and refuses to undo creating the flag', async () => {
    await flag('named');
    const before = (await alice.request('GET', `${P}/flags/named`)).json();
    const res = await alice.request('PUT', `${P}/flags/named`, {
      version: before.version,
      name: 'Renamed',
      description: 'oops',
    });
    expect(res.statusCode, res.body).toBe(200);
    const entry = await latest('flag=named', 'flag.update');
    expect(entry).toMatchObject({ restorable: true, environment: null });
    const p = await plan(entry.id, 'before');
    expect(p).toMatchObject({ kind: 'flag', environment: null, requiredApprovals: 0 });
    const done = await alice.request('POST', restore(entry.id), {
      to: 'before',
      baseVersion: p.baseVersion,
    });
    expect(done.statusCode, done.body).toBe(200);
    const after = (await alice.request('GET', `${P}/flags/named`)).json();
    expect(after).toMatchObject({ name: 'named', description: '' });
    expect((await latest('flag=named', 'flag.settings.restore')).restorable).toBe(true);

    const create = await latest('flag=named', 'flag.create');
    const undo = await viewer.request('GET', `${restore(create.id)}?to=before`);
    expect(undo.statusCode).toBe(400);
    expect(undo.json().error.message).toMatch(/archive it instead/);
    // The state after creating it is a fine thing to go back to.
    expect(await plan(create.id, 'after')).toMatchObject({ unchanged: true });
  });
});
