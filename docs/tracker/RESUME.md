# RESUME HERE — aemdev.org QA + Translation Tracker

Written 2026-08-24 ~01:00 EDT, paused for a usage-window reset. **This document is
self-contained**: a fresh session with no memory of the build can pick the work up from
here. Read it before touching anything.

## What this is

A QA + translation tracker built inside `aemgdc/aemdev`, cloned from the
`~/git/sasaem/migration-status` migration tracker with **all traces of SAS removed**.
Requested by the site owner (Tad Reeves) so the translation-tracker beat of the
adaptTo() 2026 Berlin talk can be demoed from aemdev.org itself instead of from a
client environment — see `docs/adaptto-2026/subproducts.md#s8`, which still describes it
as Tier 3 / external. **That doc is now out of date on this point.**

## Where the work is

```
worktree : /home/tad/git/aemgdc/aemdev-tracker     branch: tracker-app
main     : /home/tad/git/aemgdc/aemdev             branch: main
```

A **git worktree**, not a checkout — a second Claude session was building the Bio
Manager on `main` at the time. That session has since finished and its work is committed
and pushed to `main`. `node_modules` in the worktree is a **symlink** to the main
worktree's, excluded via `.git/info/exclude`.

**`main` has NOT been merged into `tracker-app` yet.** That is the first task below.

## Requirements, as the user stated them

1. All the `judge-dredd` and visual-compare code, repurposed so that after running a
   translation you can auto-QA that the translated pages are complete.
2. A translation tracker. aemdev.org → 10 languages, tracking pages through
   `en published` → `sent for translation` → `previewed in <lang>` → `auto QA complete`
   → `online in <lang>`.
3. New page groups replacing the SAS content-group concept: index pages, meetups,
   technical articles, bios.
4. Hidden (noindex/nofollow) pages under a `/tracker/` tree.
5. A DA app called **"Page Tracker"** — a subset of the upstream QA-signoff app.

### Decisions the user has already made — do not re-ask

| decision | answer |
| --- | --- |
| Which 10 locales | `de fr es it pt pl ja ko zh-cn zh-tw`, matching `arbory-da/scripts/lang.js`. `en` is the source. |
| Translation config | Model it on `arbory-digital-inc/arbory-da`'s `.da/translate`, with **custom-doc-rules written for this site's blocks**. Done: `.tracker/da-translate.json`. |
| Live DA writes | **Authorised.** "Full scaffold, live" — real sheets, seeded from the live query-index, tracker pages previewed. |
| Page-group paths | `/en/meetups/**`. The user then clarified: **`/en/meetup-recaps/` is dead** — it had one page and is already redirected away. The dual-prefix tolerance can be dropped. |
| `/tracker/**` being public | **Explicit non-issue.** It is a conference demo and the source is public anyway. Do not add auth. Do not raise it again. |
| Merging | The user said to PR and merge to `main` myself once ready. |

## Credentials and services — all verified working on this box (`fw13-ubuntu`)

- **DA token:** `~/today-da-token.txt` (and `~/today-auth-token.txt`) are valid and
  `resolveToken()` in `tools/tracker/lib/status-sheet.mjs` already falls through to
  them, after `DA_TOKEN` and the S2S cache. Verified live:
  `GET admin.da.live/list/aemgdc/aemdev` → 200, `/source/…/bios.json` → 200,
  `/source/…/.da/translate.json` → **404** (not configured yet).
  These are ~24h user tokens. If they have expired, ask the user to refresh them; there
  is **no S2S credential** (`node tools/tracker/da-token.mjs --describe` →
  `credential: NONE configured`, exit 3).
  **Never print, copy or echo the token.** The lib reads it; you do not need to see it.
- **Local LLM tiers, all up:** `:8080` judge (Qwen2.5-14B-Instruct-Q4_K_M), `:8081`
  triage (Qwen3-4B), `:8082` vision (Qwen2.5-VL-7B-Instruct). Same ports and roles as
  the upstream appliance.
- **`admin.hlx.page/status/aemgdc/aemdev/main/<path>` answers UNAUTHENTICATED**
  (`site.json` has `access.admin.requireAuth: "false"`). This is why `enPublished`,
  `previewed` and `online` are all directly observable with no token, and why the model
  derives them instead of storing them.
