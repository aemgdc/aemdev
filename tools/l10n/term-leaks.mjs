/* eslint-disable no-console, no-continue */
// Find do-not-translate TERM leaks: an EN text unit (block cell or default-content element)
// containing a dnt-content-rules term whose translated counterpart lacks that exact term.
// DA's content-rule wrapper is dead in the browser (XPathResult._value), so every term is
// exposed to MT. Output: JSON lines {doc, loc, unit, term, en, tx} to stdout.
// Usage: node term-leaks.mjs [--locales de,ja] /en/index /en/meetups ...
import {
  getJson, getSource, parse, norm,
} from './da.mjs';

const args = process.argv.slice(2);
const li = args.indexOf('--locales');
const locales = li >= 0 ? args.splice(li, 2)[1].split(',') : ['de', 'fr', 'es', 'it', 'pt', 'pl', 'ja', 'ko', 'zh-cn', 'zh-tw'];
const pages = args.filter((a) => a.startsWith('/'));

const cfg = (await getJson('/.da/translate.json')).json;
// Longest first, and drop terms contained in a longer term that also matches.
const terms = cfg['dnt-content-rules'].data.map((r) => r.content).filter(Boolean).sort((a, b) => b.length - a.length);

const units = (doc) => {
  const out = [];
  doc.querySelectorAll('main > div > div[class]').forEach((b, bi) => {
    [...b.children].forEach((row, ri) => [...row.children].forEach((cell, ci) => {
      out.push({ id: `b${bi + 1}:${b.className.split(' ')[0]}:r${ri + 1}c${ci + 1}`, text: norm(cell.textContent) });
    }));
  });
  [...doc.querySelectorAll('main > div > :is(h1,h2,h3,h4,h5,h6,p,li)')].forEach((e, i) => out.push({ id: `d${i + 1}`, text: norm(e.textContent) }));
  return out;
};

let leaks = 0;
for (const src of pages) {
  const enDoc = parse((await getSource(`${src}.html`)).text);
  const en = units(enDoc);
  const rel = src.replace(/^\/en/, '');
  for (const loc of locales) {
    const r = await getSource(`/${loc}${rel}.html`);
    if (r.status !== 200) continue;
    const tx = new Map(units(parse(r.text)).map((u) => [u.id, u.text]));
    for (const u of en) {
      const present = terms.filter((t) => u.text.includes(t));
      // keep longest only
      const kept = present.filter((t) => !present.some((o) => o !== t && o.includes(t)));
      for (const term of kept) {
        const txText = tx.get(u.id) ?? '';
        if (!txText.includes(term)) {
          leaks += 1;
          console.log(JSON.stringify({
            doc: `/${loc}${rel}`, loc, unit: u.id, term, en: u.text.slice(0, 300), tx: txText.slice(0, 300),
          }));
        }
      }
    }
  }
}
console.error(`term leaks: ${leaks}`);
