/** Attributes of the current user. `key` identifies them. */
export type Context = { key: string } & Record<
  string,
  string | number | boolean | null | (string | number | boolean)[]
>;

export type Value = null | boolean | number | string | Value[] | { [k: string]: Value };

/** PROVIDER_NOT_READY, FLAG_NOT_FOUND, TYPE_MISMATCH, or a code the server reported. */
export type ErrorCode = string;

export interface Detail<T> {
  value: T;
  variant?: string;
  reason: string;
  errorCode?: ErrorCode;
}

interface Evaluated {
  value?: Value;
  variant?: string;
  reason: string;
  errorCode?: string;
}

export interface BrowserClientOptions {
  /** A client key (fsc_...). It is public by design: it can only read evaluated values. */
  clientKey: string;
  baseUrl: string;
  context: Context;
  /** Refetch when flags change, over Server-Sent Events (default true). */
  streaming?: boolean;
  /** Send counts of served variants (default true). */
  sendExposures?: boolean;
  exposureFlushMs?: number;
  /** Distinct flag/variant pairs held between flushes (1,000). */
  maxExposureKeys?: number;
  fetch?: typeof fetch;
  EventSource?: typeof EventSource;
  sendBeacon?: (url: string, data: Blob) => boolean;
}

export type Listener = (changedKeys: string[]) => void;

/**
 * Client-side flags. The server evaluates the rules for the current context
 * and returns values only; this client caches them so reads are synchronous
 * at render time. A client stream says when the ruleset version changes, and
 * the client refetches.
 */
export class BrowserClient {
  private flags: Record<string, Evaluated> = {};
  private version = -1;
  private loaded = false;
  private context: Context;
  private seq = 0;
  private source: EventSource | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly readyWaiters: (() => void)[] = [];
  private exposures = new Map<string, number>();
  private closed = false;
  private readonly o: Required<
    Omit<BrowserClientOptions, 'EventSource' | 'sendBeacon' | 'context'>
  > & {
    EventSource: typeof EventSource | undefined;
    sendBeacon: ((url: string, data: Blob) => boolean) | undefined;
  };
  private readonly onHide = () => {
    if (document.visibilityState === 'hidden') this.beacon();
  };

  constructor(options: BrowserClientOptions) {
    if (!options.clientKey.startsWith('fsc_')) {
      throw new TypeError(
        'clientKey must be a client key (fsc_...); never ship a server key to a browser',
      );
    }
    this.context = options.context;
    this.o = {
      streaming: true,
      sendExposures: true,
      exposureFlushMs: 10_000,
      maxExposureKeys: 1000,
      fetch: globalThis.fetch.bind(globalThis),
      ...options,
      baseUrl: options.baseUrl.replace(/\/+$/, ''),
      EventSource: options.EventSource ?? globalThis.EventSource,
      sendBeacon:
        options.sendBeacon ??
        (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function'
          ? navigator.sendBeacon.bind(navigator)
          : undefined),
    };
    void this.refresh();
    if (this.o.streaming && this.o.EventSource !== undefined) this.listen(this.o.EventSource);
    if (this.o.sendExposures) {
      this.timer = setInterval(() => {
        void this.flush();
      }, this.o.exposureFlushMs);
      if (typeof document !== 'undefined')
        document.addEventListener('visibilitychange', this.onHide);
    }
  }