- **claude-in-chrome** is available for live testing. Use a **separate tab group** from
  any other session.

## Ground truth about the live site — verified, do not re-derive from git

`en/`, `templates/`, `fragments/` and `index.plain.html` are **gitignored**: content
lives in DA and the local copies are stale. The adaptTo planning docs are also stale.

- `/en/query-index.json` has **19 rows**: `/en/`, `/en/contact`, `/en/meetups`
  (landing), **14 meetup pages** (`template: meetup`, `status` ∈ announced|upcoming|
  recap), `/en/articles` (landing), and **1 article** (`template: blog`).
- The `/en/meetup-recaps/` → `/en/meetups/` rename **already happened**.
- Those 14 meetup pages **do** carry `template: meetup`. (An earlier survey claimed they
  did not — it was reading the stale git tree. A change adding `meetups` to
  `templatedSections` in `scripts/scripts.js` was made and then **deliberately
  reverted**, because it would inject `template=blog` into any future meetup page whose
  metadata was forgotten. Do not re-add it.)
- **Nothing is translated.** Every locale tree is empty. Tools must behave correctly and
  say something honest at zero.
- `/bios.json` exists in DA but is an **empty single-sheet doc** (`:type: 'sheet'`,
  0 rows). So the `bios` group legitimately has zero pages until the roster is seeded —
  `tools/bio-manager/seed/bios.json` on `main` has a seed to run.
- `config/sites/aemdev/query.yaml` is **the only live query config**. `helix-query.yaml`
  and `config/query.yaml` are dead for this v8/DA site — editing them fails silently.

## What is DONE (2 commits on `tracker-app`)

### `deb34a8` — the shared status model + site locale wiring

- `scripts/tracker/{stages,locales,paths,detect,data,subgroups,qa-doc,tx-doc,
  block-utils}.js` — browser+Node, zero-dep, no DOM. `.js` **never** `.mjs`:
  `preview.da.live` will not serve `.mjs` (it **401s**, so it reads as an auth problem,
  not a missing file), and DA picks its backing host per session — so opening the app
  yourself proves nothing about the session a colleague gets.
- `stages.js` is the contract everything agrees through. **Nothing stores a stage.**
  `classifyTranslation()` derives one from stored columns plus two OBSERVED facts
  (answers on preview? on live?). Its **step 4 clamp** is the single most load-bearing
  rule in the codebase: not on the preview host ⇒ not translated, whatever any column
  says. Nothing ever clears a status column, so without it a page translated, judged and
  then withdrawn reads `autoQaPass` for ever.
- `translationStage()`/`translationOrder()` exist **separately from**
  `classifyTranslation()` and any regression guard must use them. classify folds in
  `review-status`, so a guard built on it compares equal both ways and never fires —
  that is exactly how an upstream reconcile silently moved 33 rows backwards.
- Site wiring: `scripts/scripts.js` now takes its locale map from
  `scripts/tracker/locales.js`. **Keep the `''` seed in `siteLocalesConfig()`** —
  `ak.js:getLocale()` dereferences `locales[prefix].lang` with no guard and its match is
  `startsWith(`${key}/`)`, which misses on `/`, on every locale home page and on all of
  `/tracker/**`; without the seed `loadPage` dies with a TypeError.
- Config: `/tracker/*` `x-robots-tag` header, robots.txt Disallow, 10 sitemap language
  blocks, and 11 new query indices. **NONE DEPLOYED** — see the gate below.

### `9bf9af6` — the Node pipeline

32 tools + 16 libs under `tools/tracker/`. English-side judge-dredd (`structural-qa`,
`judge`, `qa-driver`), the translation lifecycle (`tx-config`, `tx-scan`, `tx-send`,
`tx-preview`, `tx-qa`, `tx-judge`, `tx-visual`, `tx-driver`, `tx-reconcile`), visual QA
(`visual-compare`, `visual-judge` — **playwright, not puppeteer**; `sharp` replaces a
shelled-out Python crop; zero new npm deps), feeds (`build-rollup`,
`build-escalations`, `publish-tx-reports`, `watch-rollup`), and group management
(`scaffold-group`, `sync-groups-from-index`, `emit-pairs`, `set-en-status`, …).
Four requirements briefs and ten glossaries in `.tracker/qa-requirements/`.

