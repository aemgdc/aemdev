#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * scaffold-requirements.mjs — create a group's QA requirements brief from the template,
 * locally and mirrored to DA, and report exactly what is still unresolved in it.
 *
 * CLI SURFACE
 *   node tools/tracker/scaffold-requirements.mjs [--group=<name>|--all]
 *        [--dry-run|--apply] [--scope=<text>] [--local-only] [--no-local]
 *        [--force] [--check] [--help]
 *
 *   npm run group:requirements -- --group=meetups            plan
 *   npm run group:requirements -- --group=meetups --apply    create + mirror to DA
 *   npm run group:requirements -- --all --check              readiness of every brief
 *
 *   --group=<name>  a group registered in .tracker/orchestrator.json
 *   --all           every registered group
 *   --dry-run       print the plan, write nothing. THE DEFAULT.
 *   --apply         write the local brief if missing, and mirror it to DA.
 *   --scope=<text>  fill the SCOPE marker on a newly created brief.
 *   --local-only    create the local brief; do not touch DA.
 *   --no-local      mirror the existing local brief to DA; create nothing locally.
 *   --force         overwrite the DA copy even when it already has content.
 *   --check         report readiness only. Writes nothing, whatever else is passed.
 *
 * ─── BOTH DA LAYOUTS ARE PROBED; ONLY ONE IS EVER WRITTEN ───────────────────
 *
 * `loadRequirements()` reads exactly ONE DA path, `requirementsPath(group)` —
 * `/tracker/requirements/<group>/production-requirements`. That is deliberate and it is
 * the fix for the upstream loader, which supported two layouts because a scaffolder had
 * already created empty docs at the wrong one and every tool was reading those instead
 * of the real content.
 *
 * So this tool writes that path and no other. It still PROBES the legacy flat form,
 * `/tracker/requirements/<group>`, because a document sitting there is content somebody
 * wrote that nothing will ever read again — worth a warning every run, and worth NOT
 * silently deleting. It does not block the create: with one loader path there is no
 * ambiguity about which brief is in force.
 *
 * ─── AN EMPTY DRAFT IN DA SHADOWS A GOOD LOCAL BRIEF ───────────────────────
 *
 * This is the failure worth the loudest warning. If the judge is pointed at DA and DA
 * holds a stub — a heading and nothing under it — then `judgeBrief()` returns `null`
 * because the section is under MIN_WORDS, and the judge runs with NO CONTRACT while a
 * complete brief sits in the repo. Nothing errors. Every page passes.
 *
 * So a DA copy that exists but parses to fewer requirement rows than the local one is
 * reported as SHADOWING, every time, whether or not this run writes anything.
 *
 * ─── `?` IS THE POINT, NOT A PROBLEM ───────────────────────────────────────
 *
 * A brief containing any `?` row BLOCKS its group's batch by design. This tool therefore
 * prints every `?` row with its ID and question — not a count — because the only way to
 * unblock a group is for a human to answer them, and a count cannot be answered.
 *
 * EXIT CODES (docs/tracker/data-contract.md section 5)
 *   0  created / mirrored / checked, and every brief examined is `ready`
 *   1  at least one brief is `blocked` (has a `?`), `empty` or `missing`, or a DA copy
 *      is shadowing a better local one. This is a REPORT, not a crash — a blocked group
 *      is a correct state, and the non-zero code is what stops a pipeline stage that
 *      should not start.
 *   2  could not reach a verdict — no token, DA unreachable.
 *   3  usage or configuration error.
 */
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import {
  daSourceUrl, previewApiUrl, daEditUrl, requirementsPath, TRACKER_REQUIREMENTS,
} from '../../scripts/tracker/paths.js';
import { loadConfig, groupNames, REPO_ROOT } from './config.mjs';
import { resolveToken, TOKEN_HINT, aemAdminHeaders } from './lib/status-sheet.mjs';
import {
  JUDGE_SECTION,
  MIN_WORDS,
  GLYPHS,
  judgeBrief,
  requirementsReadiness,
  briefToHtml,
  htmlToBrief,
  isAuditMode,
  localBriefPath,
} from './lib/requirements.mjs';

/**
 * Where the local briefs live. Committed, unlike the pipeline's state.
 *
 * The per-group path comes from `localBriefPath()` in lib/requirements.mjs — the same
 * function `loadRequirements()` falls back to — so this tool cannot create a brief at a
 * path the loader does not read.
 */
