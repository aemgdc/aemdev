# tools/l10n: post-rollout localization toolkit (aemgdc/aemdev)

These are Node CLIs that repair and check the machine-translated DA copies of the site after a
DA Translate (Smartling) rollout. Locales are `de fr es it pt pl ja ko zh-cn zh-tw`. Polish is
`pl-PL` in Smartling, but its folder is `/pl`.

The tools were first written in a session scratchpad on 2026-09-26/27, and a machine crash wiped
that scratchpad. Everything here was rebuilt from the session transcripts: the **final** version
of each script, including the later in-place patches, plus the term dictionaries and every
reviewed edit file that was applied to DA.

## Setup

- **Token.** `da.mjs` gets its token from `tools/tracker/lib/status-sheet.mjs` `resolveToken()`.
  It checks `DA_TOKEN`, then the cached S2S token, then `~/today-da-token.txt` /
  `~/today-auth-token.txt`. No tool ever prints the token. Keep it that way.
- **da-nx.** Only `simulate.mjs`, `pair-dump.mjs` and `finish-rollout.mjs` need it. They load
  DA's own loc code (`nx/blocks/loc/dnt/{parseQuery,decorateTable,dnt}.js`) from a local
  checkout of https://github.com/adobe/da-nx. That checkout is **not** vendored into this repo.
  - Set `DA_NX=/path/to/da-nx`. Without it, the default is `../../../da-nx` relative to this
    folder, which is a sibling of the repo checkout.
  - To get the checkout: `git clone --depth 1 https://github.com/adobe/da-nx`.
  - See `da-nx.mjs`.
- **Dry run by default.** Every tool that writes to DA does nothing unless you pass `--apply`
  (`publish.mjs` needs `--publish` to go live). A write always saves a DA version first, then
  re-reads the doc. If the etag changed in between, it refuses to write.

## Tools

| Tool | What it does |
|---|---|
| `da.mjs` | Shared helpers: DA source get/put/version/list/walk, jsdom `parse`, `blocks`, `versionedJsonEdit`, and admin.hlx.page `preview`/`publish`/`adminStatus`. |
| `link-heal.mjs` | Fixes the links in translated docs that the connector made absolute. See "Link rules" below the table. `node link-heal.mjs [--apply] /de/x … \| --tree /de,/ja` |
| `term-heal.mjs` | Puts do-not-translate brand terms back. It replaces each exact MT `rendering` with its English `term`, in text nodes only, longest first, for the doc's locale. `node term-heal.mjs data/dict-r1.json [--apply] /de/x … \| --tree /de,…` |
| `term-leaks.mjs` | Lists term leaks as JSON lines `{doc, loc, unit, term, en, tx}`. A leak is an EN text unit that contains a `dnt-content-rules` term while its translated unit does not. This is where new dictionary entries come from. `node term-leaks.mjs [--locales de,ja] /en/x …` |
| `check.mjs` | The canary diff: EN against each locale, block by block. It reports KEY, HREF, ENLINK, SHAPE, UNTX, MISSING and **TAXONOMY**. A TAXONOMY finding is a metadata value (other than title/description/og:title) or a tag/category/template/status cell that differs from EN, because taxonomy never goes to MT. The first output line is the count summary. `node check.mjs [--summary] [--locales …] /en/index /en/meetups …` |
| `edit-doc.mjs` | Makes exact text edits in ONE translated doc, in text nodes only. It refuses unless every `old` occurs exactly `count` times, and then it writes nothing at all. `node edit-doc.mjs /de/x edits.json [--apply]` with `edits.json` = `[{"old","new","count"}]` |
| `apply-edits.mjs` | Replays `data/edits/manifest.json` through `edit-doc.mjs`, one batch per doc, in order. It is a dry run unless you pass `--apply`. `node apply-edits.mjs [--apply] [--sets review-a,…] [--locales de,…] [/de/x …]` |
| `publish.mjs` | Previews a list of web paths, and with `--publish` also publishes them. It runs 4 lanes, and `/xx/index` is sent as `/xx/`. `node publish.mjs [--publish] /de/index /de/meetups/x …` |
| `smartling.mjs` | Shows read-only Smartling job and locale progress for a DA project, through the da-etc login and the translate.da.live proxy. It exports `smartlingSession()` → `{ get, getText }`. `node smartling.mjs <projectEpochMs>` |
| `make-project.mjs` | Builds a DA Translate project for EN paths, using the tracker's `tx-project.mjs` shape. It writes only with `--apply`. It never runs the connector: a person clicks Translate. `createdBy` is `aemdev-l10n@<host>`, or `L10N_CREATED_BY`. `node make-project.mjs <title> [--apply] /en/x …` |
| `project-status.mjs` | Prints a one-line status for a DA project. It exits 0 only when every language is `complete`, so you can use it in a wait loop. `node project-status.mjs <projectEpochMs>` |
| `simulate.mjs` | Runs DA's own custom-doc-rules engine on real source docs. It marks each block cell T (sent to MT) or - (protected). This is the best pre-flight for rule changes. `node simulate.mjs [--extra rules.json] [--blocks a,b] /en/index.html …` (needs da-nx) |
| `pair-dump.mjs` | Prints every block cell and default-content element of an EN doc (marked T/-), next to the same cell in each locale. Reviewers use it. `node pair-dump.mjs /en/x [de,fr]` (needs da-nx) |
| `mirror-config.mjs` | Rebuilds `.tracker/da-translate.json` from the live `/.da/translate.json`. It drops credential rows and keeps the `_comment`/`_why` annotations. `node tools/l10n/mirror-config.mjs .tracker/da-translate.json`, then `npm run tx:config -- --diff` |
| `finish-rollout.mjs` | Finishes a stalled rollout for one locale. It pulls the files from the completed Smartling job and saves them with da-nx `removeDnt`, the way the app would. It writes only the missing docs, unless you pass `--all`. It is a dry run unless you pass `--apply`. Do not run it unattended. (needs da-nx) |

