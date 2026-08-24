# `scripts/tracker/` — the shared model

Every file here runs in **both** the browser and Node. That constraint is the whole
reason the directory exists, and it has three hard rules.

## 1. `.js`, never `.mjs`

`preview.da.live` **will not serve `.mjs`** — it returns `401`, not `404`, which is
why the failure reads as an auth problem and not a missing file. `aem.live` serves it
fine. DA picks which host backs an app *per session*, so:

> Opening the Page Tracker yourself proves nothing about the session a colleague gets.

A single `.mjs` anywhere in the app's import graph means the app does not boot, for
some people, some of the time. `npm run lint:browser` enforces the extension
statically and `npm run verify:host` fetches every module from both real hosts.
Both run in `npm run verify`. This rule is ported from the upstream tracker along with
the outage that produced it.

Node-only code lives in `tools/tracker/` as `.mjs` and must stay unreachable from any
browser entry point.

## 2. Zero dependencies, no DOM, no Node APIs

No `import` of anything outside this directory. No `document`, no `window`, no
`node:*`. The doc models (`qa-doc.js`, `tx-doc.js`) need a DOM, so the **caller**
supplies a `Document` — the browser passes `document`, Node passes a `jsdom` one.
That keeps the parsing logic identical in both places instead of forked.

## 3. The model is derived; the sheet is stored

`stages.js` computes a page's funnel position from stored columns every time it is
asked. Nothing writes a stage. This is what lets a crawl correct a stale status
instead of arguing with it — see the `!previewed` clamp in `classifyTranslation()`,
the single most load-bearing rule in the file.

## Files

| file | what it owns |
| --- | --- |
| `locales.js` | the 11-locale registry, path↔locale mapping, trailing-slash normalization |
| `stages.js` | every status enum, `classify()`, `classifyTranslation()`, the gates, the buckets |
| `paths.js` | site identity, tree bases, every URL a link points at |
| `detect.js` | is this page actually translated? — script gate, word weighting, evidence |
| `data.js` | the browser's memoised fetch layer for the published feeds |
| `subgroups.js` | subgroup rollup (`(unassigned)` is a real bucket, forced last) |
| `qa-doc.js` | the EN QA-notes document model |
| `tx-doc.js` | the per-(page, locale) translation review document model |
| `block-utils.js` | `dom()` (element factory + status chip), `readConfig()`, number formatting — so six blocks share one copy |

## Tests

`test/scripts/tracker/*.test.js`, run by `npm test` (web-test-runner, real browser).
`stages.js` is tested before any consumer exists — it is the one file every other
part of the tracker agrees through, and a wrong enum there is wrong everywhere.
