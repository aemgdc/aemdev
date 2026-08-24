# The tracker's data contract

Every shape the tracker writes or reads, in one place. Anything that produces or
consumes one of these MUST agree with this document, and when a shape changes this
document changes in the same commit.

This exists because the parts are built independently: a Node tool writes a feed, a
browser block reads it, and a DA app writes the sheet both derive from. Three
components with three private opinions about a column name is the failure this file
prevents.

## 0. Where everything lives

| what | path | who writes | who reads |
| --- | --- | --- | --- |
| group sheet | DA `/tracker/data/groups/<group>.json` | pipeline, Page Tracker app | pipeline, app, blocks |
| EN QA doc | DA `/tracker/qa/<en-path>` | `qa-driver` | reviewer, `qa:sync` |
| review doc | DA `/tracker/tx/<locale-path>` | `tx-driver` | reviewer, `tx:scan` |
| requirements | DA `/tracker/requirements/<group>/production-requirements` | human | `judge`, `tx-judge` |
| rollup feed | DA `/tracker/data/rollup.json` | `build-rollup` | blocks |
| translation rollup | DA `/tracker/data/tx-rollup.json` | `build-rollup` | blocks |
| escalation feeds | DA `/tracker/data/{escalations,tx-escalations}.json` | `build-escalations` | blocks |
| per-locale index | DA `/tracker/data/tx-index/<code>.json` | `publish-tx-reports` | blocks, app |
| per-page report | DA `/tracker/data/tx-reports/<code>--<slug>.json` | `publish-tx-reports` | app drawer |
| ledgers | repo `.tracker/state/{qa,tx}-ledger.json` | drivers | drivers, `watch-rollup` |
| escalation queues | repo `.tracker/state/{qa,tx}-escalations.jsonl` | drivers | `build-escalations`, humans |
| reports | repo `.tracker/reports/{qa,tx}/<slug>.json` | tiers | `judge`, `build-*` |
| baselines | repo `.tracker/qa-baselines/<group>.json` | `qa:page --calibrate` | `structural-qa` |

Paths come from `FEEDS`, `qaDocPath()`, `txDocPath()` and `requirementsPath()` in
`scripts/tracker/paths.js`. **Never hardcode one.**

## 1. The group sheet

One DA multi-sheet document per group. Tabs: `data`, then one per target locale in
`TARGET_LOCALES` order (`de fr es it pt pl ja ko zh-cn zh-tw`).

### `data` tab — one row per English page

Columns in three ownership bands. **The band boundary is the contract**: an
index-driven sync may overwrite band 1 and must never touch bands 2 or 3.

```
Band 1 — index-derived. `group:sync` regenerates these every run.
  page-path        the join key. Normalized, no trailing slash. Never blank on a real row.
  title            from the query index
  template         from the query index (may be blank — not every page declares one)
  pagetype         coarse kind, derived from the path prefix, not from `template`
  en-live          'yes' | '' — observed on the live host
  last-modified    ISO 8601, from the index

Band 2 — curated by a human. A sync NEVER writes these.
  subgroup         free text; blank rolls up as `(unassigned)`
  translate        'yes' | 'no' | '' — 'no' excludes the page from every locale
  notes            free text

Band 3 — pipeline and human status.
  en-status        one of EN_STATUSES: '' | draft | en-previewed | en-published
  content-escalation  tolerant truthy: yes/y/true/1/x
```

A row with a blank `page-path` is a scaffold placeholder: `countsAsPage()` returns
false and nothing counts it.

### Locale tabs — one row per (page, locale)

```
page-path            the join key back to the `data` tab. Same normalization.
locale               the tab's own code, denormalized so a row is self-describing
locale-path          pathForLocale(page-path, locale). Derived, but stored so a
                     reviewer reading the raw sheet can click it.
sent-at              ISO 8601. Set once, when the pair is sent. Never regenerated.
previewed            'yes' | '' — CRAWL OUTPUT, regenerated every `tx:scan`
online               'yes' | '' — CRAWL OUTPUT, regenerated every `tx:scan`
translation-status   one of TRANSLATION_STATUSES
review-status        one of REVIEW_STATUSES
review-updated       ISO 8601
```

`LOCALE_PRESERVED = ['sent-at', 'translation-status', 'review-status',
'review-updated']`. A rebuild carries these over verbatim and never regenerates them —
they are testimony, not cache. `previewed` and `online` are the opposite: they are
re-observed on every scan, and that is what makes the stale-status clamp in
`classifyTranslation()` able to correct a wrong row instead of trusting it.

