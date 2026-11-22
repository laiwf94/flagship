import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ParseArgsOptionDescriptor } from 'node:util';
import { AdminApiError, AdminClient, type AdminClientOptions } from '@flagship/admin-client';
import { profileOf, saveConfig, type Config, type Profile } from './config.js';
import { CliError, UsageError } from './errors.js';

/** What the CLI talks to; tests pass their own. */
export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** All of standard input, decoded as UTF-8. */
  readStdin: () => Promise<string>;
  /** Asks for a secret without echoing it, or is absent when stdin is not a terminal. */
  promptSecret?: ((question: string) => Promise<string>) | undefined;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  fetch?: typeof globalThis.fetch | undefined;
}

export interface Option extends ParseArgsOptionDescriptor {
  description: string;
  /** Shown in help after the option name, e.g. "KEY". Booleans have none. */
  value?: string;
}

export type Values = Record<string, string | boolean | (string | boolean)[] | undefined>;

/** What a command produced: the JSON for --json, and the text otherwise. */
export interface Result {
  json: unknown;
  text: string;
  /** Exit status; 0 when absent. */
  status?: number;
}

export interface Command {
  /** The words that select it, e.g. ['flag', 'list']. */
  path: readonly string[];
  summary: string;
  /** Positional arguments for help, e.g. "<key>". */
  args?: string;
  /** How many positionals it takes after its path: [min, max]. */
  arity?: readonly [number, number];
  options?: Record<string, Option>;
  /** Longer help shown under the usage line. */
  details?: string;
  run: (ctx: Context, values: Values, args: readonly string[]) => Promise<Result>;
}

/** Options every command accepts. */
export const GLOBAL_OPTIONS: Record<string, Option> = {
  profile: {
    type: 'string',
    value: 'NAME',
    description: 'Profile from the config file (default: the current one, or FLAGSHIP_PROFILE)',
  },
  server: {
    type: 'string',
    value: 'URL',
    description: 'Server origin, overriding the profile (or FLAGSHIP_SERVER)',
  },
  project: {
    type: 'string',
    short: 'p',
    value: 'KEY',
    description: 'Project, overriding the profile (or FLAGSHIP_PROJECT)',
  },
  environment: {
    type: 'string',
    short: 'e',
    value: 'KEY',
    description: 'Environment, overriding the profile (or FLAGSHIP_ENVIRONMENT)',
  },
  json: { type: 'boolean', description: 'Print JSON on stdout, and errors as JSON on stderr' },
  reason: {
    type: 'string',
    value: 'TEXT',
    description: 'Why: recorded on the audit entry of a change',
  },
  link: { type: 'string', value: 'URL', description: 'Ticket link recorded with a change' },
  help: { type: 'boolean', short: 'h', description: 'Show help' },
};

export function str(values: Values, name: string): string | undefined {
  const v = values[name];
  return typeof v === 'string' ? v : undefined;
}