const TEMPLATE = join(REPO_ROOT, '.tracker', 'qa-requirements', 'BRIEF-TEMPLATE.md');

/**
 * The two DA layouts, nested first.
 *
 * Nested is the one `requirementsPath()` builds and the ONLY one `loadRequirements()`
 * reads. The flat form is probed for reporting and never written.
 */
const daLayouts = (group) => [
  { label: 'nested (canonical)', path: requirementsPath(group), canonical: true },
  { label: 'flat (legacy)', path: `${TRACKER_REQUIREMENTS}/${group}`, canonical: false },
];

const HELP = `group:requirements — create and mirror a group's QA requirements brief.

  --group=<name>  a group registered in .tracker/orchestrator.json
  --all           every registered group
  --dry-run       print the plan, write nothing (DEFAULT)
  --apply         create the local brief if missing, and mirror it to DA
  --scope=<text>  fill the SCOPE marker on a newly created brief
  --local-only    create locally; do not touch DA
  --no-local      mirror the existing local brief only; create nothing
  --force         overwrite a DA copy that already has content
  --check         report readiness only; writes nothing
  --help          this text

A brief with any \`?\` row BLOCKS its group's batch, by design. Every \`?\` is printed.

exit 0 every brief ready · 1 blocked/empty/missing or DA shadowing · 2 no verdict · 3 usage`;

function parseArgs(args) {
  const o = {
    group: null,
    all: false,
    apply: false,
    scope: null,
    local: true,
    da: true,
    force: false,
    check: false,
    help: false,
  };
  for (const a of args) {
    if (a === '--apply') o.apply = true;
    else if (a === '--dry-run') o.apply = false;
    else if (a === '--all') o.all = true;
    else if (a === '--local-only') o.da = false;
    else if (a === '--no-local') o.local = false;
    else if (a === '--force') o.force = true;
    else if (a === '--check') o.check = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('--group=')) o.group = a.slice(8);
    else if (a.startsWith('--scope=')) o.scope = a.slice(8);
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!o.help && !o.check && !o.group && !o.all) throw new Error('--group=<name>, --all or --check is required');
  if (o.group && o.all) throw new Error('--group= and --all are mutually exclusive');
  if (!o.local && !o.da) throw new Error('--local-only and --no-local are mutually exclusive');
  // `--check` writes nothing whatever else was passed, so it is not a modifier on
  // --apply; saying so beats a run that half-honoured both.
  if (o.check) o.apply = false;
  return o;
}

/* ------------------------------------------------------------------- DA access */

/**
 * Read one DA document, tolerating absence.
 *
 * `.html`, because DA addresses a document with `.html` and a sheet with `.json` and the
 * path you GET is the path you POST. A brief is a document.
 */
async function readDaDoc(path, token) {
  try {
    const res = await fetch(daSourceUrl(path, 'html'), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 404) return { exists: false };
    if (!res.ok) return { exists: false, error: `GET ${res.status}` };
    return { exists: true, html: await res.text() };
  } catch (e) {
    return { exists: false, error: e.message };
  }
}

/**
 * Write one DA document and preview it.
 *
 * A DA `.html` source carries NO ETag at all, so `If-Match` is unusable here and
 * `If-Unmodified-Since` is ignored — which is why the create path re-reads immediately
 * before writing rather than relying on a server-side precondition. It is a narrower
 * guarantee than the sheets get, and it is the reason this tool refuses by default
 * instead of overwriting.
 */