**Column changes are additive only.** Removing a column is data loss that `git revert`
cannot undo, because the data was never in git.

## 2. Sheet envelope rules

Two rules, both learned the hard way, both enforced in `lib/status-sheet.mjs`:

1. **Every top-level key must be `:`-prefixed or a `{total, limit, offset, data}`
   sheet object.** Anything else is refused by the content bus. So a feed's timestamp
   lives in its own `meta` sheet, not in a top-level `generated` key.
2. **A multi-tab document must carry `:type: 'multi-sheet'` and `:names: [...]`.** The
   single-sheet form (`:type: 'sheet'`, rows at the top level) is *accepted* by
   `admin.da.live` and then **refused at preview** with `400 error from content-bus`,
   which leaves DA holding a file every reader 404s. The write looks like it worked.

Writes: a DA `.json` sheet supports `If-Match`, but **strip a `W/` weak-validator
prefix first** or the comparison never matches. A DA `.html` document has **no ETag at
all**, so `If-Match` is unusable there and `If-Unmodified-Since` is ignored — which is
why per-page verdicts live in one document per (page, locale) rather than as rows in a
shared sheet. That design choice is the concurrency control.

## 3. The published feeds

### `rollup.json` — the English side

```jsonc
{
  "meta":   { "data": [{ "generated": "<iso>", "branch": "main", "expected": 19, "listed": 19, "withheld": 0 }] },
  "groups": { "data": [{ "group": "meetups", "total": 15, "counted": 15,
                         "catalogued": 0, "enPublished": 15, /* … every PAGE_STAGES id … */
                         "blocked": 0 }] },
  "totals": { "data": [{ "total": 19, "counted": 19, /* every PAGE_STAGES id */ "blocked": 0,
                         "groups": 4, "queued": 0 }] },
  "subgroups": { "data": [{ "group": "meetups", "subgroup": "(unassigned)", "key": "(unassigned)",
                            "slug": "unassigned", "total": 4, "counted": 4,
                            /* every PAGE_STAGES id */ "blocked": 0 }] },
  "queues": { "data": [{ "queue": "auto-qa-issues", "label": "Auto QA failures",
                         "owner": "pipeline", "count": 3 }] },
  ":names": ["meta", "totals", "groups", "subgroups", "queues"], ":type": "multi-sheet"
}
```

The English side tallies PAGES, by pairing each `data` row with an EMPTY locale row —
which is exactly what `classifyTranslation` expects for "no row in that locale", so it
falls through to `classifyEnglish`. That is why a group of 15 pages reads `total: 15`
here and `total: 150` across the ten locales in `tx-rollup.json`, and why only
`catalogued` and `enPublished` are ever non-zero on this side.

`subgroups` is the invariant-bearing tab: `(unassigned)` is a real bucket, and the rows
must re-add to the matching `groups` row PER COLUMN. It is dropped WHOLE, never trimmed,
when the size ceiling bites — a partial breakdown is a board disagreeing with the row it
opens from — and `meta['subgroups-complete']` goes blank when that happens.

### `tx-rollup.json` — the translation side

```jsonc
{
  "meta":    { "data": [{ "generated": "<iso>", "branch": "main", "locales": 10, "groups": 4,
                          "expected": 190, "listed": 190, "withheld": 0 }] },
  "locales": { "data": [{ "locale": "de", "name": "German", "total": 19, "counted": 19,
                          /* every PAGE_STAGES id */ "blocked": 0,
                          /* every PROGRESS_BUCKETS id, prefixed `b_` */ "b_online": 0 }] },
  "cells":   { "data": [{ "locale": "de", "group": "meetups", "counted": 15,
                          "stage": "previewed", "count": 4 }] },
  "groups":  { "data": [{ "locale": "de", "group": "meetups", "total": 15, "counted": 15,
                          /* every PAGE_STAGES id */ "blocked": 0 }] },
  "queues":  { "data": [{ "locale": "de", "queue": "retranslate", "label": "Needs retranslation",
                          "owner": "pipeline", "count": 1 }] },
  "stages":  { "data": [{ "id": "previewed", "label": "Previewed", "short": "PREV",
                          "hint": "…", "order": 3 }] },
  ":names":  ["meta", "locales", "groups", "cells", "queues", "stages"], ":type": "multi-sheet"
}
```

