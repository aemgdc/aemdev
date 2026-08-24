#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Seed the bio corpus in DA: headshots, bio documents, and the roster sheet.
 *
 * This writes exactly what the Bio Manager writes — both import the document
 * format from tools/bio-manager/bio-doc.js — so a seeded bio and an
 * author-created one are indistinguishable, and editing a seeded bio in the app
 * round-trips cleanly.
 *
 * Usage:
 *   DA_TOKEN=$(cat ~/today-da-token.txt) node tools/da/push-bios.js
 *   node tools/da/push-bios.js --dry-run
 *   node tools/da/push-bios.js --fetch-headshots      # top up ./seed/headshots
 *   node tools/da/push-bios.js --only tad-reeves,laurel-timko
 *   node tools/da/push-bios.js --no-publish           # preview only
 *
 * Headshots are read from tools/bio-manager/seed/headshots/<slug>.jpg. That
 * directory is gitignored on purpose: they are other people's photographs, and
 * a versioned copy is a copy nobody can retract. `--fetch-headshots` refills it
 * from each profile's public OpenGraph preview image. A bio with no headshot
 * still seeds — blocks/bio falls back to initials.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BIO_PATHS,
  bioPath,
  buildBioDoc,
  buildSheetPayload,
} from '../bio-manager/bio-doc.js';

const ORG = 'aemgdc';
const SITE = 'aemdev';
const BRANCH = 'main';
const DA_SOURCE = 'https://admin.da.live/source';
const AEM_ADMIN = 'https://admin.hlx.page';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED_DIR = path.resolve(HERE, '../bio-manager/seed');
const HEADSHOT_DIR = path.join(SEED_DIR, 'headshots');
const MANIFEST = path.join(SEED_DIR, 'bios.json');

const EXT_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.svg': 'image/svg+xml' };
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

/* ------------------------------------------------------------------- args */

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const value = (flag) => {
  const i = argv.indexOf(flag);
  return i > -1 ? argv[i + 1] : null;
};

const DRY_RUN = has('--dry-run');
const FETCH_HEADSHOTS = has('--fetch-headshots');
const PUBLISH = !has('--no-publish');
const ONLY = (value('--only') || '').split(',').map((s) => s.trim()).filter(Boolean);

function readToken() {
  const fromFile = path.join(os.homedir(), 'today-da-token.txt');
  if (process.env.DA_TOKEN) return process.env.DA_TOKEN.trim();
  const positional = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--only');
  if (positional) return positional.trim();
  if (fs.existsSync(fromFile)) return fs.readFileSync(fromFile, 'utf8').trim();
  return '';
}

const TOKEN = DRY_RUN ? 'dry-run' : readToken();
if (!TOKEN) {
  console.error('No DA token. Set DA_TOKEN, pass it as an argument, or put it in ~/today-da-token.txt.');
  console.error('Add --dry-run to see what would happen without one.');
  process.exit(1);
}

const auth = () => ({ Authorization: `Bearer ${TOKEN}` });
const sourceUrl = (p) => `${DA_SOURCE}/${ORG}/${SITE}${p}`;

/* -------------------------------------------------------------- headshots */

