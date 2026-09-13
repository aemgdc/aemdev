#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * seed-icons.mjs — publish tools/icon-picker/library/*.svg into the DA icon library.
 *
 * The library the Icon Picker reads is DA CONTENT, in two halves that must agree:
 *
 *   /icons/<key>.svg            the artwork
 *   /docs/library/icons.json    the manifest naming each file's insert key
 *
 * This pushes both from the copies checked into `library/`, so the library can be
 * rebuilt from git rather than from whatever happens to be in DA. It is additive:
 * a manifest key already in DA that this set does not define is left alone.
 *
 * Preview is always pushed; --live also publishes. Both matter for different
 * readers — the palette renders from the preview origin, a published page from
 * the live one.
 *
 * CLI
 *   node tools/icon-picker/seed-icons.mjs            dry run: what would change
 *   node tools/icon-picker/seed-icons.mjs --apply    write source + preview
 *   node tools/icon-picker/seed-icons.mjs --apply --live   ... and publish live
 *   node tools/icon-picker/seed-icons.mjs --check    compare DA against library/
 *
 * EXIT  0 as asked · 1 a write or the read-back failed · 2 could not reach DA
 *       3 usage / no token
 */
import { argv, exit } from 'node:process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ORG, SITE, DA_ADMIN, AEM_ADMIN, DEFAULT_BRANCH,
} from '../../scripts/tracker/paths.js';
import { resolveToken, TOKEN_HINT } from '../tracker/lib/status-sheet.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIBRARY_DIR = join(HERE, 'library');

const ICONS_DIR = 'icons';
const SHEET_PATH = 'docs/library/icons.json';

const SOURCE = (path) => `${DA_ADMIN}/source/${ORG}/${SITE}/${path}`;
const LIST = (path) => `${DA_ADMIN}/list/${ORG}/${SITE}/${path}`;
const AEM = (action, path) => `${AEM_ADMIN}/${action}/${ORG}/${SITE}/${DEFAULT_BRANCH}/${path}`;
// Absolute, because the DA Library palette renders this as an <img src> from the
// da.live origin — a root-relative path would resolve against da.live and 404.
const iconRef = (file) => `https://content.da.live/${ORG}/${SITE}/${ICONS_DIR}/${file}`;

const HELP = `seed-icons — push tools/icon-picker/library/*.svg into the DA icon library.

  (no flags)   dry run: show what would be written
  --apply      write the SVGs + manifest, and preview them
  --live       with --apply, also publish to the live tier
  --check      compare what is in DA against library/; exit 1 on any drift
  --help       this text

  library:  /${ICONS_DIR}/ + /${SHEET_PATH} on ${ORG}/${SITE}`;

function parseArgs(args) {
  const o = {
    apply: false, live: false, check: false, help: false,
  };
  for (const a of args) {
    if (a === '--apply') o.apply = true;
    else if (a === '--live') o.live = true;
    else if (a === '--check') o.check = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else {
      console.error(`unknown arg: ${a}`);
      exit(3);
    }
  }
  return o;
}

function localIcons() {
  return readdirSync(LIBRARY_DIR)
    .filter((f) => f.toLowerCase().endsWith('.svg'))
    .sort()
    .map((file) => ({
      key: basename(file, '.svg'),
      file,
      bytes: readFileSync(join(LIBRARY_DIR, file)),
    }));
}

function buildSheet(rows) {
  const len = rows.length;
  return JSON.stringify({
    total: len,
    limit: len,
    offset: 0,
    data: rows,
    ':colWidths': [175, 633],
    ':sheetname': 'data',
    ':type': 'sheet',
  });
}

