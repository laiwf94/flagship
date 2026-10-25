import type { Flag, Segment } from '@flagship/core';
import pg from 'pg';
import type { Logger } from 'pino';
import type { Db } from '../db/database.js';
import type { KeyKind } from '../db/schema.js';
import type { Metrics } from '../metrics.js';
import { KEYS_CHANNEL } from '../services/apikeys.js';
import type { RulesetCache } from '../services/cache.js';
import { CHANGES_CHANNEL } from '../services/rulesets.js';

/** The minimum a subscriber needs from a response stream. */
export interface Sink {
  write(chunk: string): boolean;
  end(): void;
  readonly writableLength: number;
}

export interface Change {
  version: number;
  kind: 'flag' | 'segment';
  key: string;
  value: Flag | Segment | null;
}

interface Subscriber {
  kind: KeyKind;
  keyId: string;
  environmentId: string;
  sink: Sink;
  /** Highest version this subscriber has been sent. */
  sent: number;
  /** Events that arrived while the initial snapshot was being written. */
  backlog: Change[] | null;
}

export interface HubOptions {
  db: Db;
  databaseUrl: string;
  cache: RulesetCache;
  metrics: Metrics;
  logger: Logger;
  heartbeatMs: number;
  maxStreams: number;
  maxStreamsPerKey: number;
  /** Bytes buffered for one client before it is considered too slow and dropped. */
  maxBufferedBytes?: number;
}

export class StreamLimitError extends Error {}

