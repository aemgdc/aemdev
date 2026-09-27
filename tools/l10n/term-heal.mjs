/* eslint-disable no-console, no-continue */
// Restore do-not-translate brand terms in translated DA docs, using per-locale dictionaries
// of the exact MT renderings ({term, rendering}) produced and adversarially checked by the
// canary QA workflow. Replaces ONLY in text nodes (between tags), longest rendering first,
// so attributes, URLs and markup are untouched. Versions each doc before writing.
// Usage: node term-heal.mjs <dict.json> [--apply] /de/index /ja/meetups ...
//        node term-heal.mjs <dict.json> [--apply] --tree /de,/ja
//   dict.json: { "de": [{"term": "...", "rendering": "..."}], ... }
import { readFileSync } from 'node:fs';
import {
  getSource, putSource, version, list,
} from './da.mjs';

const args = process.argv.slice(2);
const dict = JSON.parse(readFileSync(args[0], 'utf8'));
const apply = args.includes('--apply');
const ti = args.indexOf('--tree');
const trees = ti >= 0 ? args[ti + 1].split(',') : [];
const paths = args.slice(1).filter((a, i, arr) => a.startsWith('/') && arr[i - 1] !== '--tree');
const LABEL = `pre term-heal ${new Date().toISOString().slice(0, 10)}`;

const locOf = (p) => p.split('/')[1];
const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function walk(folder) {
  const items = (await list(folder)) || [];
  const out = [];
  for (const it of items) {
    const p = `${folder}/${it.name}`;
    if (!it.ext) out.push(...await walk(p));
    else if (it.ext === 'html') out.push(p.replace(/\.html$/, ''));
  }
  return out;
}

function healText(html, maps) {
  const counts = {};
  const ordered = [...maps].sort((a, b) => b.rendering.length - a.rendering.length);
  const out = html.split(/(<[^>]*>)/).map((part) => {
    if (part.startsWith('<')) return part;
    let text = part;
    for (const { term, rendering } of ordered) {
      if (!rendering || rendering === term) continue;
      const needle = escapeHtml(rendering);
      if (!text.includes(needle)) continue;
      const n = text.split(needle).length - 1;
      counts[`${rendering} → ${term}`] = (counts[`${rendering} → ${term}`] || 0) + n;
      text = text.split(needle).join(escapeHtml(term));
    }
    return text;
  }).join('');
  return { out, counts };
}

const targets = [...paths];
for (const t of trees) targets.push(...await walk(t));
let docsChanged = 0; let total = 0;
for (const p of targets) {
  const maps = dict[locOf(p)] || [];
  if (!maps.length) continue;
  const src = await getSource(`${p}.html`);
  if (src.status !== 200) {
    console.log(`!! ${p}: HTTP ${src.status}`);
    continue;
  }
  const { out, counts } = healText(src.text, maps);
  const n = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!n) continue;
  docsChanged += 1;
  total += n;
  let status = 'dry';
  if (apply) {
    const v = await version(`${p}.html`, LABEL);
    const again = await getSource(`${p}.html`);
    if (v !== 201) status = `version ${v}; NOT written`;
    else if (again.etag !== src.etag) status = 'changed while versioning; NOT written';
    else status = `write ${await putSource(`${p}.html`, out, 'text/html')}`;
  }
  console.log(`${p} [${status}] ${Object.entries(counts).map(([k, v]) => `${k} ×${v}`).join('; ')}`);
}
console.log(`${apply ? 'applied' : 'dry run'}: ${total} replacement(s) in ${docsChanged} doc(s)`);