**Link rules** (`link-heal.mjs`):

- An own-host `/en/x` link, absolute or relative, becomes `/<loc>/x` when that locale doc exists.
  Otherwise it becomes a relative `/en/x`.
- Redirects in `redirects.json` are followed first.
- A trailing slash is dropped when the slash-less page exists. Locale homes keep theirs.
- Any other own-host absolute link (`/tools/widgets/…`, `/fragments/…`, media) goes back to
  relative.
- Only `href` values change.
- The CLI accepts `--locales`, but it has no effect.

## Data

- `data/dict-r1.json` is the round-1 brand-term dictionary: the adversarially **approved** pairs
  from the canary QA workflow, 71 entries. Per locale:

  | de | fr | es | it | pt | pl | ja | ko | zh-cn | zh-tw |
  |---|---|---|---|---|---|---|---|---|---|
  | 5 | 11 | 7 | 5 | 5 | 4 | 5 | 7 | 11 | 11 |

- `data/dict-r2.json` is the round-2 dictionary, 173 entries. It merges the Latin and CJK builds.
  Five inflected Polish person-name forms are **dropped**: `Tada Reevesa`, `Tadem Reevesem`,
  `Grega Dimerisa`, `Markusa Haacka` and `Chrisem Millarem`. Swapping in the nominative breaks the
  Polish grammar. Per locale:

  | de | fr | es | it | pt | pl | ja | ko | zh-cn | zh-tw |
  |---|---|---|---|---|---|---|---|---|---|
  | 6 | 21 | 22 | 14 | 27 | 21 | 23 | 18 | 13 | 8 |

- `data/en-paths.txt` lists the 38 EN docs in the canary and rollout-1 scope: the 8 canary-1 docs
  (including the adaptTo page) and the 30 rollout-1 docs. It is the input for `check.mjs` and
  `term-leaks.mjs`.
- `data/edits/<set>/<loc>/<doc path with / → __>.json` holds one edit batch per doc. Each was
  applied with `edit-doc.mjs --apply` and returned `write 200`.
- `data/edits/manifest.json` maps each translated doc path to its ordered list of batches. It
  also carries per-set metadata. The sets:

  | Set | Docs | Edits | Scope |
  |---|---|---|---|
  | `review-a` | 51 | 170 | rollout-1 meetups batch A (6 pages) |
  | `review-b` | 41 | 121 | rollout-1 meetups batch B (5 pages) |
  | `review-frag` | 104 | 207 | rollout-1 bios and fragments. No zh-tw copies existed when these were reviewed. |
  | `chrome` | 28 | 50 | canary-1 nav header/footer, `/xx/meetups`, `/zh-tw/index`, tad-reeves bio |
  | `adaptto` | 10 | 248 | `/xx/meetups/adaptto-2026-berlin` |
  | `meetups2` | 20 | 259 | canary-1 washington-dc and 20260625 meetups |
  | `chips` | 3 | 3 | home-hero chip on `/ja`, `/zh-cn` and `/pl` index |