export function formatEvent(event: string, id: number, data: unknown): string {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Fans ruleset changes out to SSE subscribers on this instance.
 *
 * Every change commits a row in ruleset_changes and a NOTIFY in the same
 * transaction. Each instance LISTENs, reads the rows it hasn't broadcast yet
 * and writes them to its own subscribers, so a change made through any
 * instance reaches streams held by every other one. The rows, not the
 * notification payloads, are the source of truth: NOTIFYs can be coalesced
 * or missed across a reconnect, and the catch-up read covers both.
 */
export class Hub {
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly perKey = new Map<string, number>();
  private readonly broadcastVersion = new Map<string, number>();
  private readonly queues = new Map<string, Promise<void>>();
  private total = 0;
  private listener: pg.Client | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private reconnect: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly maxBuffered: number;

  constructor(private readonly o: HubOptions) {
    this.maxBuffered = o.maxBufferedBytes ?? 1024 * 1024;
    o.metrics.streams.collect(() => {
      let server = 0;
      let client = 0;
      for (const set of this.subscribers.values()) {
        for (const s of set) {
          if (s.kind === 'server') server++;
          else client++;
        }
      }
      o.metrics.streams.set(server, { kind: 'server' });
      o.metrics.streams.set(client, { kind: 'client' });
    });
  }

  get connections(): number {
    return this.total;
  }

  async start(): Promise<void> {
    await this.listen();
    this.heartbeat = setInterval(() => {
      for (const set of this.subscribers.values()) for (const s of set) this.write(s, ': ping\n\n');
    }, this.o.heartbeatMs);
    this.heartbeat.unref();
  }

  private async listen(): Promise<void> {
    const client = new pg.Client({ connectionString: this.o.databaseUrl });
    client.on('notification', (msg) => {
      if (msg.channel === CHANGES_CHANNEL) this.onChange(msg.payload ?? '');
      else if (msg.channel === KEYS_CHANNEL) this.revoke(msg.payload ?? '');
    });
    client.on('error', (err) => {
      this.o.logger.warn({ err }, 'change listener lost its connection');
      this.scheduleReconnect();
    });
    client.on('end', () => {
      this.scheduleReconnect();
    });
    await client.connect();
    await client.query(`LISTEN ${CHANGES_CHANNEL}`);
    await client.query(`LISTEN ${KEYS_CHANNEL}`);
    this.listener = client;
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnect !== null) return;
    this.listener = null;
    this.reconnect = setTimeout(() => {
      this.reconnect = null;
      this.listen()
        .then(() => {
          // Anything may have changed while we weren't listening.
          this.o.cache.invalidate();
          for (const environmentId of this.subscribers.keys()) this.enqueue(environmentId);
        })
        .catch((err: unknown) => {
          this.o.logger.warn({ err }, 'change listener reconnect failed');
          this.scheduleReconnect();
        });
    }, 1000);
    this.reconnect.unref();
  }

  private onChange(payload: string): void {
    const [environmentId] = payload.split(':');
    if (environmentId === undefined || environmentId === '') return;
    this.o.cache.invalidate(environmentId);
    if (this.subscribers.has(environmentId)) this.enqueue(environmentId);
  }

  /** Serialises catch-up per environment so events go out in version order. */
  private enqueue(environmentId: string): void {
    const previous = this.queues.get(environmentId) ?? Promise.resolve();
    const next = previous
      .then(() => this.catchUp(environmentId))
      .catch((err: unknown) => {
        this.o.logger.error({ err, environmentId }, 'stream catch-up failed');
      });
    this.queues.set(environmentId, next);
    void next.finally(() => {
      if (this.queues.get(environmentId) === next) this.queues.delete(environmentId);
    });
  }

  private async catchUp(environmentId: string): Promise<void> {
    const set = this.subscribers.get(environmentId);
    if (set === undefined || set.size === 0) return;
    const from =
      this.broadcastVersion.get(environmentId) ?? Math.min(...[...set].map((s) => s.sent));
    const changes = await this.changesSince(environmentId, from);
    if (changes === undefined) {
      // History was pruned past what we last sent: resend everything.
      const snapshot = await this.o.cache.get(environmentId);
      for (const s of set) this.sendSnapshot(s, snapshot.version, snapshot.ruleset);
      this.broadcastVersion.set(environmentId, snapshot.version);
      return;
    }
    for (const change of changes) {
      for (const s of set) this.deliver(s, change);
      this.broadcastVersion.set(environmentId, change.version);
    }
  }

  /** Changes after `version`, or undefined if some of them have been pruned. */
  async changesSince(environmentId: string, version: number): Promise<Change[] | undefined> {
    const rows = await this.o.db
      .selectFrom('ruleset_changes')
      .select(['version', 'kind', 'key', 'value'])
      .where('environment_id', '=', environmentId)
      .where('version', '>', version)
      .orderBy('version')
      .execute();
    if (rows.length > 0 && rows[0]?.version !== version + 1) return undefined;
    return rows.map((r) => ({
      version: r.version,
      kind: r.kind,
      key: r.key,
      value: (r.value ?? null) as Flag | Segment | null,
    }));
  }

  private deliver(s: Subscriber, change: Change): void {
    if (s.backlog !== null) {
      s.backlog.push(change);
      return;
    }
    if (change.version <= s.sent) return;
    s.sent = change.version;
    if (s.kind === 'server') {
      this.write(
        s,
        formatEvent('patch', change.version, {
          kind: change.kind,
          key: change.key,
          value: change.value,
        }),
      );
      this.o.metrics.streamEvents.inc({ event: 'patch' });
    } else {
      this.write(s, formatEvent('version', change.version, { version: change.version }));
      this.o.metrics.streamEvents.inc({ event: 'version' });
    }
  }

  private sendSnapshot(s: Subscriber, version: number, ruleset: unknown): void {
    s.sent = version;
    if (s.kind === 'server') {
      this.write(s, formatEvent('put', version, ruleset));
      this.o.metrics.streamEvents.inc({ event: 'put' });
    } else {
      this.write(s, formatEvent('version', version, { version }));
      this.o.metrics.streamEvents.inc({ event: 'version' });
    }
  }

  private write(s: Subscriber, chunk: string): void {
    if (s.sink.writableLength > this.maxBuffered) {
      // A client this far behind will resume from its last id on reconnect.
      this.o.metrics.streamDrops.inc({ reason: 'slow' });
      this.remove(s);
      s.sink.end();
      return;
    }
    s.sink.write(chunk);
  }

  /** Whether a new stream for this key would be within the limits. */
  canAccept(identity: { kind: KeyKind; keyId: string }): string | undefined {
    if (this.closed) return 'server is shutting down';
    if (this.total >= this.o.maxStreams) return 'this server has reached its stream limit';
    const keyCount = this.perKey.get(identity.keyId) ?? 0;
    if (identity.kind === 'server' && keyCount >= this.o.maxStreamsPerKey) {
      return 'this key has reached its stream limit';
    }
    return undefined;
  }

  /**
   * Registers a stream and brings it up to date. With `lastEventId` it sends
   * only the patches after that version when they are still on record,
   * otherwise a full `put`. Throws StreamLimitError when a limit is reached.
   */
  async subscribe(
    identity: { kind: KeyKind; keyId: string; environmentId: string },
    sink: Sink,
    lastEventId: number | undefined,
  ): Promise<() => void> {
    const refused = this.canAccept(identity);
    if (refused !== undefined) throw new StreamLimitError(refused);
    const keyCount = this.perKey.get(identity.keyId) ?? 0;
    const s: Subscriber = { ...identity, sink, sent: 0, backlog: [] };
    let set = this.subscribers.get(identity.environmentId);
    if (set === undefined) {
      set = new Set();
      this.subscribers.set(identity.environmentId, set);
    }
    set.add(s);
    this.total++;
    this.perKey.set(identity.keyId, keyCount + 1);

    try {
      const snapshot = await this.o.cache.get(identity.environmentId);
      let resumed = false;
      if (lastEventId !== undefined && lastEventId <= snapshot.version) {
        const missed = await this.changesSince(identity.environmentId, lastEventId);
        if (missed !== undefined) {
          s.sent = lastEventId;
          const backlog = s.backlog;
          s.backlog = null;
          for (const change of missed) this.deliver(s, change);
          s.backlog = backlog;
          resumed = true;
          if (s.kind === 'client' && missed.length === 0) {
            this.write(s, formatEvent('version', lastEventId, { version: lastEventId }));
          }
        }
      }
      if (!resumed) this.sendSnapshot(s, snapshot.version, snapshot.ruleset);
      // Close the gap between the snapshot we read and changes broadcast meanwhile.
      const later = (await this.changesSince(identity.environmentId, s.sent)) ?? [];
      const backlog = s.backlog ?? [];
      s.backlog = null;
      for (const change of [...later, ...backlog].sort((a, b) => a.version - b.version)) {
        this.deliver(s, change);
      }
      const known = this.broadcastVersion.get(identity.environmentId);
      if (known === undefined || known < s.sent)
        this.broadcastVersion.set(identity.environmentId, s.sent);
    } catch (err) {
      this.remove(s);
      throw err;
    }
    return () => {
      this.remove(s);
    };
  }

  private remove(s: Subscriber): void {
    const set = this.subscribers.get(s.environmentId);
    if (set?.delete(s) !== true) return;
    this.total--;
    const n = (this.perKey.get(s.keyId) ?? 1) - 1;
    if (n <= 0) this.perKey.delete(s.keyId);
    else this.perKey.set(s.keyId, n);
    if (set.size === 0) {
      this.subscribers.delete(s.environmentId);
      this.broadcastVersion.delete(s.environmentId);
    }
  }

  /** Closes every stream opened with a key that has just been revoked. */
  revoke(keyId: string): void {
    for (const set of this.subscribers.values()) {
      for (const s of [...set]) {
        if (s.keyId === keyId) {
          this.o.metrics.streamDrops.inc({ reason: 'revoked' });
          this.remove(s);
          s.sink.end();
        }
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    if (this.reconnect !== null) clearTimeout(this.reconnect);
    for (const set of [...this.subscribers.values()]) {
      for (const s of [...set]) {
        this.remove(s);
        s.sink.end();
      }
    }
    await Promise.allSettled([...this.queues.values()]);
    const listener = this.listener;
    this.listener = null;
    if (listener !== null) {
      listener.removeAllListeners('end');
      listener.removeAllListeners('error');
      listener.on('error', () => undefined);
      await listener.end().catch(() => undefined);
    }
  }
}
