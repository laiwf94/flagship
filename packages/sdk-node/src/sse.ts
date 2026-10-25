export interface SseMessage {
  event: string;
  data: string;
  id: string | undefined;
}

/**
 * Incremental parser for the text/event-stream format as the WHATWG HTML
 * spec defines it: CR, LF or CRLF line endings, multi-line data, comments,
 * `id` (ignored when it contains NUL) and `retry`.
 */
export class SseParser {
  private buffer = '';
  private data: string[] = [];
  private event = '';
  private id: string | undefined;
  /** Last `id` seen, carried across events as the spec requires. */
  lastEventId: string | undefined;
  retryMs: number | undefined;

  feed(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const out: SseMessage[] = [];
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer);
      if (match === null) break;
      // A lone CR at the end may be the first half of CRLF; wait for more.
      if (match[0] === '\r' && match.index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const message = this.line(line);
      if (message !== undefined) out.push(message);
    }
    return out;
  }

  private line(line: string): SseMessage | undefined {
    if (line === '') {
      if (this.data.length === 0) {
        this.event = '';
        return undefined;
      }
      const message = { event: this.event || 'message', data: this.data.join('\n'), id: this.id };
      this.data = [];
      this.event = '';
      return message;
    }
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'data':
        this.data.push(value);
        break;
      case 'event':
        this.event = value;
        break;
      case 'id':
        if (!value.includes('\u0000')) {
          this.id = value;
          this.lastEventId = value;
        }
        break;
      case 'retry':
        if (/^\d+$/.test(value)) this.retryMs = Number(value);
        break;
      default:
        break;
    }
    return undefined;
  }
}
