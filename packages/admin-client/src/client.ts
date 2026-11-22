import { AdminOperations, type OperationArgs, type OperationSpec } from './operations.js';

/** The session cookie the server sets on sign-in. */
export const SESSION_COOKIE = 'flagship_session';
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface Session {
  /** The `flagship_session=...` cookie pair. */
  cookie: string;
  csrfToken: string;
}

export interface AdminClientOptions {
  /** The server's origin, such as http://localhost:8080; /api is added. */
  baseUrl: string | URL;
  /** An API token (fst_...). Sent as a bearer token; a session is then ignored. */
  token?: string;
  /** A signed-in session, as returned by AdminClient.login. */
  session?: Session;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
  /** Abandons a request after this long. Defaults to 30 seconds. */
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

/** A non-2xx response, carrying the server's stable error body. */
export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | undefined,
    readonly details: unknown,
  ) {
    super(message);
    this.name = 'AdminApiError';
  }
}

interface ErrorBody {
  error?: { code?: unknown; message?: unknown; request_id?: unknown; details?: unknown };
}

function joinUrl(base: string | URL, path: string): URL {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/api${path}`;
  return url;
}

function expand(spec: OperationSpec, path: OperationArgs['path']): string {
  return spec.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = path?.[name];
    if (value === undefined || value === '') {
      throw new TypeError(`${spec.method} ${spec.path} needs the "${name}" path parameter`);
    }
    return encodeURIComponent(String(value));
  });
}

/**
 * The flagship admin API over fetch. Every operation in the OpenAPI document
 * is a method (see AdminOperations); results are the parsed JSON bodies.
 */
export class AdminClient extends AdminOperations {
  private readonly options: AdminClientOptions;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(options: AdminClientOptions) {
    super();
    this.options = options;
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  /** Signs in with a password and returns a client that uses the new session. */
  static async login(
    options: Omit<AdminClientOptions, 'token' | 'session'>,
    email: string,
    password: string,
  ): Promise<AdminClient> {
    const fetcher = options.fetch ?? globalThis.fetch;
    const res = await fetcher(joinUrl(options.baseUrl, '/session'), {
      method: 'POST',
      headers: {
        ...options.headers,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    if (!res.ok) throw await toError(res);
    const body = (await res.json()) as { csrfToken?: unknown };
    const cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0]?.trim() ?? '')
      .find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    if (cookie === undefined || typeof body.csrfToken !== 'string') {
      throw new Error('sign-in succeeded but returned no session cookie or CSRF token');
    }
    return new AdminClient({ ...options, session: { cookie, csrfToken: body.csrfToken } });
  }

  /** The session this client signs requests with, if it has one. */
  get session(): Session | undefined {
    return this.options.session;
  }

  protected async send(spec: OperationSpec, args: OperationArgs): Promise<unknown> {
    const url = joinUrl(this.options.baseUrl, expand(spec, args.path));
    for (const [name, value] of Object.entries(args.query ?? {})) {
      if (value !== undefined) url.searchParams.append(name, String(value));
    }
    const headers: Record<string, string> = { ...this.options.headers, accept: 'application/json' };
    if (this.options.token !== undefined) {
      headers.authorization = `Bearer ${this.options.token}`;
    } else if (this.options.session !== undefined) {
      headers.cookie = this.options.session.cookie;
      if (UNSAFE.has(spec.method)) headers['x-csrf-token'] = this.options.session.csrfToken;
    }
    const init: RequestInit = {
      method: spec.method,
      headers,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
    };
    if (args.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(args.body);
    }
    const res = await this.fetcher(url, init);
    if (!res.ok) throw await toError(res);
    if (spec.empty || res.status === 204) {
      await res.body?.cancel();
      return undefined;
    }
    const text = await res.text();
    return text === '' ? undefined : (JSON.parse(text) as unknown);
  }
}

async function toError(res: Response): Promise<AdminApiError> {
  let body: ErrorBody = {};
  try {
    body = (await res.json()) as ErrorBody;
  } catch {
    // Not the server's JSON error body (a proxy page, say); keep the status.
  }
  const e = body.error ?? {};
  return new AdminApiError(
    res.status,
    typeof e.code === 'string' ? e.code : 'unknown',
    typeof e.message === 'string' ? e.message : `HTTP ${res.status}`,
    typeof e.request_id === 'string'
      ? e.request_id
      : (res.headers.get('x-request-id') ?? undefined),
    e.details,
  );
}
