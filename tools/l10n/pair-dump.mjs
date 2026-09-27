/* eslint-disable no-console */
// Side-by-side dump for translation QA: every block cell of an EN doc, marked with what
// DA's own rule engine decided (T = sent for translation, - = protected), followed by the
// same cell in each locale. Also dumps default content (text outside blocks).
// Needs a da-nx checkout: see da-nx.mjs (env DA_NX).
// Usage: node pair-dump.mjs /en/index [de,fr,...]
import { getJson, getSource, parse, norm } from './da.mjs';
import { importDaNx } from './da-nx.mjs';

const { default: parseQuery } = await importDaNx('nx/blocks/loc/dnt/parseQuery.js');
const { default: decorateTable } = await importDaNx('nx/blocks/loc/dnt/decorateTable.js');

const [enPath, locArg] = process.argv.slice(2);
const locales = (locArg || 'de,fr,es,it,pt,pl,ja,ko,zh-cn,zh-tw').split(',');
const clip = (s, n = 200) => {
  const t = norm(s).replace(/\?\S*/g, '?…');
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

const cfg = (await getJson('/.da/translate.json')).json;
const docRules = new Map();
cfg['custom-doc-rules'].data.forEach(({ block, rule }) => block.split(',').map((b) => b.trim())
  .forEach((b) => docRules.set(b, [...(docRules.get(b) || []), rule])));
console.log(`DNT content terms: ${cfg['dnt-content-rules'].data.map((r) => r.content).join(' | ')}`);

const enDoc = parse((await getSource(`${enPath}.html`)).text);
enDoc.querySelector('header')?.remove();
enDoc.querySelector('footer')?.remove();
docRules.forEach((rules, block) => enDoc.querySelectorAll(`.${block}`)
  .forEach((el) => rules.forEach((r) => decorateTable(el, parseQuery(r)))));
const isProtected = (cell, block) => {
  for (let e = cell; e && e !== block.parentElement; e = e.parentElement) {
    if (e.getAttribute?.('translate') === 'no') return true;
  }
  return false;
};

const rel = enPath.replace(/^\/en/, '');
const tx = {};
for (const loc of locales) {
  const r = await getSource(`/${loc}${rel}.html`);
  tx[loc] = r.status === 200 ? parse(r.text) : null;
}

const enBlocks = [...enDoc.querySelectorAll('main > div > div[class]')];
console.log(`\n# ${enPath} — ${enBlocks.length} blocks; locales: ${locales.map((l) => `${l}${tx[l] ? '' : '(MISSING)'}`).join(' ')}`);
enBlocks.forEach((b, bi) => {
  console.log(`\n## block ${bi + 1}: ${b.className}  (rules: ${(docRules.get(b.className.split(' ')[0]) || ['<none: all translated>']).join(' ; ')})`);
  [...b.children].forEach((row, ri) => [...row.children].forEach((cell, ci) => {
    const mark = isProtected(cell, b) ? '-' : 'T';
    const media = cell.querySelector('img,picture') ? ' [img]' : '';
    console.log(`  r${ri + 1}c${ci + 1} ${mark} EN: ${clip(cell.textContent)}${media}`);
    for (const loc of locales) {
      const tb = tx[loc] && [...tx[loc].querySelectorAll('main > div > div[class]')][bi];
      const tcell = tb?.children[ri]?.children[ci];
      console.log(`         ${loc.padEnd(5)}: ${tcell ? clip(tcell.textContent) : '<no cell>'}`);
    }
  }));
});
// Default content: headings/paragraphs/list items that are direct section content
// (not inside blocks).
const defaults = (doc) => [...doc.querySelectorAll('main > div > :is(h1,h2,h3,h4,h5,h6,p,li,ul,ol)')]
  .map((e) => clip(e.textContent, 160)).filter(Boolean);
const enDefaults = defaults(enDoc);
if (enDefaults.length) {
  console.log('\n## default content (outside blocks), all translated');
  enDefaults.forEach((t, i) => {
    console.log(`  d${i + 1} EN: ${t}`);
    for (const loc of locales) console.log(`         ${loc.padEnd(5)}: ${tx[loc] ? (defaults(tx[loc])[i] ?? '<missing>') : '<no doc>'}`);
  });
}
