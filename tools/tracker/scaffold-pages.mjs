#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * scaffold-pages.mjs — author the four /tracker/ board pages in DA.
 *
 * These are EDS pages, so they live in DA and not in git (`/tracker/` is gitignored,
 * same as `en/`). But a board nobody can reach is a board nobody uses, and hand-authoring
 * four pages of block tables in the DA editor is both slow and easy to get subtly wrong
 * — a `metadata` row with a typo'd key silently does nothing. So the page bodies live
 * here, in code, next to the blocks they instantiate.
 *
 * EVERY PAGE CARRIES `robots: noindex, nofollow`. That is layer 1 of four:
 *
 *   1. this metadata row                 — HTML pages, visible to a crawler without JS
 *   2. absence from every query index    — `/tracker/**` is outside `include: /en/**`,
 *                                          so it cannot reach /en/sitemap.xml
 *   3. an `x-robots-tag` response header — config/sites/aemdev/headers.json. THE ONLY
 *                                          layer that reaches the JSON feeds, which are
 *                                          not HTML and carry no metadata block.
 *                                          NOT YET DEPLOYED — see the note in that file.
 *   4. `Disallow: /tracker/` in robots.txt
 *
 * The pipeline hoists a `metadata` block into `<head>` server-side and strips the block
 * from `main`, and arbitrary names pass through — verified on a live article, and
 * tools/bio-manager/bio-doc.js already relies on it for `robots` on bio documents.
 * Do NOT rely on blocks/metadata/metadata.js's client-side injection instead: on a
 * published page the block is already gone so it never fires, and it would run after
 * first paint anyway, which is useless to a crawler that does not execute JavaScript.
 *
 * CLI
 *   node tools/tracker/scaffold-pages.mjs               dry run: print each body
 *   node tools/tracker/scaffold-pages.mjs --apply        write to DA
 *   node tools/tracker/scaffold-pages.mjs --apply --preview   …and preview + publish
 *   node tools/tracker/scaffold-pages.mjs --page=/tracker/dev    just one
 *   node tools/tracker/scaffold-pages.mjs --verify       report HTTP status of each
 *
 * EXIT  0 ok · 1 a write or publish failed · 2 could not reach DA · 3 usage/no token
 */
import { argv, exit } from 'node:process';
import {
  ORG, SITE, DA_ADMIN, DEFAULT_BRANCH, daEditUrl, liveUrl, previewUrl,
  previewApiUrl, publishApiUrl,
} from '../../scripts/tracker/paths.js';
import { resolveToken, aemAdminHeaders, TOKEN_HINT } from './lib/status-sheet.mjs';

/* ------------------------------------------------------------- authoring helpers */

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Default content: a run of paragraphs and headings, outside any block. */
const prose = (...lines) => lines.join('');
const p = (t) => `<p>${esc(t)}</p>`;
const h1 = (t) => `<h1>${esc(t)}</h1>`;
const h2 = (t) => `<h2>${esc(t)}</h2>`;
const link = (href, t) => `<p><a href="${href}">${esc(t)}</a></p>`;

/**
 * A block, as DA stores it: div-per-row, div-per-cell.
 *
 * `rows` is an array of arrays of cell strings. A key/value config block is therefore
 * `[['limit', '6']]`. Passing a bare string as a row is shorthand for a one-cell row.
 */
function block(name, rows = []) {
  const body = rows.map((row) => {
    const cells = Array.isArray(row) ? row : [row];
    return `<div>${cells.map((c) => `<div>${c.startsWith('<') ? c : p(c)}</div>`).join('')}</div>`;
  }).join('');
  return `<div class="${name}">${body}</div>`;
}

/** One `<main>` section. */
const section = (...content) => `<div>${content.join('')}</div>`;

/**
 * The metadata block every tracker page ends with.
 *
 * `robots` first, because it is the one row that must never be dropped when somebody
 * edits this page in DA and reorders things.
 */
const metadata = (title, description) => block('metadata', [
  ['robots', 'noindex, nofollow'],
  ['title', title],
  ['description', description],
]);

const doc = (...sections) => `<body>
  <header></header>
  <main>${sections.join('')}</main>
  <footer></footer>
</body>
`;

