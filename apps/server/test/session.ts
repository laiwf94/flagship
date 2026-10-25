import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import type { Db } from '../src/db/database.js';
import type { Role } from '../src/db/schema.js';
import { createUser } from '../src/services/users.js';

export const PASSWORD = 'correct horse battery staple';

export interface Client {
  cookie: string;
  csrf: string;
  userId: string;
  request: (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    body?: unknown,
    extra?: { headers?: Record<string, string>; remoteAddress?: string },
  ) => Promise<LightMyRequestResponse>;
}

export async function addUser(db: Db, email: string, role: Role): Promise<string> {
  const user = await createUser(
    db,
    { email, name: email.split('@')[0] ?? email, role, password: PASSWORD },
    null,
  );
  return user.id;
}

/** Signs in through the API and returns a client that sends the cookie and CSRF token. */
export async function signIn(
  server: FastifyInstance,
  email: string,
  password = PASSWORD,
): Promise<Client> {
  const res = await server.inject({
    method: 'POST',
    url: '/api/session',
    payload: { email, password },
  });
  if (res.statusCode !== 200) throw new Error(`sign-in failed: ${res.statusCode} ${res.body}`);
  const setCookie = res.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const cookie = (raw ?? '').split(';')[0] ?? '';
  const body = res.json<{ csrfToken: string; user: { id: string } }>();
  return {
    cookie,
    csrf: body.csrfToken,
    userId: body.user.id,
    request: (method, url, payload, extra = {}) => {
      const options: InjectOptions = {
        method,
        url,
        headers: { cookie, 'x-csrf-token': body.csrfToken, ...(extra.headers ?? {}) },
      };
      if (payload !== undefined) options.payload = payload as string | object;
      if (extra.remoteAddress !== undefined) options.remoteAddress = extra.remoteAddress;
      return server.inject(options);
    },
  };
}

export async function userWithRole(
  server: FastifyInstance,
  db: Db,
  email: string,
  role: Role,
): Promise<Client> {
  await addUser(db, email, role);
  return signIn(server, email);
}
