import { vi } from 'vitest';

export type Handler = (body: unknown, url: URL) => unknown;

export interface Call {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

/**
 * Replaces fetch with a table of "METHOD /path" handlers. A handler returns a
 * body (200), [status, body], or throws to simulate a network failure.
 */
export function mockApi(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  const table = { ...routes };
  const fetchMock = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, 'http://localhost');
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({
      method,
      path: url.pathname + url.search,
      body,
      headers: init.headers as Record<string, string>,
    });
    const exact = `${method} ${url.pathname}${url.search}`;
    const loose = `${method} ${url.pathname}`;
    const route = Object.hasOwn(table, exact) ? table[exact] : table[loose];
    if (route === undefined)
      return new Response(
        JSON.stringify({ error: { code: 'not_found', message: `no mock for ${exact}` } }),
        { status: 404 },
      );
    const out = typeof route === 'function' ? (route as Handler)(body, url) : route;
    if (Array.isArray(out) && out.length === 2 && typeof out[0] === 'number') {
      const [status, payload] = out as [number, unknown];
      return new Response(status === 204 ? null : JSON.stringify(payload), { status });
    }
    return new Response(JSON.stringify(out), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    calls,
    set: (key: string, handler: unknown) => {
      table[key] = handler;
    },
  };
}

export const session = {
  user: { id: 'u1', email: 'eddie@example.com', name: 'Eddie', role: 'editor' },
  csrfToken: 'csrf-token',
};

export const projects = {
  projects: [
    {
      key: 'default',
      name: 'Default project',
      environments: [
        { key: 'development', name: 'Development' },
        { key: 'production', name: 'Production' },
      ],
    },
  ],
};

export function apiError(
  status: number,
  code: string,
  message: string,
  details?: unknown,
): [number, unknown] {
  return [
    status,
    { error: { code, message, request_id: 'r', ...(details === undefined ? {} : { details }) } },
  ];
}
