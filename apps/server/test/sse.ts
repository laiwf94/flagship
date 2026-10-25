import http from 'node:http';

export interface SseEvent {
  id?: string;
  event: string;
  data: string;
}

export interface SseClient {
  status: number;
  events: SseEvent[];
  comments: number;
  /** Resolves with the first event (from index `from`) matching `pick`. */
  next: (pick?: (e: SseEvent) => boolean, timeoutMs?: number) => Promise<SseEvent>;
  ended: Promise<void>;
  close: () => void;
}

/** A minimal SSE reader over node:http, so tests control headers and disconnects. */
export function openStream(url: string, headers: Record<string, string> = {}): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { accept: 'text/event-stream', ...headers } }, (res) => {
      const events: SseEvent[] = [];
      const waiters: (() => void)[] = [];
      let buffer = '';
      let comments = 0;
      let consumed = 0;
      let endResolve: () => void = () => undefined;
      const ended = new Promise<void>((r) => {
        endResolve = r;
      });
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let at: number;
        while ((at = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const e: SseEvent = { event: 'message', data: '' };
          let isEvent = false;
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) comments++;
            else if (line.startsWith('id: ')) e.id = line.slice(4);
            else if (line.startsWith('event: ')) {
              e.event = line.slice(7);
              isEvent = true;
            } else if (line.startsWith('data: ')) {
              e.data += line.slice(6);
              isEvent = true;
            }
          }
          if (isEvent) events.push(e);
          for (const w of waiters.splice(0)) w();
        }
      });
      res.on('end', () => {
        endResolve();
        for (const w of waiters.splice(0)) w();
      });
      res.on('error', () => {
        endResolve();
      });
      const client: SseClient = {
        status: res.statusCode ?? 0,
        events,
        get comments() {
          return comments;
        },
        ended,
        close: () => {
          req.destroy();
        },
        next: (pick = () => true, timeoutMs = 5000) =>
          new Promise((ok, fail) => {
            const timer = setTimeout(() => {
              fail(
                new Error(
                  `no matching event within ${timeoutMs} ms; got ${JSON.stringify(events)}`,
                ),
              );
            }, timeoutMs);
            const check = () => {
              for (let i = consumed; i < events.length; i++) {
                const e = events[i];
                if (e !== undefined && pick(e)) {
                  consumed = i + 1;
                  clearTimeout(timer);
                  ok(e);
                  return;
                }
              }
              waiters.push(check);
            };
            check();
          }),
      };
      resolve(client);
    });
    req.on('error', reject);
  });
}
