/* eslint-disable no-console */
/**
 * register-library-row.mjs — add, update or remove one row of a DA site-config
 * sheet, safely.
 *
 * The DA site config registers tools in three sheets, and they are not
 * interchangeable:
 *
 *   apps      full-screen, opened from da.live/apps
 *   prepare   preflight-style checks on a document
 *   library   palettes opened from inside the editor
 *
 * Generalised from tools/icon-picker/register-picker.mjs, which was written
 * first and is left alone deliberately — it works, and a shipped registration
 * script is not worth churning to save a copy. New registrars call this instead
 * of making a third one.
 *
 * The safety properties are the point, and they are all inherited from that
 * script:
 *
 *   - it never composes a config from scratch. It GETs the live document,
 *     changes exactly one row of one sheet, and PUTs that back.
 *   - the PUT form value is a plain STRING. A Blob answers 400 "Couldn't parse
 *     or save config."
 *   - it re-reads afterwards and diffs every sheet it did not mean to touch,
 *     because a config API has no preview step — the read-back is the only
 *     evidence the write was stored and nothing else moved.
 *   - it reports whether `path` actually serves before writing. DA loads the
 *     palette from the LIVE origin, so registering ahead of the deploy gives
 *     every author an entry that 404s.
 */
import {
  ORG, SITE, DA_ADMIN, liveOrigin,
} from '../../scripts/tracker/paths.js';
import { resolveToken, TOKEN_HINT } from '../tracker/lib/status-sheet.mjs';

const CONFIG_URL = `${DA_ADMIN}/config/${ORG}/${SITE}/`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function parseArgs(args, name) {
  const o = {
    apply: false, check: false, remove: false, help: false,
  };
  for (const a of args) {
    if (a === '--apply') o.apply = true;
    else if (a === '--check') o.check = true;
    else if (a === '--remove') o.remove = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else {
      console.error(`${name}: unknown arg: ${a}`);
      return null;
    }
  }
  return o;
}

/** Is the tool's HTML actually being served from the live origin? */
async function pathIsLive(path) {
  try {
    return (await fetch(`${liveOrigin()}${path}`)).status;
  } catch {
    return 0;
  }
}

/**
 * @param {object}  spec
 * @param {string}  spec.sheet  which config sheet — 'library', 'apps', 'prepare'
 * @param {object}  spec.row    the row, keyed by `title`
 * @param {object}  spec.opts   parsed flags
 * @returns {Promise<number>} exit code: 0 as asked · 1 write/verify failed
 *                            · 2 could not reach DA · 3 usage or no token
 */
export async function registerRow({ sheet, row, opts }) {
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

  const rows = cfg[sheet]?.data;
  if (!Array.isArray(rows)) {
    console.error(`ERROR: the config has no \`${sheet}\` sheet with a data array. Refusing `
      + `to invent one — open https://da.live/config#/${ORG}/${SITE}/ and look.`);
    return 3;
  }

  const at = rows.findIndex((a) => a.title === row.title);

  if (opts.check) {
    const status = await pathIsLive(row.path);
    if (at === -1) {
      console.log(`✗ "${row.title}" is NOT in the \`${sheet}\` sheet (${rows.length} row(s) registered)`);
      console.log(`  its path ${row.path} currently returns ${status || 'unreachable'}`);
      return 1;
    }
    const drift = Object.keys(row).filter((k) => (rows[at][k] ?? '') !== row[k]);
    console.log(`✓ "${row.title}" is registered at row ${at + 1} of ${rows.length}`);
    console.log(`  ${row.path} -> ${status}${status === 200 ? '' : '  ← it will fail to load'}`);
    if (drift.length) {
      console.log(`  fields differing from this file: ${drift.join(', ')}`);
      return 1;
    }
    return status === 200 ? 0 : 1;
  }

  console.log(`── register · ${opts.apply ? 'APPLY' : 'DRY RUN (default)'} ──`);
  console.log(`   config: ${CONFIG_URL}`);
  console.log(`   editor: https://da.live/config#/${ORG}/${SITE}/`);
  console.log(`\n   \`${sheet}\` sheet now (${rows.length} row(s)):`);
  rows.forEach((a, i) => console.log(`     ${i + 1}. ${a.title}  ${a.path}`));

  const status = await pathIsLive(row.path);
  console.log(`\n   ${liveOrigin()}${row.path} -> ${status || 'unreachable'}`);
  if (status !== 200) {
    console.log('   ⚠ that HTML is not being served yet. DA loads it from the live');
    console.log('     origin, so deploy the branch carrying it BEFORE applying, or');
    console.log('     authors get an entry that 404s.');
  }

  const next = { ...cfg, [sheet]: { ...cfg[sheet], data: [...rows] } };

  if (opts.remove) {
    if (at === -1) {
      console.log(`\n   "${row.title}" is not registered; nothing to remove.`);
      return 0;
    }
    next[sheet].data.splice(at, 1);
    console.log(`\n   REMOVE row ${at + 1}: ${row.title}`);
  } else if (at === -1) {
    next[sheet].data.push(row);
    console.log(`\n   ADD row ${next[sheet].data.length}:`);
    Object.entries(row).forEach(([k, v]) => console.log(`     ${k.padEnd(12)} ${v || '(blank)'}`));
  } else if (same(rows[at], { ...rows[at], ...row })) {
    console.log(`\n   "${row.title}" is already registered and every field matches. Nothing to do.`);
    return 0;
  } else {
    next[sheet].data[at] = { ...rows[at], ...row };
    console.log(`\n   UPDATE row ${at + 1}:`);
    Object.entries(row).forEach(([k, v]) => {
      const was = rows[at][k] ?? '';
      console.log(`     ${k.padEnd(12)} ${was === v ? '(unchanged)' : `${JSON.stringify(was)} -> ${JSON.stringify(v)}`}`);
    });
  }

  next[sheet].total = next[sheet].data.length;
  next[sheet].limit = next[sheet].data.length;

  if (!opts.apply) {
    console.log('\n   Nothing written. Re-run with --apply.');
    return 0;
  }

  // The form value is a plain STRING. A Blob answers 400 "Couldn't parse or
  // save config." — the contract register-app.mjs paid for.
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

  const after = await (await fetch(CONFIG_URL, { headers })).json();
  const got = (after[sheet]?.data || []).find((a) => a.title === row.title);
  const clobbered = (cfg[':names'] || [])
    .filter((n) => n !== sheet)
    .filter((n) => !same(cfg[n], after[n]));

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
  console.log(`\n   ✓ registered · ${row.path} -> ${status} · other sheets untouched`);
  return status === 200 ? 0 : 1;
}
