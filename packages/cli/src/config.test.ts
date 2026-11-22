import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkProfileName,
  configPath,
  emptyConfig,
  loadConfig,
  parseConfig,
  profileOf,
  saveConfig,
  type Config,
} from './config.js';

const posix = process.platform !== 'win32';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'flagship-config-'));
}

describe('configPath', () => {
  it('prefers FLAGSHIP_CONFIG, then XDG_CONFIG_HOME, then ~/.config', () => {
    expect(configPath({ FLAGSHIP_CONFIG: '/x/c.json', XDG_CONFIG_HOME: '/xdg' })).toBe('/x/c.json');
    expect(configPath({ XDG_CONFIG_HOME: '/xdg' })).toBe(join('/xdg', 'flagship', 'config.json'));
    expect(configPath({})).toBe(join(homedir(), '.config', 'flagship', 'config.json'));
  });
});

describe('saveConfig and loadConfig', () => {
  const config: Config = {
    version: 1,
    current: 'work',
    profiles: {
      work: {
        server: 'https://flags.example.com',
        session: { cookie: 'flagship_session=abc', csrfToken: 'csrf' },
        user: 'a@example.com',
        project: 'shop',
        environment: 'production',
      },
      ci: { server: 'http://localhost:8080', token: 'fst_secret' },
    },
  };

  it('round-trips through a 0600 file in a 0700 directory, leaving no temporary file', async () => {
    const dir = tmp();
    const path = join(dir, 'nested', 'config.json');
    await saveConfig(path, config);
    expect(await loadConfig(path)).toEqual(config);
    if (posix) {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, 'nested')).mode & 0o777).toBe(0o700);
    }
    await saveConfig(path, { ...config, current: 'ci' });
    expect((await loadConfig(path)).current).toBe('ci');
    expect(readdirSync(join(dir, 'nested'))).toEqual(['config.json']);
    expect(readFileSync(path, 'utf8')).toMatch(/\n$/);
  });

  it('starts empty when there is no file', async () => {
    expect(await loadConfig(join(tmp(), 'none.json'))).toEqual(emptyConfig());
  });

  it.runIf(posix)('refuses a file other users can read', async () => {
    const path = join(tmp(), 'config.json');
    await saveConfig(path, config);
    chmodSync(path, 0o644);
    await expect(loadConfig(path)).rejects.toThrow(
      `other users can access it (mode 0644); run: chmod 600 ${path}`,
    );
  });

  it('surfaces errors other than a missing file', async () => {
    await expect(loadConfig(tmp())).rejects.toMatchObject({ code: 'EISDIR' });
  });
});

describe('parseConfig', () => {
  const ok = (profiles: unknown) => JSON.stringify({ version: 1, current: 'a', profiles });

  it('refuses documents it does not understand', () => {
    expect(() => parseConfig('{', 'c.json')).toThrow('c.json is not valid JSON');
    expect(() => parseConfig('[]', 'c.json')).toThrow('the top level must be an object');
    expect(() => parseConfig('{"version":2}', 'c.json')).toThrow('version must be 1');
    expect(() => parseConfig('{"version":1,"current":3}', 'c.json')).toThrow('current');
    expect(() => parseConfig('{"version":1,"current":"a","profiles":[]}', 'c.json')).toThrow(
      'profiles must be an object',
    );
    expect(() => parseConfig(ok({ a: 1 }), 'c.json')).toThrow('profiles.a must be an object');
    expect(() => parseConfig(ok({ a: { server: 1 } }), 'c.json')).toThrow(
      'profiles.a.server must be a string',
    );
    expect(() => parseConfig(ok({ a: { session: { cookie: 'x' } } }), 'c.json')).toThrow(
      'profiles.a.session must have a string cookie and csrfToken',
    );
    expect(() => parseConfig(ok({ __proto__: {} }), 'c.json')).not.toThrow();
    expect(() =>
      parseConfig('{"version":1,"current":"a","profiles":{"__proto__":{}}}', 'c.json'),
    ).toThrow('profile name "__proto__" is not allowed');
  });

  it('keeps only known fields', () => {
    expect(parseConfig(ok({ a: { server: 'http://x', extra: 1 } }), 'c.json').profiles).toEqual({
      a: { server: 'http://x' },
    });
  });
});

describe('profiles', () => {
  it('only finds the config’s own profiles', () => {
    const c = emptyConfig();
    expect(profileOf(c, 'constructor')).toBeUndefined();
    c.profiles.a = { server: 'http://x' };
    expect(profileOf(c, 'a')).toEqual({ server: 'http://x' });
  });

  it('checks names', () => {
    expect(checkProfileName('staging-eu.2')).toBe('staging-eu.2');
    expect(() => checkProfileName('-x')).toThrow('profile name "-x"');
    expect(() => checkProfileName('a'.repeat(65))).toThrow('profile name');
  });

  it('writes with the exact mode even under a permissive umask', async () => {
    const path = join(tmp(), 'config.json');
    writeFileSync(path, 'old', { mode: 0o600 });
    const old = process.umask(0);
    try {
      await saveConfig(path, emptyConfig());
    } finally {
      process.umask(old);
    }
    if (posix) expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
