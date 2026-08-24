#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * move-row.mjs — move a page's row from one group sheet to another, whole.
 *
 * A group is assigned from the path prefix (lib/group-map.mjs) and nothing else, so a
 * page whose path does not describe what it actually IS lands in the wrong sheet. A
 * hand-authored landing page that lives under a section prefix is the shape of the
 * case: it needs the section index's judge brief and visual baseline, not the brief
 * for the pages beneath it.
 *
 * Why a tool and not a hand edit: the row carries recorded state — `subgroup`,
 * `notes`, `en-status`, `content-escalation` — and its locale rows carry `sent-at`,
 * which is observable nowhere else in the system. Every column moves verbatim or the
 * move is a data loss dressed as a tidy-up.
 *
 * CLI SURFACE
 *   node tools/tracker/move-row.mjs --from=<group> --to=<group> --path=<page-path> …
 *        [--dry-run|--apply] [--force] [--help]
 *
 *   npm run move-row -- --from=meetups --to=indexes --path=/en/meetups
 *   npm run move-row -- --from=meetups --to=indexes --path=/en/meetups --apply
 *
 * ─── THE GUARD THAT MATTERS ─────────────────────────────────────────────────
 *
 * `sync-groups-from-index.mjs` buckets every index row by what `groupForPath()` says
 * and then ADDS any page missing from that group's sheet. So moving a row the
 * resolver routes back produces, on the very next sync: a fresh blank row re-created
 * in the source group, the moved copy sitting in the destination, and the page
 * counted TWICE in every total for good. `refuseIfSyncWouldFight()` refuses that move
 * instead of documenting it — fix `lib/group-map.mjs` first so the resolver agrees,
 * then move the row. `--force` exists for the case where you have just changed the map
 * in the same commit and the running code has not caught up.
 *
 * ─── ORDER ──────────────────────────────────────────────────────────────────
 *
 * The destination is written FIRST, then the source. A crash between the two leaves a
 * visible duplicate, which the next sync's plan shows and a re-run fixes; the other
 * order can lose the row entirely. Both writes are ETag-conditional, so a concurrent
 * pipeline write is a clean 412 rather than a silent clobber.
 *
 * EXIT CODES  0 moved or planned · 1 the move was refused (a real defect in the
 * request) · 2 could not reach DA · 3 usage/config error
 */
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { TARGET_LOCALES, normalizePath } from '../../scripts/tracker/locales.js';
import { loadConfig, groupConfig } from './config.mjs';
import { resolveToken, TOKEN_HINT } from './lib/status-sheet.mjs';
import { groupForPath } from './lib/group-map.mjs';
import {
  DATA_COLUMNS,
  dataRowsOf,
  localeRowsOf,
  readGroupDoc,
  withDataRows,
  withLocaleRows,
  updateGroupDoc,
  groupSheetLink,
} from './lib/group-sheet.mjs';

const HELP = `move-row — move a page's row (and its locale rows) between group sheets.

  --from=<group>   source group, required
  --to=<group>     destination group, required
  --path=<path>    page path, repeatable, at least one required
  --force          move even though group:sync would route the row back
  --dry-run        print the plan, write nothing (DEFAULT)
  --apply          write
  --help           this text

exit 0 ok · 1 refused · 2 could not reach DA · 3 usage/config error`;

export function parseArgs(args) {
  const o = {
    from: null, to: null, paths: [], apply: false, force: false, help: false,
  };
  for (const a of args) {
    if (a === '--apply') o.apply = true;
    else if (a === '--dry-run') o.apply = false;
    else if (a === '--force') o.force = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('--from=')) o.from = a.slice(7);
    else if (a.startsWith('--to=')) o.to = a.slice(5);
    else if (a.startsWith('--path=')) o.paths.push(normalizePath(a.slice(7)));
    else throw new Error(`unknown arg: ${a}`);
  }
  if (o.help) return o;
  if (!o.from || !o.to) throw new Error('--from=<group> and --to=<group> are both required');
  if (o.from === o.to) throw new Error('--from and --to name the same group');
  if (!o.paths.length) throw new Error('at least one --path= is required');
  return o;
}

