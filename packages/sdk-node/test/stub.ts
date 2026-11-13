import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { rulesetChecksum, type Flag, type Ruleset, type Segment } from '@flagship/core';

/**
 * A stand-in flagship server over real HTTP: ruleset with ETags, an SSE
 * stream that can be fed events, and an events endpoint that records what it
 * gets (and can be told to answer 429).
 */
export class StubServer {
  ruleset: Ruleset;
  readonly streams = new Set<http.ServerResponse>();
  readonly events: unknown[] = [];
  /** Every accepted events request body, whole. */
  readonly bodies: { events?: unknown[]; exposures?: unknown[]; conversions?: unknown[] }[] = [];
  readonly lastEventIds: (string | undefined)[] = [];
  eventsStatus = 202;
  streamStatus = 200;
  rulesetRequests = 0;
  /** Send checksums with snapshots and patches, as the real server does. */
  checksums = true;
  /** Replaces the checksum sent with snapshots, to simulate a corrupted one. */
  snapshotChecksum: string | undefined;
  private server: http.Server | null = null;
  port = 0;

  constructor(
    ruleset: Ruleset,
    readonly key = `fss_${'k'.repeat(43)}`,
  ) {
    this.ruleset = ruleset;
  }

  /** What the server sends as a snapshot: the ruleset and, unless turned off, its checksum. */
  snapshot(): Ruleset {
    if (!this.checksums) return this.ruleset;
    return { ...this.ruleset, checksum: this.snapshotChecksum ?? rulesetChecksum(this.ruleset) };
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(port = 0): Promise<void> {
    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => {
      this.server?.listen(port, '127.0.0.1', resolve);
    });
    this.port = (this.server.address() as AddressInfo).port;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.headers.authorization !== `Bearer ${this.key}`) {
      res.writeHead(401).end();
      return;
    }
    if (req.url === '/sdk/v1/ruleset') {
      this.rulesetRequests++;
      const etag = `"${this.ruleset.version}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304).end();
        return;
      }
      res
        .writeHead(200, { 'content-type': 'application/json', etag })
        .end(JSON.stringify(this.snapshot()));
      return;
    }
    if (req.url === '/sdk/v1/stream') {
      this.lastEventIds.push(req.headers['last-event-id'] as string | undefined);
      if (this.streamStatus !== 200) {
        res.writeHead(this.streamStatus).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        `id: ${this.ruleset.version}\nevent: put\ndata: ${JSON.stringify(this.snapshot())}\n\n`,
      );
      this.streams.add(res);
      req.on('close', () => this.streams.delete(res));
      return;
    }
    if (req.url === '/sdk/v1/events' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += String(chunk);
      if (this.eventsStatus === 202) {
        const parsed = JSON.parse(body) as StubServer['bodies'][number];
        this.bodies.push(parsed);
        this.events.push(...(parsed.events ?? []));
      }
      res
        .writeHead(this.eventsStatus, this.eventsStatus === 429 ? { 'retry-after': '1' } : {})
        .end('{}');
      return;
    }
    res.writeHead(404).end();
  }

  /** Changes the ruleset and pushes a patch for one flag to every open stream. */
  patchFlag(key: string, change: Partial<Flag> | null): void {
    const current = this.ruleset.flags[key];
    this.patch(
      'flag',
      key,
      change === null || current === undefined ? null : { ...current, ...change },
    );
  }

  /**
   * Replaces (or with null removes) one entry, bumps the version and pushes
   * the patch. `send: false` changes the ruleset without telling anyone, as if
   * the patch were lost; `checksum` overrides the one sent.
   */
  patch(
    kind: 'flag' | 'segment',
    key: string,
    value: Flag | Segment | null,
    options: { send?: boolean; checksum?: string } = {},
  ): void {
    const version = this.ruleset.version + 1;
    const flags = { ...this.ruleset.flags };
    const segments = { ...this.ruleset.segments };
    const entries: Record<string, Flag | Segment> = kind === 'flag' ? flags : segments;
    if (value === null) Reflect.deleteProperty(entries, key);
    else entries[key] = value;
    this.ruleset = { ...this.ruleset, version, flags, segments };
    if (options.send === false) return;
    const data: Record<string, unknown> = { kind, key, value };
    if (this.checksums) data.checksum = options.checksum ?? rulesetChecksum(this.ruleset);
    this.send(`id: ${version}\nevent: patch\ndata: ${JSON.stringify(data)}\n\n`);
  }

  send(raw: string): void {
    for (const s of this.streams) s.write(raw);
  }

  dropStreams(): void {
    for (const s of this.streams) s.destroy();
    this.streams.clear();
  }

  async stop(): Promise<void> {
    this.dropStreams();
    const server = this.server;
    this.server = null;
    if (server === null) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  }
}

export async function until(check: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}
