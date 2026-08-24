#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * localize-fragments.mjs — move the site's shared fragments into the locale tree.
 *
 * ─── Why this exists ────────────────────────────────────────────────────────
 *
 * The site's shared fragments live at `/fragments/**` — OUTSIDE any locale tree.
 * `blocks/header/header.js` and `blocks/footer/footer.js` both fetch
 * `` `${locale.prefix}${PATH}` ``, and until the locale registry gained an `/en` entry
 * that prefix was always `''`, so `/fragments/nav/header` was the path that got fetched
 * and everything worked by accident.
 *
 * Two consequences, and the second is the real reason this tool exists:
 *
 *   1. Now that `/en` IS a locale, those blocks ask for `/en/fragments/nav/header`,
 *      which does not exist. The chrome 404s.
 *   2. More importantly: a translation project copies `/en/**` into `/<code>/**`.
 *      Anything outside `/en` can never be picked up by one. So a site whose nav and
 *      footer live at `/fragments/` would render ENGLISH chrome on every translated
 *      page, for ever, no matter how many locales were added — and nothing would report
 *      it as a defect, because from the pipeline's point of view nothing was missing.
 *
 * So this is not tidying. Moving the fragments under `/en` is what makes them
 * translatable at all.
 *
 * ─── COPY, then delete later. Deliberately not atomic. ──────────────────────
 *
 * This tool COPIES and does not delete, even with --apply, because the currently
 * deployed `main` still resolves `locale.prefix` to `''` and therefore still fetches
 * `/fragments/nav/header`. Deleting the originals before the locale change is merged
 * and deployed would take the nav and footer off the production site.
 *
 * Run `--cleanup` as a SEPARATE, LATER step, once the branch carrying the locale
 * registry is merged and live. It refuses to run unless the destination is serving.
 *
 * CLI SURFACE
 *   node tools/tracker/localize-fragments.mjs                 dry run — print the plan
 *   node tools/tracker/localize-fragments.mjs --apply         copy into /en/fragments/
 *   node tools/tracker/localize-fragments.mjs --apply --preview
 *                                                             …and preview + publish them
 *   node tools/tracker/localize-fragments.mjs --cleanup       delete the old paths (LATER)
 *   node tools/tracker/localize-fragments.mjs --verify        report both trees' HTTP status
 *   node tools/tracker/localize-fragments.mjs --help
 *
 * EXIT CODES (docs/tracker/data-contract.md section 5)
 *   0  did what was asked
 *   1  a copy or a publish failed
 *   2  could not reach a verdict — DA or admin.hlx.page unreachable
 *   3  usage error, or no token
 */
import { argv, exit } from 'node:process';
import {
  ORG, SITE, DEFAULT_BRANCH, DA_ADMIN, liveUrl, previewUrl,
  previewApiUrl, publishApiUrl,
} from '../../scripts/tracker/paths.js';
import { resolveToken, aemAdminHeaders, TOKEN_HINT } from './lib/status-sheet.mjs';

const SOURCE_ROOT = '/fragments';
const DEST_ROOT = '/en/fragments';

/*
 * `/en/fragments/bios/**` is excluded on purpose: it is already in the locale tree,
 * it is owned by the Bio Manager, and it is a tracked page group. Nothing to move.
 */
