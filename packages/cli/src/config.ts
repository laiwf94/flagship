import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Session } from '@flagship/admin-client';
import { UsageError } from './errors.js';

/** One server and the credentials and defaults used with it. */
export interface Profile {
  server?: string;
  /** An API token (fst_...). Used instead of the session when both are set. */
  token?: string;
  session?: Session;
  /** Who signed in, for `flagship whoami` and `profile list`. */
  user?: string;
  project?: string;
  environment?: string;
}

export interface Config {
  version: 1;
  current: string;
  profiles: Record<string, Profile>;
}

export const DEFAULT_PROFILE = 'default';
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function emptyConfig(): Config {
  return { version: 1, current: DEFAULT_PROFILE, profiles: {} };
}

/**
 * Where the config lives: FLAGSHIP_CONFIG, else $XDG_CONFIG_HOME/flagship,
 * else ~/.config/flagship (on Windows, %APPDATA%\flagship).
 */
export function configPath(env: Readonly<Record<string, string | undefined>>): string {
  if (env.FLAGSHIP_CONFIG) return env.FLAGSHIP_CONFIG;
  const base =
    env.XDG_CONFIG_HOME ||
    (process.platform === 'win32' && env.APPDATA ? env.APPDATA : join(homedir(), '.config'));
  return join(base, 'flagship', 'config.json');
}

/** A profile by name; only the config's own entries, never Object.prototype's. */
export function profileOf(config: Config, name: string): Profile | undefined {
  return Object.hasOwn(config.profiles, name) ? config.profiles[name] : undefined;
}

export function checkProfileName(name: string): string {
  if (!PROFILE_NAME.test(name)) {
    throw new UsageError(
      `profile name "${name}" must be 1 to 64 letters, digits, ".", "_" or "-", starting with a letter or digit`,
    );
  }
  return name;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function optionalString(v: unknown, where: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new Error(`${where} must be a string`);
  return v;
}

function parseProfile(v: unknown, where: string): Profile {
  if (!isRecord(v)) throw new Error(`${where} must be an object`);
  const p: Profile = {};
  for (const field of ['server', 'token', 'user', 'project', 'environment'] as const) {
    const value = optionalString(v[field], `${where}.${field}`);
    if (value !== undefined) p[field] = value;
  }
  if (v.session !== undefined) {
    const s = v.session;
    if (!isRecord(s) || typeof s.cookie !== 'string' || typeof s.csrfToken !== 'string') {
      throw new Error(`${where}.session must have a string cookie and csrfToken`);
    }
    p.session = { cookie: s.cookie, csrfToken: s.csrfToken };
  }
  return p;
}

/** Parses a config document, refusing anything it doesn't understand rather than guessing. */
export function parseConfig(text: string, path: string): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${path} is not valid JSON: ${(e as Error).message}`, { cause: e });
  }
  try {
    if (!isRecord(raw)) throw new Error('the top level must be an object');
    if (raw.version !== 1) throw new Error('version must be 1');
    if (typeof raw.current !== 'string') throw new Error('current must be a string');
    if (!isRecord(raw.profiles)) throw new Error('profiles must be an object');
    const profiles: Record<string, Profile> = {};
    for (const [name, value] of Object.entries(raw.profiles)) {
      if (!PROFILE_NAME.test(name)) throw new Error(`profile name "${name}" is not allowed`);
      profiles[name] = parseProfile(value, `profiles.${name}`);
    }
    return { version: 1, current: raw.current, profiles };
  } catch (e) {
    throw new Error(`${path}: ${(e as Error).message}`, { cause: e });
  }
}

/**
 * Reads the config, or an empty one when the file doesn't exist. Like ssh with
 * a private key, it refuses a file that others can read or write: it holds
 * session cookies and tokens.
 */
export async function loadConfig(path: string): Promise<Config> {
  let text: string;
  try {
    const info = await stat(path);
    if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
      const mode = (info.mode & 0o777).toString(8).padStart(4, '0');
      throw new Error(
        `${path} holds credentials but other users can access it (mode ${mode}); run: chmod 600 ${path}`,
      );
    }
    text = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyConfig();
    throw e;
  }
  return parseConfig(text, path);
}

/**
 * Writes the config with mode 0600 in a 0700 directory. The new content goes
 * to a temporary file created 0600 (never briefly world-readable) and is
 * renamed over the old one, so a crash can't leave half a file.
 */
export async function saveConfig(path: string, config: Config): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.config.${process.pid}.${Date.now()}.tmp`);
  const handle = await open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    // open()'s mode is masked by the umask, which can only remove bits; set it exactly anyway.
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}
