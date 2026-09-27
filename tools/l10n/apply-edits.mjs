/* eslint-disable no-console */
// Re-apply the recovered, reviewed MT fixes in data/edits/manifest.json, one edit-doc.mjs run
// per (doc, batch), in manifest order. Dry run by default (edit-doc's own dry run, which
// reads DA but writes nothing); --apply passes --apply through, so each doc is versioned
// before it is written. A doc whose batch is refused is skipped, never half-applied: edit-doc
// checks every `old` before writing anything.
// Usage: node apply-edits.mjs [--apply] [--sets review-a,review-frag] [--locales de,ja] [/de/x ...]
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1].split(',') : null;
};
const sets = opt('--sets');
const locales = opt('--locales');
const only = args.filter((a, i) => a.startsWith('/') && !['--sets', '--locales'].includes(args[i - 1]));

const manifest = JSON.parse(readFileSync(join(here, 'data/edits/manifest.json'), 'utf8'));
const runs = [];
Object.entries(manifest.docs).forEach(([doc, files]) => {
  if (only.length && !only.includes(doc)) return;
  if (locales && !locales.includes(doc.split('/')[1])) return;
  files.filter((f) => !sets || sets.includes(f.split('/')[0])).forEach((f) => runs.push([doc, f]));
});

const tally = { ok: 0, refused: 0, failed: 0 };
runs.forEach(([doc, f]) => {
  const cli = [join(here, 'edit-doc.mjs'), doc, join(here, 'data/edits', f)];
  if (apply) cli.push('--apply');
  const r = spawnSync(process.execPath, cli, { encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n');
  const last = out[out.length - 1];
  if (r.status === 0) tally.ok += 1;
  else if (r.status === 1) tally.refused += 1;
  else tally.failed += 1;
  console.log(`${r.status === 0 ? 'ok     ' : 'FAIL   '} ${doc}  <- ${f}  (${last})`);
  if (r.status !== 0) out.filter((l) => l.startsWith('REFUSED')).forEach((l) => console.log(`         ${l}`));
});
console.log(`${apply ? 'applied' : 'dry run'}: ${tally.ok} ok, ${tally.refused} refused, ${tally.failed} failed of ${runs.length} batch(es)`);
process.exit(tally.refused || tally.failed ? 1 : 0);
