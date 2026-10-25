import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserClient, createClient, type Context } from './client.js';

type Flags = Record<
  string,
  { value?: unknown; variant?: string; reason: string; errorCode?: string }
>;

class FakeEventSource {
  static last: FakeEventSource | undefined;
  readonly listeners = new Map<string, ((e: MessageEvent<string>) => void)[]>();
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(name: string, fn: (e: MessageEvent<string>) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
  }
  emit(name: string, data: unknown): void {
    for (const fn of this.listeners.get(name) ?? [])
      fn({ data: JSON.stringify(data) } as MessageEvent<string>);
  }
  close(): void {
    this.closed = true;
  }
}

/** A fake server: answers /evaluate from `answer(context)` and records /events posts. */
function fakeServer(answer: (ctx: Context) => { version: number; flags: Flags } | 'fail' | number) {
  const events: unknown[] = [];
  const pending: (() => void)[] = [];
  let hold = false;
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const u = url;
    const body = JSON.parse(init?.body as string) as { context?: Context; events?: unknown[] };
    if (u.endsWith('/sdk/v1/events')) {
      events.push(...(body.events ?? []));
      return new Response('{}', { status: 202 });
    }
    if (hold) await new Promise<void>((r) => pending.push(r));
    const a = answer(body.context as Context);
    if (a === 'fail') throw new TypeError('network down');
    if (typeof a === 'number') return new Response('{}', { status: a });
    return new Response(JSON.stringify(a), { status: 200 });
  });
  return {
    fetch: fetchFn as unknown as typeof fetch,
    events,
    hold: () => {
      hold = true;
    },
    release: () => {
      hold = false;
      for (const r of pending.splice(0)) r();
    },
  };
}

const flags = (on: boolean): Flags => ({
  checkout: { value: on, variant: on ? 'on' : 'off', reason: 'DEFAULT' },
  banner: { value: 'Hello', variant: 'b', reason: 'TARGETING_MATCH' },
  limits: { value: { max: 3 }, variant: 'x', reason: 'DEFAULT' },
  broken: { reason: 'ERROR', errorCode: 'MALFORMED_FLAG' },
});

const clients: BrowserClient[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
});

function make(
  server: ReturnType<typeof fakeServer>,
  extra: Partial<ConstructorParameters<typeof BrowserClient>[0]> = {},
) {
  const c = createClient({
    clientKey: 'fsc_test',
    baseUrl: 'https://flags.example/',
    context: { key: 'alice' },
    fetch: server.fetch,
    EventSource: FakeEventSource as unknown as typeof EventSource,
    exposureFlushMs: 60_000,
    ...extra,
  });
  clients.push(c);
  return c;
}

