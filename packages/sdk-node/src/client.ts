import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  RulesetDigest,
  evaluate,
  keySchema,
  own,
  validateFlag,
  validateRuleset,
  validateSegment,
  type Context,
  type ContextValue,
  type Flag,
  type Ruleset,
  type Segment,
} from '@flagship/core';
import { SseParser, type SseMessage } from './sse.js';

type JsonValue = Flag['variants'][number]['value'];

export interface Logger {
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface ClientOptions {
  /** A server key (fss_...) for the environment to evaluate. */
  sdkKey: string;
  /** Where the flagship server is, e.g. https://flags.example.com */
  baseUrl: string;
  /** Receive changes over SSE (default). When false, poll with ETags. */
  streaming?: boolean;
  /** Poll interval when streaming is off or the stream is down (30 s). */
  pollIntervalMs?: number;
  /** Timeout for one-shot requests (10 s). */
  requestTimeoutMs?: number;
  /** Reconnect if the stream is silent this long; the server pings every 15 s (60 s). */
  streamIdleTimeoutMs?: number;
  /** First and largest delay between stream reconnects (1 s, 30 s); jittered. */
  reconnectMs?: { initial: number; max: number };
  /** Report which variants were served, so the UI can show counts (true). */
  sendExposures?: boolean;
  /** How often exposure counts are sent (10 s). */
  exposureFlushMs?: number;
  /** Distinct flag/variant pairs held between flushes before new ones are dropped (10,000). */
  maxExposureKeys?: number;
  /**
   * First exposures and conversions held between flushes before new ones are
   * dropped (10,000). A first exposure is sent once per context and flag, and
   * only for contexts a percentage split bucketed, so experiment results can
   * attribute conversions to the variant each context saw first.
   */
  maxEvents?: number;
  /** Context and flag pairs remembered as already reported; the oldest are forgotten first (10,000). */
  maxSeenContexts?: number;
  logger?: Logger;
  fetch?: typeof fetch;
}

export type ErrorCode =
  | 'FLAG_NOT_FOUND'
  | 'INVALID_CONTEXT'
  | 'PREREQUISITE_CYCLE'
  | 'MALFORMED_FLAG'
  | 'PROVIDER_NOT_READY'
  | 'TYPE_MISMATCH';

export interface Detail<T> {
  value: T;
  variant?: string;
  reason: string;
  ruleId?: string;
  errorCode?: ErrorCode;
}

/**
 * initializing: no ruleset yet, every call returns the caller's default.
 * ready: we have a ruleset and a live connection (stream or successful poll).
 * stale: we have a ruleset but can't reach the server; we keep using it.
 */
export type Status = 'initializing' | 'ready' | 'stale' | 'closed';

export interface ChangeEvent {
  version: number;
  flags: string[];
  segments: string[];
}

export class AuthError extends Error {}

/** The ruleset or a patch did not match the checksum the server sent with it. */
export class ChecksumError extends Error {}

const sha256 = (text: string): Uint8Array => createHash('sha256').update(text, 'utf8').digest();

const silent: Logger = { warn: () => undefined, error: () => undefined };

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

interface Events {
  ready: [];
  change: [ChangeEvent];
  status: [Status];
  error: [Error];
}

/**
 * Server-side client. Evaluation is local: a call to `variation` reads the
 * in-memory ruleset and never touches the network. The ruleset arrives over
 * SSE (resuming with Last-Event-ID after a drop) or by ETag polling, and the
 * last good copy is kept for as long as the server is unreachable.
 */
export class FlagshipClient extends EventEmitter<Events> {
  private ruleset: Ruleset | undefined;
  /** Entry digests of `ruleset`, so each patch is checked without rehashing everything. */
  private digest: RulesetDigest | undefined;
  /** Checksum failures since the last verified snapshot; drives reconnect backoff. */
  private checksumFailures = 0;
  private etag: string | undefined;
  private lastEventId: string | undefined;
  private state: Status = 'initializing';
  private streamConnected = false;
  private pollOk = false;
  private readonly lifetime = new AbortController();
  private streamAbort: AbortController | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private exposures = new Map<string, number>();
  private exposureWindow = Date.now();
  private exposureRetryAt = 0;
  private exposureFailures = 0;
  /** First exposures waiting to be sent, by flag and context key. */
  private firstExposures = new Map<string, FirstExposure>();
  /** Flag and context pairs already reported, oldest first. */
  private seen = new Set<string>();
  private conversions: Conversion[] = [];
  private flushing: Promise<void> | null = null;
  private readonly o: Required<Omit<ClientOptions, 'logger' | 'fetch'>> & {
    logger: Logger;
    fetch: typeof fetch;
  };
  /** Exposure counts discarded because the buffer was full. */
  droppedExposures = 0;
  /** First exposures and conversions discarded because the buffer was full. */
  droppedEvents = 0;
  /**
   * Full resyncs forced because a snapshot or patch did not match its
   * checksum, or a patch could not be applied. Non-zero means the stream lost
   * or garbled something and the client recovered by fetching it all again.
   */
  resyncs = 0;