`groups` is the wide form of `cells` and `cells` is its long form; both are published
because a matrix reads the wide one and a drill-in reads the long one. `cells` carries
NON-ZERO triples only — an absent long-form row already means zero — and it is the first
tab dropped when the ceiling bites (`meta['cells-listed']` vs `meta['cells-nonzero']`),
then `queues`. Every dropped tab records `meta['<tab>-withheld']`.

`stages` carries the stage VOCABULARY with the data, so a board renders labels from the
same build that counted the rows and cannot drift out of step with `stages.js`.

`meta[0].{expected,listed,withheld}` is not decoration. A feed that lists fewer rows
than exist must say so, or a short feed reads as "we are nearly done" rather than "we
truncated". The published index has a real size ceiling — a 685 KB feed was refused
outright by the content bus while a 38 KB one went through — so withholding is a
normal operating mode, not an error.

**The unit is what the feed aggregates**: pages for `rollup.json`, (page, locale) pairs
for `tx-rollup.json`, pages for a locale index. `expected` is what the build discovered,
`listed` is what it counted in, and `withheld = expected − listed` is what it knowingly
left out — a draft, a sandbox page, a scaffold placeholder, a non-bio fragment.

A shortfall has a SECOND cause that must never share that field. A group sheet the build
could not read at all contributes an UNKNOWN number of pages, so it is carried as
`incomplete: 'yes'` plus `groups-failed`, never folded into `withheld`. `withheld` is a
quantity we know; an unread sheet is one we do not, and claiming otherwise is how an
understated denominator makes a rollout look further along than it is. All groups failing
refuses the build outright.

`generatedAt` duplicates `generated` under the spelling `scripts/tracker/data.js` reads.
It is redundant and should not survive: collapse it the moment the browser data layer is
amended to read `generated`. Emitting only one of them today would leave either this
document or every board's provenance stamp wrong, and a board that silently shows
"generated: never" is worse than a redundant key.

**Two invariants, asserted at build time, not hoped for:**
- for every group and locale, the stage counts plus `blocked` equal `counted`
- a group's subgroups re-add to the group's own total, per column

A build that cannot satisfy these **fails loudly and writes nothing**. Half an answer
published as a whole one is worse than no answer: it was believed for a day.

### Escalation feeds

```jsonc
{ "escalations": { "data": [{
    "page-path": "/en/meetups/x", "locale": "de", "group": "meetups",
    "queue": "auto-qa-escalate", "scope": "template|page|content",
    "summary": "…", "detail": "…", "tier": "judge", "confidence": 0.42,
    "first-seen": "<iso>", "attempts": 2,
    "doc": "/tracker/tx/de/meetups/x", "report": ".tracker/reports/tx/de--meetups--x.json"
  }] },
  "meta": { "data": [{ "generated": "<iso>", "expected": 12, "listed": 12, "withheld": 0 }] },
  ":names": ["escalations", "meta"], ":type": "multi-sheet" }
```

`publishable()` strips anything not fit for a public page before writing: the raw
prose blobs, the full `checks` array, and any source text. **`/tracker/**` is publicly
readable once previewed** — noindex is not access control — so this stripping is
mandatory, not prudent.

The mechanism is an ALLOW-LIST projection onto the thirteen columns above, plus one
structural rule: **every published cell must be a scalar.** That removes the whole class
at once rather than by remembering field names — an `issues[]` with its verbatim
`evidence`, a `textSample.pairs` of source and target sentences, a `checks` array — and a
deny-list would have to be extended every time a tier learns a new field. `NEVER_PUBLISH`
in `tools/tracker/lib/feed.mjs` additionally refuses to be ASKED for such a column by
name, so a caller that means "the number of findings" has to say `finding-count`.

Every emitted `group` is resolved from `page-path` through `groupForPath()` and ASSERTED
to be a registered group. A row whose recorded `group` contradicts the resolver is
excluded and reported, never rewritten: one of the two is wrong, and publishing either is
a guess. This is the fix for the upstream feed whose `group` values no work-queue filter
could match, leaving 21 of 23 groups unfilterable.

### `tx-index/<code>.json` — one locale's pages

`:type: 'multi-sheet'` with tabs `meta` and `pages`, **never** `:type: 'sheet'`. The
single-sheet form carries rows at the top level, is accepted by `admin.da.live`, and is
then refused at PREVIEW with `400 error from content-bus` — leaving DA holding a file
every reader 404s while the tool prints success.