async function main() {
  const opts = parseArgs(argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  const token = resolveToken();
  if (!token) {
    console.error(`ERROR: no DA token (${TOKEN_HINT})`);
    return 3;
  }
  const headers = { Authorization: `Bearer ${token}` };

  const icons = localIcons();
  if (!icons.length) {
    console.error(`ERROR: no SVGs in ${LIBRARY_DIR}`);
    return 3;
  }

  // What DA holds right now.
  let remoteFiles = [];
  let remoteRows = [];
  try {
    const lr = await fetch(LIST(ICONS_DIR), { headers });
    if (lr.status === 401 || lr.status === 403) {
      console.error('ERROR: token rejected reading the icons folder');
      return 3;
    }
    if (lr.ok) {
      remoteFiles = (await lr.json())
        .filter((i) => String(i.ext).toLowerCase() === 'svg')
        .map((i) => `${i.name}.${i.ext}`);
    }
    const mr = await fetch(SOURCE(SHEET_PATH), { headers });
    if (mr.ok) {
      const json = await mr.json();
      remoteRows = Array.isArray(json?.data) ? json.data : [];
    }
  } catch (e) {
    console.error(`ERROR: could not reach DA — ${e.message}`);
    return 2;
  }

  const have = new Set(remoteFiles);
  const haveKey = new Set(remoteRows.map((r) => String(r.key)));
  const missingFile = icons.filter((i) => !have.has(i.file));
  const missingKey = icons.filter((i) => !haveKey.has(i.key));

  if (opts.check) {
    const ok = !missingFile.length && !missingKey.length;
    console.log(`${ok ? '✓' : '✗'} ${icons.length} local icon(s) · `
      + `${remoteFiles.length} file(s) and ${remoteRows.length} manifest row(s) in DA`);
    if (missingFile.length) console.log(`  missing file:  ${missingFile.map((i) => i.file).join(', ')}`);
    if (missingKey.length) console.log(`  missing key:   ${missingKey.map((i) => i.key).join(', ')}`);
    return ok ? 0 : 1;
  }

  console.log(`── seed-icons · ${opts.apply ? 'APPLY' : 'DRY RUN (default)'} ──`);
  console.log(`   site:     ${ORG}/${SITE}`);
  console.log(`   folder:   /${ICONS_DIR}/  (${remoteFiles.length} svg in DA now)`);
  console.log(`   manifest: /${SHEET_PATH}  (${remoteRows.length} row(s) in DA now)`);
  console.log(`   tier:     preview${opts.live ? ' + live' : ' only (pass --live to publish)'}`);
  console.log(`\n   ${icons.length} icon(s) in library/:`);
  for (const i of icons) {
    const state = have.has(i.file) ? 'replace' : 'add';
    console.log(`     ${state.padEnd(8)} ${i.key.padEnd(14)} ${i.file}`);
  }

  // Additive: keep any manifest key DA already has that this set does not define.
  const mine = new Set(icons.map((i) => i.key));
  const kept = remoteRows.filter((r) => !mine.has(String(r.key)));
  const rows = [...kept, ...icons.map((i) => ({ key: i.key, icon: iconRef(i.file) }))]
    .sort((a, b) => String(a.key).localeCompare(String(b.key)));
  if (kept.length) {
    console.log(`\n   keeping ${kept.length} existing manifest row(s) this set does not define: `
      + `${kept.map((r) => r.key).join(', ')}`);
  }

  if (!opts.apply) {
    console.log(`\n   Manifest would hold ${rows.length} row(s). Nothing written. Re-run with --apply.`);
    return 0;
  }

  console.log('\n   writing…');
  for (const i of icons) {
    const path = `${ICONS_DIR}/${i.file}`;
    const body = new FormData();
    body.append('data', new Blob([i.bytes], { type: 'image/svg+xml' }), i.file);
    const put = await fetch(SOURCE(path), { method: 'POST', headers, body });
    if (!put.ok) {
      console.error(`   ✗ ${i.file} -> ${put.status} ${await put.text()}`);
      return 1;
    }
    // The palette reads the preview origin; a published page reads the live one.
    for (const action of opts.live ? ['preview', 'live'] : ['preview']) {
      const r = await fetch(AEM(action, path), { method: 'POST', headers });
      if (!r.ok) {
        console.error(`   ✗ ${action} ${i.file} -> ${r.status}`);
        return 1;
      }
    }
    console.log(`     ✓ ${i.file}`);
  }

  const sheetBody = new FormData();
  sheetBody.append('data', new Blob([buildSheet(rows)], { type: 'application/json' }), 'icons.json');
  const mp = await fetch(SOURCE(SHEET_PATH), { method: 'POST', headers, body: sheetBody });
  if (!mp.ok) {
    console.error(`   ✗ manifest -> ${mp.status} ${await mp.text()}`);
    return 1;
  }
  for (const action of opts.live ? ['preview', 'live'] : ['preview']) {
    const r = await fetch(AEM(action, SHEET_PATH), { method: 'POST', headers });
    if (!r.ok) {
      console.error(`   ✗ ${action} manifest -> ${r.status}`);
      return 1;
    }
  }
  console.log(`     ✓ ${SHEET_PATH} (${rows.length} rows)`);

  // Confirm on the read-back: a 200 on the write is not evidence it was stored.
  const afterList = await (await fetch(LIST(ICONS_DIR), { headers })).json();
  const afterFiles = new Set(afterList
    .filter((i) => String(i.ext).toLowerCase() === 'svg')
    .map((i) => `${i.name}.${i.ext}`));
  const afterRows = (await (await fetch(SOURCE(SHEET_PATH), { headers })).json())?.data || [];
  const lostFile = icons.filter((i) => !afterFiles.has(i.file)).map((i) => i.file);
  const afterKeys = new Set(afterRows.map((r) => String(r.key)));
  const lostKey = icons.filter((i) => !afterKeys.has(i.key)).map((i) => i.key);

  if (lostFile.length || lostKey.length) {
    console.error(`\n   ✗ write returned OK but the read-back is short — files: ${lostFile.join(', ') || 'none'} · keys: ${lostKey.join(', ') || 'none'}`);
    return 1;
  }
  console.log(`\n   ✓ ${afterFiles.size} file(s) and ${afterRows.length} manifest row(s) confirmed in DA`);
  console.log(`   Open https://da.live/#/${ORG}/${SITE}/${ICONS_DIR} to browse the folder.`);
  return 0;
}

main().then(exit).catch((e) => {
  console.error(`ERROR: ${e.message}`);
  exit(2);
});