  /** Resolves true once values for the current context have loaded. */
  ready(timeoutMs = 5000): Promise<boolean> {
    if (this.loaded) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve(false);
      }, timeoutMs);
      this.readyWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /** Switches to another user and loads their values. Responses for the old one are ignored. */
  async identify(context: Context): Promise<void> {
    this.context = context;
    await this.refresh();
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  detail<T extends Value>(
    key: string,
    fallback: T,
    check: (v: Value) => boolean = () => true,
  ): Detail<T> {
    if (!this.loaded) return { value: fallback, reason: 'ERROR', errorCode: 'PROVIDER_NOT_READY' };
    const e = Object.hasOwn(this.flags, key) ? this.flags[key] : undefined;
    if (e === undefined) return { value: fallback, reason: 'ERROR', errorCode: 'FLAG_NOT_FOUND' };
    if (e.reason === 'ERROR' || e.value === undefined) {
      return { value: fallback, reason: 'ERROR', errorCode: e.errorCode ?? 'GENERAL' };
    }
    if (!check(e.value)) return { value: fallback, reason: 'ERROR', errorCode: 'TYPE_MISMATCH' };
    if (e.variant !== undefined) this.record(key, e.variant);
    const d: Detail<T> = { value: e.value as T, reason: e.reason };
    if (e.variant !== undefined) d.variant = e.variant;
    return d;
  }

  boolVariation(key: string, fallback: boolean): boolean {
    return this.detail(key, fallback, (v) => typeof v === 'boolean').value;
  }

  stringVariation(key: string, fallback: string): string {
    return this.detail(key, fallback, (v) => typeof v === 'string').value;
  }

  numberVariation(key: string, fallback: number): number {
    return this.detail(key, fallback, (v) => typeof v === 'number').value;
  }

  jsonVariation<T extends Value>(key: string, fallback: T): T {
    return this.detail(key, fallback).value;
  }

  /** Every flag value for the current context, for debugging panels. */
  all(): Record<string, Value> {
    const out: Record<string, Value> = {};
    for (const [k, e] of Object.entries(this.flags)) if (e.value !== undefined) out[k] = e.value;
    return out;
  }

  private listen(ES: typeof EventSource): void {
    const url = `${this.o.baseUrl}/sdk/v1/client-stream?key=${encodeURIComponent(this.o.clientKey)}`;
    this.source = new ES(url);
    this.source.addEventListener('version', (event) => {
      const version = Number(
        (JSON.parse((event as MessageEvent<string>).data) as { version: unknown }).version,
      );
      if (Number.isFinite(version) && version > this.version) void this.refresh();
    });
  }

  private async refresh(): Promise<void> {
    const seq = ++this.seq;
    const context = this.context;
    try {
      const res = await this.o.fetch(`${this.o.baseUrl}/sdk/v1/evaluate`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.o.clientKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ context }),
      });
      if (!res.ok) return;
      const body = (await res.json()) as { version: number; flags: Record<string, Evaluated> };
      // A newer request (another identify, or a later version) has been sent since.
      if (seq !== this.seq || this.closed) return;
      const before = this.flags;
      this.flags = body.flags;
      this.version = body.version;
      const first = !this.loaded;
      this.loaded = true;
      if (first) for (const w of this.readyWaiters.splice(0)) w();
      const keys = [...new Set([...Object.keys(before), ...Object.keys(body.flags)])].filter(
        (k) => JSON.stringify(before[k]) !== JSON.stringify(body.flags[k]),
      );
      if (!first && keys.length > 0) for (const l of this.listeners) l(keys);
    } catch {
      // Offline or server down: keep the values we have (or the caller defaults).
    }
  }

  private record(flag: string, variant: string): void {
    if (!this.o.sendExposures || this.closed) return;
    const key = `${flag}\u0000${variant}`;
    const n = this.exposures.get(key);
    if (n !== undefined) this.exposures.set(key, n + 1);
    else if (this.exposures.size < this.o.maxExposureKeys) this.exposures.set(key, 1);
  }

  private take(): { flag: string; variant: string; count: number }[] {
    const events = [...this.exposures].map(([k, count]) => {
      const [flag = '', variant = ''] = k.split('\u0000');
      return { flag, variant, count };
    });
    this.exposures = new Map();
    return events;
  }

  private putBack(events: { flag: string; variant: string; count: number }[]): void {
    for (const e of events) {
      const key = `${e.flag}\u0000${e.variant}`;
      const n = this.exposures.get(key);
      if (n !== undefined) this.exposures.set(key, n + e.count);
      else if (this.exposures.size < this.o.maxExposureKeys) this.exposures.set(key, e.count);
    }
  }

  /** Sends pending exposure counts. */
  async flush(): Promise<void> {
    const events = this.take();
    if (events.length === 0) return;
    try {
      const res = await this.o.fetch(`${this.o.baseUrl}/sdk/v1/events`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.o.clientKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ events }),
        keepalive: true,
      });
      if (res.status === 429 || res.status >= 500) this.putBack(events);
    } catch {
      this.putBack(events);
    }
  }

  /**
   * Last-chance delivery when the page is hidden. sendBeacon can't set
   * headers, so the (public) client key goes in the query string and the
   * body is sent as text/plain, which needs no CORS preflight.
   */
  private beacon(): void {
    if (this.o.sendBeacon === undefined) return;
    const events = this.take();
    if (events.length === 0) return;
    const url = `${this.o.baseUrl}/sdk/v1/events?key=${encodeURIComponent(this.o.clientKey)}`;
    const ok = this.o.sendBeacon(
      url,
      new Blob([JSON.stringify({ events })], { type: 'text/plain' }),
    );
    if (!ok) this.putBack(events);
  }

  close(): void {
    if (this.closed) return;
    this.beacon();
    this.closed = true;
    this.source?.close();
    if (this.timer !== null) clearInterval(this.timer);
    if (typeof document !== 'undefined')
      document.removeEventListener('visibilitychange', this.onHide);
  }
}

export function createClient(options: BrowserClientOptions): BrowserClient {
  return new BrowserClient(options);
}
