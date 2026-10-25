import { EventEmitter } from 'node:events';
import {
  evaluate,
  own,
  validateFlag,
  validateRuleset,
  validateSegment,
  type Context,
  type ContextValue,
  type Flag,
  type Ruleset,
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
  private flushing: Promise<void> | null = null;
  private readonly o: Required<Omit<ClientOptions, 'logger' | 'fetch'>> & {
    logger: Logger;
    fetch: typeof fetch;
  };
  /** Exposure counts discarded because the buffer was full. */
  droppedExposures = 0;

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
      ...options,
      baseUrl: options.baseUrl.replace(/\/+$/, ''),
      logger: options.logger ?? silent,
      fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    };
    // Unhandled 'error' events would crash the process; errors are reported, never thrown.
    this.on('error', () => undefined);
    if (this.o.streaming) void this.streamLoop();
    else this.schedulePoll(0);
    if (this.o.sendExposures) {
      this.flushTimer = setInterval(() => {
        void this.flush();
      }, this.o.exposureFlushMs);
      this.flushTimer.unref();
    }
  }

  get status(): Status {
    return this.state;
  }

  /** The ruleset version in use, or undefined before the first one arrives. */
  get version(): number | undefined {
    return this.ruleset?.version;
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
    this.replace(result.value);
    return true;
  }

  private patch(data: unknown, version: number): void {
    const current = this.ruleset;
    const msg = data as { kind?: unknown; key?: unknown; value?: unknown };
    if (current === undefined || typeof msg.key !== 'string') return;
    const next: Ruleset = {
      ...current,
      version,
      flags: { ...current.flags },
      segments: { ...current.segments },
    };
    const key = msg.key;
    if (msg.kind === 'flag') {
      if (msg.value === null) Reflect.deleteProperty(next.flags, key);
      else {
        const v = validateFlag(msg.value);
        if (!v.ok) {
          this.o.logger.error('ignored an invalid flag patch', { key });
          return;
        }
        next.flags[key] = v.value;
      }
    } else if (msg.kind === 'segment') {
      if (msg.value === null) Reflect.deleteProperty(next.segments, key);
      else {
        const v = validateSegment(msg.value);
        if (!v.ok) {
          this.o.logger.error('ignored an invalid segment patch', { key });
          return;
        }
        next.segments[key] = v.value;
      }
    } else {
      return;
    }
    this.ruleset = next;
    this.emit('change', {
      version,
      flags: msg.kind === 'flag' ? [key] : [],
      segments: msg.kind === 'segment' ? [key] : [],
    });
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
        this.patch(data, version);
        if (m.id !== undefined) this.lastEventId = m.id;
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
      if (received) attempt = 0;
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

  /** Sends pending exposure counts now. Normally runs on a timer and at close. */
  flush(): Promise<void> {
    this.flushing ??= this.doFlush().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    if (this.exposures.size === 0 || Date.now() < this.exposureRetryAt) return;
    const batch = this.exposures;
    const at = this.exposureWindow;
    this.exposures = new Map();
    this.exposureWindow = Date.now();
    const events = [...batch].map(([k, count]) => {
      const [flag = '', variant = ''] = k.split('\u0000');
      return { flag, variant, count, at };
    });
    for (let i = 0; i < events.length; i += 1000) {
      const chunk = events.slice(i, i + 1000);
      let retryAfterMs: number | undefined;
      try {
        const res = await this.o.fetch(`${this.o.baseUrl}/sdk/v1/events`, {
          method: 'POST',
          headers: this.headers({ 'content-type': 'application/json' }),
          body: JSON.stringify({ events: chunk }),
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
        this.o.logger.warn('could not send exposure counts; keeping them', { error: String(err) });
        for (const e of events.slice(i)) {
          const key = `${e.flag}\u0000${e.variant}`;
          const n = this.exposures.get(key);
          if (n !== undefined) this.exposures.set(key, n + e.count);
          else if (this.exposures.size < this.o.maxExposureKeys) this.exposures.set(key, e.count);
          else this.droppedExposures += e.count;
        }
        this.exposureWindow = Math.min(this.exposureWindow, at);
        return;
      }
    }
  }
}

export type { Context, ContextValue };
