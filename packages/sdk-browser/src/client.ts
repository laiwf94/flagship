import { canonicalJson, sha256Hex } from './checksum.js';

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
  /**
   * First exposures and conversions held between flushes (1,000). A first
   * exposure is sent once per user and flag, only when a percentage split
   * bucketed the user, so experiment results can attribute conversions.
   */
  maxEvents?: number;
  /** First and largest delay before refetching an answer that failed its checksum (1 s, 30 s). */
  retryMs?: { initial: number; max: number };
  fetch?: typeof fetch;
  EventSource?: typeof EventSource;
  sendBeacon?: (url: string, data: Blob) => boolean;
  /** WebCrypto, used to verify answers; defaults to globalThis.crypto.subtle when there is one. */
  subtle?: SubtleCrypto;
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
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private checksumFailures = 0;
  private readonly listeners = new Set<Listener>();
  private readonly readyWaiters: (() => void)[] = [];
  private exposures = new Map<string, number>();
  private firstExposures = new Map<string, FirstExposure>();
  /** Flag and user pairs already reported, oldest first. */
  private seen = new Set<string>();
  private conversions: Conversion[] = [];
  private closed = false;
  private readonly o: Required<
    Omit<BrowserClientOptions, 'EventSource' | 'sendBeacon' | 'context' | 'subtle'>
  > & {
    EventSource: typeof EventSource | undefined;
    sendBeacon: ((url: string, data: Blob) => boolean) | undefined;
    subtle: SubtleCrypto | undefined;
  };
  /**
   * Answers refetched because they did not match the checksum the server
   * sent. The values from before stay in use until a verified answer arrives.
   */
  resyncs = 0;
  /** First exposures and conversions discarded because the buffer was full. */
  droppedEvents = 0;
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
      maxEvents: 1000,
      retryMs: { initial: 1000, max: 30_000 },
      fetch: globalThis.fetch.bind(globalThis),
      ...options,
      baseUrl: options.baseUrl.replace(/\/+$/, ''),
      EventSource: options.EventSource ?? globalThis.EventSource,
      sendBeacon:
        options.sendBeacon ??
        (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function'
          ? navigator.sendBeacon.bind(navigator)
          : undefined),
      subtle: options.subtle ?? (globalThis.crypto as Crypto | undefined)?.subtle,
    };
    void this.refresh();
    if (this.o.streaming && this.o.EventSource !== undefined) this.listen(this.o.EventSource);
    // Conversions are sent even with sendExposures off, so the timer always runs.
    this.timer = setInterval(() => {
      void this.flush();
    }, this.o.exposureFlushMs);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onHide);
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
    if (e.variant !== undefined) {
      this.record(key, e.variant);
      if (e.reason === 'SPLIT') this.recordFirst(key, e.variant);
    }
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

  /**
   * Records a conversion for the current user, such as a purchase. Experiment
   * results count it for the variant of each flag the user was first served.
   * Returns false, and records nothing, if the event key or value is invalid,
   * the buffer is full, or the client is closed.
   */
  track(event: string, value?: number): boolean {
    if (this.closed || !EVENT_KEY.test(event) || !validContextKey(this.context.key)) return false;
    if (value !== undefined && !(Number.isFinite(value) && Math.abs(value) <= 1e15)) return false;
    if (this.firstExposures.size + this.conversions.length >= this.o.maxEvents) {
      this.droppedEvents++;
      return false;
    }
    const c: Conversion = { id: eventId(), event, key: this.context.key, at: Date.now() };
    if (value !== undefined) c.value = value;
    this.conversions.push(c);
    return true;
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
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
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
      const body = (await res.json()) as {
        version: number;
        flags: Record<string, Evaluated>;
        checksum?: unknown;
      };
      const actual =
        typeof body.checksum === 'string'
          ? await sha256Hex(canonicalJson(body.flags), this.o.subtle)
          : undefined;
      // A newer request (another identify, or a later version) has been sent since.
      if (seq !== this.seq || this.closed) return;
      if (actual !== undefined && actual !== body.checksum) {
        this.retry();
        return;
      }
      this.checksumFailures = 0;
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

  /** Fetches again after a garbled answer, backing off while they keep coming. */
  private retry(): void {
    this.resyncs++;
    const { initial, max } = this.o.retryMs;
    const delay = Math.min(max, initial * 2 ** Math.min(this.checksumFailures, 20));
    this.checksumFailures++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.refresh();
    }, delay);
  }

  private record(flag: string, variant: string): void {
    if (!this.o.sendExposures || this.closed) return;
    const key = `${flag}\u0000${variant}`;
    const n = this.exposures.get(key);
    if (n !== undefined) this.exposures.set(key, n + 1);
    else if (this.exposures.size < this.o.maxExposureKeys) this.exposures.set(key, 1);
  }

  private recordFirst(flag: string, variant: string): void {
    const contextKey = this.context.key;
    if (!this.o.sendExposures || this.closed || !validContextKey(contextKey)) return;
    const key = `${flag}\u0000${contextKey}`;
    if (this.seen.has(key)) return;
    if (this.firstExposures.size + this.conversions.length >= this.o.maxEvents) {
      this.droppedEvents++;
      return;
    }
    // Forgetting the oldest only means a user may be reported twice; the server keeps the first.
    if (this.seen.size >= SEEN_LIMIT) {
      const oldest = this.seen.values().next();
      if (oldest.done !== true) this.seen.delete(oldest.value);
    }
    this.seen.add(key);
    this.firstExposures.set(key, { flag, variant, key: contextKey, at: Date.now() });
  }

  private take(): EventBatch {
    const batch: EventBatch = {
      events: [...this.exposures].map(([k, count]) => {
        const [flag = '', variant = ''] = k.split('\u0000');
        return { flag, variant, count };
      }),
      exposures: [...this.firstExposures.values()],
      conversions: this.conversions,
    };
    this.exposures = new Map();
    this.firstExposures = new Map();
    this.conversions = [];
    return batch;
  }

  private putBack(r: Partial<EventBatch>): void {
    for (const e of r.events ?? []) {
      const key = `${e.flag}\u0000${e.variant}`;
      const n = this.exposures.get(key);
      if (n !== undefined) this.exposures.set(key, n + e.count);
      else if (this.exposures.size < this.o.maxExposureKeys) this.exposures.set(key, e.count);
    }
    const room = () => this.firstExposures.size + this.conversions.length < this.o.maxEvents;
    for (const e of r.exposures ?? []) {
      const key = `${e.flag}\u0000${e.key}`;
      const pending = this.firstExposures.get(key);
      if (pending !== undefined) {
        if (e.at < pending.at) this.firstExposures.set(key, e);
      } else if (room()) this.firstExposures.set(key, e);
      else this.droppedEvents++;
    }
    for (const c of r.conversions ?? []) {
      if (room()) this.conversions.push(c);
      else this.droppedEvents++;
    }
  }

  /** Sends pending exposure counts, first exposures and conversions. */
  async flush(): Promise<void> {
    const requests = packEvents(this.take(), 200_000);
    for (let i = 0; i < requests.length; i++) {
      try {
        const res = await this.o.fetch(`${this.o.baseUrl}/sdk/v1/events`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.o.clientKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(requests[i]),
          keepalive: true,
        });
        if (res.status === 429 || res.status >= 500) {
          for (const r of requests.slice(i)) this.putBack(r);
          return;
        }
      } catch {
        for (const r of requests.slice(i)) this.putBack(r);
        return;
      }
    }
  }

  /**
   * Last-chance delivery when the page is hidden. sendBeacon can't set
   * headers, so the (public) client key goes in the query string and the
   * body is sent as text/plain, which needs no CORS preflight. Browsers cap a
   * beacon at about 64 KB, so large batches go as several.
   */
  private beacon(): void {
    if (this.o.sendBeacon === undefined) return;
    const requests = packEvents(this.take(), 60_000);
    const url = `${this.o.baseUrl}/sdk/v1/events?key=${encodeURIComponent(this.o.clientKey)}`;
    for (let i = 0; i < requests.length; i++) {
      const body = new Blob([JSON.stringify(requests[i])], { type: 'text/plain' });
      if (!this.o.sendBeacon(url, body)) {
        for (const r of requests.slice(i)) this.putBack(r);
        return;
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.beacon();
    this.closed = true;
    this.source?.close();
    if (this.timer !== null) clearInterval(this.timer);
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    if (typeof document !== 'undefined')
      document.removeEventListener('visibilitychange', this.onHide);
  }
}

interface CountEvent {
  flag: string;
  variant: string;
  count: number;
}

interface FirstExposure {
  flag: string;
  variant: string;
  key: string;
  at: number;
}

interface Conversion {
  id: string;
  event: string;
  key: string;
  value?: number;
  at: number;
}

interface EventBatch {
  events: CountEvent[];
  exposures: FirstExposure[];
  conversions: Conversion[];
}

const EVENT_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SEEN_LIMIT = 1000;

/** The server takes context keys of 1 to 1,024 characters. */
function validContextKey(key: unknown): boolean {
  return typeof key === 'string' && key.length > 0 && key.length <= 1024;
}

/** A random id for a conversion, so a retried request is stored once. */
function eventId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof c?.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Splits pending events into request bodies of at most 1,000 items and about
 * `maxBytes` of JSON. Empty lists are left out.
 */
export function packEvents(batch: EventBatch, maxBytes: number): Partial<EventBatch>[] {
  const out: Partial<EventBatch>[] = [];
  let current: EventBatch = { events: [], exposures: [], conversions: [] };
  let items = 0;
  let bytes = 0;
  const finish = () => {
    if (items === 0) return;
    const body: Partial<EventBatch> = {};
    if (current.events.length > 0) body.events = current.events;
    if (current.exposures.length > 0) body.exposures = current.exposures;
    if (current.conversions.length > 0) body.conversions = current.conversions;
    out.push(body);
    current = { events: [], exposures: [], conversions: [] };
    items = 0;
    bytes = 0;
  };
  const add = <K extends keyof EventBatch>(list: K, item: EventBatch[K][number]) => {
    const size = JSON.stringify(item).length + 1;
    if (items >= 1000 || (items > 0 && bytes + size > maxBytes)) finish();
    (current[list] as EventBatch[K][number][]).push(item);
    items++;
    bytes += size;
  };
  for (const e of batch.events) add('events', e);
  for (const e of batch.exposures) add('exposures', e);
  for (const c of batch.conversions) add('conversions', c);
  finish();
  return out;
}

export function createClient(options: BrowserClientOptions): BrowserClient {
  return new BrowserClient(options);
}