async function writeDaDoc(path, token, html) {
  const form = new FormData();
  form.append('data', new Blob([html], { type: 'text/html' }), `${path.split('/').pop()}.html`);
  const post = await fetch(daSourceUrl(path, 'html'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!post.ok) throw new Error(`DA POST ${post.status}`);
  // Previewed, and the result REPORTED. A doc whose source write succeeds and whose
  // preview is refused exists in DA and is served to nobody, while the tool prints
  // success — the judge then reads a 404 and escalates every page in the group.
  const pv = await fetch(previewApiUrl(path), { method: 'POST', headers: aemAdminHeaders(token) });
  return {
    previewed: pv.ok,
    previewError: pv.ok ? null : (pv.headers.get('x-error') || `preview ${pv.status}`),
  };
}

/* ---------------------------------------------------------------- the local brief */

/** Fill the template's placeholders for a new group. */
function seedBrief(group, scope) {
  if (!existsSync(TEMPLATE)) throw new Error(`template missing: ${TEMPLATE}`);
  const raw = readFileSync(TEMPLATE, 'utf8');
  const filled = raw
    .replace(/<group>/g, group)
    .replace(/^(\**SCOPE:\**)\s*.*$/m, `$1 ${scope || `<which pages of ${group} this brief governs>`}`);
  /*
   * Reported rather than assumed. The template is co-owned — its heading and marker
   * spelling have already changed once — and a placeholder substitution that silently
   * matched nothing would leave a brief that says `<group>` where the group name goes,
   * which reads as finished and is not.
   */
  const substitutions = raw.split('<group>').length - 1;
  return { md: filled, substitutions, scopeFilled: /^\**SCOPE:/m.test(filled) };
}

/* ---------------------------------------------------------------------- reporting */

function printReadiness(md, label) {
  const r = requirementsReadiness(md);
  const brief = judgeBrief(md);
  console.log(`      ${label}: ${r.state.toUpperCase()} · ${r.counts.rows} row(s) — `
    + `✓${r.counts.must} ~${r.counts.may} ✗${r.counts.removed} ?${r.counts.unresolved}`
    + `${r.counts.unknown ? ` unknown:${r.counts.unknown}` : ''}`);
  console.log(`      REQUIREMENTS STATUS: ${r.marker || '(unset)'}`
    + ` · JUDGE_MODE ${isAuditMode(md) ? 'audit' : 'compare'}`
    + ` · judgeBrief() ${brief ? `returns ${brief.split('\n').length} line(s)` : 'returns NULL'}`);
  if (!brief) {
    console.log(`      ! the judge would run with NO CONTRACT — "${JUDGE_SECTION}" is absent or `
      + `under ${MIN_WORDS} words`);
  }
  for (const w of r.warnings) console.log(`      ! ${w}`);
  for (const u of r.unresolved) {
    console.log(`      ? ${u.ref}: ${u.requirement}`);
    if (u.note) console.log(`          ${u.note}`);
  }
  return r;
}

/* ----------------------------------------------------------------------- one group */

async function handleGroup(group, opts, token) {
  const file = localBriefPath(group);
  console.log(`\n── ${group} ──`);
  console.log(`   local: ${file}`);

  let md = existsSync(file) ? readFileSync(file, 'utf8') : null;
  let created = false;
  if (!md) {
    if (!opts.local) {
      console.log('   ✗ no local brief, and --no-local was passed — nothing to mirror');
      return { group, state: 'missing' };
    }
    const seed = seedBrief(group, opts.scope);
    md = seed.md;
    console.log(`   + would create from ${TEMPLATE}`);
    console.log(`     ${seed.substitutions} "<group>" placeholder(s) filled in`
      + `${seed.substitutions ? '' : ' — NONE, so check the template still carries them'}`);
    console.log('     every row seeded as "?" — a scaffolded brief BLOCKS its group until filled in');
    if (opts.apply) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, md);
      created = true;
      console.log('   ✓ created');
    }
  } else {
    console.log('   = exists, left as it is (this tool never edits a brief a human wrote)');
  }

  const local = printReadiness(md, 'local');

  if (!opts.da) return { group, state: local.state, created };

  if (!token) {
    console.log('   ! no DA token, so the mirror was not checked. The local brief above is all this run knows.');
    return { group, state: local.state, created, daUnknown: true };
  }

  /*
   * Both layouts, every run. A doc at the flat legacy path stops the create even though
   * the create would target the nested one — two briefs for one group in DA is worse
   * than no brief, because nothing tells a reader which one the judge used.
   */
  let stray = null;
  const found = [];
  for (const layout of daLayouts(group)) {
    const doc = await readDaDoc(layout.path, token);
    if (doc.error) {
      console.log(`   ! ${layout.label} ${layout.path}: ${doc.error}`);
    } else if (doc.exists) {
      // Parsed back to markdown through `htmlToBrief`, the exact inverse of the
      // `briefToHtml` used to write it, so the comparison below is between two
      // READINESS results rather than between a row count and a byte count.
      const readiness = requirementsReadiness(htmlToBrief(doc.html));
      console.log(`   DA ${layout.label}: EXISTS · ${doc.html.length} byte(s) · `
        + `${readiness.counts.rows} row(s) · ${readiness.state}`);
      console.log(`      ${daEditUrl(layout.path)}`);
      found.push({ layout, doc, readiness });
      if (!layout.canonical) {
        stray = layout.path;
        console.log('      ! nothing reads this path — loadRequirements() looks only at the nested '
          + 'form. It is orphaned content, not a competing brief. Move what matters into the '
          + 'canonical doc, then delete it by hand.');
      }
    } else {
      console.log(`   DA ${layout.label}: absent`);
    }
  }

  /*
   * THE SHADOW CHECK. An empty or stubbed DA copy makes judgeBrief() return null while a
   * complete brief sits in the repo — the judge then runs with no contract, nothing
   * errors, and every page passes. Reported whether or not this run writes anything.
   */
  let shadowing = false;
  const canonical = found.find((f) => f.layout.canonical);
  if (canonical && canonical.readiness.counts.rows < local.counts.rows) {
    shadowing = true;
    console.log(`   ✗ SHADOWING: the DA copy parses to ${canonical.readiness.counts.rows} row(s) `
      + `against ${local.counts.rows} locally, and loadRequirements() PREFERS DA. The judge would `
      + 'get a weaker contract than the repo holds — and a stub parses to nothing, which means no '
      + 'contract at all, no error, and every page passing. Re-mirror with --apply --force.');
  }

  const wantWrite = !canonical || opts.force;
  if (!wantWrite) {
    console.log('   = DA copy left as it is. Pass --force to overwrite it from the local brief.');
  } else if (!opts.apply) {
    console.log(`   + would ${canonical ? 'OVERWRITE' : 'create'} ${requirementsPath(group)} from the local brief`);
  } else {
    const res = await writeDaDoc(requirementsPath(group), token, briefToHtml(md));
    console.log(`   ✓ mirrored to ${requirementsPath(group)} · preview `
      + `${res.previewed ? 'ok' : `FAILED: ${res.previewError}`}`);
    if (!res.previewed) return { group, state: local.state, created, previewFailed: true };
    shadowing = false;
  }

  return {
    group, state: local.state, created, shadowing, stray,
  };
}

