import type { IncomingMessage } from 'node:http';
import { pino, type DestinationStream, type Logger } from 'pino';

/** Hides the value of `key=` in query strings; client keys ride there on EventSource URLs. */
export function redactUrl(url: string): string {
  return url.replace(/([?&]key=)[^&#]*/g, '$1[redacted]');
}

export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      base: null,
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      // Headers are not logged by the serializers below; this is a second guard
      // for anything that logs a request or error object some other way.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-csrf-token"]',
          'res.headers["set-cookie"]',
          'password',
          '*.password',
        ],
        censor: '[redacted]',
      },
      serializers: {
        req: (req: IncomingMessage & { ip?: string }) => ({
          method: req.method,
          url: redactUrl(req.url ?? ''),
          remoteAddress: req.ip ?? req.socket.remoteAddress,
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    },
    destination,
  );
}
