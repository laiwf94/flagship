import type { LookupAddress } from 'node:dns';
import { describe, expect, it } from 'vitest';
import {
  EgressPolicy,
  EgressRefused,
  formatIp,
  inRange,
  parseAllowEntry,
  parseIp,
  parseRange,
  refusedKind,
} from './egress.js';

const ip = (text: string) => {
  const parsed = parseIp(text);
  if (parsed === null) throw new Error(`not an address: ${text}`);
  return parsed;
};
const kind = (text: string) => refusedKind(ip(text));

describe('parsing addresses', () => {
  it('reads IPv4 and every IPv6 spelling into bytes', () => {
    expect([...ip('192.168.1.20').bytes]).toEqual([192, 168, 1, 20]);
    expect(ip('192.168.1.20').family).toBe(4);
    expect([...ip('::1').bytes]).toEqual([...Array<number>(15).fill(0), 1]);
    expect([...ip('::').bytes]).toEqual(Array<number>(16).fill(0));
    expect([...ip('fe80::1%eth0').bytes.slice(0, 2)]).toEqual([0xfe, 0x80]);
    expect([...ip('[2001:db8::8a2e:370:7334]').bytes]).toEqual([
      0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0x8a, 0x2e, 0x03, 0x70, 0x73, 0x34,
    ]);
    expect([...ip('::ffff:10.1.2.3').bytes.slice(10)]).toEqual([0xff, 0xff, 10, 1, 2, 3]);
    expect(formatIp(ip('::ffff:10.1.2.3'))).toBe('::ffff:a01:203');
    expect(formatIp(ip('1:0:0:2:0:0:0:3'))).toBe('1:0:0:2::3');
    expect(formatIp(ip('1:2:3:4:5:6:7:8'))).toBe('1:2:3:4:5:6:7:8');
    expect(formatIp(ip('1:0:2:0:3:0:4:0'))).toBe('1:0:2:0:3:0:4:0');
    expect(formatIp(ip('fd00::'))).toBe('fd00::');
    expect(formatIp(ip('10.0.0.1'))).toBe('10.0.0.1');
    for (const bad of [
      '',
      'example.com',
      '1.2.3',
      '1.2.3.256',
      '01.2.3.4',
      ':::',
      '[::1',
      'g::1',
    ]) {
      expect(parseIp(bad), bad).toBeNull();
    }
  });

  it('reads ranges and matches prefixes that do not end on a byte', () => {
    const r = (text: string) => {
      const parsed = parseRange(text);
      if (parsed === null) throw new Error(text);
      return parsed;
    };
    expect(r('172.16.0.0/12').prefix).toBe(12);
    expect(r('10.0.0.7').prefix).toBe(32);
    expect(r('::1').prefix).toBe(128);
    expect(inRange(ip('172.31.255.255'), r('172.16.0.0/12'))).toBe(true);
    expect(inRange(ip('172.32.0.0'), r('172.16.0.0/12'))).toBe(false);
    expect(inRange(ip('100.127.0.1'), r('100.64.0.0/10'))).toBe(true);
    expect(inRange(ip('100.128.0.1'), r('100.64.0.0/10'))).toBe(false);
    expect(inRange(ip('1.2.3.4'), r('0.0.0.0/0'))).toBe(true);
    expect(inRange(ip('::1'), r('0.0.0.0/0'))).toBe(false);
    expect(inRange(ip('fdff::1'), r('fc00::/7'))).toBe(true);
    for (const bad of ['10.0.0.0/33', '::/129', '10.0.0.0/', '10.0.0.0/a', 'x/8', '10.0.0.0/8/8']) {
      expect(parseRange(bad), bad).toBeNull();
    }
  });
});

