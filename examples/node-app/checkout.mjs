// A checkout service whose new path is broken, for the guarded rollout in
// examples/demo.sh.
//
//   node checkout.mjs FLAG SHOPPERS
//
// Sends SHOPPERS through the boolean FLAG with the Node SDK, which reports
// each shopper's first exposure. Exactly 10% of the shoppers served `on` (the
// new checkout) and 1% of those served `off` hit an error, tracked as the
// `checkout-error` event, so the new path fails ten times as often. It then
// keeps running and prints a line whenever FLAG changes, with how many of the
// same shoppers it now serves `on`: a guard that rolls the plan back shows up
// here as "on for 0/SHOPPERS".
//
// FLAGSHIP_SDK_KEY and FLAGSHIP_URL configure the SDK, as for app.mjs.
import { FlagshipClient } from '@flagship/node';

const ERROR_RATES = { on: 0.1, off: 0.01 };
const EVENT = 'checkout-error';

const [flag, count] = process.argv.slice(2);
const shoppers = Number(count);
if (flag === undefined || !Number.isInteger(shoppers) || shoppers < 1) {
  console.error('usage: checkout.mjs FLAG SHOPPERS');
  process.exit(2);
}

/** Exactly round(n·rate) of the first n arrivals, spread evenly, as in experiment.mjs. */
function every(rate) {
  let i = 0;
  return () => {
    const hit = Math.floor((i + 1) * rate + 1e-9) > Math.floor(i * rate + 1e-9);
    i++;
    return hit;
  };
}

const client = new FlagshipClient({
  sdkKey: process.env.FLAGSHIP_SDK_KEY ?? '',
  baseUrl: process.env.FLAGSHIP_URL ?? 'http://localhost:8080',
  // Hold the events until the explicit flush after the last checkout.
  exposureFlushMs: 600_000,
  maxEvents: 2 * shoppers,
  maxSeenContexts: 2 * shoppers,
});
const contexts = Array.from({ length: shoppers }, (_, i) => ({ key: `checkout-shopper-${i}` }));
const onCount = () => contexts.filter((c) => client.boolVariation(flag, c, false)).length;

const stop = async (code = 0) => {
  await client.close();
  process.exit(code);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());

try {
  if (!(await client.ready())) throw new Error('the SDK could not load the ruleset');
  client.on('change', (c) => {
    if (c.flags.includes(flag)) {
      console.log(`[checkout] change: ${flag} is on for ${onCount()}/${shoppers} shoppers`);
    }
  });
  const arms = { on: { served: 0, failed: 0 }, off: { served: 0, failed: 0 } };
  const fails = { on: every(ERROR_RATES.on), off: every(ERROR_RATES.off) };
  for (const shopper of contexts) {
    const d = client.boolDetail(flag, shopper, false);
    if (d.reason !== 'SPLIT') throw new Error(`${flag} is not a split: ${d.reason}`);
    const arm = arms[d.variant];
    if (arm === undefined) throw new Error(`unexpected variant ${d.variant}`);
    arm.served++;
    if (fails[d.variant]()) {
      if (!client.track(EVENT, shopper)) throw new Error('track() dropped an error');
      arm.failed++;
    }
  }
  if (client.droppedEvents > 0) throw new Error(`the SDK dropped ${client.droppedEvents} events`);
  await client.flush();
  const part = (v) =>
    `${v} ${arms[v].served} (${arms[v].failed} failed, ${((arms[v].failed / Math.max(1, arms[v].served)) * 100).toFixed(1)}%)`;
  console.log(`[checkout] ${shoppers} checkouts sent: ${part('on')}, ${part('off')}`);
} catch (err) {
  console.log(`[checkout] FAILED: ${err.stack ?? err}`);
  await stop(1);
}