/** Pull the public OpenGraph preview image off a profile page. */
async function fetchHeadshot(bio) {
  if (!bio.linkedin) return false;
  const resp = await fetch(bio.linkedin, { headers: { 'User-Agent': UA } });
  if (!resp.ok) {
    console.log(`    profile page ${resp.status} — skipping headshot`);
    return false;
  }
  const html = await resp.text();
  const match = html.match(/https:\/\/media\.licdn\.com\/dms\/image\/[^"']*profile-displayphoto[^"']*/);
  if (!match) {
    console.log('    no public preview image on that profile — skipping headshot');
    return false;
  }
  const url = match[0].replace(/&amp;/g, '&');
  const img = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!img.ok) {
    console.log(`    preview image ${img.status} — skipping headshot`);
    return false;
  }
  const bytes = Buffer.from(await img.arrayBuffer());
  fs.mkdirSync(HEADSHOT_DIR, { recursive: true });
  fs.writeFileSync(path.join(HEADSHOT_DIR, `${bio.slug}.jpg`), bytes);
  console.log(`    fetched headshot (${bytes.length} bytes)`);
  return true;
}

function localHeadshot(slug) {
  const found = Object.keys(EXT_TYPES)
    .map((ext) => path.join(HEADSHOT_DIR, `${slug}${ext}`))
    .find((p) => fs.existsSync(p));
  return found || null;
}

/**
 * Upload a headshot and return the URL to put in the document. DA hands back a
 * content-bus URL, which is exactly what DA itself writes into docs — the Edge
 * Delivery pipeline resolves and re-hosts it when the doc is previewed.
 */
async function uploadHeadshot(file, slug) {
  const ext = path.extname(file).toLowerCase();
  const target = `${BIO_PATHS.media}/${slug}${ext}`;
  if (DRY_RUN) {
    console.log(`    [dry-run] would upload ${path.basename(file)} -> ${target}`);
    return `https://content.da.live/${ORG}/${SITE}${target}`;
  }
  const body = new FormData();
  body.append('data', new Blob([fs.readFileSync(file)], { type: EXT_TYPES[ext] }), path.basename(target));
  const resp = await fetch(sourceUrl(target), { method: 'POST', headers: auth(), body });
  if (!resp.ok) throw new Error(`headshot upload failed (${resp.status}) for ${target}`);
  const json = await resp.json().catch(() => null);
  const url = json?.source?.contentUrl;
  if (!url) throw new Error(`DA returned no contentUrl for ${target}`);
  console.log(`    uploaded -> ${target}`);
  return url;
}

/* ------------------------------------------------------------------- DA IO */

async function ensureFolders() {
  for (let i = 0; i < BIO_PATHS.folders.length; i += 1) {
    const folder = BIO_PATHS.folders[i];
    if (DRY_RUN) {
      console.log(`[dry-run] would ensure folder ${folder}`);
    } else {
      const resp = await fetch(sourceUrl(folder), { method: 'POST', headers: auth() });
      if (!resp.ok && ![400, 409].includes(resp.status)) {
        throw new Error(`could not create ${folder} (${resp.status})`);
      }
    }
  }
  console.log(`Folders ready: ${BIO_PATHS.folders.join(', ')}`);
}

async function putDoc(daPath, html) {
  if (DRY_RUN) {
    console.log(`    [dry-run] would write ${daPath}.html (${html.length} bytes)`);
    return;
  }
  const body = new FormData();
  body.append('data', new Blob([html], { type: 'text/html' }), `${path.basename(daPath)}.html`);
  const resp = await fetch(`${sourceUrl(daPath)}.html`, { method: 'POST', headers: auth(), body });
  if (!resp.ok) throw new Error(`document write failed (${resp.status}) for ${daPath}`);
  console.log(`    wrote ${daPath}.html`);
}

/** Read the roster so a partial re-seed merges instead of truncating. */
async function readSheet() {
  if (DRY_RUN) return { rows: [], envelope: { kind: 'single' } };
  const resp = await fetch(`${sourceUrl(BIO_PATHS.sheet)}.json`, { headers: auth() });
  if (resp.status === 404) return { rows: [], envelope: { kind: 'single' } };
  if (!resp.ok) throw new Error(`could not read ${BIO_PATHS.sheet}.json (${resp.status})`);
  const json = await resp.json();
  if (Array.isArray(json?.data)) return { rows: json.data, envelope: { kind: 'single' } };
  if (Array.isArray(json?.[':names'])) {
    const names = json[':names'];
    const primary = names.includes('data') ? 'data' : names[0];
    return {
      rows: Array.isArray(json[primary]?.data) ? json[primary].data : [],
      envelope: { kind: 'multi', names, primary, raw: json },
    };
  }
  return { rows: [], envelope: { kind: 'single' } };
}

async function writeSheet(bios, envelope) {
  const payload = buildSheetPayload(bios, envelope);
  if (DRY_RUN) {
    console.log(`[dry-run] would write ${BIO_PATHS.sheet}.json with ${bios.length} rows`);
    return;
  }
  const body = new FormData();
  body.append('data', new Blob([JSON.stringify(payload)], { type: 'application/json' }), 'bios.json');
  const resp = await fetch(`${sourceUrl(BIO_PATHS.sheet)}.json`, {
    method: 'POST',
    headers: auth(),
    body,
  });
  if (!resp.ok) throw new Error(`sheet write failed (${resp.status})`);
  console.log(`Roster written: ${BIO_PATHS.sheet}.json (${bios.length} rows)`);
}

async function aemAction(action, daPath) {
  if (DRY_RUN) {
    console.log(`    [dry-run] would ${action} ${daPath}`);
    return true;
  }
  const url = `${AEM_ADMIN}/${action}/${ORG}/${SITE}/${BRANCH}${daPath}`;
  const resp = await fetch(url, { method: 'POST', headers: auth() });
  if (resp.ok) {
    console.log(`    ${action} ok`);
    return true;
  }
  const why = resp.headers.get('x-error') || resp.statusText;
  console.log(`    ${action} FAILED ${resp.status} ${why}`);
  return false;
}

/* -------------------------------------------------------------------- main */

async function seedBio(entry) {
  console.log(`\n[${entry.slug}] ${entry.name}`);

  if (FETCH_HEADSHOTS && !localHeadshot(entry.slug)) await fetchHeadshot(entry);

  const file = localHeadshot(entry.slug);
  let image = '';
  if (file) {
    image = await uploadHeadshot(file, entry.slug);
  } else {
    console.log('    no headshot — the bio will render with initials');
  }

  const bio = {
    slug: entry.slug,
    name: entry.name,
    title: entry.title,
    company: entry.company,
    linkedin: entry.linkedin,
    status: entry.status || 'placeholder',
    image,
    body: entry.body.map((p) => `<p>${p}</p>`).join(''),
    path: bioPath(entry.slug),
    updated: new Date().toISOString().slice(0, 10),
  };

  await putDoc(bio.path, buildBioDoc(bio));
  const previewed = await aemAction('preview', bio.path);
  if (previewed && PUBLISH) await aemAction('live', bio.path);
  return bio;
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const entries = ONLY.length
    ? manifest.bios.filter((b) => ONLY.includes(b.slug))
    : manifest.bios;

  if (!entries.length) {
    console.error(`Nothing to do — --only matched none of: ${manifest.bios.map((b) => b.slug).join(', ')}`);
    process.exit(2);
  }

  console.log(`=== Seeding ${entries.length} bio(s) into ${ORG}/${SITE} ===`);
  if (DRY_RUN) console.log('DRY RUN — nothing will be written.\n');

  await ensureFolders();

  const seeded = [];
  const failed = [];
  for (let i = 0; i < entries.length; i += 1) {
    try {
      seeded.push(await seedBio(entries[i]));
    } catch (e) {
      failed.push(entries[i].slug);
      console.error(`    ERROR ${e.message}`);
    }
  }

  if (seeded.length) {
    const { rows, envelope } = await readSheet();
    const kept = rows.filter((r) => !seeded.some((b) => b.slug === r.Slug));
    // Existing rows come back in sheet shape; buildSheetPayload re-serialises
    // both, so pass the kept rows through unchanged by faking the bio shape.
    const keptBios = kept.map((r) => ({
      slug: r.Slug,
      name: r.Name,
      title: r.Title,
      company: r.Company,
      linkedin: r.LinkedIn,
      image: r.Image,
      path: r.Path,
      status: r.Status,
      updated: r.Updated,
    }));
    const all = keptBios.concat(seeded).sort((a, b) => String(a.name).localeCompare(b.name));
    await writeSheet(all, envelope);
  }

  console.log(`\n=== Done: ${seeded.length} seeded, ${failed.length} failed ===`);
  if (failed.length) console.log(`Failed: ${failed.join(', ')}`);
  if (!DRY_RUN && seeded.length) {
    console.log(`\nRoster:   https://da.live/sheet#/${ORG}/${SITE}${BIO_PATHS.sheet}`);
    console.log(`Bios:     https://da.live/#/${ORG}/${SITE}${BIO_PATHS.fragments}`);
    console.log(`Live:     https://www.aemdev.org${bioPath(seeded[0].slug)}`);
    console.log(`App:      https://da.live/app/${ORG}/${SITE}/tools/bio-manager`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
