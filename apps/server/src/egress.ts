import dns, { type LookupAddress, type LookupOptions } from 'node:dns';
import { isIPv4, isIPv6, type LookupFunction } from 'node:net';

/**
 * Outbound connection policy for requests the server makes on a user's
 * behalf, such as webhook deliveries.
 *
 * Without it, anyone who can create a webhook could make the server POST to
 * its own loopback interface, the database, a cloud metadata endpoint or
 * anything else on the private network. So every address is checked when it
 * is about to be connected to: after DNS resolution, inside the socket's own
 * lookup, which means a name that resolves to a public address when the
 * webhook is saved and to a private one later (DNS rebinding) is still
 * refused. Literal addresses in a URL never reach a lookup, so they are
 * checked before the request starts.
 *
 * Refused: loopback, private (RFC 1918 and IPv6 unique local), link-local,
 * carrier-grade NAT, "this network", multicast, broadcast and reserved space,
 * documentation and benchmarking ranges, and IPv6 forms that embed one of
 * those (IPv4-mapped, NAT64, 6to4). A self-hosted receiver on such an address
 * is let through by listing it, its range or its host name in the allow-list.
 */

export interface Ip {
  family: 4 | 6;
  bytes: Uint8Array;
}

/** Parses a literal IPv4 or IPv6 address (brackets and a zone id allowed); null otherwise. */
export function parseIp(text: string): Ip | null {
  let s = text;
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (isIPv4(s)) return { family: 4, bytes: Uint8Array.from(s.split('.').map(Number)) };
  if (!isIPv6(s)) return null;
  s = s.split('%')[0] ?? '';
  const dot = s.lastIndexOf(':');
  const last = s.slice(dot + 1);
  if (last.includes('.')) {
    const [a = 0, b = 0, c = 0, d = 0] = last.split('.').map(Number);
    s = `${s.slice(0, dot + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = s.split('::');
  const groups = (part: string) => (part === '' ? [] : part.split(':'));
  const h = groups(head);
  const t = tail === undefined ? [] : groups(tail);
  const all = [...h, ...Array<string>(8 - h.length - t.length).fill('0'), ...t];
  const bytes = new Uint8Array(16);
  all.forEach((g, i) => {
    const n = parseInt(g, 16);
    bytes[i * 2] = n >> 8;
    bytes[i * 2 + 1] = n & 0xff;
  });
  return { family: 6, bytes };
}

export function formatIp(ip: Ip): string {
  if (ip.family === 4) return ip.bytes.join('.');
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) {
    groups.push((((ip.bytes[i] ?? 0) << 8) | (ip.bytes[i + 1] ?? 0)).toString(16));
  }
  // Compress the longest run of zero groups, as RFC 5952 says.
  let best = -1;
  let bestLen = 1;
  for (let i = 0; i < 8;) {
    if (groups[i] !== '0') {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === '0') j++;
    if (j - i > bestLen) {
      best = i;
      bestLen = j - i;
    }
    i = j;
  }
  if (best === -1) return groups.join(':');
  return `${groups.slice(0, best).join(':')}::${groups.slice(best + bestLen).join(':')}`;
}

export interface Range {
  ip: Ip;
  prefix: number;
}

/** Parses `address/prefix` or a bare address (a single-address range); null if invalid. */
export function parseRange(text: string): Range | null {
  const slash = text.indexOf('/');
  const ip = parseIp(slash === -1 ? text : text.slice(0, slash));
  if (ip === null) return null;
  const max = ip.family === 4 ? 32 : 128;
  if (slash === -1) return { ip, prefix: max };
  const p = text.slice(slash + 1);
  if (!/^\d{1,3}$/.test(p) || Number(p) > max) return null;
  return { ip, prefix: Number(p) };
}

export function inRange(ip: Ip, r: Range): boolean {
  if (ip.family !== r.ip.family) return false;
  const full = r.prefix >> 3;
  for (let i = 0; i < full; i++) if (ip.bytes[i] !== r.ip.bytes[i]) return false;
  const rest = r.prefix & 7;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return ((ip.bytes[full] ?? 0) & mask) === ((r.ip.bytes[full] ?? 0) & mask);
}

const range = (text: string): Range => {
  const r = parseRange(text);
  /* v8 ignore next */
  if (r === null) throw new Error(`bad built-in range ${text}`);
  return r;
};

/** IPv6 ranges whose addresses carry an IPv4 address, and where it sits. */
const EMBEDDING: { range: Range; offset: number }[] = [
  { range: range('::ffff:0:0/96'), offset: 12 }, // IPv4-mapped
  { range: range('64:ff9b::/96'), offset: 12 }, // NAT64, well-known prefix
  { range: range('2002::/16'), offset: 2 }, // 6to4
];

/** Refused ranges, most specific first. */
const REFUSED: [Range, string][] = (
  [
    ['0.0.0.0/8', '"this network"'],
    ['10.0.0.0/8', 'private'],
    ['100.64.0.0/10', 'carrier-grade NAT'],
    ['127.0.0.0/8', 'loopback'],
    ['169.254.0.0/16', 'link-local'],
    ['172.16.0.0/12', 'private'],
    ['192.0.0.0/24', 'IETF protocol assignment'],
    ['192.0.2.0/24', 'documentation'],
    ['192.88.99.0/24', '6to4 relay'],
    ['192.168.0.0/16', 'private'],
    ['198.18.0.0/15', 'benchmarking'],
    ['198.51.100.0/24', 'documentation'],
    ['203.0.113.0/24', 'documentation'],
    ['224.0.0.0/4', 'multicast'],
    ['240.0.0.0/4', 'reserved'],
    ['::/128', 'unspecified'],
    ['::1/128', 'loopback'],
    ['::/96', 'IPv4-compatible (deprecated)'],
    ['64:ff9b:1::/48', 'local-use NAT64'],
    ['100::/64', 'discard-only'],
    ['2001::/23', 'IETF protocol assignment'],
    ['2001:db8::/32', 'documentation'],
    ['fc00::/7', 'unique local (private)'],
    ['fe80::/10', 'link-local'],
    ['fec0::/10', 'site-local (deprecated)'],
    ['ff00::/8', 'multicast'],
  ] as const
).map(([r, label]) => [range(r), label]);

/** What kind of non-public address this is, or null for a public one. */
export function refusedKind(ip: Ip): string | null {
  if (ip.family === 6) {
    for (const e of EMBEDDING) {
      if (!inRange(ip, e.range)) continue;
      const inner = refusedKind({ family: 4, bytes: ip.bytes.slice(e.offset, e.offset + 4) });
      return inner === null ? null : `${inner}, embedded in IPv6`;
    }
  }
  for (const [r, label] of REFUSED) if (inRange(ip, r)) return label;
  return null;
}

/** The IPv4 address behind an IPv4-mapped IPv6 one, so allow-list ranges match it. */
function unmapped(ip: Ip): Ip {
  const mapped = EMBEDDING[0];
  if (ip.family === 6 && mapped !== undefined && inRange(ip, mapped.range)) {
    return { family: 4, bytes: ip.bytes.slice(12, 16) };
  }
  return ip;
}

const HOST_NAME =
  /^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*$/;

export type AllowEntry = { kind: 'range'; range: Range } | { kind: 'host'; name: string };

/**
 * Parses allow-list entries: an address (`10.0.0.7`, `::1`), a range
 * (`10.0.0.0/8`, `fd00::/8`) or an exact host name (`receiver.internal`),
 * which lets that name through whatever it resolves to.
 */
export function parseAllowEntry(text: string): AllowEntry | null {
  const s = text.trim().toLowerCase();
  if (s === '') return null;
  const r = parseRange(s);
  if (r !== null) return { kind: 'range', range: r };
  if (s.includes('/') || /^[\d.]+$/.test(s)) return null;
  const name = s.endsWith('.') ? s.slice(0, -1) : s;
  return HOST_NAME.test(name) ? { kind: 'host', name } : null;
}

export const ALLOW_SETTING = 'FLAGSHIP_WEBHOOK_ALLOWED_TARGETS';

/** Thrown, or passed to a lookup callback, when a connection is not allowed. */
export class EgressRefused extends Error {
  readonly code = 'EGRESS_REFUSED';
  constructor(message: string) {
    super(message);
    this.name = 'EgressRefused';
  }
}

type Resolve = (
  hostname: string,
  options: { family?: LookupOptions['family'] | undefined; hints?: number | undefined },
) => Promise<LookupAddress[]>;

const systemResolve: Resolve = (hostname, options) =>
  dns.promises.lookup(hostname, { ...options, all: true });

const isLocalhostName = (host: string) => host === 'localhost' || host.endsWith('.localhost');

export class EgressPolicy {
  private readonly ranges: Range[] = [];
  private readonly hosts = new Set<string>();
  private readonly resolve: Resolve;

  /** Throws for an entry parseAllowEntry rejects. */
  constructor(allow: readonly string[] = [], o: { resolve?: Resolve } = {}) {
    for (const text of allow) {
      const e = parseAllowEntry(text);
      if (e === null) throw new Error(`not an address, range or host name: "${text}"`);
      if (e.kind === 'range') this.ranges.push(e.range);
      else this.hosts.add(e.name);
    }
    this.resolve = o.resolve ?? systemResolve;
  }

  private hostAllowed(hostname: string | undefined): boolean {
    if (hostname === undefined) return false;
    const h = hostname.toLowerCase();
    return this.hosts.has(h.endsWith('.') ? h.slice(0, -1) : h);
  }

  /** Why connecting to `address` (resolved from `hostname`) is refused, or null if allowed. */
  refusal(address: string, hostname?: string): string | null {
    const parsed = parseIp(address);
    if (parsed === null) return `"${address}" is not an IP address`;
    if (this.hostAllowed(hostname)) return null;
    const ip = unmapped(parsed);
    if (this.ranges.some((r) => inRange(ip, r))) return null;
    const kind = refusedKind(ip);
    if (kind === null) return null;
    const via =
      hostname === undefined || parseIp(hostname) !== null ? '' : ` (resolved from ${hostname})`;
    return (
      `refusing to connect to ${formatIp(parsed)}${via}: a ${kind} address; ` +
      `list it in ${ALLOW_SETTING} to allow it`
    );
  }

  /**
   * Checks what can be checked without DNS: a literal address, or a
   * `localhost` name. Null when the URL may go ahead to resolution.
   */
  urlRefusal(url: URL): string | null {
    const host = url.hostname.toLowerCase();
    if (parseIp(host) !== null) return this.refusal(host, host);
    if (isLocalhostName(host.endsWith('.') ? host.slice(0, -1) : host) && !this.hostAllowed(host)) {
      return `refusing to connect to ${host}: a loopback name; list it in ${ALLOW_SETTING} to allow it`;
    }
    return null;
  }

  /**
   * A drop-in for dns.lookup on a socket: resolves every address, refuses
   * the connection if any of them is not allowed, and otherwise answers in
   * the shape the caller asked for (one address, or all with `all: true`).
   */
  readonly lookup: LookupFunction = (hostname, options, callback) => {
    this.resolve(hostname, { family: options.family, hints: options.hints }).then(
      (addresses) => {
        for (const a of addresses) {
          const why = this.refusal(a.address, hostname);
          if (why !== null) {
            callback(new EgressRefused(why), '', 0);
            return;
          }
        }
        const first = addresses[0];
        if (first === undefined) {
          const err: NodeJS.ErrnoException = new Error(`no addresses for ${hostname}`);
          err.code = 'ENOTFOUND';
          callback(err, '', 0);
        } else if (options.all === true) {
          (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
        } else callback(null, first.address, first.family);
      },
      (err: unknown) => {
        callback(err as NodeJS.ErrnoException, '', 0);
      },
    );
  };
}
