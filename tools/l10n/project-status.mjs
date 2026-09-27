/* eslint-disable no-console */
// One-line status of a DA Translate project: "<n>/<langs> complete | code:status/saved ...".
// Exit code 0 only when every language is complete, so it can gate a wait loop.
// Usage: node project-status.mjs <projectEpochMs>
import { getJson } from './da.mjs';

const p = (await getJson(`/.da/translation/active/${process.argv[2]}.json`)).json;
const done = p.langs.filter((l) => l.translation?.status === 'complete').length;
console.log(`${done}/${p.langs.length} complete | ${p.langs.map((l) => `${l.code}:${l.translation?.status}/${l.translation?.saved ?? 0}`).join(' ')}`);
process.exit(done === p.langs.length ? 0 : 1);