Three defects in the upstream code were **fixed, not ported** — each verified by
watching the guard go red first: `visual-judge`'s exit codes were fiction (always 0, so
any gate shelling out to it passed unconditionally); the judge emitted `confidence: 95`
against a 0..1 schema; `escalation.maxAttempts` was incremented and never compared.

**Tests: 506 passing** — 259 node (`npm run test:node`), 247 browser
(`npx wtr "./test/scripts/tracker/*.test.js" --node-resolve --port=2015`). Lint clean
(`npx eslint scripts/tracker tools/tracker`).

`npm test` (the whole suite) **exits non-zero** because of a **pre-existing orphan**:
`test/scripts/nx.test.js` imports `scripts/nx.js`, which has never existed in this repo.
Not a port defect. A background task was filed to delete it.

## What is NOT done — the remaining work, in order

### 1. Merge `main` into `tracker-app` (do this first)

`main` is at `12b0100`; this branch forked at `8a9b78f`. Main added the Bio Manager,
`blocks/speakers/`, an `aemdev-bios` query index, a `robots.txt` edit, and a null-guard
in `ak.js:decoratePictures` (unrelated to locales).

**Expected conflicts:** `config/sites/aemdev/query.yaml` (they added `aemdev-bios`, we
added `aemdev-tracker` + ten locale mirrors + `robots` on `aemdev-en` — **keep both**)
and `config/sites/aemdev/robots.txt` (**keep both** Disallow lines).

### 2. Drop the `meetup-recaps` tolerance

Per the user: that tree is dead and redirected. Simplify `tools/tracker/lib/group-map.mjs`
to `/en/meetups/**` only, and update `.tracker/qa-requirements/meetups-brief.md`'s SCOPE
line. Keep the landing-page split: `/en/meetups` belongs to `indexes`,
`/en/meetups/foo` to `meetups`.

### 3. Finish the interrupted verification pass

The pipeline's verify agent was **killed mid-run** for the window reset, so these were
never done and must not be assumed:

- `--help` on all 32 tools; confirm none crashes.
- Cross-agent contract drift: a second definition of a status enum / locale list /
  org-site constant / feed path / exit-code map anywhere; any tool hand-rolling a DA
  envelope instead of using `lib/status-sheet.mjs`; any raw path not passed through
  `normalizePath`; the ledger key must be `` `${path}\0${locale}` `` everywhere
  (**NUL** — plain `grep` reads those files as binary, use `grep -a`).
- Confirm what the tools actually write matches `docs/tracker/data-contract.md`.
- Live read-only runs, output unseen so far: `tx-scan --group=meetups --dry-run`,
  `structural-qa` on `/en/meetups/adaptto-2026-berlin`, the tier-2 judge on that report
  against `:8080`, `visual-judge` against `:8082`, `rollup --dry-run`.
- **Watch each guard go red**, then restore byte-identical: build-rollup's two
  invariants, the driver gate on an unresolved `?` row, the backwards-write regression
  guard, visual-judge's non-zero exit on FAIL.

### 4. Write the two missing tools

`tools/tracker/app-harness.mjs` and `tools/tracker/tx-heal-links.mjs`. Their
package.json scripts (`harness`, `tx:heal-links`) were **removed** rather than left to
fail with a confusing MODULE_NOT_FOUND — restore them with the tools.

### 5. Phase 4 — the `/tracker/` boards (6 blocks, not yet started)

`blocks/{tracker-summary,translation-matrix,group-progress,work-queue,escalation-list,
status-primer}/` — the six directories exist and are **empty**. Build against
`docs/tracker/data-contract.md` §3 and `scripts/tracker/data.js`. House convention is
exactly two files per block (`<name>.js` + `<name>.css`), `export default function`,
no wrapper dir. Read `blocks/card/` and `blocks/table/` first.
Build `status-primer` **first**: it renders from the model with no data fetch, so it
validates the enums before any feed exists.

Then author the pages in DA: `/tracker/`, `/tracker/translations`, `/tracker/dev`,
`/tracker/how-to-use-this` — each with a `| robots | noindex, nofollow |` row in a
`metadata` block. (The pipeline hoists `metadata` into `<head>` server-side and strips
the block from `main`; `tools/bio-manager/bio-manager.js` already relies on this for
bio docs, so arbitrary names pass through.)

