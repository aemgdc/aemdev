/* eslint-disable no-console */
// Heal internal links in TRANSLATED DA docs after a connector rollout.
//   https://main--aemdev--aemgdc.aem.page/en/x   (connector absolutizes relative links)
//   https://…aem.live/en/x, https://www.aemdev.org/en/x, /en/x
// become /<loc>/x when the locale doc exists, else a RELATIVE /en/x.
// Known redirects (redirects.json) are followed first. Only href attributes change; the
// raw DA HTML is edited in place so no other markup is re-serialized.
// Usage: node link-heal.mjs [--apply] /de/meetups/x /ja/fragments/nav/header ...
//        node link-heal.mjs [--apply] --tree /de       (every .html doc under /de)
import {
  getSource, putSource, version, list,
} from './da.mjs';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const ti = args.indexOf('--tree');
const trees = ti >= 0 ? args[ti + 1].split(',') : [];
const paths = args.filter((a, i) => a.startsWith('/') && args[i - 1] !== '--tree');
const LABEL = `pre link-heal ${new Date().toISOString().slice(0, 10)}`;
const HOSTS = /^https:\/\/(main--aemdev--aemgdc\.aem\.(page|live)|www\.aemdev\.org|aemdev\.org)/;

const redirects = await fetch('https://main--aemdev--aemgdc.aem.live/redirects.json')
  .then((r) => (r.ok ? r.json() : { data: [] }))
  .then((j) => new Map((j.data || []).map((r) => [r.source, r.destination])))
  .catch(() => new Map());

const exists = new Map();
async function docExists(p) {
  if (exists.has(p)) return exists.get(p);
  const clean = p.replace(/\/$/, '');
  const candidates = p.endsWith('/') || clean.split('/').length === 2
    ? [`${clean}/index.html`] : [`${clean}.html`];
  let ok = false;
  for (const c of candidates) {
    if ((await getSource(c)).status === 200) {
      ok = true;
      break;
    }
  }
  exists.set(p, ok);
  return ok;
}

async function walk(folder) {
  const items = (await list(folder)) || [];
  const out = [];
  for (const it of items) {
    const p = `${folder}/${it.name}`;
    if (!it.ext) out.push(...await walk(p));
    else if (it.ext === 'html') out.push(p);
  }
  return out;
}

async function healDoc(docPath) {
  const loc = docPath.split('/')[1];
  const src = await getSource(`${docPath}.html`);
  if (src.status !== 200) return { docPath, error: `HTTP ${src.status}` };
  const changes = [];
  const re = /href="([^"]+)"/g;
  let html = src.text;
  const hrefs = [...new Set([...html.matchAll(re)].map((m) => m[1]))];
  for (const href of hrefs) {
    const url = href.replace(/&amp;/g, '&');
    const hostless = url.replace(HOSTS, '');
    if (!/^\/en(\/|$|[?#])/.test(hostless)) {
      // Any other own-host link the connector absolutized (/tools/widgets/…, /fragments/…,
      // media) just goes back to relative; its path is not locale-specific.
      if (hostless !== url && hostless.startsWith('/')) {
        changes.push(`${href.replace(/\?\S*/, '?…')} -> ${hostless.replace(/\?\S*/, '?…')}`);
        html = html.split(`href="${href}"`).join(`href="${hostless.replace(/&/g, '&amp;')}"`);
      }
      continue; // eslint-disable-line no-continue
    }
    const [pathPart, suffix = ''] = hostless.split(/(?=[?#])/);
    const followed = redirects.get(pathPart) || redirects.get(pathPart.replace(/\/$/, '')) || pathPart;
    const rel = followed.replace(/^\/en/, '') || '/';
    // `/x/` 404s on this site when `/x` is a page (only locale homes like `/de/` keep the
    // slash), so a trailing slash is dropped whenever the slash-less page exists.
    const unslash = async (p) => {
      if (!p.endsWith('/') || p.split('/').length <= 3) return p;
      return (await docExists(p.replace(/\/$/, ''))) ? p.replace(/\/$/, '') : p;
    };
    const localized = await unslash(`/${loc}${rel}`);
    const target = (await docExists(localized)) ? localized : await unslash(followed);
    const next = `${target}${suffix}`;
    if (next !== url) {
      changes.push(`${href.replace(/\?\S*/, '?…')} -> ${next.replace(/\?\S*/, '?…')}`);
      html = html.split(`href="${href}"`).join(`href="${next.replace(/&/g, '&amp;')}"`);
    }
  }
  if (!changes.length) return { docPath, changes };
  if (apply) {
    const v = await version(`${docPath}.html`, LABEL);
    if (v !== 201) return { docPath, error: `version ${v}; not written`, changes };
    const again = await getSource(`${docPath}.html`);
    if (again.etag !== src.etag) return { docPath, error: 'changed while versioning; not written', changes };
    const status = await putSource(`${docPath}.html`, html, 'text/html');
    return { docPath, changes, status };
  }
  return { docPath, changes };
}

const targets = [...paths];
for (const t of trees) targets.push(...(await walk(t)).map((p) => p.replace(/\.html$/, '')));
let changed = 0;
for (const p of targets) {
  const r = await healDoc(p);
  if (r.error) console.log(`!! ${p}: ${r.error}`);
  if (r.changes?.length) {
    changed += 1;
    const written = r.status === 200 ? 'HEALED' : `WRITE ${r.status}`;
    console.log(`${apply ? written : 'WOULD HEAL'} ${p}`);
    r.changes.forEach((c) => console.log(`     ${c}`));
  }
}
console.log(`${apply ? 'applied' : 'dry run'}: ${changed}/${targets.length} doc(s) with link changes`);