/* ------------------------------------------------------------------- the pages */

const PAGES = [
  {
    path: '/tracker',
    title: 'Tracker — AEM Global Developer Collective',
    description: 'QA and translation status for aemdev.org. Internal board.',
    body: () => doc(
      section(prose(
        p('// Tracker'),
        h1('Where every page is.'),
        p('Translation and QA status for aemdev.org, across ten languages. '
          + 'Derived from the live site every time it is built — nothing here is typed in by hand.'),
      )),
      section(block('tracker-summary')),
      section(prose(h2('By group')), block('group-progress')),
      section(prose(
        p('The boards: '),
      ), block('columns', [[
        link('/tracker/translations', 'Translations →'),
        link('/tracker/dev', 'Work queue and escalations →'),
        link('/tracker/how-to-use-this', 'How to read this →'),
      ]])),
      section(metadata(
        'Tracker — AEM Global Developer Collective',
        'QA and translation status for aemdev.org. Internal board, not indexed.',
      )),
    ),
  },
  {
    path: '/tracker/translations',
    title: 'Translations — Tracker',
    description: 'Every page, every language, and how far each has got.',
    body: () => doc(
      section(prose(
        p('// Tracker'),
        h1('Translations.'),
        p('Ten locales down, four page groups across. Each cell is that group\'s spread '
          + 'across the funnel in that language. Click a cell to open it in the Page Tracker.'),
      )),
      section(block('translation-matrix')),
      section(prose(
        h2('Reading a row'),
        p('A locale row totals the same 27 pages as every other row — the question is '
          + 'how far along each one is. A row of zeroes means nothing has been sent for '
          + 'that language yet, which is not the same as nothing being tracked.'),
      ), block('columns', [[
        link('/tracker', '← Tracker'),
        link('/tracker/how-to-use-this', 'How to read this →'),
      ]])),
      section(metadata(
        'Translations — Tracker',
        'Every page, every language, and how far each has got. Internal board, not indexed.',
      )),
    ),
  },
  {
    path: '/tracker/dev',
    title: 'Work queue — Tracker',
    description: 'What needs doing, whose it is, and what the judge could not decide.',
    body: () => doc(
      section(prose(
        p('// Tracker'),
        h1('Work queue.'),
        p('What needs a human, grouped by who is being asked. An empty board is the '
          + 'good state.'),
      )),
      section(block('work-queue')),
      section(prose(
        h2('Escalations'),
        p('Where the judge could not decide. Grouped by scope, because the fix differs: '
          + 'a template-scope escalation means the requirements brief is wrong, and one '
          + 'edit clears every page it matched.'),
      ), block('escalation-list')),
      section(block('columns', [[
        link('/tracker', '← Tracker'),
        link('/tracker/how-to-use-this', 'How to read this →'),
      ]])),
      section(metadata(
        'Work queue — Tracker',
        'What needs doing and what the judge could not decide. Internal board, not indexed.',
      )),
    ),
  },
  {
    path: '/tracker/how-to-use-this',
    title: 'How to read the tracker',
    description: 'The status model, generated from the model itself.',
    body: () => doc(
      section(prose(
        p('// Tracker'),
        h1('How to read this.'),
        p('Every table below is generated from the status model in code, so it cannot '
          + 'fall behind it. If a stage or a queue appears here, it exists; if a hint '
          + 'reads oddly, the fix is a one-line edit in scripts/tracker/stages.js and '
          + 'this page changes with it.'),
      )),
      section(block('status-primer')),
      section(block('columns', [[
        link('/tracker', '← Tracker'),
        link('/tracker/translations', 'Translations →'),
      ]])),
      section(metadata(
        'How to read the tracker',
        'The tracker\'s status model, generated from the model itself. Internal, not indexed.',
      )),
    ),
  },
];

/* ----------------------------------------------------------------------- runner */

const HELP = `scaffold-pages — author the four /tracker/ board pages in DA.

  (no flags)        dry run: print each page body
  --apply           write to DA
  --preview         with --apply, also preview and publish
  --page=<path>     just one page
  --verify          report the HTTP status of each page on both hosts
  --help            this text

Every page carries a \`robots | noindex, nofollow\` metadata row.`;