### 6. Phase 5 — the "Page Tracker" DA app (not started)

`tools/page-tracker.html` + `tools/page-tracker/{page-tracker,da-source,rows,table,
drawer}.js` + `.css`. `tools/bio-manager/` on `main` is the best in-repo model for
booting a DA app (`import DA_SDK from 'https://da.live/nx/utils/sdk.js'`), and
`~/git/sasaem/migration-status/tools/qa-signoff/` is the functional model. Launches at
`https://da.live/app/aemgdc/aemdev/tools/page-tracker`; `?readonly=1` is how you hand
someone a branch build safely.

### 7. The live scaffold the user authorised

In this order, and **read every dry-run plan before applying**:
`tx:config --apply` → `group:scaffold --apply` (×4) → `group:sync --apply` →
`tx:scan --apply` → `rollup` → preview the `/tracker/` pages.
Every writing tool defaults to `--dry-run` and prints a plan rather than a count,
deliberately: a count cannot tell you whether the right value is landing on the right row.

### 8. The query.yaml deployment gate — DO NOT SKIP

`config/sites/aemdev/query.yaml` **must not be pushed** before running the
`Sync site configs` workflow and reading the diff. The repo copy is a strict SUBSET of
what is deployed: the live config emits eight properties this file does not define
(`bookAuthor`, `bookPublishDate`, `bookTypeTitle`, `displayLabel`, `eventDateTime`,
`eventDisplayLabel`, `eventDisplayTime`, `offDateTime`). `update-index-configuration` is
a **blind push**, so deploying as-is DELETES those eight and triggers a full reindex.
There is a banner in the file. The order is: sync down → decide about the eight →
push → **re-preview affected paths (pushing config does not backfill)** → sync again to
prove no drift.

## Four questions that need the user, not a guess

These are `?` rows in the briefs, and **a `?` row BLOCKS a batch by design** — the judge
escalates rather than passing silently. So the pipeline cannot run wide until they are
answered.

1. **QC1 — is English site chrome on a translated page a defect?** This is a real
   architectural finding, not a nitpick: the nav and footer fragments resolve to
   `/fragments/nav/header`, **outside `/en`**, so no `/en → /<code>` translation project
   will ever contain them and **every translated page will render English chrome**. That
   part is certain. Whether the judge should report it is the question — answer it or the
   judge either flags it on every page in every locale, or never.
2. **QC2 — must a translated page carry `hreflang` / a canonical link to its English
   source?** Nothing emits `hreflang` in `head.html` today.
3. **Q10 (meetups) — may a locale substitute a subtitled or dubbed recording?** If yes, a
   different video ID is correct; if no, any difference is a defect. The two answers
   invert the same check.
4. **I1 (meetups) — `templates/meetup/meetup.css` does not exist.** 14 live pages declare
   `template: meetup` with no template CSS behind it. Not blocking, but the visual tier
   has no template baseline to calibrate against. Note `templates/` is gitignored, so a
   new file there needs `git add -f`.

## House rules that matter

- `scripts/tracker/*.js` — browser+Node, **zero deps, no DOM globals, no `node:*`**.
  A DOM-needing function takes a `Document` from its caller.
- `tools/tracker/**.mjs` — Node-only, never reachable from a browser entry.
  `npm run lint:browser` enforces this statically.
- **Do not run `npm run lint`** (`eslint .`) — it hits a large pre-existing baseline.
  Use `npm run lint:tracker`, or `npx eslint` on your own paths.
- Comment the **why**. When porting a rule that exists because of a real past failure,
  port the reason with it. That is the house style in both repos.
- Exit codes are contractual (`docs/tracker/data-contract.md` §5). **2 = "could not
  reach a verdict"** and exists separately from 1 = "found a defect"; that is what lets
  a batch be interrupted and resumed without corrupting state.
- "A green run with zero work done is a failure." Read the counts, not the exit code.

## Read these, in this order

1. `docs/tracker/data-contract.md` — every shape written or read. Non-negotiable.
2. `docs/tracker/PORT-MANIFEST.md` — the full plan; §A file-by-file, §C the model
   redesign, §D page groups, §E target architecture, §G build order.
3. `scripts/tracker/README.md` — the three rules for the shared model.
4. `scripts/tracker/stages.js` — the model itself.
