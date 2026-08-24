#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * register-app.mjs — add or update the Page Tracker's card in the DA site config.
 *
 * The card that appears at https://da.live/apps#/aemgdc/aemdev comes from the `apps`
 * sheet of the site config. Contract, read out of `adobe/da-nx`
 * (`nx/blocks/site-apps/site-apps.js`) rather than guessed:
 *
 *   GET  https://admin.da.live/config/<org>/<site>/
 *   -> { data: {...}, apps: { data: [ {title, description, image, path, ref} ] },
 *        prepare: {...}, ':names': [...], ':version': 3, ':type': 'multi-sheet' }
 *
 *   `image`  rendered straight into `<img src>`. Absent -> DA substitutes a mock.
 *   `path`   the card's "Go" link.
 *   `ref`    branch gate. Blank or `main` means always shown; any other value shows
 *            the card only when the apps page itself is opened with `?ref=` matching,
 *            or with `?ref=dev`. Blank is what we want.
 *
 * ─── Why this is scripted when tools/bio-manager/README.md says not to ──────
 *
 * That README's reasoning is sound and worth repeating: the same config API also
 * serves permissions, and writing it back from a GUESSED payload is not worth the
 * blast radius for a 30-second manual edit.
 *
 * This does not guess. It GETs the live config, appends or replaces exactly one row of
 * one sheet, and PUTs the whole document back — then re-reads and diffs. Two facts
 * make that safe, both recorded in that same README: permissions live in the ORG
 * config, not the site config; and the site config holds only `data`, `apps` and
 * `prepare`. So the blast radius is the three sheets it prints for you before writing.
 *
 * It exists at all because a card that has to be hand-rebuilt after a config reset
 * gets rebuilt wrong, and because `--check` gives a fast answer to "is the card
 * actually registered right now?" — which is the question you have when it is missing.
 *
 * CLI
 *   node tools/tracker/register-app.mjs              dry run: print the current config
 *                                                    and the exact row that would change
 *   node tools/tracker/register-app.mjs --apply      write it, then read back and verify
 *   node tools/tracker/register-app.mjs --check      report whether the card is registered
 *   node tools/tracker/register-app.mjs --remove     take the card out again
 *
 * EXIT  0 as asked · 1 write or verify failed · 2 could not reach DA · 3 usage/no token
 */
import { argv, exit } from 'node:process';
import { ORG, SITE, liveOrigin, DA_ADMIN } from '../../scripts/tracker/paths.js';
import { resolveToken, TOKEN_HINT } from './lib/status-sheet.mjs';

const CONFIG_URL = `${DA_ADMIN}/config/${ORG}/${SITE}/`;

/**
 * The row. `image` is an ABSOLUTE aem.live URL, not a relative path: the apps page is
 * served from da.live, so a site-relative `/img/...` would resolve against da.live and
 * 404. bio-manager's row uses the same absolute form for the same reason.
 *
 * It points at the PNG rather than the SVG deliberately — the card is an `<img>` in a
 * cropped container, and a raster at the exact card ratio cannot be re-laid-out by the
 * container the way a scalable SVG can.
 */
const ROW = {
  title: 'Page Tracker',
  description: 'Where every page is, in every language. Tracks the translation '
    + 'lifecycle from English publication to live in ten locales, with the auto-QA '
    + 'verdict for each.',
  image: `${liveOrigin()}/img/tools/page-tracker.png`,
  path: `https://da.live/app/${ORG}/${SITE}/tools/page-tracker`,
  ref: '',
};

