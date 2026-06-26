#!/usr/bin/env node
/**
 * Push all aemdev.org scaffold pages to DA + trigger Helix preview.
 *
 * Usage:
 *   DA_TOKEN=$(cat ~/today-da-token.txt) node tools/da/push-aemdev-pages.js
 *
 * DA API:   https://admin.da.live/source/{org}/{site}{daPath}
 * HLX API:  https://admin.hlx.page/preview/{org}/{site}/{branch}/{hlxPath}
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ORG = 'aemgdc';
const SITE = 'aemdev';
const BRANCH = 'main';
const DA_API = 'https://admin.da.live/source';
const HLX_API = 'https://admin.hlx.page';

const token = process.env.DA_TOKEN || process.argv[2];
if (!token) {
  console.error('Error: DA_TOKEN env var or first arg required.');
  console.error('Usage: DA_TOKEN=$(cat ~/today-da-token.txt) node tools/da/push-aemdev-pages.js');
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

const PAGES = [
  {
    label: 'home',
    src: 'index.plain.html',
    daPath: '/index.html',
    hlxPath: '',
  },
  {
    label: 'nav/header',
    src: 'fragments/nav/header.plain.html',
    daPath: '/fragments/nav/header.html',
    hlxPath: 'fragments/nav/header',
  },
  {
    label: 'nav/footer',
    src: 'fragments/nav/footer.plain.html',
    daPath: '/fragments/nav/footer.html',
    hlxPath: 'fragments/nav/footer',
  },
  {
    label: 'articles listing',
    src: 'en/articles/index.plain.html',
    daPath: '/en/articles.html',
    hlxPath: 'en/articles',
  },
  {
    label: 'meetup-recaps listing',
    src: 'en/meetup-recaps/index.plain.html',
    daPath: '/en/meetup-recaps.html',
    hlxPath: 'en/meetup-recaps',
  },
  {
    label: 'contact',
    src: 'en/contact/index.plain.html',
    daPath: '/en/contact.html',
    hlxPath: 'en/contact',
  },
  {
    label: 'article: content-modeling-deep-dive',
    src: 'en/articles/aem-eds-content-modeling-deep-dive/index.plain.html',
    daPath: '/en/articles/aem-eds-content-modeling-deep-dive.html',
    hlxPath: 'en/articles/aem-eds-content-modeling-deep-dive',
  },
  {
    label: 'recap: june-2026-eds-cdn',
    src: 'en/meetup-recaps/aem-gdc-june-2026-eds-cdn-recap/index.plain.html',
    daPath: '/en/meetup-recaps/aem-gdc-june-2026-eds-cdn-recap.html',
    hlxPath: 'en/meetup-recaps/aem-gdc-june-2026-eds-cdn-recap',
  },
];

async function uploadDoc(page) {
  const fullSrc = path.resolve(repoRoot, page.src);
  if (!fs.existsSync(fullSrc)) {
    console.error(`  ✗ missing: ${page.src}`);
    return false;
  }
  const inner = fs.readFileSync(fullSrc, 'utf8');
  const html = `<body>\n  <header></header>\n  <main>\n${inner}\n  </main>\n  <footer></footer>\n</body>`;
  const url = `${DA_API}/${ORG}/${SITE}${page.daPath}`;

  const form = new FormData();
  form.append('data', new Blob([html], { type: 'text/html' }), path.basename(page.daPath));

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  if (!res.ok && res.status !== 201) {
    const body = await res.text();
    console.error(`  ✗ DA ${res.status} ${res.statusText} — ${body.slice(0, 300)}`);
    return false;
  }
  console.log(`  ✓ DA ${res.status}  →  ${page.daPath}`);
  return true;
}

async function preview(page) {
  const hlxPath = page.hlxPath;
  const url = `${HLX_API}/preview/${ORG}/${SITE}/${BRANCH}/${hlxPath}`;
  console.log(`  → preview ${url}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.text();
  if (!res.ok) {
    console.error(`  ✗ preview ${res.status} ${res.statusText} — ${body.slice(0, 200)}`);
    return false;
  }
  try {
    const data = JSON.parse(body);
    const previewUrl = data?.preview?.url || data?.url || '';
    console.log(`  ✓ preview ${res.status}  ${previewUrl}`);
  } catch {
    console.log(`  ✓ preview ${res.status}`);
  }
  return true;
}

async function main() {
  console.log(`\n=== aemdev.org DA push + preview ===`);
  console.log(`Org: ${ORG}  Site: ${SITE}  Branch: ${BRANCH}`);
  console.log(`Pages: ${PAGES.length}\n`);

  let pushed = 0;
  let previewed = 0;

  for (const page of PAGES) {
    console.log(`\n[${page.label}]`);
    const ok = await uploadDoc(page);
    if (ok) {
      pushed++;
      const pOk = await preview(page);
      if (pOk) previewed++;
    }
  }

  console.log(`\n=== Done ===`);
  console.log(`Uploaded:  ${pushed}/${PAGES.length}`);
  console.log(`Previewed: ${previewed}/${PAGES.length}`);

  if (previewed === PAGES.length) {
    console.log(`\nPreview root: https://${BRANCH}--${SITE}--${ORG}.aem.page/`);
    console.log(`DA view:      https://da.live/#/${ORG}/${SITE}`);
  }

  process.exit(pushed < PAGES.length ? 1 : 0);
}

main();