PRESENT pages only: those the crawl observed `previewed` or `online` on. Presence is read
off the OBSERVED columns and never off `translation-status`, because nothing clears a
status column and a withdrawn page would stay in the index forever. `meta.withheld` is
the expected-but-absent remainder, and `meta.note` says in words which of "nothing is
translated yet" and "we truncated" a short index means.

### `tx-reports/<code>--<slug>.json` — one page's reviewer subset

Tabs `meta`, `report` (one row: the page's identity, the three tier verdicts, a
`finding-count`), and `findings` (one bounded row per finding: `tier`, `severity`,
`kind`, `detail`, `width`, `check`). A tier that did not run is `''`, never `'pass'`.

`<slug>` is `slugOf(<en-path>)`, so the file is `de--en--meetups--x.json` — the EN path's
slug, with its `en--` segment, because `slugOf()` in `scripts/tracker/paths.js` is the
only committed slug helper and a second spelling of a filename rule is how a writer and
a reader come to disagree about which file they mean. The examples elsewhere in this
document write `de--meetups--x`; either add a base-path slug helper to `paths.js` and
change both, or read those examples as shorthand.

## 4. Repo-side state

### `.tracker/state/tx-ledger.json`

```jsonc
{ "version": 1, "updated": "<iso>",
  "runs": [{ "started": "<iso>", "finished": "<iso>", "host": "<hostname>",
             "branch": "main", "group": "meetups", "locales": ["de"],
             "pass": 12, "fail": 2, "escalate": 1, "skipped": 3 }],
  "pages": { "/en/meetups/x de": {
      "translation-status": "auto-qa-ok", "tiers": { "structural": "pass", "judge": "pass", "visual": null },
      "judged": "<iso>", "attempts": 1, "report": ".tracker/reports/tx/de--meetups--x.json" } } }
```

The `pages` key is `` `${page-path}\0${locale}` `` — a NUL separator, matching
`indexLocaleRows()` in `stages.js`. A separator that can occur inside a key is a silent
collision.

**The ledger is run bookkeeping. It is NOT the source of truth for status.** The locale
tab is. The upstream tracker got this backwards — one tool read tier status from a
gitignored per-machine ledger while another wrote it to a sheet tab nobody read — and
that was the weakest link in its whole state model. `tx:scan` reads the sheet.

### `.tracker/reports/tx/<code>--<slug>.json`

```jsonc
{ "page-path": "/en/meetups/x", "locale": "de", "group": "meetups", "template": "meetup",
  "urls": { "source": "<en preview url>", "target": "<locale preview url>" },
  "branch": "main", "generated": "<iso>",
  "tiers": {
    "structural": { "verdict": "pass|fail|review", "checks": [ /* … */ ], "fatal": null },
    "judge":      { "verdict": "pass|fail|escalate", "confidence": 0.0,
                    "issues": [{ "severity": "high|medium|low", "kind": "…", "detail": "…", "evidence": "…" }],
                    "model": "…", "elapsedMs": 0 },
    "visual":     { "verdict": "pass|fail|escalate", "widths": { "390": "pass", "1280": "pass", "2360": "pass" },
                    "findings": [ /* … */ ], "images": [ /* paths */ ] }
  },
  "verdict": "pass|fail|escalate" }
```

Tier verdicts are written independently and merged once, by the driver. A tier that did
not run is `null`, never `"pass"` — "we did not look" and "we looked and it was fine"
must not be the same value.

## 5. Exit codes

Uniform across every pipeline tool, because callers branch on them:

| code | meaning |
| --- | --- |
| 0 | pass |
| 1 | fail — a real defect was found |
| 2 | **the tool could not reach a verdict.** A down LLM service, a network error, a missing page. The page HOLDS its current status and the batch continues. |
| 3 | usage or configuration error. Nothing ran. |

Exit 2 existing separately from 1 is the whole reason a batch can be interrupted and
resumed without corrupting state. `LlmUnavailable` maps to 2; a bad model answer maps
to 1 or an escalation.

## 6. The judge's contract

`.tracker/qa-requirements/<group>-brief.md`, mirrored to DA. Only the
`## QA Requirements` section is shown to the model — `judgeBrief()` returns that
section alone, or `null`. Rows are `✓` (must survive verbatim), `~` (may change, with a
note), `✗` (approved removal), `?` (**unresolved**).

**A brief containing any `?` row blocks the batch.** The judge escalates those pages
rather than passing them silently, because a requirement nobody could state is not a
requirement the model can check. This is a gate, not a warning.
