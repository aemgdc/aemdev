/* eslint-disable no-console, no-continue */
// Exact text edit(s) in ONE translated DA doc, text nodes only (never attributes/markup).
// Refuses unless each `old` occurs exactly `count` times (default 1). Versions before write.
// Usage: node edit-doc.mjs /de/meetups/x edits.json [--apply]
//   edits.json: [{"old": "Der Flurweg", "new": "Gespräche am Rande", "count": 1}, ...]
// Dry run by default: prints what would change and exits non-zero if any edit is refused.
import { readFileSync } from 'node:fs';
import { getSource, putSource, version } from './da.mjs';

const [path, file, flag] = process.argv.slice(2);
const apply = flag === '--apply';
if (!path?.startsWith('/') || path.startsWith('/en/')) {
  console.error('refusing: give a translated doc path (not /en/)');
  process.exit(3);
}
const edits = JSON.parse(readFileSync(file, 'utf8'));
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const src = await getSource(`${path}.html`);
if (src.status !== 200) {
  console.error(`HTTP ${src.status}`);
  process.exit(2);
}
let parts = src.text.split(/(<[^>]*>)/);
let refused = 0;
for (const { old, new: repl, count = 1 } of edits) {
  const needle = esc(old);
  const found = parts.reduce((n, p) => (p.startsWith('<') ? n : n + (p.split(needle).length - 1)), 0);
  if (found !== count) {
    refused += 1;
    console.log(`REFUSED "${old.slice(0, 60)}": found ${found}, expected ${count}`);
    continue;
  }
  parts = parts.map((p) => (p.startsWith('<') ? p : p.split(needle).join(esc(repl))));
  console.log(`ok     "${old.slice(0, 50)}" → "${repl.slice(0, 50)}" ×${found}`);
}
if (refused) {
  console.log(`${refused} edit(s) refused; nothing written`);
  process.exit(1);
}
if (!apply) {
  console.log('dry run OK (re-run with --apply)');
  process.exit(0);
}
const v = await version(`${path}.html`, `pre QA fix ${new Date().toISOString().slice(0, 10)}`);
const again = await getSource(`${path}.html`);
if (v !== 201 || again.etag !== src.etag) {
  console.log(`not written (version ${v}, drift ${again.etag !== src.etag})`);
  process.exit(2);
}
console.log(`write ${await putSource(`${path}.html`, parts.join(''), 'text/html')}`);