describe('which addresses are refused', () => {
  it.each([
    ['0.0.0.0', '"this network"'],
    ['10.20.30.40', 'private'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['169.254.169.254', 'link-local'],
    ['172.16.0.1', 'private'],
    ['172.31.0.1', 'private'],
    ['192.0.0.170', 'IETF protocol assignment'],
    ['192.0.2.1', 'documentation'],
    ['192.88.99.1', '6to4 relay'],
    ['192.168.0.1', 'private'],
    ['198.19.0.1', 'benchmarking'],
    ['198.51.100.1', 'documentation'],
    ['203.0.113.1', 'documentation'],
    ['224.0.0.251', 'multicast'],
    ['239.255.255.250', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'reserved'],
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['::7f00:1', 'IPv4-compatible (deprecated)'],
    ['64:ff9b:1::1', 'local-use NAT64'],
    ['100::1', 'discard-only'],
    ['2001::1', 'IETF protocol assignment'],
    ['2001:db8::1', 'documentation'],
    ['fc00::1', 'unique local (private)'],
    ['fd12:3456::1', 'unique local (private)'],
    ['fe80::1%lo0', 'link-local'],
    ['febf::1', 'link-local'],
    ['fec0::1', 'site-local (deprecated)'],
    ['ff02::1', 'multicast'],
    ['::ffff:127.0.0.1', 'loopback, embedded in IPv6'],
    ['::ffff:a9fe:a9fe', 'link-local, embedded in IPv6'],
    ['64:ff9b::10.0.0.1', 'private, embedded in IPv6'],
    ['2002:c0a8:101::1', 'private, embedded in IPv6'],
  ])('%s is %s', (address, label) => {
    expect(kind(address)).toBe(label);
  });

  it.each([
    '1.1.1.1',
    '8.8.8.8',
    '9.255.255.255',
    '11.0.0.0',
    '100.63.255.255',
    '100.128.0.0',
    '126.255.255.255',
    '128.0.0.0',
    '169.253.255.255',
    '172.15.255.255',
    '172.32.0.0',
    '192.167.255.255',
    '192.169.0.0',
    '223.255.255.255',
    '2606:4700:4700::1111',
    '2a00:1450:4001::200e',
    '2001:4860:4860::8888',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
    '2002:808:808::1',
  ])('%s is public', (address) => {
    expect(kind(address)).toBeNull();
  });
});

describe('allow-list entries', () => {
  it('accepts addresses, ranges and host names, case-insensitively', () => {
    expect(parseAllowEntry(' 10.0.0.0/8 ')).toMatchObject({ kind: 'range', range: { prefix: 8 } });
    expect(parseAllowEntry('::1')).toMatchObject({ kind: 'range', range: { prefix: 128 } });
    expect(parseAllowEntry('Receiver.Internal.')).toEqual({
      kind: 'host',
      name: 'receiver.internal',
    });
    expect(parseAllowEntry('hooks')).toEqual({ kind: 'host', name: 'hooks' });
    expect(parseAllowEntry('my_svc.ns.svc.cluster.local')).toMatchObject({ kind: 'host' });
  });

  it('rejects anything else', () => {
    for (const bad of [
      '',
      '  ',
      '10.0.0.0/40',
      '10.0.0',
      '999.1.1.1',
      'http://example.com',
      'a..b',
      '-a.com',
      'a b',
      '*.example.com',
      'x'.repeat(64),
      `${'a.'.repeat(127)}a`,
    ]) {
      expect(parseAllowEntry(bad), bad).toBeNull();
    }
  });
});

describe('EgressPolicy', () => {
  it('refuses private addresses, saying what they are and how to allow them', () => {
    const p = new EgressPolicy();
    expect(p.refusal('8.8.8.8')).toBeNull();
    expect(p.refusal('10.0.0.5')).toBe(
      'refusing to connect to 10.0.0.5: a private address; ' +
        'list it in FLAGSHIP_WEBHOOK_ALLOWED_TARGETS to allow it',
    );
    expect(p.refusal('127.0.0.1', 'hooks.example.com')).toMatch(
      /^refusing to connect to 127\.0\.0\.1 \(resolved from hooks\.example\.com\): a loopback/,
    );
    expect(p.refusal('::ffff:7f00:1', '::ffff:7f00:1')).toMatch(
      /to ::ffff:7f00:1: a loopback address/,
    );
    expect(p.refusal('not-an-ip')).toBe('"not-an-ip" is not an IP address');
  });

  it('lets allow-listed ranges and host names through', () => {
    const p = new EgressPolicy(['10.1.0.0/16', 'fd00::/8', 'Hooks.Internal']);
    expect(p.refusal('10.1.2.3')).toBeNull();
    expect(p.refusal('::ffff:10.1.2.3')).toBeNull();
    expect(p.refusal('10.2.0.1')).not.toBeNull();
    expect(p.refusal('fd00::1')).toBeNull();
    expect(p.refusal('fe80::1')).not.toBeNull();
    expect(p.refusal('127.0.0.1', 'hooks.internal')).toBeNull();
    expect(p.refusal('127.0.0.1', 'HOOKS.internal.')).toBeNull();
    expect(p.refusal('127.0.0.1', 'other.internal')).not.toBeNull();
    expect(() => new EgressPolicy(['10.0.0.0/8', 'http://x'])).toThrow(
      'not an address, range or host name: "http://x"',
    );
  });

  it('checks literal addresses and localhost names in URLs without DNS', () => {
    const p = new EgressPolicy();
    const refused = (u: string) => p.urlRefusal(new URL(u));
    expect(refused('https://hooks.example.com/x')).toBeNull();
    expect(refused('https://93.184.215.14/x')).toBeNull();
    expect(refused('http://[2606:4700:4700::1111]:8080/')).toBeNull();
    expect(refused('http://127.0.0.1:8080/')).toMatch(/127\.0\.0\.1: a loopback address/);
    // The URL parser normalises these spellings, so they are caught too.
    expect(refused('http://2130706433/')).toMatch(/127\.0\.0\.1: a loopback/);
    expect(refused('http://0x7f.1/')).toMatch(/127\.0\.0\.1: a loopback/);
    expect(refused('http://[::ffff:169.254.169.254]/')).toMatch(
      /::ffff:a9fe:a9fe: a link-local address/,
    );
    expect(refused('http://[64:ff9b::a9fe:a9fe]/')).toMatch(/link-local, embedded in IPv6/);
    expect(refused('http://[::1]/')).toMatch(/::1: a loopback/);
    expect(refused('http://0.0.0.0/')).toMatch(/"this network"/);
    expect(refused('http://localhost:3000/')).toBe(
      'refusing to connect to localhost: a loopback name; ' +
        'list it in FLAGSHIP_WEBHOOK_ALLOWED_TARGETS to allow it',
    );
    expect(refused('http://LocalHost./')).toMatch(/a loopback name/);
    expect(refused('http://app.localhost/')).toMatch(/a loopback name/);
    expect(refused('http://localhost.example.com/')).toBeNull();

    const allowed = new EgressPolicy(['127.0.0.1', 'localhost']);
    expect(allowed.urlRefusal(new URL('http://127.0.0.1/'))).toBeNull();
    expect(allowed.urlRefusal(new URL('http://localhost/'))).toBeNull();
    expect(allowed.urlRefusal(new URL('http://127.0.0.2/'))).not.toBeNull();
  });

  describe('lookup', () => {
    const table: Record<string, LookupAddress[]> = {
      'public.test': [
        { address: '93.184.215.14', family: 4 },
        { address: '2606:2800:21f:cb07:6820:80da:af6b:8b2c', family: 6 },
      ],
      'mixed.test': [
        { address: '93.184.215.14', family: 4 },
        { address: '10.0.0.9', family: 4 },
      ],
      'empty.test': [],
    };
    const asked: unknown[] = [];
    const policy = (allow: string[] = []) =>
      new EgressPolicy(allow, {
        resolve: (host, options) => {
          asked.push(options);
          const found = table[host];
          if (found === undefined) {
            const err: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${host}`);
            err.code = 'ENOTFOUND';
            return Promise.reject(err);
          }
          return Promise.resolve(found);
        },
      });
    const look = (p: EgressPolicy, host: string, all: boolean) =>
      new Promise<{ err: NodeJS.ErrnoException | null; address: unknown; family?: number }>(
        (resolve) => {
          p.lookup(host, { all, family: 0, hints: 0 }, (err, address, family) => {
            resolve({ err, address, ...(family === undefined ? {} : { family }) });
          });
        },
      );

    it('answers in the shape asked for when every address is allowed', async () => {
      const one = await look(policy(), 'public.test', false);
      expect(one).toEqual({ err: null, address: '93.184.215.14', family: 4 });
      const all = await look(policy(), 'public.test', true);
      expect(all.err).toBeNull();
      expect(all.address).toEqual(table['public.test']);
      expect(asked.at(-1)).toEqual({ family: 0, hints: 0 });
    });

    it('refuses the connection if any address is not allowed', async () => {
      const r = await look(policy(), 'mixed.test', true);
      expect(r.err).toBeInstanceOf(EgressRefused);
      expect(r.err?.code).toBe('EGRESS_REFUSED');
      expect(r.err?.message).toBe(
        'refusing to connect to 10.0.0.9 (resolved from mixed.test): a private address; ' +
          'list it in FLAGSHIP_WEBHOOK_ALLOWED_TARGETS to allow it',
      );
      expect((await look(policy(['10.0.0.0/8']), 'mixed.test', false)).err).toBeNull();
      expect((await look(policy(['mixed.test']), 'mixed.test', false)).err).toBeNull();
    });

    it('passes resolution failures on', async () => {
      expect((await look(policy(), 'missing.test', false)).err?.code).toBe('ENOTFOUND');
      const empty = await look(policy(), 'empty.test', true);
      expect(empty.err?.code).toBe('ENOTFOUND');
      expect(empty.err?.message).toBe('no addresses for empty.test');
    });

    it('uses the system resolver by default', async () => {
      const r = await look(new EgressPolicy(), 'localhost', false);
      expect(r.err).toBeInstanceOf(EgressRefused);
      expect(r.err?.message).toMatch(/\(resolved from localhost\): a loopback/);
    });
  });
});
