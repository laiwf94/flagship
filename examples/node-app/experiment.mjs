// The experiment half of examples/demo.sh, in two steps.
//
//   node experiment.mjs simulate EFFECT_FLAG SRM_FLAG OUT.json
//     Sends 4,000 shoppers through one 50/50 boolean flag and 4,000 visitors
//     through another with the Node SDK, which reports each context's first
//     exposure, and tracks `purchase` conversions with known outcomes:
//     - EFFECT_FLAG: exactly 10% of the shoppers served `off` and 15% of those
//       served `on` buy, each for 40, so the true lift is +50%.
//     - SRM_FLAG: the variant is decided by a second client that reports
//       nothing, as a server rendering the page would, and the reporting client
//       only sees a visitor once the page is up. One in five `on` visitors
//       leaves first, as if the new page were slow, so their exposures are
//       lost: a known sample ratio mismatch. 12% of each arm buys.
//     Writes what the server should report to OUT.json.
//
//   node experiment.mjs check EXPECTED.json EFFECT.json SRM.json SRM_SHOWN.json
//     Checks the results route's answers against that: the effect is found
//     with exact counts and a lift interval around +50%, and the mismatch hides
//     the results behind a warning unless they are asked for.
//
// FLAGSHIP_SDK_KEY and FLAGSHIP_URL configure the SDK, as for app.mjs.
import { readFileSync, writeFileSync } from 'node:fs';
import { FlagshipClient } from '@flagship/node';

const SHOPPERS = 4000;
const PRICE = 40;
const EFFECT_RATES = { off: 0.1, on: 0.15 };
const SRM_RATE = 0.12;
const SRM_LOSS = 1 / 5;
const EVENT = 'purchase';

/**
 * Picks exactly round(n·rate) of the first n arrivals in an arm, spread
 * evenly: the i-th one (from 0) is picked when floor((i+1)·rate) grows. The
 * demo needs the realized rate to be the stated one, not a random draw.
 */
function every(rate) {
  let i = 0;
  return () => {
    const hit = Math.floor((i + 1) * rate + 1e-9) > Math.floor(i * rate + 1e-9);
    i++;
    return hit;
  };
}

function emptyArm() {
  return { exposed: 0, converted: 0, conversions: 0, value: 0 };
}

async function simulate(effectFlag, srmFlag, out) {
  const options = {
    sdkKey: process.env.FLAGSHIP_SDK_KEY ?? '',
    baseUrl: process.env.FLAGSHIP_URL ?? 'http://localhost:8080',
    // Hold every shopper's events until the explicit flush at the end.
    exposureFlushMs: 600_000,
    maxEvents: 4 * SHOPPERS,
    maxSeenContexts: 4 * SHOPPERS,
  };
  const reporter = new FlagshipClient(options);
  const renderer = new FlagshipClient({ ...options, sendExposures: false });
  try {
    if (!(await reporter.ready()) || !(await renderer.ready())) {
      throw new Error('the SDK could not load the ruleset');
    }
    const expected = { [effectFlag]: {}, [srmFlag]: {} };
    const arm = (flag, variant) => (expected[flag][variant] ??= emptyArm());
    const buys = {
      [effectFlag]: { off: every(EFFECT_RATES.off), on: every(EFFECT_RATES.on) },
      [srmFlag]: { off: every(SRM_RATE), on: every(SRM_RATE) },
    };
    const leaves = every(SRM_LOSS);
    let lost = 0;

    for (let i = 0; i < SHOPPERS; i++) {
      // A purchase counts for every experiment its buyer was exposed to, so
      // each experiment gets shoppers of its own.
      const shopper = { key: `shopper-${i}` };
      const visitor = { key: `visitor-${i}` };
      const buy = (flag, variant, context) => {
        const a = arm(flag, variant);
        if (!buys[flag][variant]()) return;
        if (!reporter.track(EVENT, context, PRICE)) throw new Error('track() dropped a purchase');
        a.converted++;
        a.conversions++;
        a.value += PRICE;
      };

      // A context reports its exposure on evaluation and buys in its arm.
      const effect = reporter.boolDetail(effectFlag, shopper, false);
      if (effect.reason !== 'SPLIT')
        throw new Error(`${effectFlag} is not a split: ${effect.reason}`);
      arm(effectFlag, effect.variant).exposed++;
      buy(effectFlag, effect.variant, shopper);

      const page = renderer.boolDetail(srmFlag, visitor, false);
      if (page.reason !== 'SPLIT') throw new Error(`${srmFlag} is not a split: ${page.reason}`);
      if (page.variant === 'on' && leaves()) {
        // Gone before the page reported anything: no exposure, no purchase.
        lost++;
        arm(srmFlag, page.variant);
        continue;
      }
      const seen = reporter.boolDetail(srmFlag, visitor, false);
      if (seen.variant !== page.variant) throw new Error('the two clients disagree on a variant');
      arm(srmFlag, seen.variant).exposed++;
      buy(srmFlag, seen.variant, visitor);
    }

    if (reporter.droppedEvents > 0)
      throw new Error(`the SDK dropped ${reporter.droppedEvents} events`);
    // Sent in requests of up to 1,000 items. A request the server refuses with
    // 429 stays buffered for a retry, which the demo then notices as results
    // that never reach the expected counts.
    await reporter.flush();
    writeFileSync(out, JSON.stringify({ shoppers: SHOPPERS, lost, expected }, null, 2));
    for (const [flag, arms] of Object.entries(expected)) {
      const parts = Object.entries(arms).map(
        ([v, a]) => `${v}: ${a.exposed} exposed, ${a.converted} bought`,
      );
      console.log(`${flag}  ${parts.join('; ')}`);
    }
    console.log(`${lost} visitors left the new ${srmFlag} page before it reported them`);
  } finally {
    await Promise.all([reporter.close(), renderer.close()]);
  }
}

