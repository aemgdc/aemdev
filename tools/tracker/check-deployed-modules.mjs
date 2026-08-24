#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * check-deployed-modules.mjs — fetch every browser module from the REAL hosts.
 *
 * CLI SURFACE
 *   node tools/tracker/check-deployed-modules.mjs [--ref=<branch>|--ref=HEAD]
 *        [--host=<host>]... [--all-hosts] [--concurrency=<n>] [--json] [--help]
 *
 *   npm run verify:host                       # ref from config publish.branch (main)
 *   npm run verify:host -- --ref=HEAD         # the branch this worktree is on
 *   npm run verify:host -- --all-hosts        # add preview.da.live
 *   npm run verify:host -- --host=aem.live
 *
 * This is the check that is missing when an app goes down for every user while
 * everything local is green — because nothing local serves from a delivery host, and
 * the rule that should catch it resolves to "open the URL and look at it".
 *
 * ─── Why it probes MORE THAN ONE host ───────────────────────────────────────
 *
 * A page's modules come from the delivery host the visitor happens to land on, and
 * there is more than one. `aem.page` (preview) and `aem.live` (published) are the two
 * that serve the site, and they do not have the same content: a file that is previewed
 * but not published answers 200 on aem.page and 404 on aem.live. A check against one
 * host is worse than useless there, because it produces false confidence.
 *
 * DA adds a third. From da.live/nx/blocks/shell/shell.js the app host is chosen PER
 * SESSION — an authenticated user gets `<ref>--<site>--<org>.preview.da.live`, anyone
 * else falls back to `<ref>--<site>--<org>.aem.live` — so an engineer who opens a DA
 * app and sees it working has learned nothing about the session a colleague gets. It is
 * behind `--all-hosts` rather than in the default set because it only serves the DA
 * app surface, and a red line there for a page module is noise.
 *
 * ─── 404 AND 401 MEAN DIFFERENT THINGS, AND CONFLATING THEM COSTS HOURS ─────
 *
 *   404  THE FILE IS ABSENT from this host at this ref. Not pushed, not previewed,
 *        not published, or the path is wrong. Fix: push/preview/publish, or fix the path.
 *   401  THE HOST WILL NOT SERVE THIS EXTENSION. The file is there; the request fell
 *        through to the authenticated content path because the extension is not on the
 *        static allowlist. Fix: rename the file. No amount of publishing helps.
 *
 * Measured on THIS site today, and this is why the distinction is printed rather than
 * summarised as "not 200":
 *
 *     /scripts/sync-configs.mjs   aem.page 200   preview.da.live 401
 *     /scripts/scripts.js         aem.page 200   preview.da.live 200
 *     /scripts/scripts.mjs        aem.page 404   preview.da.live 401
 *
 * The middle row is the trap: a real, deployed, correct `.mjs` answers 401, so the
 * outage reads as an auth problem and you go looking in the wrong place — while a
 * `.mjs` that genuinely does not exist ALSO answers 401 on that host, so the same code
 * cannot even tell you whether the file is there. Only the `.js` sibling answers 404
 * honestly. A static import that fails takes the whole module graph with it, so one bad
 * extension means the app does not boot at all.
 *
 * The module list comes from `browserGraph()` in check-browser-modules.mjs, so the two
 * checks can never disagree about what "the browser loads" means. A hand-maintained
 * second list goes stale the first time someone adds an import.
 *
 * EXIT CODES  0 every module serves on every host ·
 *             1 a module will not load (404 or 401 — a real, diagnosed defect) ·
 *             2 a request failed outright (DNS, timeout, reset): no verdict was
 *               reached, so nothing may be concluded about the ref ·
 *             3 usage or configuration error
 */
import { execFileSync } from 'node:child_process';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { ORG, SITE, liveOrigin, previewOrigin } from '../../scripts/tracker/paths.js';
import { loadConfig } from './config.mjs';
import { browserGraph } from './check-browser-modules.mjs';

/**
 * The hosts that serve this site's pages. Order is the order they are reported in.
 *
 * `aem.page` first because it is where content lands first: a module missing there is
 * missing everywhere, and a module present there but missing on `aem.live` is simply
 * unpublished, which is a different sentence to say to an operator.
 */