  constructor(options: ClientOptions) {
    super();
    if (!/^fss_/.test(options.sdkKey)) {
      throw new TypeError('sdkKey must be a server key (fss_...); browsers use @flagship/browser');
    }
    this.o = {
      streaming: true,
      pollIntervalMs: 30_000,
      requestTimeoutMs: 10_000,
      streamIdleTimeoutMs: 60_000,
      reconnectMs: { initial: 1000, max: 30_000 },
      sendExposures: true,
      exposureFlushMs: 10_000,
      maxExposureKeys: 10_000,
      maxEvents: 10_000,
      maxSeenContexts: 10_000,
      ...options,
      baseUrl: options.baseUrl.replace(/\/+$/, ''),
      logger: options.logger ?? silent,
      fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    };
    // Unhandled 'error' events would crash the process; errors are reported, never thrown.
    this.on('error', () => undefined);
    if (this.o.streaming) void this.streamLoop();
    else this.schedulePoll(0);
    // Conversions are sent even with sendExposures off, so the timer always runs.
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.o.exposureFlushMs);
    this.flushTimer.unref();
  }

  get status(): Status {
    return this.state;
  }

  /** The ruleset version in use, or undefined before the first one arrives. */
  get version(): number | undefined {
    return this.ruleset?.version;
  }

  /** Checksum of the ruleset in use (see RulesetDigest in @flagship/core). */
  get checksum(): string | undefined {
    return this.digest?.checksum;
  }

