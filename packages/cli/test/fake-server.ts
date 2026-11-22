export interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: unknown;
}

type Handler = (req: Seen) => Response | Promise<Response>;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function apiError(
  status: number,
  code: string,
  message: string,
  details?: unknown,
): Response {
  return json({ error: { code, message, request_id: 'req-1', details } }, status);
}

/** A fetch that routes "METHOD /api/path" to handlers and records every request. */
export function fakeServer(routes: Record<string, Handler>) {
  const seen: Seen[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? 'GET';
    const req: Seen = {
      method,
      path: url.pathname,
      query: url.searchParams,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    seen.push(req);
    const handler = routes[`${method} ${url.pathname}`];
    if (handler === undefined)
      return apiError(404, 'not_found', `no route ${method} ${url.pathname}`);
    return handler(req);
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}
