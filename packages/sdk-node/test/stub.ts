import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Ruleset } from '@flagship/core';

/**
 * A stand-in flagship server over real HTTP: ruleset with ETags, an SSE
 * stream that can be fed events, and an events endpoint that records what it
 * gets (and can be told to answer 429).
 */
export class StubServer {
  ruleset: Ruleset;
  readonly streams = new Set<http.ServerResponse>();
  readonly events: unknown[] = [];
  readonly lastEventIds: (string | undefined)[] = [];
  eventsStatus = 202;
  streamStatus = 200;
  rulesetRequests = 0;
  private server: http.Server | null = null;
  port = 0;

  constructor(
    ruleset: Ruleset,
    readonly key = `fss_${'k'.repeat(43)}`,
  ) {
    this.ruleset = ruleset;
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
        .end(JSON.stringify(this.ruleset));
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
        `id: ${this.ruleset.version}\nevent: put\ndata: ${JSON.stringify(this.ruleset)}\n\n`,
      );
      this.streams.add(res);
      req.on('close', () => this.streams.delete(res));
      return;
    }
    if (req.url === '/sdk/v1/events' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += String(chunk);
      if (this.eventsStatus === 202)
        this.events.push(...(JSON.parse(body) as { events: unknown[] }).events);
      res
        .writeHead(this.eventsStatus, this.eventsStatus === 429 ? { 'retry-after': '1' } : {})
        .end('{}');
      return;
    }
    res.writeHead(404).end();
  }

  /** Changes the ruleset and pushes a patch for one flag to every open stream. */
  patchFlag(key: string, change: Partial<Ruleset['flags'][string]> | null): void {
    const version = this.ruleset.version + 1;
    const flags = { ...this.ruleset.flags };
    const current = flags[key];
    if (change === null) Reflect.deleteProperty(flags, key);
    else if (current !== undefined) flags[key] = { ...current, ...change };
    this.ruleset = { ...this.ruleset, version, flags };
    const value = change === null ? null : flags[key];
    for (const s of this.streams) {
      s.write(
        `id: ${version}\nevent: patch\ndata: ${JSON.stringify({ kind: 'flag', key, value })}\n\n`,
      );
    }
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