describe('BrowserClient', () => {
  it('returns defaults until ready, then cached values synchronously', async () => {
    const server = fakeServer(() => ({ version: 1, flags: flags(true) }));
    const c = make(server);
    expect(c.detail('checkout', false)).toEqual({
      value: false,
      reason: 'ERROR',
      errorCode: 'PROVIDER_NOT_READY',
    });
    expect(await c.ready()).toBe(true);
    expect(await c.ready()).toBe(true);
    expect(c.boolVariation('checkout', false)).toBe(true);
    expect(c.stringVariation('banner', 'x')).toBe('Hello');
    expect(c.jsonVariation('limits', {})).toEqual({ max: 3 });
    expect(c.numberVariation('banner', 1)).toBe(1);
    expect(c.detail('banner', 1, (v) => typeof v === 'number').errorCode).toBe('TYPE_MISMATCH');
    expect(c.detail('nope', true)).toEqual({
      value: true,
      reason: 'ERROR',
      errorCode: 'FLAG_NOT_FOUND',
    });
    expect(c.detail('broken', true).errorCode).toBe('MALFORMED_FLAG');
    expect(c.all()).toEqual({ checkout: true, banner: 'Hello', limits: { max: 3 } });
    expect(FakeEventSource.last?.url).toBe(
      'https://flags.example/sdk/v1/client-stream?key=fsc_test',
    );
  });

  it('refetches when the stream reports a newer version and tells listeners what changed', async () => {
    let on = false;
    let version = 1;
    const server = fakeServer(() => ({ version, flags: flags(on) }));
    const c = make(server);
    await c.ready();
    const changes: string[][] = [];
    c.on((keys) => changes.push(keys));
    FakeEventSource.last?.emit('version', { version: 1 });
    await Promise.resolve();
    expect(server.fetch).toHaveBeenCalledTimes(1);
    on = true;
    version = 2;
    FakeEventSource.last?.emit('version', { version: 2 });
    await vi.waitFor(() => {
      expect(c.boolVariation('checkout', false)).toBe(true);
    });
    expect(changes).toEqual([['checkout']]);
  });

  it('ignores a slow response for a user it has since switched away from', async () => {
    const server = fakeServer((ctx) => ({ version: 1, flags: flags(ctx.key === 'bob') }));
    const c = make(server, { streaming: false });
    await c.ready();
    server.hold();
    const toCarol = c.identify({ key: 'carol' });
    server.release();
    server.hold();
    const toBob = c.identify({ key: 'bob' });
    server.release();
    await Promise.all([toCarol, toBob]);
    expect(c.boolVariation('checkout', false)).toBe(true);
  });

  it('keeps defaults or last values when the server is unreachable or refuses', async () => {
    let mode: 'fail' | 'ok' | 500 = 'fail';
    const server = fakeServer(() => (mode === 'ok' ? { version: 1, flags: flags(true) } : mode));
    const c = make(server, { streaming: false });
    expect(await c.ready(50)).toBe(false);
    expect(c.boolVariation('checkout', false)).toBe(false);
    mode = 'ok';
    await c.identify({ key: 'alice' });
    mode = 500;
    await c.identify({ key: 'alice' });
    expect(c.boolVariation('checkout', false)).toBe(true);
  });

  it('counts exposures, flushes them, and keeps them through a failure', async () => {
    const server = fakeServer(() => ({ version: 1, flags: flags(true) }));
    const c = make(server, { maxExposureKeys: 2 });
    await c.ready();
    c.boolVariation('checkout', false);
    c.boolVariation('checkout', false);
    c.stringVariation('banner', '');
    c.jsonVariation('limits', {});
    await c.flush();
    expect(server.events).toEqual([
      { flag: 'checkout', variant: 'on', count: 2 },
      { flag: 'banner', variant: 'b', count: 1 },
    ]);
    await c.flush();
    expect(server.events).toHaveLength(2);

    const failing = vi.fn(async () => new Response('{}', { status: 503 }));
    const d = make(fakeServer(() => ({ version: 1, flags: flags(true) })));
    await d.ready();
    d.boolVariation('checkout', false);
    (d as unknown as { o: { fetch: typeof fetch } }).o.fetch = failing;
    await d.flush();
    (d as unknown as { o: { fetch: typeof fetch } }).o.fetch = vi.fn(async () => {
      throw new TypeError('offline');
    });
    await d.flush();
    const beacons: string[] = [];
    (d as unknown as { o: { sendBeacon: (u: string, b: Blob) => boolean } }).o.sendBeacon = (u) => {
      beacons.push(u);
      return true;
    };
    d.close();
    expect(beacons).toEqual(['https://flags.example/sdk/v1/events?key=fsc_test']);
  });

  it('sends a beacon when the page is hidden and on close', async () => {
    const sent: { url: string; body: string }[] = [];
    const server = fakeServer(() => ({ version: 1, flags: flags(true) }));
    let accept = false;
    const c = make(server, {
      sendBeacon: (url, blob) => {
        void blob.text().then((body) => sent.push({ url, body }));
        return accept;
      },
    });
    await c.ready();
    c.boolVariation('checkout', false);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    accept = true;
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => {
      expect(sent).toHaveLength(2);
    });
    expect(JSON.parse(sent[1]?.body ?? '')).toEqual({
      events: [{ flag: 'checkout', variant: 'on', count: 1 }],
    });
    c.close();
    c.close();
    expect(FakeEventSource.last?.closed).toBe(true);
    c.boolVariation('checkout', false);
    expect(sent).toHaveLength(2);
  });

  it('refuses server keys', () => {
    expect(() =>
      createClient({ clientKey: 'fss_x', baseUrl: 'https://x', context: { key: 'a' } }),
    ).toThrow(/client key/);
  });

  it('uses the browser globals by default', async () => {
    const server = fakeServer(() => ({ version: 1, flags: flags(true) }));
    vi.stubGlobal('fetch', server.fetch);
    vi.stubGlobal('EventSource', FakeEventSource);
    const beacon = vi.fn(() => true);
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true });
    const c = createClient({ clientKey: 'fsc_x', baseUrl: 'https://x', context: { key: 'a' } });
    clients.push(c);
    expect(await c.ready()).toBe(true);
    c.boolVariation('checkout', false);
    c.close();
    expect(beacon).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
