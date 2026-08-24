# The tracker — state of play

Last updated 2026-08-24. **This document is self-contained**: a session with no memory of
the build can pick the work up from here. Read it before touching anything.

## What this is

A QA + translation tracker inside `aemgdc/aemdev`, ported from the
`~/git/sasaem/migration-status` migration tracker with **all traces of that client
removed**. It answers one question — *where is every page, in every language?* — and it
can auto-QA a translation once one lands.

Built so the translation-tracker beat of the adaptTo() 2026 Berlin talk can be demoed
from aemdev.org itself. `docs/adaptto-2026/subproducts.md#s8` still describes that beat
as "Tier 3, external, one slide plus a screen capture" — **that section is now out of
date**, and so is its constraint about scrubbing client content from the capture.

## It is built, merged, and running

Two PRs, both merged to `main`: [#2](https://github.com/aemgdc/aemdev/pull/2) (the
tracker) and [#3](https://github.com/aemgdc/aemdev/pull/3) (the icon, the pages, and
three bugs found by opening a browser).

| | |
| --- | --- |
| [/tracker](https://main--aemdev--aemgdc.aem.live/tracker) | top-line board |
| [/tracker/translations](https://main--aemdev--aemgdc.aem.live/tracker/translations) | the 10 × 4 matrix |
| [/tracker/dev](https://main--aemdev--aemgdc.aem.live/tracker/dev) | work queue + escalations |
| [/tracker/how-to-use-this](https://main--aemdev--aemgdc.aem.live/tracker/how-to-use-this) | the model, generated from the model |
| [Page Tracker](https://da.live/app/aemgdc/aemdev/tools/page-tracker) | the DA app; card at [da.live/apps](https://da.live/apps#/aemgdc/aemdev) |

Live in DA: `.da/translate.json` configured (11 languages, 16 doc rules), four group
sheets under `/tracker/data/groups/`, **27 pages × 10 locales = 270 pairs** synced and
crawled, and the rollup / tx-rollup / escalations feeds published to **both** hosts.

`npm run verify` passes: lint, the browser-module guard (99 modules from 60 entry
points), 259 node tests, 470 browser tests.

## Decisions already made — do not re-ask

| | |
| --- | --- |
| Locales | `de fr es it pt pl ja ko zh-cn zh-tw`, from `arbory-da/scripts/lang.js`. `en` is the source. |
| Translation mechanism | DA's own Translate app (Google connector). Config source of truth is `.tracker/da-translate.json`. |
| Page groups | `indexes`, `meetups`, `technical-articles`, `bios`. `/en/meetup-recaps/` is dead — one page, already redirected. |
| `/tracker/**` being world-readable | **Explicit non-issue.** Conference demo, public source. Do not add auth. Do not raise it again. |
| Live DA writes | Authorised. |

## Credentials and services

- **DA token:** `~/today-da-token.txt` / `~/today-auth-token.txt`. `resolveToken()` in
  `tools/tracker/lib/status-sheet.mjs` falls through to them after `DA_TOKEN` and the
  S2S cache. These are ~24h user tokens; if they have expired, ask for a refresh. There
  is **no S2S credential** (`node tools/tracker/da-token.mjs --describe` → none).
  **Never print, copy or echo the token.**
- **`admin.hlx.page/status/aemgdc/aemdev/main/<path>` answers UNAUTHENTICATED**
  (`site.json` has `requireAuth: "false"`). This is why `enPublished`, `previewed` and
  `online` are observed rather than stored.
- **Local LLM tiers** on `fw13-ubuntu`: `:8080` judge (Qwen2.5-14B), `:8081` triage
  (Qwen3-4B), `:8082` vision (Qwen2.5-VL-7B).

## Ground truth — verified, do not re-derive from git

`en/`, `templates/`, `fragments/`, `tracker/` and `index.plain.html` are **gitignored**:
content lives in DA and local copies are stale. The adaptTo planning docs are also stale.

- 19 rows in `/en/query-index.json`; the `bios` group comes from a **second** index,
  `/en/fragments/bios/query-index.json` (7 rows), because `/en/fragments/**` is excluded
  from `aemdev-en`.
- The `/en/meetup-recaps/` → `/en/meetups/` rename already happened, and those 14 pages
  **do** carry `template: meetup`. Do not add `meetups` to `templatedSections` — it
  would inject `template=blog` into any future meetup page whose metadata was forgotten.
- **Nothing is translated.** Every locale tree is empty, so the empty states are the
  primary states.
- Shared fragments now live under `/en/fragments/**`. The originals at `/fragments/**`
  are still there — see "unfinished business" below.

## Five things that will bite you

1. **`.js`, never `.mjs`, anywhere a browser can reach.** `preview.da.live` will not
   serve `.mjs` — it **401s**, so it reads as an auth failure rather than a missing file.
   Confirmed live: DA served the app from `preview.da.live` on 2026-08-24. `npm run
   lint:browser` enforces it.
2. **A browser's `fetch` has an HTTP cache and Node's does not.** A read-back-confirm
   that works in the pipeline silently returns the **pre-write** body in a DA app. The
   fix needs BOTH `cache: 'no-store'` and a `?nocache=` param, because Cloudflare fronts
   `admin.da.live` and `no-store` only governs the browser. DA's own client does the same
   (`cachebust` in `nx2/utils/api.js`).
3. **Preview and live are different hosts.** A feed published to one only makes the board
   on the other render its honest "nothing published yet" panel — indistinguishable from
   the pipeline never having run. `rollup --publish` exists for this and reports its own
   absence every run.
4. **The DA config API is PUT with a plain-string form value.** A source document is POST
   with a Blob. Only the field name is shared; getting it wrong returns
   `400 Couldn't parse or save config` and says nothing about which half it disliked.
5. **`config/sites/aemdev/query.yaml` must not be deployed** without running the
   `Sync site configs` workflow and reading the diff first. The repo copy is a strict
   subset of what is deployed — the live config emits eight properties defined nowhere
   here — and the push is blind, so deploying as-is **deletes** them and triggers a full
   reindex. There is a banner in the file.

## Unfinished business

**Needs a human decision — four `?` rows in `.tracker/qa-requirements/*-brief.md`.** A
`?` row blocks a batch by design, and the live escalations show why that matters: the
brief is currently failing 8 pages for **its own** defects.

- **QC1 — is English chrome on a translated page a defect the judge reports?** Now that
  fragments are under `/en` the chrome *will* translate, so the question is narrower than
  it was: until a locale's chrome is translated, should the judge flag it? Unanswered, it
  either fires on all 270 pairs or never.
- **QC2** — are `hreflang` / canonical links required on translated pages?
- **Q10** — may a locale substitute a subtitled or dubbed recap recording?
- **I1** — `templates/meetup/meetup.css` does not exist, so the visual tier has no
  template baseline. (`templates/` is gitignored; a new file there needs `git add -f`.)

**Brief defects the pipeline already found** (`/tracker/dev`, and
`.tracker/state/qa-escalations.jsonl`): the `meetups` brief requires a `What to expect`
heading that recap pages do not have, and requires `"Berlin"` verbatim across the whole
group — clearly seeded from the adaptTo page. Both are scoped `template`, so one brief
edit clears eight pages.

**Real content bugs the pipeline found**, worth fixing independently:
- a broken internal link on `/en/meetups/20260625-…` →
  `/en/articles/aem-eds-content-modeling-deep-dive/` **with a trailing slash**, which
  404s on this site
- `event-date` missing on `/en/meetups/aem-65-lts-vs-eds-vs-aemaacs-columbus`
- two stale nav links on **every** page: "Articles" points at `/en/` and "Meetup Recaps"
  at the redirected `/en/meetup-recaps`. `content-plan.md` already lists the second as
  "do fix".

**Delete the old fragment copies.** `/fragments/**` still exists in DA alongside
`/en/fragments/**`. It was deliberately not deleted while the old code was deployed;
that code is now merged, so:
```
node tools/tracker/localize-fragments.mjs --cleanup
```
It refuses to run unless every destination is already serving on live.

**Not verified end to end:** the write-confirm fix. The write itself is proven — a
`content-escalation` toggle landed in the sheet and was undone — but confirming that the
*message* is now correct needs a click in the app, which the browser pane could not
reach. The mechanism is verified: `daFetch` really is `(url, opts) => fetch(url, opts)`,
and `?nocache=` returns 200 with an identical body and ETag.

**Also not done:** `tools/tracker/app-harness.mjs` and `tx-heal-links.mjs` are unwritten
(their package.json scripts were removed rather than left to fail confusingly); the
`escalation-list` block has render coverage but no dedicated test; the dark scheme has
never rendered because `styles.css` pins `.dark-scheme` to `color-scheme: light`; and no
board has been checked at 390px.

## House rules

- `scripts/tracker/*.js` — browser + Node, **zero deps, no DOM globals, no `node:*`**. A
  DOM-needing function takes a `Document` from its caller.
- `tools/tracker/**.mjs` — Node-only, never reachable from a browser entry.
- **Do not run `npm run lint`** (`eslint .`) — it hits a large pre-existing baseline in
  the vendored `scripts/search` bundle. Use `npm run lint:tracker`.
- Exit codes are contractual (`docs/tracker/data-contract.md` §5). **2 = "could not reach
  a verdict"** and exists separately from 1 = "found a defect"; that is what lets a batch
  be interrupted and resumed without corrupting state.
- Any tool that writes defaults to `--dry-run` and prints **the plan**, not a count. A
  count cannot tell you whether the right value is landing on the right row.
- "A green run with zero work done is a failure." Read the counts, not the exit code.

## Read these, in order

1. `docs/tracker/data-contract.md` — every shape written or read. Non-negotiable.
2. `docs/tracker/PORT-MANIFEST.md` — the original plan and the reasoning behind it.
3. `scripts/tracker/README.md` — the three rules for the shared model.
4. `scripts/tracker/stages.js` — the model itself, and the clamp at step 4 of
   `classifyTranslation()`, which is the single most load-bearing rule in the codebase.
