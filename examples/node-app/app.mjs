// A tiny service that asks flagship whether 1,000 users get the new checkout,
// using the Node SDK. It evaluates locally and reprints on every change.
import { FlagshipClient } from '@flagship/node';

const users = Array.from({ length: 1000 }, (_, i) => ({ key: `user-${i}` }));
const client = new FlagshipClient({
  sdkKey: process.env.FLAGSHIP_SDK_KEY ?? '',
  baseUrl: process.env.FLAGSHIP_URL ?? 'http://localhost:8080',
});

let firstGroup;

function report(reason) {
  const on = users.filter((u) => client.boolVariation('new-checkout', u, false)).map((u) => u.key);
  let note = '';
  if (on.length > 0 && on.length < users.length) {
    if (firstGroup === undefined) firstGroup = new Set(on);
    else if (on.length > firstGroup.size) {
      const kept = [...firstGroup].filter((k) => on.includes(k)).length;
      note = `; ${kept} of the first ${firstGroup.size} are still on`;
    }
  }
  console.log(
    `[app] ${reason}: new-checkout is on for ${on.length}/1000 users${note} (ruleset v${client.version})`,
  );
}

client.on('status', (s) => console.log(`[app] status ${s}`));
await client.ready();
report('ready');
client.on('change', (c) => {
  if (c.flags.includes('new-checkout')) report('change');
});

const stop = async () => {
  await client.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