function parseArgs(args) {
  const o = {
    apply: false, preview: false, verify: false, help: false, page: null,
  };
  for (const a of args) {
    if (a === '--apply') o.apply = true;
    else if (a === '--preview') o.preview = true;
    else if (a === '--verify') o.verify = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('--page=')) o.page = a.slice(7);
    else {
      console.error(`unknown arg: ${a}`);
      exit(3);
    }
  }
  return o;
}

const code = async (url) => {
  try {
    return (await fetch(url)).status;
  } catch {
    return 0;
  }
};

async function main() {
  const opts = parseArgs(argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  const pages = opts.page ? PAGES.filter((x) => x.path === opts.page) : PAGES;
  if (!pages.length) {
    console.error(`no such page: ${opts.page}\nknown: ${PAGES.map((x) => x.path).join(', ')}`);
    return 3;
  }

  if (opts.verify) {
    console.log('path'.padEnd(30), 'preview  live');
    for (const pg of pages) {
      /* eslint-disable no-await-in-loop */
      const [pv, lv] = [await code(previewUrl(pg.path)), await code(liveUrl(pg.path))];
      console.log(pg.path.padEnd(30), `${pv}`.padEnd(9), lv);
    }
    return 0;
  }

  const token = resolveToken();
  if (!token) {
    console.error(`ERROR: no DA token (${TOKEN_HINT})`);
    return 3;
  }
  const headers = { Authorization: `Bearer ${token}` };

  console.log(`── scaffold-pages · ${opts.apply ? 'APPLY' : 'DRY RUN (default)'} ──`);
  let failed = 0;

  for (const pg of pages) {
    const html = pg.body();
    const blocks = [...html.matchAll(/<div class="([a-z-]+)"/g)].map((m) => m[1]);
    console.log(`\n── ${pg.path} ──`);
    console.log(`   editor: ${daEditUrl(pg.path)}`);
    console.log(`   blocks: ${[...new Set(blocks)].join(', ')}`);
    console.log(`   robots: ${html.includes('noindex, nofollow') ? 'noindex, nofollow ✓' : 'MISSING ✗'}`);

    if (!html.includes('noindex, nofollow')) {
      console.error('   REFUSING: a tracker page without the robots row is not one of these pages.');
      failed += 1;
      continue; // eslint-disable-line no-continue
    }

    if (!opts.apply) {
      console.log(`   ${html.length} bytes:\n${html.split('\n').map((l) => `     ${l.slice(0, 160)}`).join('\n')}`);
      continue; // eslint-disable-line no-continue
    }

    /* eslint-disable no-await-in-loop */
    const form = new FormData();
    form.append('data', new Blob([html], { type: 'text/html' }));
    const put = await fetch(`${DA_ADMIN}/source/${ORG}/${SITE}${pg.path}.html`, {
      method: 'POST', headers, body: form,
    });
    if (!put.ok) {
      console.error(`   ✗ write ${put.status}`);
      failed += 1;
      continue; // eslint-disable-line no-continue
    }
    console.log('   ✓ written');

    if (opts.preview) {
      const ah = aemAdminHeaders(token);
      const pv = await fetch(previewApiUrl(pg.path, DEFAULT_BRANCH), { method: 'POST', headers: ah });
      if (!pv.ok) {
        console.error(`   ✗ preview ${pv.status} — DA holds the file and nothing serves it`);
        failed += 1;
        continue; // eslint-disable-line no-continue
      }
      console.log(`   ✓ previewed  ${previewUrl(pg.path)}`);
      const lv = await fetch(publishApiUrl(pg.path, DEFAULT_BRANCH), { method: 'POST', headers: ah });
      console.log(lv.ok ? `   ✓ published  ${liveUrl(pg.path)}` : `   ✗ publish ${lv.status}`);
      if (!lv.ok) failed += 1;
    }
  }

  if (!opts.apply) console.log('\n   Nothing written. Re-run with --apply (and --preview to publish).');
  return failed ? 1 : 0;
}

main().then(exit).catch((e) => {
  console.error(`ERROR: ${e.message}`);
  exit(2);
});