const val = (row, key) => String(row?.[key] ?? '').trim();

/**
 * Would the next `group:sync` undo this move?
 *
 * @returns {string|null} the reason to refuse, or null when the move is durable.
 */
export function refuseIfSyncWouldFight(path, to) {
  const routed = groupForPath(path);
  if (routed === to) return null;
  if (routed === null) {
    // Not in any group's prefix set, so the sync never visits it: the move is durable
    // whatever the destination. This is the manual-row case (`/` is the live example).
    return null;
  }
  return `groupForPath("${path}") routes it to "${routed}", not "${to}". The next \`group:sync\` `
    + `would re-add a blank row for it in "${routed}" and leave your copy in "${to}" — the page `
    + 'would be counted twice, permanently. Change the prefix rules in '
    + 'tools/tracker/lib/group-map.mjs first, or pass --force if you have just done exactly that.';
}

/**
 * Plan one page's move against both docs. Pure — no I/O.
 *
 * @returns {{ path, row, localeRows, refused: string|null }}
 */
export function planOne({
  path, fromDoc, toDoc, to, force,
}) {
  const row = dataRowsOf(fromDoc).find((r) => normalizePath(val(r, 'page-path')) === path);
  if (!row) return { path, row: null, localeRows: {}, refused: 'not in the --from sheet' };
  if (dataRowsOf(toDoc).some((r) => normalizePath(val(r, 'page-path')) === path)) {
    return {
      path,
      row,
      localeRows: {},
      refused: 'already present in the --to sheet — moving it would duplicate the page',
    };
  }
  /*
   * The locale rows move WITH the master row. The source tool refused a row that had
   * any, because there the locale tabs were vestigial; here they are load-bearing and
   * carry `sent-at` — testimony that exists nowhere else — so leaving them behind
   * would orphan it against a master row that is no longer there.
   */
  const localeRows = {};
  for (const code of TARGET_LOCALES) {
    const hits = localeRowsOf(fromDoc, code).filter((r) => normalizePath(val(r, 'page-path')) === path);
    if (hits.length) localeRows[code] = hits;
  }
  const fight = force ? null : refuseIfSyncWouldFight(path, to);
  return { path, row, localeRows, refused: fight };
}

/** The row as written into the destination: schema order, values verbatim. */
export function rebuildForDestination(row) {
  const out = {};
  for (const c of DATA_COLUMNS) out[c] = row[c] ?? '';
  // Never drop an unrecognised column — it is somebody's data until proven otherwise,
  // and the schema is additive-only precisely because a removal cannot be reverted.
  for (const [k, v] of Object.entries(row)) if (!(k in out)) out[k] = v;
  return out;
}

