/* eslint-disable no-console */
// Canary diff (check) from DA source: EN vs each locale, block by block. No preview needed.
//   KEY     a short key-looking source value that came back translated (DNT rule gap)
//   HREF    a link target that changed other than the /en/ -> /<loc>/ swap
//   ENLINK  an internal /en/ link that survived into the translation (link-heal candidate)
//   SHAPE   block count / class / row / column drift
//   UNTX    a prose cell returned identical (rule too broad, or connector skipped it)
//   MISSING the translated doc does not exist yet
//   TAXONOMY a metadata value (other than title/description) or a tag/category-valued block
//           cell differs from the English source; taxonomy never goes to MT
// First line of output is the per-kind count summary (or "clean"); --summary prints only it.
// Usage: node check.mjs [--summary] [--locales de,ja] /en/index /en/meetups ...  (no .html)
import { getSource, parse, norm, blocks } from './da.mjs';

const args = process.argv.slice(2);
const li = args.indexOf('--locales');
const locales = li >= 0 ? args.splice(li, 2)[1].split(',') : ['de', 'fr', 'es', 'it', 'pt', 'pl', 'ja', 'ko', 'zh-cn', 'zh-tw'];
const quiet = args.includes('--summary');
const pages = args.filter((a) => !a.startsWith('--'));

const keyish = (s) => s.length > 0 && s.length <= 40
  && (/^[\w:./#@+|,-]+$/.test(s) || /^[a-z][a-z0-9 |,-]{0,30}$/.test(s));
const prose = (s) => s.length >= 60 && /[a-z]{3,} [a-z]{3,} [a-z]{3,}/i.test(s);
const clean = (s) => String(s).replace(/\?\S*/g, '?…');

const counts = {};
const lines = [];
const push = (kind, text) => {
  counts[kind] = (counts[kind] || 0) + 1;
  lines.push(`${kind.padEnd(7)} ${clean(text)}`);
};

for (const src of pages) {
  const rel = src.replace(/^\/en/, '');
  const s = await getSource(`${src}.html`);
  if (s.status !== 200) {
    push('SRCERR', `${src} HTTP ${s.status}`);
    continue; // eslint-disable-line no-continue
  }
  const sdoc = parse(s.text);
  const sb = blocks(sdoc);
  for (const loc of locales) {
    const txPath = `/${loc}${rel}`;
    const t = await getSource(`${txPath}.html`);
    if (t.status !== 200) {
      push('MISSING', `${txPath} (HTTP ${t.status})`);
      continue; // eslint-disable-line no-continue
    }
    const tdoc = parse(t.text);
    const tb = blocks(tdoc);
    if (sb.length !== tb.length || sb.some((b, i) => b.className !== tb[i]?.className)) {
      push('SHAPE', `${txPath} blocks src=[${sb.map((b) => b.className).join(',')}] tx=[${tb.map((b) => b.className).join(',')}]`);
    }
    sb.forEach((b, i) => {
      const x = tb[i];
      if (!x || x.className !== b.className) return;
      const name = b.className.split(' ')[0];
      if (b.children.length !== x.children.length) push('SHAPE', `${txPath} ${name} rows ${b.children.length} -> ${x.children.length}`);
      [...b.children].forEach((row, ri) => {
        const xrow = x.children[ri];
        if (!xrow) return;
        [...row.children].forEach((cell, ci) => {
          const xcell = xrow.children[ci];
          if (!xcell) return;
          const a = norm(cell.textContent); const z = norm(xcell.textContent);
          const label = ci > 0 ? ` [${norm(row.children[0].textContent).slice(0, 20)}]` : '';
          const where = `${txPath} ${name} r${ri + 1}c${ci + 1}${label}`;
          if (a && a !== z && keyish(a)) push('KEY', `${where}: "${a}" -> "${z.slice(0, 40)}"`);
          if (a && a === z && prose(a)) push('UNTX', `${where}: "${a.slice(0, 50)}"`);
          const ah = [...cell.querySelectorAll('a[href]')].map((e) => e.getAttribute('href'));
          const zh = [...xcell.querySelectorAll('a[href]')].map((e) => e.getAttribute('href'));
          ah.forEach((h, hi) => {
            const got = zh[hi];
            const swapped = h.replace(/^\/en(\/|$)/, `/${loc}$1`);
            if (got !== undefined && got !== h && got !== swapped) push('HREF', `${where}: ${h} -> ${got}`);
          });
        });
      });
    });
    // TAXONOMY: tags/categories come from the AEM tags servlet, never from MT. Every metadata
    // row except title/description-type rows, and every category/tag-valued block cell,
    // must be byte-identical to the English source.
    const TRANSLATABLE_META = new Set(['title', 'description', 'displaydescription', 'og:title']);
    const TAXO_KEY = /^(tags?|categor(y|ies)|article:tag|template|status|card-\d+-category)$/i;
    sb.forEach((b, i) => {
      const x = tb[i];
      if (!x || x.className !== b.className) return;
      const name = b.className.split(' ')[0];
      [...b.children].forEach((row, ri) => {
        const key = norm(row.children[0]?.textContent).toLowerCase();
        const guarded = name === 'metadata' ? !TRANSLATABLE_META.has(key) : TAXO_KEY.test(key);
        if (!guarded || row.children.length < 2) return;
        const a = norm(row.children[1].textContent);
        const z = norm(x.children[ri]?.children[1]?.textContent);
        if (a !== z) push('TAXONOMY', `${txPath} ${name} [${key}]: "${a.slice(0, 50)}" -> "${z.slice(0, 50)}"`);
      });
    });
    // Internal /en/ links anywhere in the translated main (incl. default content outside blocks).
    const enLinks = [...tdoc.querySelectorAll('main a[href]')].map((e) => e.getAttribute('href'))
      .filter((h) => /^(https:\/\/[^/]*(aem\.(page|live)|aemdev\.org))?\/en(\/|$)/.test(h));
    if (enLinks.length) push('ENLINK', `${txPath}: ${enLinks.length} /en/ link(s): ${[...new Set(enLinks)].slice(0, 4).join(', ')}`);
  }
}
console.log(Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ') || 'clean');
if (!quiet) console.log(lines.join('\n'));