const HELP = `register-app — add or update the Page Tracker card in the DA site config.

  (no flags)   dry run: show the live config and the row that would change
  --apply      write, then read back and verify
  --check      report whether the card is registered; exit 1 if it is not
  --remove     remove the card (with --apply)
  --help       this text

The card appears at https://da.live/apps#/${ORG}/${SITE}`;

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

  const apps = cfg.apps?.data;
  if (!Array.isArray(apps)) {
    console.error('ERROR: the config has no `apps` sheet with a data array. Refusing to '
      + `invent one — open https://da.live/config#/${ORG}/${SITE}/ and look.`);
    return 3;
  }

  const at = apps.findIndex((a) => a.title === ROW.title);

  if (opts.check) {
    if (at === -1) {
      console.log(`✗ "${ROW.title}" is NOT in the apps sheet (${apps.length} card(s) registered)`);
      return 1;
    }
    const drift = Object.keys(ROW).filter((k) => (apps[at][k] ?? '') !== ROW[k]);
    console.log(`✓ "${ROW.title}" is registered at row ${at + 1} of ${apps.length}`);
    if (drift.length) {
      console.log(`  but these fields differ from this file: ${drift.join(', ')}`);
      for (const k of drift) {
        console.log(`    ${k}\n      live: ${JSON.stringify(apps[at][k])}\n      here: ${JSON.stringify(ROW[k])}`);
      }
      return 1;
    }
    console.log('  every field matches');
    return 0;
  }

  console.log(`── register-app · ${opts.apply ? 'APPLY' : 'DRY RUN (default)'} ──`);
  console.log(`   config: ${CONFIG_URL}`);
  console.log(`   editor: https://da.live/config#/${ORG}/${SITE}/`);
  console.log(`   sheets in this config: ${(cfg[':names'] || []).join(', ')} `
    + `(:version ${cfg[':version']}, :type ${cfg[':type']})`);
  console.log('   NOTE: permissions are in the ORG config, not this one. This document');
  console.log('         holds only the sheets listed above.\n');

  console.log(`   apps sheet now (${apps.length} row(s)):`);
  for (const [i, a] of apps.entries()) {
    console.log(`     ${i + 1}. ${a.title}${a.image ? '' : '   (no image — DA substitutes a mock)'}`);
  }
  console.log();

  const next = { ...cfg, apps: { ...cfg.apps, data: [...apps] } };

  if (opts.remove) {
    if (at === -1) {
      console.log(`   "${ROW.title}" is not registered; nothing to remove.`);
      return 0;
    }
    next.apps.data.splice(at, 1);
    console.log(`   REMOVE row ${at + 1}: ${ROW.title}`);
  } else if (at === -1) {
    next.apps.data.push(ROW);
    console.log(`   ADD row ${next.apps.data.length}:`);
    for (const [k, v] of Object.entries(ROW)) console.log(`     ${k.padEnd(12)} ${v || '(blank)'}`);
  } else if (same(apps[at], { ...apps[at], ...ROW })) {
    console.log(`   "${ROW.title}" is already registered and every field matches. Nothing to do.`);
    return 0;
  } else {
    next.apps.data[at] = { ...apps[at], ...ROW };
    console.log(`   UPDATE row ${at + 1}:`);
    for (const [k, v] of Object.entries(ROW)) {
      const was = apps[at][k] ?? '';
      console.log(`     ${k.padEnd(12)} ${was === v ? '(unchanged)' : `${JSON.stringify(was)} -> ${JSON.stringify(v)}`}`);
    }
  }

  // Keep the row count in the envelope honest; DA reads `data` but the sheet UI shows
  // these, and a stale total is the kind of thing that later reads as data loss.
  next.apps.total = next.apps.data.length;
  next.apps.limit = next.apps.data.length;

  if (!opts.apply) {
    console.log('\n   Nothing written. Re-run with --apply.');
    return 0;
  }

  /*
   * PUT, and the form value is a plain STRING, not a Blob.
   *
   * Both were wrong on the first attempt and the config API answered
   * `400 {"error":"Couldn't parse or save config."}` — which says nothing about which
   * of the two it disliked. The shape is taken from DA's own client
   * (`config.save` in adobe/da-nx `nx2/utils/api.js`): `formData.append('config', body)`
   * with `{ method: 'PUT' }`, where `body` is already-serialized JSON.
   *
   * A source doc POST does take a Blob, which is what made the mistake easy: this is a
   * different API on a different verb, and only the field name is shared.
   *
   * The failure was at least clean — it wrote nothing, and the read-back below would
   * have caught it either way.
   */
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

  /*
   * Confirm on the READ-BACK, never on the 200. This is a config API, so there is no
   * preview step to catch a write that was accepted and then not stored — the read is
   * the only evidence.
   */
  const after = await (await fetch(CONFIG_URL, { headers })).json();
  const got = (after.apps?.data || []).find((a) => a.title === ROW.title);
  const otherSheets = (cfg[':names'] || []).filter((n) => n !== 'apps');
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
  console.log(`\n   ✓ written and read back · ${after.apps.data.length} card(s) · `
    + `${otherSheets.length} other sheet(s) untouched`);
  console.log(`   Open https://da.live/apps#/${ORG}/${SITE} to see the card.`);
  return 0;
}

main().then(exit).catch((e) => {
  console.error(`ERROR: ${e.message}`);
  exit(2);
});