async function main() {
  const opts = parseArgs(argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  const cfg = loadConfig();
  const fromCfg = groupConfig(cfg, opts.from);
  const toCfg = groupConfig(cfg, opts.to);
  const token = resolveToken();
  if (!token) {
    console.error(`ERROR: no DA token (${TOKEN_HINT}) — run \`npm run da-token\` first`);
    return 2;
  }

  const src = await readGroupDoc(fromCfg, token);
  const dst = await readGroupDoc(toCfg, token);
  console.log(`── ${opts.apply ? 'move' : 'plan'} row · ${opts.from} → ${opts.to} `
    + `· ${opts.apply ? 'APPLY' : 'DRY RUN (default)'} ──`);
  if (!src.exists || !dst.exists) {
    console.error(`ERROR: ${!src.exists ? fromCfg.path : toCfg.path} does not exist — scaffold it first`);
    return 3;
  }

  const plans = opts.paths.map((path) => planOne({
    path, fromDoc: src.doc, toDoc: dst.doc, to: opts.to, force: opts.force,
  }));

  for (const p of plans) {
    console.log(`\n   ${p.path}`);
    if (p.refused) {
      console.log(`     ✗ REFUSED — ${p.refused}`);
    } else {
      console.log('     ✓ movable, carrying every non-blank column verbatim:');
      for (const [k, v] of Object.entries(rebuildForDestination(p.row))) {
        if (String(v ?? '').trim()) console.log(`         ${k.padEnd(20)} ${JSON.stringify(v)}`);
      }
      const locales = Object.entries(p.localeRows).map(([c, rs]) => `${c}=${rs.length}`).join(' ');
      console.log(`     locale rows moving with it: ${locales || '(none)'}`);
      console.log(`     groupForPath("${p.path}") → ${groupForPath(p.path)}`
        + `${opts.force ? '  [--force: the guard was skipped]' : ''}`);
    }
  }

  /*
   * Refuse the WHOLE run on any refusal. A partial move is the worst outcome: it
   * leaves the operator believing the batch succeeded.
   */
  const refused = plans.filter((p) => p.refused);
  if (refused.length) {
    console.error(`\n✗ ${refused.length} of ${plans.length} row(s) cannot be moved — nothing was written`);
    return 1;
  }

  const moving = new Set(plans.map((p) => p.path));
  console.log(`\n   ${opts.from}: ${dataRowsOf(src.doc).length} → ${dataRowsOf(src.doc).length - plans.length} data row(s)`);
  console.log(`   ${opts.to}:   ${dataRowsOf(dst.doc).length} → ${dataRowsOf(dst.doc).length + plans.length} data row(s)`);
  console.log(`   ${opts.from}: ${groupSheetLink(fromCfg)}`);
  console.log(`   ${opts.to}:   ${groupSheetLink(toCfg)}`);

  if (!opts.apply) {
    console.log('\n   Re-run with --apply to write.');
    return 0;
  }

  // DESTINATION FIRST. See the header: a crash after this leaves a visible duplicate,
  // which is recoverable; the other order can leave the row in neither sheet.
  const added = await updateGroupDoc(toCfg, token, (doc, { exists }) => {
    if (!exists) throw new Error(`${toCfg.path} vanished between the read and the write`);
    const incomingData = plans.map((p) => rebuildForDestination(p.row));
    let next = withDataRows(doc, [...dataRowsOf(doc), ...incomingData]);
    for (const code of TARGET_LOCALES) {
      const incoming = plans.flatMap((p) => p.localeRows[code] || []);
      if (incoming.length) {
        next = withLocaleRows(next, code, [...localeRowsOf(doc, code), ...incoming]);
      }
    }
    return next;
  }, {
    confirm: (after) => {
      const got = new Set(dataRowsOf(after).map((r) => normalizePath(val(r, 'page-path'))));
      const missing = [...moving].filter((p) => !got.has(p));
      return missing.length ? `${missing.join(', ')} did not land in ${opts.to}` : null;
    },
  });
  console.log(`\n   ✓ added to ${opts.to}${added.retried ? ' after one 412 retry' : ''} · preview `
    + `${added.preview?.previewed ? 'ok' : `FAILED: ${added.preview?.previewError}`}`);

  const removed = await updateGroupDoc(fromCfg, token, (doc, { exists }) => {
    if (!exists) throw new Error(`${fromCfg.path} vanished between the read and the write`);
    const keep = (r) => !moving.has(normalizePath(val(r, 'page-path')));
    let next = withDataRows(doc, dataRowsOf(doc).filter(keep));
    for (const code of TARGET_LOCALES) {
      next = withLocaleRows(next, code, localeRowsOf(doc, code).filter(keep));
    }
    return next;
  }, {
    confirm: (after) => {
      const left = dataRowsOf(after).map((r) => normalizePath(val(r, 'page-path'))).filter((p) => moving.has(p));
      return left.length ? `${left.join(', ')} is still in ${opts.from} — it is now in BOTH sheets` : null;
    },
  });
  console.log(`   ✓ removed from ${opts.from}${removed.retried ? ' after one 412 retry' : ''} · preview `
    + `${removed.preview?.previewed ? 'ok' : `FAILED: ${removed.preview?.previewError}`}`);
  console.log('   Next: npm run group:sync   (confirm the resolver agrees with where the row now lives)');
  return 0;
}

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main()
    .then((code) => exit(code))
    .catch((e) => {
      console.error(`✗ move-row: ${e.message}`);
      exit(/^unknown arg|required|same group|unknown group/.test(e.message) ? 3 : 2);
    });
}