export function strs(values: Values, name: string): string[] {
  const v = values[name];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function bool(values: Values, name: string): boolean {
  return values[name] === true;
}

/** A whole number option, refusing anything else. */
export function int(
  values: Values,
  name: string,
  { min = 0, max = Number.MAX_SAFE_INTEGER } = {},
): number | undefined {
  const v = str(values, name);
  if (v === undefined) return undefined;
  if (!/^-?\d+$/.test(v)) throw new UsageError(`--${name} must be a whole number, not "${v}"`);
  const n = Number(v);
  if (n < min || n > max) throw new UsageError(`--${name} must be from ${min} to ${max}`);
  return n;
}

/** Exactly one of `choices`, or undefined when not given. */
export function oneOf<T extends string>(
  values: Values,
  name: string,
  choices: readonly T[],
): T | undefined {
  const v = str(values, name);
  if (v === undefined) return undefined;
  if (!(choices as readonly string[]).includes(v)) {
    throw new UsageError(`--${name} must be one of ${choices.join(', ')}, not "${v}"`);
  }
  return v as T;
}

/** Comma-separated and repeated values, flattened: --include a,b --include c. */
export function csv(values: Values, name: string): string[] {
  return strs(values, name)
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

/**
 * Everything a command needs: the resolved profile, the admin client and the
 * project and environment, each failing with a clear message when missing.
 */
export class Context {
  readonly profileName: string;
  readonly profile: Profile;
  private clientInstance: AdminClient | undefined;

  constructor(
    readonly io: Io,
    readonly config: Config,
    readonly configFile: string,
    readonly globals: Values,
  ) {
    this.profileName = str(globals, 'profile') ?? io.env.FLAGSHIP_PROFILE ?? config.current;
    this.profile = profileOf(config, this.profileName) ?? {};
  }

  get json(): boolean {
    return bool(this.globals, 'json');
  }

  /** The server origin: --server, FLAGSHIP_SERVER, then the profile. */
  server(): string {
    const server =
      str(this.globals, 'server') ?? this.io.env.FLAGSHIP_SERVER ?? this.profile.server;
    if (server === undefined || server === '') {
      throw new UsageError(
        `no server for profile "${this.profileName}": run flagship login --server URL, or pass --server`,
      );
    }
    return normalizeServer(server);
  }

  project(): string {
    const project =
      str(this.globals, 'project') ?? this.io.env.FLAGSHIP_PROJECT ?? this.profile.project;
    if (project === undefined || project === '') {
      throw new UsageError(
        'no project: pass --project KEY, set FLAGSHIP_PROJECT, or save one with flagship profile set --project KEY',
      );
    }
    return project;
  }

  environment(): string {
    const environment = this.explicitEnvironment() ?? this.profile.environment;
    if (environment === undefined || environment === '') {
      throw new UsageError(
        'no environment: pass --environment KEY, set FLAGSHIP_ENVIRONMENT, or save one with flagship profile set --environment KEY',
      );
    }
    return environment;
  }

  /** The environment from the command line or FLAGSHIP_ENVIRONMENT, ignoring the profile's. */
  explicitEnvironment(): string | undefined {
    return str(this.globals, 'environment') ?? this.io.env.FLAGSHIP_ENVIRONMENT;
  }

  /** Headers carrying --reason and --link to the audit log. */
  noteHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    const reason = str(this.globals, 'reason');
    const link = str(this.globals, 'link');
    if (reason !== undefined) headers['flagship-reason'] = encodeURIComponent(reason);
    if (link !== undefined) headers['flagship-link'] = link;
    return headers;
  }

  clientOptions(): Omit<AdminClientOptions, 'token' | 'session'> {
    const options: Omit<AdminClientOptions, 'token' | 'session'> = {
      baseUrl: this.server(),
      headers: { 'user-agent': 'flagship-cli', ...this.noteHeaders() },
    };
    if (this.io.fetch !== undefined) options.fetch = this.io.fetch;
    return options;
  }

  /** How requests authenticate: FLAGSHIP_TOKEN, then the profile's token, then its session. */
  credentials(): { token: string } | { session: NonNullable<Profile['session']> } {
    const token = this.io.env.FLAGSHIP_TOKEN || this.profile.token;
    if (token) return { token };
    if (this.profile.session) return { session: this.profile.session };
    throw new UsageError(
      `profile "${this.profileName}" is not signed in: run flagship login, or set FLAGSHIP_TOKEN`,
    );
  }

  client(): AdminClient {
    this.clientInstance ??= new AdminClient({ ...this.clientOptions(), ...this.credentials() });
    return this.clientInstance;
  }

  /** Calls the API, turning an expired session into advice to sign in again. */
  async call<T>(request: (client: AdminClient) => Promise<unknown>): Promise<T> {
    try {
      return (await request(this.client())) as T;
    } catch (e) {
      if (e instanceof AdminApiError && e.status === 401) {
        const how = 'token' in this.credentials() ? 'token' : 'session';
        throw new CliError(
          e.code,
          `the ${how} for profile "${this.profileName}" was refused (${e.message}): run flagship login again`,
          e.details,
        );
      }
      throw e;
    }
  }

  /** Changes the profile on disk and in memory. */
  async saveProfile(name: string, profile: Profile): Promise<void> {
    this.config.profiles[name] = profile;
    // The first profile, or one saved while the current one doesn't exist, becomes current.
    if (!Object.hasOwn(this.config.profiles, this.config.current)) this.config.current = name;
    await saveConfig(this.configFile, this.config);
  }

  async saveConfig(): Promise<void> {
    await saveConfig(this.configFile, this.config);
  }

  /**
   * A JSON argument: inline JSON, @path for a file, or - for stdin. `what`
   * names it in errors.
   */
  async readJson(source: string, what: string): Promise<unknown> {
    let text: string;
    let from: string;
    if (source === '-') {
      text = await this.io.readStdin();
      from = 'stdin';
    } else if (source.startsWith('@')) {
      from = source.slice(1);
      try {
        text = await readFile(resolve(this.io.cwd, from), 'utf8');
      } catch (e) {
        throw new UsageError(`can't read ${what} from ${from}: ${(e as Error).message}`);
      }
    } else {
      text = source;
      from = 'the argument';
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (e) {
      throw new UsageError(`${what} in ${from} is not valid JSON: ${(e as Error).message}`);
    }
  }

  /** A JSON file named by --file (a path, or - for stdin). */
  async readFileJson(path: string, what: string): Promise<unknown> {
    return this.readJson(path === '-' ? '-' : `@${path}`, what);
  }
}

/** Drops a trailing slash and /api, and refuses anything that isn't an http(s) origin. */
export function normalizeServer(server: string): string {
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    throw new UsageError(`server "${server}" is not a URL such as https://flags.example.com`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UsageError(`server "${server}" must use http or https`);
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new UsageError(`server "${server}" must not carry credentials, a query or a fragment`);
  }
  const path = url.pathname.replace(/\/+$/, '').replace(/\/api$/, '');
  return `${url.origin}${path}`;
}

/** Keeps only `keys` of an object that came from a file, so a full `flag get` output can be fed back. */
export function pick<K extends string>(
  value: unknown,
  keys: readonly K[],
  what: string,
): Partial<Record<K, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new UsageError(`${what} must be a JSON object`);
  }
  const out: Partial<Record<K, unknown>> = {};
  for (const k of keys) {
    if (Object.hasOwn(value, k)) out[k] = (value as Record<string, unknown>)[k];
  }
  return out;
}