## Post-rollout pipeline (run after EVERY rollout or Get status)

```sh
L=/de,/fr,/es,/it,/pt,/pl,/ja,/ko,/zh-cn,/zh-tw
node tools/l10n/link-heal.mjs --tree $L                              # 1. relink (dry run; add --apply)
node tools/l10n/term-heal.mjs tools/l10n/data/dict-r1.json --tree $L # 2. round-1 terms
node tools/l10n/apply-edits.mjs                                      # 3. reviewed edits
node tools/l10n/term-heal.mjs tools/l10n/data/dict-r2.json --tree $L # 4. round-2 terms
node tools/l10n/link-heal.mjs --tree $L                              # 5. final link sweep
P=$(cat tools/l10n/data/en-paths.txt)
node tools/l10n/check.mjs $P                                         # gate: TAXONOMY/SHAPE/HREF = 0
node tools/l10n/term-leaks.mjs $P > leaks.jsonl                      # remaining brand leaks
node tools/l10n/publish.mjs [--publish] /de/index /de/meetups/x …    # then preview / publish
```

Run each step as a dry run first, then again with `--apply`.

**Order matters.** The reviewed edits (step 3) were written against docs that had already been
through steps 1 and 2. Many `old` strings contain terms that dict-r1 restores, such as "AEM
Global Developer Collective", "Document Authoring" and "Tad Reeves". On a freshly overwritten doc
those batches refuse until dict-r1 has run.

This was checked on 2026-09-27 against the live DA state. The steps were simulated in memory,
read-only:

- All 196 rollout-1 batches (`review-a`, `review-b` and `review-frag`) match exactly after dict-r1.
- The canary-1 sets (`chrome`, `adaptto`, `meetups2` and `chips`) are still applied in DA. Their
  batches refuse with "found 0", and that is expected.

A refused batch writes nothing, so re-running the pipeline is safe.

## Known traps

- **DA rollout absolutizes links.** On rollout, da-nx `resetHrefs` rewrites relative links to
  `https://main--aemdev--aemgdc.aem.page/...`. Every translated doc then links to the `.page`
  host and to `/en/`. `link-heal` undoes this, so run it after every rollout.
- **`dnt-content-rules` do nothing in the browser.** DA's content-rule wrapper breaks in the
  browser (`XPathResult._value`), so every "protected" term goes to MT anyway. That is why the
  term dictionaries and `term-heal` exist. Custom **doc** rules (block/column rules) do work, and
  `simulate.mjs` shows exactly what they protect.
- **Get status re-saves ALL languages.** Clicking Get status in the Translate app re-downloads and
  **overwrites every language's docs** in the project, not only the missing ones. The "Rolled
  Out" version is taken after that write, so it is not a pre-overwrite restore point.
  - Every heal and reviewed edit on those docs is lost. Re-run the whole pipeline.
  - This happened to rollout-1 (project 1790464599116) after 2026-09-27 ~06:00Z. Its docs are
    back to raw MT, with absolutized links and term leaks.
  - zh-tw now has all 30 docs. The 22 zh-tw docs that were missing at review time have never
    been reviewed, so no edit batches exist for them.
- **Tokens are never printed.** Not in logs, error messages, or files. The Smartling access token
  from `smartling.mjs` stays in-process. Project JSON under `/.da/translation/` holds the
  Smartling secret in `options.service`, so never preview or publish a project doc.
- **Taxonomy never goes to MT.** Tags, categories, template and status must stay byte-identical
  to EN. `check.mjs` TAXONOMY must be 0 before you publish.
- **Trailing slashes 404.** On this site `/x/` 404s when `/x` is a page. Only locale homes (`/de/`)
  keep the slash. `publish.mjs` sends `/xx/index` as `/xx/`.
- **Edits are exact.** `edit-doc.mjs` matches escaped text-node content only, never attributes or
  markup. A string split by inline markup cannot be matched.
- **Code bus.** `tools/` is not in `.hlxignore`, so these scripts and `data/` are publicly
  readable on the code bus. They contain nothing secret. The data is published site content.
  Keep it that way.

## Not captured as data

- Some one-off writes from the session live only in DA history. They are:
  - the `/xx/meetups` insights filter (`Category|Meetup Recap` → `template|meetup`, also fixed in
    EN)
  - two adaptTo related-link slugs, also fixed in EN
  - the EN footer trailing slashes
  - config and term changes to `/.da/translate.json`, which are mirrored by
    `.tracker/da-translate.json`
- The EN-side fixes survive a re-rollout.