/* ---------------------------------------------------------------------- the run */

async function main() {
  const opts = parseArgs(argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  const cfg = loadConfig();
  const names = opts.group ? [opts.group] : groupNames(cfg);
  const registered = groupNames(cfg);
  for (const n of names) {
    // A typo must fail before any I/O: a brief scaffolded under a misspelled group name
    // is a file the judge will never look for.
    if (!registered.includes(n)) {
      throw new Error(`unknown group "${n}" — registered: ${registered.join(', ')}`);
    }
  }

  const writeMode = opts.apply ? 'APPLY' : 'DRY RUN (default)';
  const mode = opts.check ? 'CHECK (writes nothing)' : writeMode;
  console.log(`── group:requirements · ${mode} · ${names.length} group(s) ──`);
  console.log(`   template: ${TEMPLATE}`);
  console.log(`   glyphs:   ${GLYPHS.map((g) => `${g.glyph} ${g.label}`).join(' · ')}`);

  const token = opts.da ? resolveToken() : null;
  if (opts.da && !token) console.log(`   ! no DA token (${TOKEN_HINT}) — the DA mirror will not be checked`);

  const results = [];
  for (const group of names) {
    try {
      results.push(await handleGroup(group, opts, token));
    } catch (e) {
      console.error(`   ✗ ${group}: ${e.message}`);
      results.push({ group, state: 'error', error: e.message });
    }
  }

  const blocked = results.filter((r) => ['blocked', 'empty', 'missing', 'error'].includes(r.state));
  const shadowed = results.filter((r) => r.shadowing);
  console.log(`\n   ${results.filter((r) => r.state === 'ready').length} ready · ${blocked.length} `
    + `blocked/empty/missing · ${shadowed.length} shadowed by DA`);
  for (const r of blocked) console.log(`   ✗ ${r.group}: ${r.state}`);
  if (blocked.length) {
    console.log('\n   A blocked group is a CORRECT outcome, not a crash: the `?` rows above are');
    console.log('   questions nobody has answered, and a judge asked to check an unstated');
    console.log('   requirement invents one. Answer them in the brief, then re-run.');
  }
  if (!opts.apply && !opts.check) console.log('   Re-run with --apply to write.');

  if (results.some((r) => r.previewFailed)) return 1;
  return blocked.length || shadowed.length ? 1 : 0;
}

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main()
    .then((code) => exit(code))
    .catch((e) => {
      console.error(`✗ group:requirements: ${e.message}`);
      exit(/^unknown arg|required|mutually exclusive|unknown group|template missing/.test(e.message) ? 3 : 2);
    });
}