const SKIP = [/^\/en\/fragments\/bios\//];

function parseArgs(args) {
  const o = {
    apply: false, preview: false, cleanup: false, verify: false, help: false,
  };
  for (const a of args) {
    if (a === '--apply') o.apply = true;
    else if (a === '--preview') o.preview = true;
    else if (a === '--cleanup') o.cleanup = true;
    else if (a === '--verify') o.verify = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else {
      console.error(`unknown arg: ${a}`);
      exit(3);
    }
  }
  return o;
}

/** Recursively list every document under a DA path. Directories have no `ext`. */
async function listDocs(headers, path, out = []) {
  const r = await fetch(`${DA_ADMIN}/list/${ORG}/${SITE}${path}`, { headers });
  if (r.status === 404) return out;
  if (!r.ok) throw new Error(`list ${path} -> ${r.status}`);
  const items = await r.json();
  for (const e of items) {
    // `e.path` carries the /org/site prefix; strip it to get a site path.
    const sitePath = e.path.replace(`/${ORG}/${SITE}`, '');
    if (!e.ext) {
      await listDocs(headers, sitePath, out);
    } else if (e.ext === 'html') {
      // A DA doc listed as `/x/y.html` is addressed as `/x/y`.
      out.push(sitePath.replace(/\.html$/, ''));
    }
  }
  return out;
}

const destFor = (p) => `${DEST_ROOT}${p.slice(SOURCE_ROOT.length)}`;

async function getDoc(headers, path) {
  const r = await fetch(`${DA_ADMIN}/source/${ORG}/${SITE}${path}.html`, { headers });
  if (!r.ok) return { ok: false, status: r.status };
  return { ok: true, body: await r.text() };
}

async function putDoc(headers, path, body) {
  const form = new FormData();
  form.append('data', new Blob([body], { type: 'text/html' }));
  const r = await fetch(`${DA_ADMIN}/source/${ORG}/${SITE}${path}.html`, {
    method: 'POST', headers, body: form,
  });
  return { ok: r.ok, status: r.status };
}

async function deleteDoc(headers, path) {
  const r = await fetch(`${DA_ADMIN}/source/${ORG}/${SITE}${path}.html`, {
    method: 'DELETE', headers,
  });
  return { ok: r.ok || r.status === 404, status: r.status };
}

/**
 * Preview then publish one path.
 *
 * `admin.hlx.page` does not merely record a preview — it fetches the document from DA to
 * build it. So it needs BOTH auth headers, which is what `aemAdminHeaders` supplies.
 */
async function previewAndPublish(token, path) {
  const h = aemAdminHeaders(token);
  const p = await fetch(previewApiUrl(path, DEFAULT_BRANCH), { method: 'POST', headers: h });
  if (!p.ok) return { ok: false, stage: 'preview', status: p.status };
  const l = await fetch(publishApiUrl(path, DEFAULT_BRANCH), { method: 'POST', headers: h });
  if (!l.ok) return { ok: false, stage: 'publish', status: l.status };
  return { ok: true };
}

const code = async (url) => {
  try {
    return (await fetch(url, { method: 'GET' })).status;
  } catch {
    return 0;
  }
};

async function main() {
  const opts = parseArgs(argv.slice(2));
  if (opts.help) {
    console.log(await import('node:fs').then((fs) => fs.readFileSync(new URL(import.meta.url), 'utf8')
      .split('\n').filter((l) => l.startsWith(' *') || l.startsWith('/**'))
      .join('\n')));
    exit(0);
  }

  const token = resolveToken();
  if (!token) {
    console.error(`ERROR: no DA token (${TOKEN_HINT})`);
    exit(3);
  }
  const headers = { Authorization: `Bearer ${token}` };

  let sources;
  try {
    sources = (await listDocs(headers, SOURCE_ROOT))
      .filter((p) => !SKIP.some((re) => re.test(p)))
      .sort();
  } catch (e) {
    console.error(`ERROR: could not list ${SOURCE_ROOT} — ${e.message}`);
    exit(2);
  }

  if (opts.verify) {
    console.log('path'.padEnd(42), 'old live/page   new live/page');
    for (const s of sources) {
      const d = destFor(s);
      /* eslint-disable no-await-in-loop */
      const [ol, op, nl, np] = [
        await code(liveUrl(s)), await code(previewUrl(s)),
        await code(liveUrl(d)), await code(previewUrl(d)),
      ];
      console.log(s.padEnd(42), `${ol}/${op}`.padEnd(15), `${nl}/${np}`);
    }
    exit(0);
  }

  if (opts.cleanup) {
    /*
     * Refuse unless the destination is actually serving. Deleting the source while the
     * destination 404s would leave the site with no nav and no footer, and the symptom
     * (missing chrome everywhere) is a long way from the cause.
     */
    const notServing = [];
    for (const s of sources) {
      // eslint-disable-next-line no-await-in-loop
      if (await code(liveUrl(destFor(s))) !== 200) notServing.push(destFor(s));
    }
    if (notServing.length) {
      console.error('REFUSING to clean up — these destinations are not serving on live:');
      for (const p of notServing) console.error(`   ${p}`);
      console.error('\nCopy and publish them first, and make sure the branch carrying the');
      console.error('locale registry is merged and deployed, or production loses its chrome.');
      exit(3);
    }
    console.log(`Deleting ${sources.length} source document(s):`);
    let failed = 0;
    for (const s of sources) {
      // eslint-disable-next-line no-await-in-loop
      const r = await deleteDoc(headers, s);
      console.log(`   ${r.ok ? 'deleted' : `FAILED ${r.status}`}  ${s}`);
      if (!r.ok) failed += 1;
    }
    exit(failed ? 1 : 0);
  }

  console.log(`${opts.apply ? 'COPYING' : 'PLAN (dry run — nothing is written)'}`);
  console.log(`${SOURCE_ROOT}  ->  ${DEST_ROOT}   ${sources.length} document(s)\n`);

  let failed = 0;
  for (const s of sources) {
    const d = destFor(s);
    if (!opts.apply) {
      // eslint-disable-next-line no-await-in-loop
      const exists = await code(previewUrl(d)) === 200;
      console.log(`   ${s}\n     -> ${d}${exists ? '   (destination already serving)' : ''}`);
      continue; // eslint-disable-line no-continue
    }
    /* eslint-disable no-await-in-loop */
    const got = await getDoc(headers, s);
    if (!got.ok) {
      console.log(`   FAILED read ${got.status}  ${s}`);
      failed += 1;
      continue; // eslint-disable-line no-continue
    }
    const put = await putDoc(headers, d, got.body);
    if (!put.ok) {
      console.log(`   FAILED write ${put.status}  ${d}`);
      failed += 1;
      continue; // eslint-disable-line no-continue
    }
    let note = 'copied';
    if (opts.preview) {
      const pub = await previewAndPublish(token, d);
      note = pub.ok ? 'copied + published' : `copied, ${pub.stage} FAILED ${pub.status}`;
      if (!pub.ok) failed += 1;
    }
    console.log(`   ${note}  ${d}`);
  }

  if (!opts.apply) {
    console.log('\nNothing was written. Re-run with --apply (and --preview to publish).');
    console.log('The old paths are NOT deleted by --apply: the deployed main still');
    console.log('fetches them. Run --cleanup only after the locale change is live.');
  }
  exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`ERROR: ${e.message}`);
  exit(2);
});