class CheckError extends Error {}
function must(ok, message) {
  if (!ok) throw new CheckError(message);
}
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const range = (iv, f = pct) => `[${f(iv.lower)}, ${f(iv.upper)}]`;

function counts(results, flagExpected) {
  for (const v of results.variants) {
    const want = flagExpected[v.variant]?.exposed ?? 0;
    must(v.exposed === want, `${v.variant}: ${v.exposed} exposed, expected ${want}`);
  }
  const p = results.srm.pValue;
  console.log(
    `  sample ratio: ${results.variants.map((v) => `${v.variant} ${v.exposed}`).join(' / ')}` +
      ` against ${results.variants.map((v) => v.weight / 1000 + '%').join(' / ')},` +
      ` chi-square ${results.srm.statistic.toFixed(2)}, p ${p < 1e-4 ? p.toExponential(1) : p.toFixed(3)}`,
  );
}

function metric(results, kind) {
  const m = results.metrics?.find((x) => x.event === EVENT && x.kind === kind);
  must(m !== undefined, `no ${EVENT} ${kind} metric in the results`);
  return m;
}

function check(expectedFile, effectFile, srmFile, shownFile) {
  const [{ expected }, effect, srm, shown] = [expectedFile, effectFile, srmFile, shownFile].map(
    (f) => JSON.parse(readFileSync(f, 'utf8')),
  );
  const effectFlag = effect.experiment.flag;
  const srmFlag = srm.experiment.flag;

  console.log(`${effect.experiment.key} (known effect: 10% → 15%, lift +50%)`);
  counts(effect, expected[effectFlag]);
  must(!effect.srm.mismatch && effect.warning === null, 'a fair split was flagged as a mismatch');
  must(!effect.allocationChanged, 'the allocation was reported as changed');
  const rate = metric(effect, 'conversion');
  for (const v of rate.variants) {
    const want = expected[effectFlag][v.variant];
    must(
      v.converted === want.converted,
      `${v.variant}: ${v.converted} bought, expected ${want.converted}`,
    );
    must(v.mean === want.converted / want.exposed, `${v.variant}: rate ${v.mean} is not exact`);
    must(
      v.interval.lower < v.mean && v.mean < v.interval.upper,
      `${v.variant}: the interval does not contain the rate`,
    );
    console.log(`  ${v.variant.padEnd(3)} ${pct(v.mean)} bought, 95% ${range(v.interval)}`);
  }
  const on = rate.variants.find((v) => v.variant === 'on');
  const c = on.comparison;
  must(c !== null && c.lift !== null, 'no comparison against the control');
  // Exact arm rates make the lift 0.5 up to rounding of 15% and 10% of each arm.
  must(Math.abs(c.lift - 0.5) < 0.02, `lift ${c.lift} is not +50%`);
  must(c.liftInterval.lower > 0 && c.liftInterval.upper > 0.5, 'the lift interval misses +50%');
  must(c.significant && c.pValue < 0.001, `the effect is not significant (p ${c.pValue})`);
  console.log(
    `  on vs off: ${c.difference >= 0 ? '+' : ''}${pct(c.difference)} ${range(c.differenceInterval)},` +
      ` lift ${pct(c.lift)} ${range(c.liftInterval)}, p ${c.pValue.toExponential(1)}`,
  );
  const value = metric(effect, 'value');
  for (const v of value.variants) {
    const want = expected[effectFlag][v.variant];
    must(v.value === want.value, `${v.variant}: value ${v.value}, expected ${want.value}`);
  }
  console.log(
    `  revenue per shopper: ${value.variants.map((v) => `${v.variant} ${v.mean.toFixed(2)}`).join(', ')}`,
  );

  console.log(`${srm.experiment.key} (known mismatch: one in five 'on' exposures lost)`);
  counts(srm, expected[srmFlag]);
  must(
    srm.srm.mismatch && srm.srm.pValue < srm.srm.threshold,
    'the lost exposures were not caught',
  );
  must(srm.warning?.code === 'sample_ratio_mismatch', 'no sample ratio warning');
  must(srm.metrics === null, 'metrics were shown behind a failed sample ratio check');
  console.log(`  results hidden: ${srm.warning.message}`);
  must(shown.metrics !== null && shown.srm.mismatch, '?showMismatched=true did not show them');
  const shownRate = metric(shown, 'conversion');
  console.log(
    `  with ?showMismatched=true: ${shownRate.variants.map((v) => `${v.variant} ${pct(v.mean)}`).join(', ')}`,
  );
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'simulate' && args.length === 3) await simulate(...args);
  else if (command === 'check' && args.length === 4) check(...args);
  else {
    console.error('usage: experiment.mjs simulate EFFECT_FLAG SRM_FLAG OUT.json');
    console.error('       experiment.mjs check EXPECTED.json EFFECT.json SRM.json SRM_SHOWN.json');
    process.exit(2);
  }
} catch (err) {
  console.error(`FAILED: ${err instanceof CheckError ? err.message : (err.stack ?? err)}`);
  process.exit(1);
}
