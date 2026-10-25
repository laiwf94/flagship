/** Realistic data so pages are judged with real content, created through the public API. */

export const ADMIN = { email: 'admin@example.com', password: 'e2e admin password 1' };
export const EDITOR = { email: 'eddie@example.com', password: 'e2e editor password 1' };

interface Session {
  cookie: string;
  csrf: string;
}

async function signIn(base: string, email: string, password: string): Promise<Session> {
  const res = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`sign-in failed: ${res.status}`);
  const body = (await res.json()) as { csrfToken: string };
  return {
    cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
    csrf: body.csrfToken,
  };
}

async function call<T>(
  base: string,
  s: Session,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

const P = '/api/projects/default';
const rollout = (on: number) => ({
  rollout: {
    variants: [
      { variant: 'on', weight: on * 1000 },
      { variant: 'off', weight: (100 - on) * 1000 },
    ],
  },
});

export async function seed(base: string): Promise<void> {
  const s = await signIn(base, ADMIN.email, ADMIN.password);
  await call(base, s, 'POST', '/api/users', { ...EDITOR, name: 'Eddie Editor', role: 'editor' });
  await call(base, s, 'POST', '/api/users', {
    email: 'vera@example.com',
    name: 'Vera Viewer',
    role: 'viewer',
    password: 'e2e viewer password 1',
  });

  await call(base, s, 'POST', `${P}/environments/production/segments`, {
    key: 'beta-testers',
    name: 'Beta testers',
    description: 'People who opted in to early features',
    included: ['alice', 'bob', 'carol'],
    excluded: ['mallory'],
    rules: [
      {
        id: 'staff',
        clauses: [{ attribute: 'email', operator: 'endsWith', values: ['@acme.com'] }],
      },
    ],
  });
  await call(base, s, 'POST', `${P}/environments/production/segments`, {
    key: 'enterprise',
    name: 'Enterprise customers',
    description: '',
    included: [],
    excluded: [],
    rules: [
      {
        id: 'plan',
        clauses: [{ attribute: 'plan', operator: 'in', values: ['enterprise', 'enterprise-plus'] }],
      },
    ],
  });

  const flags: {
    key: string;
    name: string;
    description: string;
    type: string;
    clientSide?: boolean;
    variants?: unknown[];
  }[] = [
    {
      key: 'new-checkout',
      name: 'New checkout',
      description: 'One-page checkout with saved cards.',
      type: 'boolean',
      clientSide: true,
    },
    {
      key: 'dark-mode',
      name: 'Dark mode',
      description: 'Dark theme for the dashboard.',
      type: 'boolean',
      clientSide: true,
    },
    {
      key: 'search-ranking',
      name: 'Search ranking model',
      description: 'Which ranking model powers product search.',
      type: 'string',
      variants: [
        { key: 'classic', value: 'bm25' },
        { key: 'semantic', value: 'semantic-v2' },
      ],
    },
    {
      key: 'recommendations-limit',
      name: 'Recommendations per page',
      description: '',
      type: 'number',
      variants: [
        { key: 'few', value: 4 },
        { key: 'some', value: 8 },
        { key: 'many', value: 16 },
      ],
    },
    {
      key: 'homepage-hero',
      name: 'Homepage hero',
      description: 'Hero banner experiment.',
      type: 'json',
      clientSide: true,
      variants: [
        { key: 'photo', value: { layout: 'photo', cta: 'Shop now' } },
        { key: 'video', value: { layout: 'video', cta: 'Watch the story' } },
      ],
    },
    {
      key: 'payments-v3',
      name: 'Payments v3',
      description: 'New payment provider integration.',
      type: 'boolean',
    },
    {
      key: 'legacy-export',
      name: 'Legacy CSV export',
      description: 'Old export path, kept for one customer.',
      type: 'boolean',
    },
  ];
  for (const f of flags) await call(base, s, 'POST', `${P}/flags`, f);

  const target = async (key: string, config: Record<string, unknown>) => {
    const flag = await call<{ version: number }>(base, s, 'GET', `${P}/flags/${key}`);
    await call(base, s, 'PUT', `${P}/flags/${key}/environments/production`, {
      version: flag.version,
      enabled: true,
      prerequisites: [],
      rules: [],
      ...config,
    });
  };
  await target('new-checkout', {
    offVariant: 'off',
    rules: [
      {
        id: 'beta',
        clauses: [{ operator: 'inSegment', segments: ['beta-testers'] }],
        serve: { variant: 'on' },
      },
      {
        id: 'mobile-old',
        clauses: [{ attribute: 'appVersion', operator: 'semverLt', values: ['4.2.0'] }],
        serve: { variant: 'off' },
      },
    ],
    fallthrough: rollout(25),
  });
  await target('dark-mode', { offVariant: 'off', fallthrough: { variant: 'on' } });
  await target('search-ranking', {
    offVariant: 'classic',
    rules: [
      {
        id: 'enterprise',
        clauses: [{ operator: 'inSegment', segments: ['enterprise'] }],
        serve: { variant: 'semantic' },
      },
    ],
    fallthrough: { variant: 'classic' },
  });
  await target('homepage-hero', {
    offVariant: 'photo',
    fallthrough: {
      rollout: {
        variants: [
          { variant: 'photo', weight: 50_000 },
          { variant: 'video', weight: 50_000 },
        ],
      },
    },
  });
  await target('payments-v3', {
    offVariant: 'off',
    prerequisites: [{ flag: 'new-checkout', variant: 'on' }],
    fallthrough: rollout(10),
  });
  const legacy = await call<{ version: number }>(base, s, 'GET', `${P}/flags/legacy-export`);
  await call(base, s, 'POST', `${P}/flags/legacy-export/archive`, { version: legacy.version });

  const tomorrow = new Date(Date.now() + 86_400_000);
  tomorrow.setUTCHours(9, 0, 0, 0);
  await call(base, s, 'POST', `${P}/flags/new-checkout/environments/production/schedules`, {
    runAt: tomorrow.toISOString(),
    change: { enabled: true, fallthrough: rollout(50) },
  });

  const server = await call<{ secret: string }>(
    base,
    s,
    'POST',
    `${P}/environments/production/api-keys`,
    {
      kind: 'server',
      name: 'checkout service',
    },
  );
  const client = await call<{ secret: string }>(
    base,
    s,
    'POST',
    `${P}/environments/production/api-keys`,
    {
      kind: 'client',
      name: 'storefront',
    },
  );
  await fetch(`${base}/sdk/v1/environment`, {
    headers: { authorization: `Bearer ${server.secret}` },
  });
  await fetch(`${base}/sdk/v1/events`, {
    method: 'POST',
    headers: { authorization: `Bearer ${client.secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      events: [
        { flag: 'new-checkout', variant: 'on', count: 3120 },
        { flag: 'new-checkout', variant: 'off', count: 9214 },
        { flag: 'homepage-hero', variant: 'photo', count: 4410 },
        { flag: 'homepage-hero', variant: 'video', count: 4388 },
      ],
    }),
  });
  await new Promise((r) => setTimeout(r, 500));
}
