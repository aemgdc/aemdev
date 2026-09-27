/* eslint-disable no-console */
// Apply DA's own custom-doc-rules engine (da-nx parseQuery + decorateTable) to real DA source docs
// and print, per block cell, whether it will be sent for translation (T) or protected (-).
// Needs a da-nx checkout: see da-nx.mjs (env DA_NX).
// Usage: node simulate.mjs [--extra rules.json] [--blocks a,b] <da-path.html> ...
import { readFileSync } from 'node:fs';
import { getJson, getSource, parse, norm } from './da.mjs';
import { importDaNx } from './da-nx.mjs';

const { default: parseQuery } = await importDaNx('nx/blocks/loc/dnt/parseQuery.js');
const { default: decorateTable } = await importDaNx('nx/blocks/loc/dnt/decorateTable.js');

const args = process.argv.slice(2);
let extra = [];
const ei = args.indexOf('--extra');
if (ei >= 0) {
  extra = JSON.parse(readFileSync(args[ei + 1], 'utf8'));
  args.splice(ei, 2);
}
const only = args.indexOf('--blocks');
let onlyBlocks = null;
if (only >= 0) {
  onlyBlocks = args[only + 1].split(',');
  args.splice(only, 2);
}

const cfg = (await getJson('/.da/translate.json')).json;
const docRules = new Map();
[...cfg['custom-doc-rules'].data, ...extra].forEach(({ block, rule }) => {
  block.split(',').map((b) => b.trim()).filter(Boolean).forEach((b) => {
    docRules.set(b, [...(docRules.get(b) || []), rule]);
  });
});

const protectedCell = (cell, blockEl) => {
  for (let el = cell; el && el !== blockEl.parentElement; el = el.parentElement) {
    if (el.getAttribute && el.getAttribute('translate') === 'no') return true;
  }
  return false;
};

for (const path of args) {
  const doc = parse((await getSource(path)).text);
  doc.querySelector('header')?.remove();
  doc.querySelector('footer')?.remove();
  docRules.forEach((rules, block) => {
    doc.querySelectorAll(`.${block}`).forEach((el) => rules.forEach((rule) => decorateTable(el, parseQuery(rule))));
  });
  console.log(`## ${path}`);
  doc.querySelectorAll('main > div > div[class]').forEach((b) => {
    const name = b.className.split(' ')[0];
    if (onlyBlocks && !onlyBlocks.includes(name)) return;
    const rows = [...b.children].map((r) => [...r.children].map((c) => {
      const t = norm(c.textContent).replace(/\?\S*/g, '?…').slice(0, 22);
      const mark = protectedCell(c, b) ? '-' : 'T';
      return `${mark}"${t}"${c.querySelector('img,picture') ? '<img>' : ''}`;
    }).join(' | '));
    console.log(`  ${b.className}: ${rows.length ? rows.map((r, i) => `r${i + 1}[${r}]`).join(' ') : '(empty)'}`);
  });
}
