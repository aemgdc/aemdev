#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * register-picker.mjs — add or update the Icon Picker's row in the DA site config.
 *
 * The Icon Picker is opened from INSIDE the editor to drop an icon into a document,
 * so it belongs in the config's `library` sheet — the palette list that already
 * carries "AEM Tags" — and not in `apps` (full-screen tools, opened from
 * da.live/apps) or `prepare` (preflight-style checks).
 *
 *   GET  https://admin.da.live/config/<org>/<site>/
 *   -> { data, apps, prepare, library: { data: [ {title, path, format, icon,
 *        experience, ref} ] }, ':names', ':version', ':type' }
 *
 *   `path`        site-relative; DA resolves it against the site's aem.live origin,
 *                 which is why the code must be DEPLOYED before this is applied.
 *   `experience`  'dialog' opens the palette as a modal — the right shape for a
 *                 grid of icons. Blank renders it in the narrow side rail.
 *   `icon`        left blank; DA substitutes a default. Point it at an absolute
 *                 content.da.live URL if you add artwork later, the way the
 *                 AEM Tags row does.
 *   `ref`         branch gate. Blank means always shown.
 *
 * ORDER MATTERS. `path` is fetched from the live site, so applying this before the
 * branch carrying tools/icon-picker/ is deployed registers a palette entry that
 * 404s for every author. --check reports that state rather than guessing.
 *
 * Like register-app.mjs, this does not compose a config from scratch: it GETs the
 * live document, changes exactly one row of one sheet, PUTs it back, then re-reads
 * and diffs every other sheet to prove they round-tripped untouched.
 *
 * CLI
 *   node tools/icon-picker/register-picker.mjs            dry run
 *   node tools/icon-picker/register-picker.mjs --apply    write, then verify
 *   node tools/icon-picker/register-picker.mjs --check    is it registered, and live?
 *   node tools/icon-picker/register-picker.mjs --remove   take the row out (with --apply)
 *
 * EXIT  0 as asked · 1 write or verify failed · 2 could not reach DA · 3 usage/no token
 */
import { argv, exit } from 'node:process';
import {
  ORG, SITE, DA_ADMIN, liveOrigin,
} from '../../scripts/tracker/paths.js';
import { resolveToken, TOKEN_HINT } from '../tracker/lib/status-sheet.mjs';

const CONFIG_URL = `${DA_ADMIN}/config/${ORG}/${SITE}/`;
const SHEET = 'library';

const ROW = {
  title: 'Icon Picker',
  path: '/tools/icon-picker/icon-picker.html',
  format: '',
  icon: '',
  experience: 'dialog',
  ref: '',
};

const HELP = `register-picker — add or update the Icon Picker row in the DA \`${SHEET}\` sheet.

  (no flags)   dry run: show the live sheet and the row that would change
  --apply      write, then read back and verify
  --check      report whether the row is registered AND its path resolves
  --remove     remove the row (with --apply)
  --help       this text

The palette appears in the DA editor at https://da.live/edit#/${ORG}/${SITE}/…`;

