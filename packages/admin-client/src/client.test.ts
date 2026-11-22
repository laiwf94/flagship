import { describe, expect, it } from 'vitest';
import { AdminApiError, AdminClient } from './client.js';
import { OPERATIONS } from './operations.js';

interface Seen {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function fake(respond: (seen: Seen) => Response): {
  fetch: typeof globalThis.fetch;
  calls: Seen[];
} {
  const calls: Seen[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const seen: Seen = {
      url: new URL(input instanceof Request ? input.url : input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(seen);
    return respond(seen);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('AdminClient', () => {
  it('expands and encodes path parameters, and sends defined query values only', async () => {
    const f = fake(() => json(200, { flags: [] }));
    const client = new AdminClient({
      baseUrl: 'http://flags.test/base/',
      token: 'fst_x',
      fetch: f.fetch,
    });
    const result = await client.listFlags({
      path: { project: 'web app' },
      query: { environment: 'prod', limit: 5, q: undefined },
    });
    expect(result).toEqual({ flags: [] });
    const call = f.calls[0]!;
    expect(call.url.pathname).toBe('/base/api/projects/web%20app/flags');
    expect([...call.url.searchParams]).toEqual([
      ['environment', 'prod'],
      ['limit', '5'],
    ]);
    expect(call.method).toBe('GET');
    expect(call.headers.authorization).toBe('Bearer fst_x');
    expect(call.headers['content-type']).toBeUndefined();
    expect(call.body).toBeUndefined();
  });

  it('sends JSON bodies and resolves empty responses to undefined', async () => {
    const f = fake((seen) =>
      seen.method === 'DELETE' ? new Response(null, { status: 204 }) : json(201, { key: 'a' }),
    );
    const client = new AdminClient({ baseUrl: 'http://flags.test', token: 't', fetch: f.fetch });
    const created = await client.createFlag({
      path: { project: 'web' },
      body: { key: 'a', name: 'A', type: 'boolean' },
    });
    expect(created).toEqual({ key: 'a' });
    expect(f.calls[0]!.headers['content-type']).toBe('application/json');
    expect(JSON.parse(f.calls[0]!.body!)).toEqual({ key: 'a', name: 'A', type: 'boolean' });
    await expect(client.revokeApiToken({ path: { id: 'abc' } })).resolves.toBeUndefined();
    expect(f.calls[1]!.url.pathname).toBe('/api/tokens/abc');
  });

  it('signs session requests with the cookie, and unsafe ones with the CSRF token', async () => {
    const f = fake(() => json(200, {}));
    const client = new AdminClient({
      baseUrl: 'http://flags.test',
      session: { cookie: 'flagship_session=s1', csrfToken: 'c1' },
      headers: { 'user-agent': 'flagship-cli/0.1.0' },
      fetch: f.fetch,
    });
    await client.listProjects();
    await client.createProject({ body: { key: 'p', name: 'P' } });
    expect(f.calls[0]!.headers).toMatchObject({ cookie: 'flagship_session=s1' });
    expect(f.calls[0]!.headers['x-csrf-token']).toBeUndefined();
    expect(f.calls[1]!.headers).toMatchObject({
      cookie: 'flagship_session=s1',
      'x-csrf-token': 'c1',
      'user-agent': 'flagship-cli/0.1.0',
    });
    expect(client.session?.csrfToken).toBe('c1');
  });

  it('prefers a token over a session', async () => {
    const f = fake(() => json(200, {}));
    const client = new AdminClient({
      baseUrl: 'http://flags.test',
      token: 'fst_t',
      session: { cookie: 'flagship_session=s1', csrfToken: 'c1' },
      fetch: f.fetch,
    });
    await client.createProject({ body: { key: 'p', name: 'P' } });
    expect(f.calls[0]!.headers.authorization).toBe('Bearer fst_t');
    expect(f.calls[0]!.headers.cookie).toBeUndefined();
  });

  it('throws AdminApiError with the server error body', async () => {
    const f = fake(() =>
      json(400, {
        error: {
          code: 'invalid_argument',
          message: 'invalid flag',
          request_id: 'r1',
          details: [{ path: 'key', message: 'bad' }],
        },
      }),
    );
    const client = new AdminClient({ baseUrl: 'http://flags.test', token: 't', fetch: f.fetch });
    const err = await client
      .createFlag({ path: { project: 'web' }, body: { key: '-', name: 'x', type: 'boolean' } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdminApiError);
    expect(err).toMatchObject({
      status: 400,
      code: 'invalid_argument',
      message: 'invalid flag',
      requestId: 'r1',
      details: [{ path: 'key', message: 'bad' }],
    });
  });

  it('keeps the status of an error that is not the server JSON body', async () => {
    const f = fake(
      () =>
        new Response('<html>bad gateway</html>', {
          status: 502,
          headers: { 'x-request-id': 'r9' },
        }),
    );
    const client = new AdminClient({ baseUrl: 'http://flags.test', fetch: f.fetch });
    await expect(client.listProjects()).rejects.toMatchObject({
      status: 502,
      code: 'unknown',
      message: 'HTTP 502',
      requestId: 'r9',
    });
  });

  it('refuses to send a request with a missing path parameter', async () => {
    const f = fake(() => json(200, {}));
    const client = new AdminClient({ baseUrl: 'http://flags.test', fetch: f.fetch });
    await expect(client.getFlag({ path: { project: 'web', flag: '' } })).rejects.toThrow(
      'needs the "flag" path parameter',
    );
    expect(f.calls).toHaveLength(0);
  });

  it('treats an empty 200 body as undefined', async () => {
    const f = fake(() => new Response('', { status: 200 }));
    const client = new AdminClient({ baseUrl: 'http://flags.test', fetch: f.fetch });
    await expect(client.listProjects()).resolves.toBeUndefined();
  });

  it('logs in and keeps the session cookie and CSRF token', async () => {
    const f = fake((seen) => {
      if (seen.url.pathname === '/api/session') {
        const res = json(200, { user: { id: 'u' }, csrfToken: 'csrf-1' });
        res.headers.append('set-cookie', 'other=1; Path=/');
        res.headers.append('set-cookie', 'flagship_session=abc; Path=/; HttpOnly; SameSite=Lax');
        return res;
      }
      return json(200, { user: { id: 'u' } });
    });
    const client = await AdminClient.login(
      { baseUrl: 'http://flags.test', fetch: f.fetch },
      'a@example.com',
      'pw',
    );
    expect(client.session).toEqual({ cookie: 'flagship_session=abc', csrfToken: 'csrf-1' });
    expect(JSON.parse(f.calls[0]!.body!)).toEqual({ email: 'a@example.com', password: 'pw' });
    await client.getSession();
    expect(f.calls[1]!.headers.cookie).toBe('flagship_session=abc');
  });

  it('reports a failed or malformed sign-in', async () => {
    const denied = fake(() =>
      json(401, { error: { code: 'unauthenticated', message: 'email or password is incorrect' } }),
    );
    await expect(
      AdminClient.login({ baseUrl: 'http://flags.test', fetch: denied.fetch }, 'a@b.c', 'x'),
    ).rejects.toMatchObject({ status: 401, code: 'unauthenticated' });
    const noCookie = fake(() => json(200, { csrfToken: 'c' }));
    await expect(
      AdminClient.login({ baseUrl: 'http://flags.test', fetch: noCookie.fetch }, 'a@b.c', 'x'),
    ).rejects.toThrow('no session cookie');
  });

  it('has a method for every operation that sends that operation', async () => {
    const f = fake((seen) =>
      seen.method === 'DELETE' ? new Response(null, { status: 204 }) : json(200, {}),
    );
    const client = new AdminClient({ baseUrl: 'http://flags.test', token: 't', fetch: f.fetch });
    const methods = client as unknown as Record<string, (args: unknown) => Promise<unknown>>;
    for (const [id, spec] of Object.entries(OPERATIONS)) {
      const path = Object.fromEntries(spec.params.map((p) => [p, `${p}-1`]));
      await methods[id]!.call(client, { path, body: {} });
      const call = f.calls.at(-1)!;
      expect(call.method, id).toBe(spec.method);
      expect(call.url.pathname, id).toBe(`/api${spec.path.replace(/\{([^}]+)\}/g, '$1-1')}`);
    }
    expect(f.calls).toHaveLength(Object.keys(OPERATIONS).length);
  });
});
