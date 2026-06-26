#!/usr/bin/env node
/**
 * Push article(s) to DA + trigger preview + publish on aem.live.
 *
 * Usage:
 *   DA_TOKEN=$(cat ~/today-da-token.txt) node tools/da/push-articles.js [slug]
 *
 * If no slug is provided, pushes every entry in ARTICLES below.
 *
 * Each article maps a local `en/<slug>/index.plain.html` source file to a DA
 * document at `/en/<slug>.html`, then triggers preview + publish.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ORG = 'treeves';
const SITE = 'opsinventor-eds';
const BRANCH = 'main';
const DA_API = 'https://admin.da.live/source';
const HLX_API = 'https://admin.hlx.page';

const ARTICLES = [
  {
    slug: 'home',
    src: 'index.plain.html',
    daPath: '/index.html',
    hlxPath: '',
  },
  {
    slug: 'nav',
    src: 'fragments/nav/header.plain.html',
    daPath: '/fragments/nav/header.html',
    hlxPath: 'fragments/nav/header',
  },
  {
    slug: 'footer',
    src: 'fragments/nav/footer.plain.html',
    daPath: '/fragments/nav/footer.html',
    hlxPath: 'fragments/nav/footer',
  },
  {
    slug: 'tailing-and-viewing-adobe-cloud-manager-build-logs',
    src: 'en/tailing-and-viewing-adobe-cloud-manager-build-logs/index.plain.html',
  },
  {
    slug: 'testing-geo-seo-with-adobe-llm-optimizer',
    src: 'en/testing-geo-seo-with-adobe-llm-optimizer/index.plain.html',
  },
  {
    slug: 'aem-infrastructure-and-personnel-strategy-a-talk-with-tom-johnson-of-hirobe',
    src: 'en/aem-infrastructure-and-personnel-strategy-a-talk-with-tom-johnson-of-hirobe/index.plain.html',
  },
];

const token = process.env.DA_TOKEN || process.argv[3];
if (!token) {
  console.error('Error: DA_TOKEN env var or 2nd arg required.');
  console.error('Usage: DA_TOKEN=$(cat ~/today-da-token.txt) node tools/da/push-articles.js [slug]');
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

async function uploadDoc(article) {
  const { slug, src: srcPath } = article;
  const fullSrc = path.resolve(repoRoot, srcPath);
  if (!fs.existsSync(fullSrc)) {
    console.error(`  ✗ missing source file: ${fullSrc}`);
    return false;
  }
  const inner = fs.readFileSync(fullSrc, 'utf8');
  // Wrap with the DA document shell DA expects.
  const html = `<body>\n  <header></header>\n  <main>\n${inner}\n  </main>\n  <footer></footer>\n</body>`;

  const daPath = article.daPath || `/en/${slug}.html`;
  const url = `${DA_API}/${ORG}/${SITE}${daPath}`;

  const form = new FormData();
  form.append('data', new Blob([html], { type: 'text/html' }), `${slug}.html`);

  console.log(`→ DA upload  ${daPath}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok && res.status !== 201) {
    const body = await res.text();
    console.error(`  ✗ ${res.status} ${res.statusText}\n  ${body.slice(0, 400)}`);
    return false;
  }
  console.log(`  ✓ ${res.status}`);
  return true;
}

async function hlxAction(action, article) {
  const hlxPath = article.hlxPath !== undefined ? article.hlxPath : `en/${article.slug}`;
  const url = `${HLX_API}/${action}/${ORG}/${SITE}/${BRANCH}/${hlxPath}`;
  console.log(`→ ${action.padEnd(7)} ${url}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.text();
  if (!res.ok) {
    console.error(`  ✗ ${res.status} ${res.statusText}\n  ${body.slice(0, 400)}`);
    return false;
  }
  try {
    const data = JSON.parse(body);
    console.log(`  ✓ ${res.status}  ${data?.[action]?.url || ''}`);
  } catch {
    console.log(`  ✓ ${res.status}`);
  }
  return true;
}

async function pushOne(article) {
  console.log(`\n=== ${article.slug} ===`);
  const ok = await uploadDoc(article);
  if (!ok) return false;
  await hlxAction('preview', article);
  // publish is the second action — call only if preview worked, but don't fail on errors
  // await hlxAction('live', article); // uncomment to publish
  return true;
}

async function main() {
  const onlySlug = process.argv[2];
  const targets = onlySlug
    ? ARTICLES.filter((a) => a.slug === onlySlug)
    : ARTICLES;
  if (!targets.length) {
    console.error(`No article matches slug "${onlySlug}".`);
    process.exit(2);
  }
  let failed = 0;
  for (const a of targets) {
    const ok = await pushOne(a);
    if (!ok) failed += 1;
  }
  console.log(`\nDone. ${targets.length - failed}/${targets.length} pushed.`);
  process.exit(failed ? 1 : 0);
}

main();