function parseArgs(args) {
  const o = {
    apply: false, check: false, remove: false, help: false,
  };
  for (const a of args) {
    if (a === '--apply') o.apply = true;
    else if (a === '--check') o.check = true;
    else if (a === '--remove') o.remove = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else {
      console.error(`unknown arg: ${a}`);
      exit(3);
    }
  }
  return o;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Is the palette's HTML actually being served? A registered row whose path 404s
 *  is the one failure an author sees and cannot diagnose. */
async function pathIsLive() {
  try {
    const r = await fetch(`${liveOrigin()}${ROW.path}`, { method: 'GET' });
    return r.status;
  } catch {
    return 0;
  }
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

  let cfg;
  try {
    const r = await fetch(CONFIG_URL, { headers });
    if (!r.ok) {
      console.error(`ERROR: GET config -> ${r.status}`);
      return r.status === 401 || r.status === 403 ? 3 : 2;
    }
    cfg = await r.json();
  } catch (e) {
    console.error(`ERROR: could not reach DA — ${e.message}`);
    return 2;
  }

  const rows = cfg[SHEET]?.data;
  if (!Array.isArray(rows)) {
    console.error(`ERROR: the config has no \`${SHEET}\` sheet with a data array. Refusing `
      + `to invent one — open https://da.live/config#/${ORG}/${SITE}/ and look.`);
    return 3;
  }

  const at = rows.findIndex((a) => a.title === ROW.title);

  if (opts.check) {
    const status = await pathIsLive();
    if (at === -1) {
      console.log(`✗ "${ROW.title}" is NOT in the \`${SHEET}\` sheet (${rows.length} palette(s) registered)`);
      console.log(`  its path ${ROW.path} currently returns ${status || 'unreachable'}`);
      return 1;
    }
    const drift = Object.keys(ROW).filter((k) => (rows[at][k] ?? '') !== ROW[k]);
    console.log(`✓ "${ROW.title}" is registered at row ${at + 1} of ${rows.length}`);
    console.log(`  ${ROW.path} -> ${status}${status === 200 ? '' : '  ← the palette will fail to load'}`);
    if (drift.length) {
      console.log(`  fields differing from this file: ${drift.join(', ')}`);
      return 1;
    }
    return status === 200 ? 0 : 1;
  }

  console.log(`── register-picker · ${opts.apply ? 'APPLY' : 'DRY RUN (default)'} ──`);
  console.log(`   config: ${CONFIG_URL}`);
  console.log(`   editor: https://da.live/config#/${ORG}/${SITE}/`);
  console.log(`   sheets in this config: ${(cfg[':names'] || []).join(', ')} `
    + `(:version ${cfg[':version']}, :type ${cfg[':type']})`);
  console.log(`\n   \`${SHEET}\` sheet now (${rows.length} row(s)):`);
  for (const [i, a] of rows.entries()) console.log(`     ${i + 1}. ${a.title}  ${a.path}`);

  const status = await pathIsLive();
  console.log(`\n   ${liveOrigin()}${ROW.path} -> ${status || 'unreachable'}`);
  if (status !== 200) {
    console.log('   ⚠ the palette HTML is not being served yet. DA loads it from the');
    console.log('     live origin, so deploy the branch carrying tools/icon-picker/');
    console.log('     BEFORE applying, or authors get a palette entry that 404s.');
  }

  const next = { ...cfg, [SHEET]: { ...cfg[SHEET], data: [...rows] } };

  if (opts.remove) {
    if (at === -1) {
      console.log(`\n   "${ROW.title}" is not registered; nothing to remove.`);
      return 0;
    }
    next[SHEET].data.splice(at, 1);
    console.log(`\n   REMOVE row ${at + 1}: ${ROW.title}`);
  } else if (at === -1) {
    next[SHEET].data.push(ROW);
    console.log(`\n   ADD row ${next[SHEET].data.length}:`);
    for (const [k, v] of Object.entries(ROW)) console.log(`     ${k.padEnd(12)} ${v || '(blank)'}`);
  } else if (same(rows[at], { ...rows[at], ...ROW })) {
    console.log(`\n   "${ROW.title}" is already registered and every field matches. Nothing to do.`);
    return 0;
  } else {
    next[SHEET].data[at] = { ...rows[at], ...ROW };
    console.log(`\n   UPDATE row ${at + 1}:`);
    for (const [k, v] of Object.entries(ROW)) {
      const was = rows[at][k] ?? '';
      console.log(`     ${k.padEnd(12)} ${was === v ? '(unchanged)' : `${JSON.stringify(was)} -> ${JSON.stringify(v)}`}`);
    }
  }

  next[SHEET].total = next[SHEET].data.length;
  next[SHEET].limit = next[SHEET].data.length;

  if (!opts.apply) {
    console.log('\n   Nothing written. Re-run with --apply.');
    return 0;
  }

  // PUT, and the form value is a plain STRING, not a Blob — the contract
  // register-app.mjs paid for. A Blob answers 400 "Couldn't parse or save config."
  const body = new FormData();
  body.append('config', JSON.stringify(next));
  let put;
  try {
    put = await fetch(CONFIG_URL, { method: 'PUT', headers, body });
  } catch (e) {
    console.error(`\n   ✗ write failed to reach DA — ${e.message}`);
    return 2;
  }
  if (!put.ok) {
    console.error(`\n   ✗ write -> ${put.status} ${await put.text()}`);
    return 1;
  }

  // Confirm on the read-back; a config API has no preview step to catch a write
  // that was accepted and then not stored.
  const after = await (await fetch(CONFIG_URL, { headers })).json();
  const got = (after[SHEET]?.data || []).find((a) => a.title === ROW.title);
  const otherSheets = (cfg[':names'] || []).filter((n) => n !== SHEET);
  const clobbered = otherSheets.filter((n) => !same(cfg[n], after[n]));

  if (clobbered.length) {
    console.error(`\n   ✗ WROTE, BUT ALSO CHANGED: ${clobbered.join(', ')}. Restore from the`);
    console.error('     editor immediately — those sheets should have round-tripped untouched.');
    return 1;
  }
  if (opts.remove) {
    console.log(got ? '\n   ✗ removal did not stick' : '\n   ✓ removed · other sheets untouched');
    return got ? 1 : 0;
  }
  if (!got) {
    console.error('\n   ✗ write returned OK but the row is not in the config on read-back');
    return 1;
  }
  console.log(`\n   ✓ written and read back · ${after[SHEET].data.length} palette(s) · `
    + `${otherSheets.length} other sheet(s) untouched`);
  return 0;
}

main().then(exit).catch((e) => {
  console.error(`ERROR: ${e.message}`);
  exit(2);
});