const PAGE_HOSTS = ['aem.page', 'aem.live'];

/** The DA app host. Only reachable when the visitor is authenticated. See the header. */
const DA_APP_HOST = 'preview.da.live';

/*
 * The two page hosts get their origins from scripts/tracker/paths.js rather than a
 * second copy of the `<ref>--<site>--<org>.<host>` pattern, so a change to the host
 * scheme — or to the branch-name lowercasing, which AEM needs and which is easy to
 * forget — lands in one place. `preview.da.live` has no builder there because nothing
 * else in the tracker addresses it, so it falls through to the generic form.
 */
const ORIGIN_BUILDERS = { 'aem.page': previewOrigin, 'aem.live': liveOrigin };

const originFor = (host, ref) => (ORIGIN_BUILDERS[host]
  ? ORIGIN_BUILDERS[host](ref)
  : `https://${String(ref).toLowerCase()}--${SITE}--${ORG}.${host}`);

const HELP = `check-deployed-modules — every browser module, fetched from the real hosts.

  --ref=<branch>      ref to probe (default: config publish.branch)
  --ref=HEAD          use the branch this worktree is on
  --host=<host>       probe only this host; repeatable
  --all-hosts         add ${DA_APP_HOST} to the default set
  --concurrency=<n>   parallel requests per host (default 4; the hosts rate-limit)
  --json              machine-readable result on stdout
  --help              this text

exit 0 all serve · 1 a module will not load · 2 a request failed outright · 3 usage`;

function parseArgs(args) {
  const o = {
    ref: null, hosts: [], allHosts: false, concurrency: 4, json: false, help: false,
  };
  for (const a of args) {
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--all-hosts') o.allHosts = true;
    else if (a === '--json') o.json = true;
    else if (a.startsWith('--ref=')) o.ref = a.slice(6);
    else if (a.startsWith('--host=')) o.hosts.push(a.slice(7));
    else if (a.startsWith('--concurrency=')) o.concurrency = Math.max(1, Number(a.slice(14)));
    else throw new Error(`unknown arg: ${a}`);
  }
  return o;
}

const currentBranch = () => execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim();

/**
 * What a status code actually tells you. Returns null when the module is fine.
 *
 * Spelled out per code rather than as "not 200" because the FIX is different for each
 * one, and an operator reading a wall of red needs the fix, not the count.
 */
export function explain(status, host) {
  if (status === 200) return null;
  if (status === 401) {
    return `401 THE EXTENSION IS NOT SERVED — the file may well be there; ${host} does not `
      + 'serve this extension and fell through to the authenticated content path. Rename '
      + 'the file (.mjs → .js); publishing it again will not help.';
  }
  if (status === 404) {
    return '404 THE FILE IS ABSENT at this ref — not pushed, not previewed, or not published '
      + 'to this host. Check that the branch is pushed and the path is right.';
  }
  if (status === 403) return '403 refused — the host served a challenge or the ref is not authorised.';
  if (status === 0) return 'REQUEST FAILED OUTRIGHT (DNS, timeout, connection reset) — no verdict.';
  return `unexpected status ${status}`;
}

/** HEAD would be cheaper, but these hosts answer some HEADs from a different path. */
async function probeOne(url) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });
    return { status: res.status };
  } catch (e) {
    return { status: 0, error: e.message };
  }
}

/** Probe a list of paths against one origin, `concurrency` at a time. */
async function probeHost(origin, paths, concurrency) {
  const results = [];
  for (let i = 0; i < paths.length; i += concurrency) {
    const batch = paths.slice(i, i + concurrency);
    const answers = await Promise.all(batch.map((p) => probeOne(`${origin}${p}`)));
    batch.forEach((p, j) => results.push({ path: p, ...answers[j] }));
  }
  return results;
}