  /** Resolves true once a ruleset is loaded, false if `timeoutMs` passes first. */
  ready(timeoutMs = 10_000): Promise<boolean> {
    if (this.ruleset !== undefined) return Promise.resolve(true);
    if (this.state === 'closed') return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer);
        this.off('ready', onReady);
        resolve(ok);
      };
      const onReady = () => {
        done(true);
      };
      const timer = setTimeout(() => {
        done(false);
      }, timeoutMs);
      timer.unref();
      this.on('ready', onReady);
    });
  }

  /** Full evaluation result; `fallback` is returned on any error. */
  detail<T extends JsonValue>(flagKey: string, context: Context, fallback: T): Detail<T> {
    if (this.ruleset === undefined) {
      return { value: fallback, reason: 'ERROR', errorCode: 'PROVIDER_NOT_READY' };
    }
    const e = evaluate(this.ruleset, flagKey, context);
    if (e.reason === 'ERROR') return { value: fallback, reason: 'ERROR', errorCode: e.errorCode };
    this.recordExposure(flagKey, e.variant);
    if (e.reason === 'SPLIT') this.recordFirstExposure(flagKey, e.variant, context.key);
    const d: Detail<T> = { value: e.value as T, variant: e.variant, reason: e.reason };
    if (e.ruleId !== undefined) d.ruleId = e.ruleId;
    return d;
  }

  private typed<T extends JsonValue>(
    flagKey: string,
    context: Context,
    fallback: T,
    check: (v: unknown) => boolean,
  ): Detail<T> {
    const d = this.detail<JsonValue>(flagKey, context, fallback);
    if (d.reason !== 'ERROR' && !check(d.value)) {
      return { value: fallback, reason: 'ERROR', errorCode: 'TYPE_MISMATCH' };
    }
    return d as Detail<T>;
  }

  boolDetail(flagKey: string, context: Context, fallback: boolean): Detail<boolean> {
    return this.typed(flagKey, context, fallback, (v) => typeof v === 'boolean');
  }

  stringDetail(flagKey: string, context: Context, fallback: string): Detail<string> {
    return this.typed(flagKey, context, fallback, (v) => typeof v === 'string');
  }

  numberDetail(flagKey: string, context: Context, fallback: number): Detail<number> {
    return this.typed(flagKey, context, fallback, (v) => typeof v === 'number');
  }

  jsonDetail<T extends JsonValue>(flagKey: string, context: Context, fallback: T): Detail<T> {
    return this.typed(flagKey, context, fallback, () => true);
  }

  boolVariation(flagKey: string, context: Context, fallback: boolean): boolean {
    return this.boolDetail(flagKey, context, fallback).value;
  }

  stringVariation(flagKey: string, context: Context, fallback: string): string {
    return this.stringDetail(flagKey, context, fallback).value;
  }

  numberVariation(flagKey: string, context: Context, fallback: number): number {
    return this.numberDetail(flagKey, context, fallback).value;
  }

  jsonVariation<T extends JsonValue>(flagKey: string, context: Context, fallback: T): T {
    return this.jsonDetail(flagKey, context, fallback).value;
  }

  /**
   * Records a conversion for `context`, such as a purchase, to be sent with
   * the next flush. Experiment results count it for the variant of each flag
   * the context was first served. `value` (a price, a duration) is optional.
   * Returns false, and records nothing, if the event key or value is invalid,
   * the buffer is full, or the client is closed.
   */
  track(event: string, context: Context, value?: number): boolean {
    if (this.state === 'closed') return false;
    if (!keySchema.safeParse(event).success || !validContextKey(context.key)) {
      this.o.logger.warn('track() ignored an invalid event', { event });
      return false;
    }
    if (value !== undefined && !validValue(value)) {
      this.o.logger.warn('track() ignored an invalid value', { event });
      return false;
    }
    if (this.pendingEvents() >= this.o.maxEvents) {
      this.droppedEvents++;
      return false;
    }
    const c: Conversion = { id: randomUUID(), event, key: context.key, at: Date.now() };
    if (value !== undefined) c.value = value;
    this.conversions.push(c);
    return true;
  }

  /** Keys of the flags in the current ruleset. */
  flagKeys(): string[] {
    return Object.keys(this.ruleset?.flags ?? {});
  }

  /** Stops streaming and polling and sends any pending exposure counts. */
  async close(): Promise<void> {
    if (this.state === 'closed') return;
    this.setStatus('closed');
    this.lifetime.abort();
    this.streamAbort?.abort();
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    if (this.flushTimer !== null) clearInterval(this.flushTimer);
    this.exposureRetryAt = 0;
    await this.flush();
  }

  private pendingEvents(): number {
    return this.firstExposures.size + this.conversions.length;
  }

  private isClosed(): boolean {
    return this.lifetime.signal.aborted;
  }

  private setStatus(next: Status): void {
    if (this.state === next || this.state === 'closed') return;
    this.state = next;
    this.emit('status', next);
  }

  private refreshStatus(): void {
    if (this.ruleset === undefined) return;
    this.setStatus(this.streamConnected || this.pollOk ? 'ready' : 'stale');
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `Bearer ${this.o.sdkKey}`,
      'user-agent': 'flagship-node/0.1.0',
      ...extra,
    };
  }

  private replace(next: Ruleset): void {
    const previous = this.ruleset;
    this.ruleset = next;
    if (previous === undefined) {
      this.refreshStatus();
      this.emit('ready');
      return;
    }
    const changed = (a: Record<string, unknown>, b: Record<string, unknown>) =>
      [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
        (k) => JSON.stringify(own(a, k)) !== JSON.stringify(own(b, k)),
      );
    const flags = changed(previous.flags, next.flags);
    const segments = changed(previous.segments, next.segments);
    if (flags.length > 0 || segments.length > 0) {
      this.emit('change', { version: next.version, flags, segments });
    }
  }

  private accept(input: unknown, source: string): boolean {
    const result = validateRuleset(input);
    if (!result.ok) {
      // Keep the last good ruleset; a bad one must never replace it.
      this.o.logger.error('ignored an invalid ruleset', {
        source,
        issues: result.issues.slice(0, 5),
      });
      this.emit('error', new Error(`invalid ruleset from ${source}`));
      return false;
    }
    const digest = RulesetDigest.of(result.value, sha256);
    const expected = result.value.checksum;
    if (expected !== undefined && digest.checksum !== expected) {
      this.resync(`the ruleset from ${source} does not match its checksum`, {
        expected,
        actual: digest.checksum,
      });
      return false;
    }
    this.digest = digest;
    this.checksumFailures = 0;
    this.replace(result.value);
    return true;
  }

  /**
   * Throws away what the stream and the ETag say we have, so the next
   * connection or poll fetches the whole ruleset. The last good ruleset stays
   * in use until a verified one replaces it.
   */
  private resync(reason: string, meta: Record<string, unknown> = {}): void {
    this.resyncs++;
    this.checksumFailures++;
    this.lastEventId = undefined;
    this.etag = undefined;
    this.o.logger.error(`${reason}; fetching the whole ruleset again`, meta);
    this.emit('error', new ChecksumError(reason));
    this.streamAbort?.abort();
  }

  /** Applies a patch; false when it forced a resync, so its id must not be resumed from. */
  private patch(data: unknown, version: number): boolean {
    const current = this.ruleset;
    const digest = this.digest;
    const msg = data as { kind?: unknown; key?: unknown; value?: unknown; checksum?: unknown };
    if (current === undefined || digest === undefined || typeof msg.key !== 'string') return true;
    if (msg.kind !== 'flag' && msg.kind !== 'segment') return true;
    const key = msg.key;
    let value: Flag | Segment | null = null;
    if (msg.value !== null) {
      const v = msg.kind === 'flag' ? validateFlag(msg.value) : validateSegment(msg.value);
      if (!v.ok) {
        // Skipping it would leave us out of step with the server for good.
        this.resync(`ignored an invalid ${msg.kind} patch`, { key, version });
        return false;
      }
      value = v.value;
    }
    const pending = digest.prepare(msg.kind, key, value);
    if (typeof msg.checksum === 'string' && msg.checksum !== pending.checksum) {
      this.resync('a patch does not match its checksum', {
        key,
        version,
        expected: msg.checksum,
        actual: pending.checksum,
      });
      return false;
    }
    const next: Ruleset = {
      ...current,
      version,
      flags: { ...current.flags },
      segments: { ...current.segments },
    };
    const entries: Record<string, Flag | Segment> =
      msg.kind === 'flag' ? next.flags : next.segments;
    if (value === null) Reflect.deleteProperty(entries, key);
    else entries[key] = value;
    if (typeof msg.checksum === 'string') next.checksum = msg.checksum;
    else delete next.checksum;
    pending.apply();
    this.ruleset = next;
    this.emit('change', {
      version,
      flags: msg.kind === 'flag' ? [key] : [],
      segments: msg.kind === 'segment' ? [key] : [],
    });
    return true;
  }

  private onMessage(m: SseMessage): void {
    let data: unknown;
    try {
      data = JSON.parse(m.data);
    } catch {
      this.o.logger.warn('ignored a malformed stream event', { event: m.event });
      return;
    }
    if (m.event === 'put') {
      if (this.accept(data, 'stream') && m.id !== undefined) this.lastEventId = m.id;
    } else if (m.event === 'patch') {
      const version = Number(m.id);
      if (Number.isSafeInteger(version)) {
        if (this.patch(data, version) && m.id !== undefined) this.lastEventId = m.id;
      }
    }
  }

  private async streamLoop(): Promise<void> {
    let attempt = 0;
    while (!this.lifetime.signal.aborted) {
      const controller = new AbortController();
      this.streamAbort = controller;
      let received = false;
      try {
        const res = await this.o.fetch(`${this.o.baseUrl}/sdk/v1/stream`, {
          headers: this.headers({
            accept: 'text/event-stream',
            ...(this.lastEventId === undefined ? {} : { 'last-event-id': this.lastEventId }),
          }),
          signal: controller.signal,
        });
        if (res.status === 401 || res.status === 403) {
          throw new AuthError(`the server refused the SDK key (${res.status})`);
        }
        if (!res.ok || res.body === null) throw new Error(`stream answered ${res.status}`);
        this.streamConnected = true;
        this.stopPolling();
        const parser = new SseParser();
        const decoder = new TextDecoder();
        const reader = (res.body as ReadableStream<Uint8Array>).getReader();
        let idle = setTimeout(() => {
          controller.abort();
        }, this.o.streamIdleTimeoutMs);
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            clearTimeout(idle);
            idle = setTimeout(() => {
              controller.abort();
            }, this.o.streamIdleTimeoutMs);
            for (const m of parser.feed(decoder.decode(value, { stream: true }))) {
              // A resync aborts this connection; nothing after it may be applied.
              if (controller.signal.aborted) break;
              received = true;
              this.onMessage(m);
            }
            this.refreshStatus();
          }
        } finally {
          clearTimeout(idle);
        }
      } catch (err) {
        if (this.isClosed()) break;
        if (err instanceof AuthError) {
          this.o.logger.error(err.message);
          this.emit('error', err);
          this.streamConnected = false;
          this.refreshStatus();
          return;
        }
        if (!controller.signal.aborted) {
          this.o.logger.warn('stream disconnected', { error: String(err) });
        }
      }
      this.streamConnected = false;
      this.refreshStatus();
      // While the stream is down, fall back to polling so changes still arrive.
      this.schedulePoll(this.ruleset === undefined ? 0 : this.o.pollIntervalMs);
      // A connection that ended in a checksum failure doesn't reset the backoff,
      // so a server that keeps sending bad data isn't hammered.
      if (received && this.checksumFailures === 0) attempt = 0;
      const base = Math.min(this.o.reconnectMs.max, this.o.reconnectMs.initial * 2 ** attempt);
      attempt = Math.min(attempt + 1, 20);
      await sleep(base * (0.5 + Math.random() / 2), this.lifetime.signal);
    }
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private schedulePoll(delay: number): void {
    if (this.lifetime.signal.aborted || this.pollTimer !== null || this.streamConnected) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll().finally(() => {
        if (!this.streamConnected) this.schedulePoll(this.o.pollIntervalMs);
      });
    }, delay);
    this.pollTimer.unref();
  }

  /** One ETag-conditional fetch of the ruleset. */
  async poll(): Promise<void> {
    try {
      const res = await this.o.fetch(`${this.o.baseUrl}/sdk/v1/ruleset`, {
        headers: this.headers(this.etag === undefined ? {} : { 'if-none-match': this.etag }),
        signal: AbortSignal.any([
          this.lifetime.signal,
          AbortSignal.timeout(this.o.requestTimeoutMs),
        ]),
      });
      if (res.status === 304) {
        this.pollOk = true;
      } else if (res.ok) {
        const ok = this.accept(await res.json(), 'poll');
        if (ok) this.etag = res.headers.get('etag') ?? undefined;
        this.pollOk = ok;
      } else {
        this.pollOk = false;
        if (res.status === 401 || res.status === 403) {
          this.emit('error', new AuthError(`the server refused the SDK key (${res.status})`));
        }
      }
    } catch (err) {
      this.pollOk = false;
      if (!this.lifetime.signal.aborted) this.o.logger.warn('poll failed', { error: String(err) });
    }
    this.refreshStatus();
  }

  private recordExposure(flag: string, variant: string): void {
    if (!this.o.sendExposures || this.state === 'closed') return;
    const key = `${flag}\u0000${variant}`;
    const n = this.exposures.get(key);
    if (n !== undefined) this.exposures.set(key, n + 1);
    else if (this.exposures.size < this.o.maxExposureKeys) this.exposures.set(key, 1);
    else this.droppedExposures++;
  }

  private recordFirstExposure(flag: string, variant: string, contextKey: string): void {
    if (!this.o.sendExposures || this.state === 'closed') return;
    const key = `${flag}\u0000${contextKey}`;
    if (this.seen.has(key) || !validContextKey(contextKey)) return;
    if (this.pendingEvents() >= this.o.maxEvents) {
      this.droppedEvents++;
      return;
    }
    // Forgetting the oldest only means a context may be reported twice; the server keeps the first.
    if (this.seen.size >= this.o.maxSeenContexts) {
      const oldest = this.seen.values().next();
      if (oldest.done !== true) this.seen.delete(oldest.value);
    }
    this.seen.add(key);
    this.firstExposures.set(key, { flag, variant, key: contextKey, at: Date.now() });
  }

  /** Sends pending exposure counts, first exposures and conversions now. Normally runs on a timer and at close. */
  flush(): Promise<void> {
    this.flushing ??= this.doFlush().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    if (this.exposures.size === 0 && this.pendingEvents() === 0) return;
    if (Date.now() < this.exposureRetryAt) return;
    const at = this.exposureWindow;
    const counts: CountEvent[] = [...this.exposures].map(([k, count]) => {
      const [flag = '', variant = ''] = k.split('\u0000');
      return { flag, variant, count, at };
    });
    const batch: EventBatch = {
      events: counts,
      exposures: [...this.firstExposures.values()],
      conversions: this.conversions,
    };
    this.exposures = new Map();
    this.firstExposures = new Map();
    this.conversions = [];
    this.exposureWindow = Date.now();
    const requests = packEvents(batch);
    for (let i = 0; i < requests.length; i++) {
      let retryAfterMs: number | undefined;
      try {
        const res = await this.o.fetch(`${this.o.baseUrl}/sdk/v1/events`, {
          method: 'POST',
          headers: this.headers({ 'content-type': 'application/json' }),
          body: JSON.stringify(requests[i]),
          signal: AbortSignal.timeout(this.o.requestTimeoutMs),
        });
        if (res.status === 429 || res.status >= 500) {
          const header = Number(res.headers.get('retry-after'));
          retryAfterMs = Number.isFinite(header) && header > 0 ? header * 1000 : undefined;
          throw new Error(`events answered ${res.status}`);
        }
        // 4xx other than 429 means the batch itself is wrong; retrying won't help.
        if (!res.ok) this.o.logger.warn('server refused exposure events', { status: res.status });
        this.exposureFailures = 0;
      } catch (err) {
        this.exposureFailures++;
        const backoff = Math.min(60_000, 1000 * 2 ** this.exposureFailures);
        this.exposureRetryAt = Date.now() + (retryAfterMs ?? backoff);
        this.o.logger.warn('could not send events; keeping them', { error: String(err) });
        for (const r of requests.slice(i)) this.putBack(r);
        this.exposureWindow = Math.min(this.exposureWindow, at);
        return;
      }
    }
  }

  /** Returns unsent events to the buffers, within their bounds. */
  private putBack(r: Partial<EventBatch>): void {
    for (const e of r.events ?? []) {
      const key = `${e.flag}\u0000${e.variant}`;
      const n = this.exposures.get(key);
      if (n !== undefined) this.exposures.set(key, n + e.count);
      else if (this.exposures.size < this.o.maxExposureKeys) this.exposures.set(key, e.count);
      else this.droppedExposures += e.count;
    }
    for (const e of r.exposures ?? []) {
      const key = `${e.flag}\u0000${e.key}`;
      const pending = this.firstExposures.get(key);
      if (pending !== undefined) {
        if (e.at < pending.at) this.firstExposures.set(key, e);
      } else if (this.pendingEvents() < this.o.maxEvents) this.firstExposures.set(key, e);
      else this.droppedEvents++;
    }
    for (const c of r.conversions ?? []) {
      if (this.pendingEvents() < this.o.maxEvents) this.conversions.push(c);
      else this.droppedEvents++;
    }
  }
}

interface CountEvent {
  flag: string;
  variant: string;
  count: number;
  at: number;
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

export interface EventBatch {
  events: CountEvent[];
  exposures: FirstExposure[];
  conversions: Conversion[];
}

/** The server's limits on one events request: 1,000 items and a 256 KiB body. */
const MAX_ITEMS = 1000;
const MAX_BYTES = 200_000;

/**
 * Splits pending events into request bodies the server accepts: at most
 * 1,000 items in all, and well under its body limit even when every context
 * key is long. Empty lists are left out.
 */
export function packEvents(batch: EventBatch): Partial<EventBatch>[] {
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
    if (items >= MAX_ITEMS || bytes + size > MAX_BYTES) finish();
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

/** The server takes context keys of 1 to 1,024 characters. */
function validContextKey(key: unknown): key is string {
  return typeof key === 'string' && key.length > 0 && key.length <= 1024;
}

function validValue(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= 1e15;
}

export type { Context, ContextValue };
