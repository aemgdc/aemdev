/* eslint-disable no-console */
// Preview (or with --publish, also publish) a list of web paths. /xx/index is sent as /xx/.
// Usage: node publish.mjs [--publish] /de/index /de/meetups/x /ja/fragments/nav/header ...
// Four lanes in parallel; prints "<mode>: ok/total ok" then one FAIL line per failure.
import { preview, publish } from './da.mjs';

const args = process.argv.slice(2);
const doPublish = args.includes('--publish');
const paths = args.filter((a) => a.startsWith('/')).map((p) => p.replace(/\/index$/, '/'));
const results = { ok: 0, fail: [] };
const queue = [...paths];
await Promise.all(Array.from({ length: 4 }, async () => {
  while (queue.length) {
    const p = queue.shift();
    const pv = await preview(p);
    let lv = { status: 'skip' };
    if (doPublish && pv.status === 200) lv = await publish(p);
    if (pv.status === 200 && (!doPublish || lv.status === 200)) results.ok += 1;
    else results.fail.push(`${p} preview=${pv.status}${pv.error ? `(${pv.error})` : ''} live=${lv.status}${lv.error ? `(${lv.error})` : ''}`);
  }
}));
console.log(`${doPublish ? 'preview+publish' : 'preview'}: ${results.ok}/${paths.length} ok`);
results.fail.forEach((f) => console.log(`  FAIL ${f}`));