async function main() {
  const o = parseArgs(argv.slice(2));
  if (o.help) {
    console.log(HELP);
    return 0;
  }
  const cfg = loadConfig();
  /*
   * Default to the ref every other surface derives from, NOT to the current branch.
   *
   * The source defaulted to `git branch --show-current`, which on a feature branch that
   * has not been pushed makes every host answer 404 for every module — a full page of
   * red that reads as a total outage and is really just "this branch is local". The
   * config already declares the one ref every surface agrees on, so that is the
   * default, and `--ref=HEAD` asks for the old behaviour explicitly.
   */
  let ref = o.ref || cfg.publish.branch;
  if (ref === 'HEAD') {
    ref = currentBranch();
    if (!ref) throw new Error('could not determine the current branch — pass --ref=<branch>');
  }

  const hosts = o.hosts.length
    ? o.hosts
    : [...PAGE_HOSTS, ...(o.allHosts ? [DA_APP_HOST] : [])];

  const {
    modules, entries, badExt, unresolved,
  } = browserGraph();
  if (unresolved.length) {
    console.error('✗ the local import graph does not resolve; fix that first with `npm run lint:browser`.');
    for (const u of unresolved) console.error(`    ${u}`);
    return 3;
  }
  if (badExt.length) {
    // Not fatal here — the point of this tool is to show what the HOSTS do with it —
    // but it predicts exactly the 401s below, so say so before the table.
    console.log(`⚠ ${badExt.length} browser-reachable module(s) use .mjs; expect 401 on ${DA_APP_HOST}.`);
  }

  // Web paths, not filesystem paths.
  const paths = modules.map((m) => `/${m}`);
  console.log(`Checking ${paths.length} browser module(s) from ${entries.length} entry point(s)`);
  console.log(`  ref   ${ref}${o.ref === 'HEAD' ? ' (--ref=HEAD)' : ''}`);
  console.log(`  hosts ${hosts.join(', ')}\n`);

  const report = {
    tool: 'check-deployed-modules',
    generated: new Date().toISOString(),
    ref,
    org: ORG,
    site: SITE,
    hosts: {},
    modules: paths.length,
  };
  const failures = [];
  const unreached = [];

  for (const host of hosts) {
    const origin = originFor(host, ref);
    const results = await probeHost(origin, paths, o.concurrency);
    const counts = results.reduce((acc, r) => {
      acc[r.status] = (acc[r.status] || 0) + 1;
      return acc;
    }, {});
    const ok = counts[200] || 0;
    report.hosts[host] = {
      origin,
      ok,
      byStatus: counts,
      problems: results
        .filter((r) => r.status !== 200)
        .map((r) => ({ path: r.path, status: r.status })),
    };
    const breakdown = Object.entries(counts)
      .filter(([s]) => s !== '200')
      .map(([s, n]) => `${n}×${s}`)
      .join(' ');
    console.log(`  ${host.padEnd(16)} ${String(ok).padStart(3)}/${paths.length} serve 200${breakdown ? `   ${breakdown}` : ''}`);
    for (const r of results) {
      if (r.status === 0) unreached.push(`${host}  ${r.path}  — ${r.error}`);
      else if (r.status !== 200) failures.push({ host, ...r });
    }
  }

  if (o.json) console.log(`\n${JSON.stringify(report, null, 2)}`);

  if (unreached.length) {
    console.error(`\n✗ ${unreached.length} request(s) failed outright — NO VERDICT was reached for this ref:`);
    for (const u of unreached.slice(0, 20)) console.error(`    ${u}`);
    return 2;
  }
  if (failures.length) {
    // Grouped by status so the two diagnoses stay separate. The whole point.
    const byStatus = new Map();
    for (const f of failures) {
      const k = `${f.host} ${f.status}`;
      if (!byStatus.has(k)) byStatus.set(k, []);
      byStatus.get(k).push(f.path);
    }
    console.error(`\n✗ ${failures.length} module(s) will not load:`);
    for (const [k, list] of byStatus) {
      const [host, status] = k.split(' ');
      console.error(`\n  ${host} — ${explain(Number(status), host)}`);
      for (const p of list) console.error(`      ${p}`);
    }
    console.error('\n  A static import that fails takes the whole module graph with it, so this is a');
    console.error('  total app outage for whichever session lands on that host — not a degraded page.');
    return 1;
  }
  console.log(`\n✓ every browser module serves on ${hosts.join(' and ')} for ref "${ref}".`);
  return 0;
}

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main()
    .then((code) => exit(code))
    .catch((e) => {
      console.error(`ERROR: ${e.message}`);
      exit(3);
    });
}
