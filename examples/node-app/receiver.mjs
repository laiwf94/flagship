// A webhook receiver, as a team would run one next to its own systems. It
// checks every request with parseWebhook() from the Node SDK: the
// Flagship-Signature must be an HMAC-SHA256 of "<t>.<raw body>" under the
// webhook's secret, and t within five minutes of now. Anything else gets 401
// and is not acted on. Event ids are remembered, so a replayed or retried
// delivery of an event already handled is acknowledged without acting twice.
//
// FLAGSHIP_WEBHOOK_SECRET is the secret flagship showed once when the webhook
// was created; RECEIVER_PORT (default 9090) is where it listens. Used by
// examples/demo.sh, which reads the lines it prints.
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { parseWebhook, SIGNATURE_HEADER, WebhookSignatureError } from '@flagship/node';

const secret = process.env.FLAGSHIP_WEBHOOK_SECRET ?? '';
const port = Number(process.env.RECEIVER_PORT ?? 9090);
/** flagship sends at most 256 KiB; anything far larger is not a delivery. */
const MAX_BODY = 1024 * 1024;

if (!secret.startsWith('whsec_')) {
  console.error('FLAGSHIP_WEBHOOK_SECRET must be the whsec_... secret of the webhook');
  process.exit(2);
}

const handled = new Set();
const pct = (x) => `${(x * 100).toFixed(1)}%`;

/** One line on what an event says, for the events the demo looks at. */
function describe(event) {
  const after = event.after ?? {};
  if (event.type === 'flag.rollout.guard' && Array.isArray(after.readings)) {
    const readings = after.readings.map((r) => {
      const lift = r.lift === null ? '' : `, lift +${pct(r.lift)}`;
      const iv =
        r.liftInterval === null
          ? ''
          : ` [${pct(r.liftInterval.lower)}, ${pct(r.liftInterval.upper)}]`;
      return (
        `${r.guard.event} ${r.guard.kind}: ${r.variant.variant} ${pct(r.variant.mean)} of ${r.variant.exposed}` +
        ` vs ${r.baseline.variant} ${pct(r.baseline.mean)} of ${r.baseline.exposed}${lift}${iv}`
      );
    });
    return `; ${after.action} at step ${after.step + 1}: ${readings.join('; ')}`;
  }
  return '';
}

const server = createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/flagship') {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY) {
      res.writeHead(413).end();
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (res.headersSent) return;
    // Verify the bytes as received: a parsed and re-serialised body would not match.
    const body = Buffer.concat(chunks);
    let event;
    try {
      event = parseWebhook(body, req.headers[SIGNATURE_HEADER], secret);
    } catch (err) {
      if (!(err instanceof WebhookSignatureError)) throw err;
      console.log(`[receiver] rejected (${err.code}): ${err.message}`);
      res.writeHead(401, { 'content-type': 'text/plain' }).end(err.code);
      return;
    }
    const delivery = req.headers['flagship-delivery'];
    const attempt = req.headers['flagship-attempt'];
    if (handled.has(event.id)) {
      console.log(
        `[receiver] duplicate ${event.id} ${event.type} (delivery ${delivery}, attempt ${attempt}): already handled`,
      );
    } else {
      handled.add(event.id);
      console.log(
        `[receiver] verified ${event.id} ${event.type} ${event.target.key} in ${event.environment}` +
          ` by ${event.actor.name} (delivery ${delivery}, attempt ${attempt})${describe(event)}`,
      );
    }
    res.writeHead(204).end();
  });
});

server.listen(port, '0.0.0.0', () => console.log(`[receiver] listening on :${port}`));
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
