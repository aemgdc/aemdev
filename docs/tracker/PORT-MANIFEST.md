# PORT MANIFEST — aemdev.org QA & Translation Tracker

**Source:** `/home/tad/git/sasaem/migration-status` (org `sasaem`, repo `migration-status`; content site `sas-institute-corp/sas-da`)
**Target:** `/home/tad/git/aemgdc/aemdev-tracker` (worktree of `/home/tad/git/aemgdc/aemdev`, branch `tracker-app`; org `aemgdc`, repo `aemdev`, branch `main`)

**The single most consequential structural difference:** the source has **two DA sites** (`STATUS_SITE = sasaem/migration-status` for the tracker, `PUBLISH = sas-institute-corp/sas-da` for the content). The target has **one** — `aemgdc/aemdev` is both the content site and the tracker host. Every place the source distinguishes `STATUS_SITE` from `PUBLISH` collapses to one pair, and the tracker's pages and feeds must be hidden inside a live public site rather than isolated behind a separate site's auth. That is why requirement 4 (`/tracker/` noindex tree) exists, and it drives Section E.

Confirmed against the target worktree: `playwright ^1.58.2`, `jsdom ^29.1.1`, `sharp ^0.34.5`, `form-data`, `node-fetch` are already dependencies; **`puppeteer` is not**. `.agents/skills/diff/scripts/{visual-diff,diff-profiles,content-diff}.mjs` already exist in the target at an **older revision** (292 lines vs the source's 370; no `live-session.mjs`).

---

## A. File-by-file port table

Naming conventions adopted throughout (justified in E):

| source concept | target |
|---|---|
| `scripts/migration-*.js` | `scripts/tracker/*.js` (**`.js`, never `.mjs`** — see A.9) |
| `tools/migration/` | `tools/tracker/` |
| `.migration/` | `.tracker/` |
| `/content-groups/*.json` | `/tracker/data/*.json` |
| `/qa-status/<path>` | `/tracker/qa/<path>` |
| `/lang-status/<locale-path>` | `/tracker/tx/<locale-path>` |
| `tools/qa-signoff` + `tools/language-rollout` | `tools/page-tracker` (one merged app) |
| env `SAS_QA_*` | env `AEMDEV_QA_*` |

### A.1 Shared model modules (browser + Node, zero-dep, DOM-free)

| source | target | verdict | reason |
|---|---|---|---|
| `scripts/migration-stages.js` | `scripts/tracker/stages.js` | **REWRITE** | Keeps `classify()`'s exact shape (`{stage,order,queues,blocked,warnings}`), evaluation-order contract, flag-appended-on-every-exit-path rule, ingest-gate pair, `productionStage()`/`productionOrder()` regression guard, `sheetRows`/`sheetTabs`, `empty*Counts()`. All six vocabularies get new members (Section C). |
| `scripts/migration-language.js` | `scripts/tracker/locales.js` + `scripts/tracker/detect.js` | **ADAPT (split)** | 1200+ lines doing three jobs. `LOCALES`/`TARGET_LOCALES`/`locale()`/`localeForPath`/`pathForLocale` → `locales.js` (new 10-locale registry). `detectLanguage`/`languageVerdict`/`WORD_WEIGHTS`/`SIGNATURES`/`evidence()`/script gate/`extractNumbers`/`spelledOut`/`QUOTE_CONVENTIONS` → `detect.js`, **ported verbatim minus the SAS brand terms** — the script gate, the `1/(langs containing word)` weighting, the `evidence()` guard and the `margin × strength` confidence split are the most valuable code in either repo. `classifyLanguage()` → `classifyTranslation()` in `stages.js`. |
| `scripts/migration-paths.js` | `scripts/tracker/paths.js` | **REWRITE** | Mechanisms survive (`canonicalNewPath`, `resolveLanguageCode`, `branchFromPreviewUrl`, all link builders, branch lower-casing, `main` default). `SOURCE_HOST`, `PUBLISH`, `STATUS_SITE`, `IA_RULES`, `LOCALE_RULES`, `isUsableNewPath`, `migratedPathFromSource`, `newPathFromSource` all go (Section B). |
| `scripts/migration-data.js` | `scripts/tracker/data.js` | **ADAPT** | Keep the per-path promise cache, `clearDataCache(path?)` test seam, `loadRollup()`/`loadGroup()` tolerance defaults, `rowsForQueue`/`rowsBlocked`/`slugOf`/`links`. Re-point `/content-groups/` → `/tracker/data/`. Drop `loadFormsRollup()`. |
| `scripts/migration-subgroups.js` | `scripts/tracker/subgroups.js` | **PORT-AS-IS** | Zero SAS strings. Rename import specifier only. |
| `scripts/qa-notes-doc.js` | `scripts/tracker/qa-doc.js` | **ADAPT** | Keep `buildQaNotesHtml`/`readQaNotesDoc`/`applyQaVerdict`/`applyContentEscalation`/`serializeQaNotesDoc`, the caller-supplies-`Document` contract, the visible-line-vs-metadata dual write and its per-field precedence, `EMPTY_ISSUE` being exported, `legacy` vs `mismatch`. Drop `applyFormQaVerdict` + all `form-*` metadata keys. Section headings change (Section C). |
| `scripts/lang-notes-doc.js` | `scripts/tracker/tx-doc.js` | **ADAPT** | Same as above for the translation-review doc. Sections become `Preview Check` / `Translation Findings` / `Layout Findings` / `Reviewer Notes` / `Translation Review Log`. |
| `scripts/forms-model.js` | — | **DROP** | Forms subsystem. aemdev.org has no form census. |
| `scripts/migration-scope.mjs` | `tools/tracker/lib/scope.mjs` | **ADAPT** | The `SCOPE: <col> in a,b` grammar is generically useful for `--where=` selectors. Node-only; must stay unreachable from any browser entry point. |
| `scripts/migration-slug.mjs` | `tools/tracker/lib/slug.mjs` | **ADAPT** | Node-only slug helpers. |
| `scripts/migration-translation.mjs` | — | **DROP** | Entirely SAS: `SAS_STATUS_SCOPE`, `MIGRATION_SCOPES`, `NO_TRANSLATION_TIERS`, `lang-class GLOBAL/LOCAL-ONLY`, `fansOut()`. Replaced by a one-line rule: every page in a tracked group fans out to all 10 locales. |
| — | `scripts/tracker/README.md` | **NEW** | States the `.js`-not-`.mjs` rule and the zero-dep/DOM-free contract at the directory root. |

### A.2 Judge-dredd pipeline (requirement 1)

| source | target | verdict | reason |
|---|---|---|---|
| `tools/migration/structural-qa.mjs` | `tools/tracker/structural-qa.mjs` | **ADAPT** | Core check battery (headings/text/images/links/blocks/icons/metadata), the `.plain.html` derivation `replace(/\/$/,'/index') + '.plain.html'`, exit codes `{pass:0,fail:1,review:2}?? 3`, `report.fatal`→3, `loadBaseline()` export, heading fallback order. **Remove:** `template === 'press-release'` caption gate, `extractTitleShelf`, `foldName`/`nameTokens` SAS customer-name folding, `shelf` check. Repurposed: "source" becomes the **EN page**, "migrated" becomes the **translated page** (Section C). |
| `tools/migration/judge.mjs` | `tools/tracker/judge.mjs` | **ADAPT** | Keep `VERDICT_SCHEMA`, the in-place report rewrite, `--tier=`, `LlmUnavailable → exit 2`, the merge rule, `loadRequirements()`/`filterBrief()`/`isAuditMode()`, the `SYSTEM_AUDIT` confidence plea. **Remove:** `cleanSourceText`'s `About SAS` truncation, `APPROVED_ISSUE_PATTERNS['customer-story']` (11 suppressions), every SAS block regex in `cleanMigratedText`, the Brightcove branch. **Fix while porting:** normalize `confidence` (live reports carry `95` against a 0..1 schema) and either gate on it or delete the header claim. |
| `tools/migration/lib/llm.mjs` | `tools/tracker/lib/llm.mjs` | **PORT-AS-IS** | Zero SAS content. `node:http`/`node:https` instead of `fetch` (undici's unraisable 300 s `headersTimeout`), one wall-clock timeout, openai + ollama dialects, `reasoning_content` fallback, retry-once + fence-strip, `LlmUnavailable` vs plain `Error` distinction, `probe()`. Add the `callVision(tier, images, prompt)` helper the source never extracted. |
| `tools/migration/config.mjs` | `tools/tracker/config.mjs` | **ADAPT** | Keep the four-layer merge (`DEFAULTS` → `.tracker/orchestrator.json` → `.tracker/hosts/<hostname>.json` → env), `deepMerge` array-replace/null-falls-back semantics, `REPO_ROOT` resolution of `cfg.state.*`, and the stated invariant that a host profile may tune transport but **never** `qa.maxTextWords`/`qa.wordRatio`. Replace `map.sourceHost`, `map.pathRules`, `publish`, `locales`, `statusSheets`, `formsSheet`, `qa.userAgent`, and all 7 `SAS_QA_*` names. |
| `tools/migration/driver.mjs` | `tools/tracker/qa-driver.mjs` | **REWRITE** | Loop shape, ledger mechanics, skip rule, `--limit`/`--force`/`--no-judge`, `validateOnly ?? host.role==='validator'`, pairs-file grammar, slug derivation, tool-error report shape, end-of-run rollup+escalations calls all survive. But the work queue changes from "rows at `ready-for-ingest`" to "(page, locale) pairs at `sent` with a preview present", and `deriveMigrated` becomes `deriveTranslated` (Section C). |
| `tools/migration/lib/extract.mjs` | `tools/tracker/lib/extract.mjs` | **ADAPT** | DOM extraction is reusable. **Remove:** the `\s*\|\s*SAS\s*$` title-suffix strip, `SHARE_LINK` regex, `extractTitleShelf`, all AEM-6.5 parsys knowledge. |
| `tools/migration/lib/requirements.mjs` | `tools/tracker/lib/requirements.mjs` | **ADAPT** | Keep `REQUIREMENTS STATUS:` / `SCOPE:` / `Golden master:` markers, `MIN_WORDS=12`, `requirementsReadiness()`, `judgeBrief()` returning **only** the QA section, heading-level preservation, `unmatched` reporting, `REQ_MARKER_READINESS`. **Rewrite `REQ_SECTIONS`:** `Requirements from SAS` → `Content Requirements`; keep `Architect-Provided Requirements` → `Implementation Requirements`; keep `QA Requirements` (`forJudge: true`). |
| `tools/migration/lib/status-sheet.mjs` | `tools/tracker/lib/status-sheet.mjs` | **ADAPT** | Keep the DA multipart write, `If-Match` optimistic locking, the **Cloudflare `W/` weak-validator strip** (without it every conditional write 412s), the preview-after-write returning `previewed`/`previewError` rather than fire-and-forget, `resolveToken()` order. Replace `TOKEN_FILES` paths and `updateProductionStatus`'s column names. |
| `tools/migration/lib/qa-notes.mjs` | `tools/tracker/lib/qa-doc-io.mjs` | **ADAPT** | Node-side create-if-missing + write of the per-page doc via `jsdom`. Re-point to `/tracker/qa/`. |
| `tools/migration/lib/content-group.mjs` | `tools/tracker/lib/group-sheet.mjs` | **REWRITE** | Keep the three-ownership-band concept, `emptyGroupDoc()` creating locale tabs up front (da.live collapses a one-tab sheet on save), `LOCALE_PRESERVED`, additive-only column policy. `DATA_COLUMNS` and `LOCALE_COLUMNS` are wholly new (Section C). |
| `tools/migration/lib/group-map.mjs` | `tools/tracker/lib/group-map.mjs` | **REWRITE** | `GROUP_BY_CONTENT_TYPE` (23 SAS content types), `SNOWFLAKES` fallback, `LEGACY_TEMPLATE_KEYS` all go. New mapping is **path-prefix + `template` metadata**, not a spreadsheet column (Section D). |
| `tools/migration/lib/dnt.mjs` | `tools/tracker/lib/dnt.mjs` | **ADAPT (defer)** | Only if aemdev.org gets a Smartling/DA-loc connector with `.da/translate`. Port the **safety asymmetry verbatim** — an unparseable rule *throws*, because "no rule = everything translated" is the permissive default and degrading to it silently deletes content. Re-point `https://da.live/sheet#/sas-institute-corp/sas-da/.da/translate`. Flagged in F. |
| `tools/migration/appliance/llmctl.sh` | `tools/tracker/appliance/llmctl.sh` | **PORT-AS-IS** | `llama-server` launcher, three ports, the mandatory `--mmproj` for the VL model, `GET /health` loop. Only `$MODELS_DIR`/systemd unit names change. |
| `tools/migration/qa-reconcile.mjs` | `tools/tracker/tx-reconcile.mjs` | **ADAPT** | Keep — and keep the reason: it is the tool the `productionStage()` guard exists to protect (a reconcile silently downgraded 33 `visual-qa-pass` rows because `classify()` folds in `qa-status` and compared equal both ways). |
| `tools/migration/sync-qa-status.mjs` | `tools/tracker/sync-review-status.mjs` | **ADAPT** | Doc → sheet, **one-way, never clears**. Keep the shared-verdict-to-sibling-rows behaviour (in the new model a verdict is per (page, locale), so the fan-out is smaller but not zero). |
| `tools/migration/repair-product-links.mjs` | — | **DROP** | `<em><sup>®</sup></em>` unwrapping for "SAS® Viya® 4". |
| `tools/migration/da-ims.mjs` | `tools/tracker/lib/da-ims.mjs` | **PORT-AS-IS** | Cached S2S token. Generic. |

### A.3 Visual QA (requirement 1)

| source | target | verdict | reason |
|---|---|---|---|
| `tools/migration/language-visual.mjs` | `tools/tracker/tx-visual.mjs` | **ADAPT — highest-value file in the set** | Geometry-not-pixels is exactly right for translated pages: "every pixel containing text is different BY DESIGN". Keep `measureInPage()` (`lines` via `getClientRects().length`, `escapeRight`, `fixedH`), the translation-stable element key `s<i>/block<j>:<firstClass>`, the "worse than English" phrasing of every check (this is what stops re-reporting layout debt ten times), the return-to-top before comparing `y` offsets, screenshots only for flagged blocks capped at 4 re-found by key, `EXIT = {pass:0,fail:1,review:2}`, the machine-readable report, the `{severity,check,width,detail,key}` finding shape. **Change:** port from **puppeteer to playwright** (playwright is already a target dependency, puppeteer is not); set `DEFAULT_WIDTHS = [2360, 1280, 390]` — the source's 30-line comment justifies three widths and the array only has two; drop the `migration-language.js` import down to `{code,name}` from `scripts/tracker/locales.js`. |
| `tools/migration/visual-judge.mjs` | `tools/tracker/visual-judge.mjs` | **REWRITE** | Prompt construction and the side-labelling convention are worth keeping; the implementation is not. **Its documented exit contract is fiction** — `main()` prints prose and returns, so any gate shelling out to it passes unconditionally. Rewrite to request **JSON against a schema** (reuse `VERDICT_SCHEMA`) and honour `0/1/2/3`. Replace `execFileSync('python3', …PIL…)` cropping with **`sharp`** (already a target dependency; the Python path silently no-ops when PIL is missing). Replace `'LEFT = REFERENCE (live AEM 6.5 production site)' / 'RIGHT = MIGRATED (new EDS implementation)'` with EN/locale framing. Replace the "Start it on the Mule with `sudo systemctl start llm-vision`" error text. |
| `tools/visual-compare/compare.mjs` | `tools/tracker/visual-compare.mjs` | **ADAPT** | Only file in the visual set with a literal SAS URL (`LIVE_MAP`). Keep element-scoped `element.screenshot()` capture, the no-image-library stitching (two data-URI `<img>`s in a third headless page), the lazy-load scroll sweep, cookie dismissal, the lazy browser import that degrades with a message. **Fix the two documented defects:** `--mobile` mutates the viewport but never applies the documented 390px width, and `--out` is not width-namespaced so a second run overwrites `local-0.png`. Read the URL map from config, not the source file. Port to playwright. New role: EN-preview ↔ locale-preview or preview ↔ live drift. |
| `tools/visual-compare/README.md` | `tools/tracker/docs/visual-compare.md` | **ADAPT** | Its "Adding pages: edit the source" instruction and its 390px claim are both wrong; rewrite alongside the fixes. |
| `.agents/skills/diff/scripts/visual-diff.mjs` | `.agents/skills/diff/scripts/visual-diff.mjs` | **ADAPT (upgrade in place)** | **Already present in the target at 292 lines vs the source's 370.** The source revision adds `BotChallengeError` (exit 3), `gotoLive`, `newLiveContext` with `REAL_CHROME_UA` + full `sec-ch-ua`/`Accept-Language` (UA alone still returned 403 from Akamai), and the per-side `defaultWaitUntil()` (`networkidle` for localhost and `EDS_HOST_RE`, `domcontentloaded` elsewhere because analytics beacons never idle). Merge the source's delta into the target copy — do **not** create a second file. |
| `.agents/skills/diff/scripts/live-session.mjs` | `.agents/skills/diff/scripts/live-session.mjs` | **PORT-AS-IS** | Missing from the target. `visual-diff.mjs`'s upgrade depends on it. Only residual coupling is `EDS_HOST_RE`, which is correct for aemdev. |
| `.agents/skills/diff/scripts/diff-profiles.mjs` | (target copy) | **ADAPT** | Target already has it. Strip the `#36`/`#37`/`#65`/`#77` skill-finding numbers from the `eds` hints — meaningless outside the source repo. |
| `.agents/skills/diff/SKILL.md` | (target copy) | **ADAPT** | Delete the `npm i -D playwright --no-save` workaround prereq — playwright is a real dependency in the target. |
| `tools/migration/mark-visual-qa.mjs` | — | **DROP; re-implement the concept** | Explicitly flagged in the survey: "Do not port this file; port the concept against the new site's tracker." Pure `cfg.statusSheets[template]` + `source-url` row match + SAS status enum. Replaced by `tools/tracker/mark-tx-status.mjs`. |
| `.agents/skills/judge-dredd/SKILL.md` | `.agents/skills/tx-qa/SKILL.md` | **ADAPT** | The `✓ ~ ? ✗` glyph legend and the `JUDGE_MODE: audit` marker are hard code contracts (`filterBrief`, `isAuditMode`) — keep verbatim. All SAS page examples go. |
| `.agents/skills/judge-dredd/BRIEF-TEMPLATE.md` | `.tracker/qa-requirements/BRIEF-TEMPLATE.md` | **REWRITE** | Structure (Parts 1–5, ID columns `R1`/`S1`/`Q1`, Status column) stays. Every pre-populated row is SAS-page-specific (`R1` social share, `R3` "Request a Demo", `S1` `quote-customer-story`, `S3` `/en/fragments/customer-story-next-steps`, `Q7` product names). **Note the parser's brittleness before authoring:** it greps for a cell that is *exactly* `✓` or `~` — `✓ (see note)` will not match, `?`/`✗` rows are silently dropped, zero resolved rows yields `null` with no warning, and `filterBrief`'s skip logic is hardwired to `## Part 4 — Visual` with an em-dash. |

### A.4 Translation pipeline (requirement 2)

| source | target | verdict | reason |
|---|---|---|---|
| `tools/migration/language-qa.mjs` | `tools/tracker/tx-qa.mjs` | **ADAPT — the core auto-QA engine** | Tier 1. Keep: the three-parallel-fetch shape (`en.plain.html`, `locale.plain.html`, rendered locale page), skeleton alignment short-circuiting keys/DNT/markup/expansion, `cellFindings`, the **`dntViolation` vs `dntGap` distinction** ("a permissive contract cannot be violated; it has to be reported as the thing that is wrong"), `isKeyCell` conservatism, `leakedEnglishPaths` walking **both** prose paths and block-cell paths, `checkPaths` probing DA-not-aem.page for the localized counterpart with error-if-exists/warning-if-absent, `checkNumbers` on prose only, positional never-text-anchored findings, the three deliberately-collapsed finding shapes, and `textSample.pairs` with **all** its filter rules (the highest-value field; excluding block cells was a real bug). Exit `{pass:0,fail:1,review:2,error:3}`. **Change:** DNT becomes optional (F), `loadDntRules`'s hardcoded `org='sas-institute-corp', repo='sas-da'` parameter defaults must read config. |
| `tools/migration/language-judge.mjs` | `tools/tracker/tx-judge.mjs` | **ADAPT** | Tier 2. Keep the 5-step merge ladder — especially **step 4: judge `fail` with no quotable evidence becomes `escalate`, not `fail`** — plus `verifyQuotes` normalizing against the report's own `textSample` haystack, the error→warning downgrade with `[UNVERIFIED: … may be fabricated]` suffix, `quoteVerified: true|false|null`, the `quotedAs:'term-list'` branch, `suppressed[]` retention. **Rewrite `SUPPRESS`** — all 8 regexes are SAS block/brand vocabulary. **Rewrite `loadGlossary`** (`.tracker/qa-requirements/glossary.md` + `glossary-<code>.md`) with an aemdev DNT list. |
| `tools/migration/language-driver.mjs` | `tools/tracker/tx-driver.mjs` | **ADAPT** | Keep: **the work queue is the tree, not the sheet** (the first version created 164 review docs for 13 translated pages and would have written ~1,367 bogus escalations); the preflight refusals; `toLangStatus(status, report)` scanning **errors before warnings** deliberately; `stageFor()`; the **one batched conditional sheet write per run** with a single 412 re-read-and-reapply retry (7 of 9 writes 412'd running nine locales back to back); `--validate-only` touching no shared state; `langStatus` computed **before** the ledger write and persisted. Rename `toLangStatus` → `toTranslationStatus` to end the name collision with `language-scan.mjs`'s same-named function. |
| `tools/migration/language-scan.mjs` | `tools/tracker/tx-scan.mjs` | **REWRITE** | The crawl is the spine of the new model, but this file carries the worst debt in the source. Keep: token probe **before** crawling, the concurrency lanes, `tally()` defined once for both the locale row and the group drill-in, `--locale=` **merging** into the published rollup, the refusal to publish on any group-sheet fetch failure ("an understated denominator makes a locale look further along than it is"), `put()` treating a **failed preview as a failed publish**, the size ceiling note (1,301 rows / 685 KB was rejected by the content bus). **Fix:** the F8 shadowing bug — the locale row spreads `{...tally(pages), expectedRows, ...stage, ...queues}` so `stage.langOk`/`stage.blocked` shadow `tally.langOk`/`tally.blocked` while group rows spread `...t` only, giving one column two definitions in one table. **Delete:** its duplicate marker-reader regexes and its second `MARKER_TO_STATUS` table — use the exported `langStatusFromDocText`. **Extend:** must now crawl **two** trees per locale (preview + live) to observe the `previewed` and `online` states. |
| `tools/migration/lang-preview.mjs` | `tools/tracker/tx-preview.mjs` | **PORT-AS-IS (retarget)** | Existence-vs-preview is the whole reason it exists and the reason applies identically to any connector that writes into DA and stops. Keep: `isPreviewed` HEADing the **rendered** URL not `.plain.html`; `--publish` sequenced **after** a successful preview; the already-previewed check **skipped entirely** under `--publish` (the first version left 9 German fragments unpublished while publishing 72); concurrency 6, retry on 429/5xx only. |
| `tools/migration/lang-heal-links.mjs` | `tools/tracker/tx-heal-links.mjs` | **ADAPT** | 109/109 documents carried both defects, and both recur on any DA-loc rollout. Keep: exactly two mechanically-provable rewrites, **only inside `href`/`src` attribute values** so prose can never be altered; the branch-agnostic self-host strip with the `(?=/)` lookahead; `/en/` → `/<locale>/` **only after confirming the target exists in DA**; dry-run default; a DA version cut per document before its write; read-verify-write. Keep the stated framing: **the tool is the cleanup, not the fix.** Drop the `www.sas.com/en_us/` whitelist. |
| `tools/migration/publish-language-reports.mjs` | `tools/tracker/publish-tx-reports.mjs` | **ADAPT** | Keep `publishable()` stripping the two prose blobs and the full `checks` block, and keep the reason — **anything published under the tracker tree is public once previewed**, which is *more* true in the target (one site, no site auth) than in the source. Keep best-effort-never-fails-the-run. |
| `tools/migration/scaffold-locale-sheets.mjs` | — | **DROP** | Superseded by `finalize-group` in the source itself. |
| `docs/language-qa-process.md` | `docs/tracker/tx-qa-process.md` | **ADAPT** | Keep the retired-locale-tabs reasoning and the "seam" section; it is the only place the single-machine-ledger dependency is written down. |

### A.5 Group / list management (requirement 3)

| source | target | verdict | reason |
|---|---|---|---|
| `tools/migration/scaffold-content-group.mjs` | `tools/tracker/scaffold-group.mjs` | **ADAPT** | Keep kebab-case validation, `emptyGroupDoc` with locale tabs up front, create-if-missing refusing to clobber, `--force` only on a zero-real-row sheet, printing the registry JSON to paste. |
| `tools/migration/finalize-group.mjs` | `tools/tracker/finalize-group.mjs` | **ADAPT** | Keep `buildLocaleDoc()` re-emitting a clean multi-sheet (repairs a da.live-collapsed sheet), idempotency, status preservation. Drop `normalizeNewPath`/`applyIaRules` — the target has no IA restructure. |
| `tools/migration/upgrade-columns.mjs` | `tools/tracker/upgrade-columns.mjs` | **PORT-AS-IS** | Additive column upgrade on an existing sheet. Generic and needed from day one. |
| `tools/migration/set-readiness.mjs` | `tools/tracker/set-en-status.mjs` | **ADAPT** | Keep the closed vocabulary, the selectors (`--all`, `--from=` where blank is a real selector, repeated `--url=`), skip-rows-already-worked unless `--include-worked`, dry-run default, the shared writer lock. |
| `tools/migration/set-subgroup.mjs` | `tools/tracker/set-subgroup.mjs` | **PORT-AS-IS** | Keep all **three deliberate refusals**: an unmatched `--url=` is an error not a no-op; a `--where=` naming a missing column refuses the run (a missing column reads `''`, so `subgroup != X` would select every row); `--to` has no default so no run can blank the column. Keep the non-slug `--to` refusal that prints the slug rather than rewriting. |
| `tools/migration/move-row.mjs` | `tools/tracker/move-row.mjs` | **ADAPT** | Keep verbatim-column moves and the refusal to move a row the group-assigner would route straight back. |
| `tools/migration/work-queue.mjs` | `tools/tracker/emit-pairs.mjs` | **ADAPT** | Keep "only gate-passed rows" and the inspectable/committable pairs artifact, plus `--requeue=<reason>` writing a manifest beside it. Emits `<en-url>,<locale-url>` pairs now. |
| `tools/migration/scaffold-requirements.mjs` | `tools/tracker/scaffold-requirements.mjs` | **ADAPT** | Keep checking **both** doc layouts before creating (so a legacy flat doc gets no competing sibling) and the preview-after-create. Keep the warning that an empty DRAFT DA doc **shadows** a good local brief for the judge. Add the `--scope` flag the source lacks. |
| `tools/migration/list-ingest.mjs` | — | **DROP** | Reads `docs/xls/Final Migration List <date>.xlsx`, tab `Full Migration List FINAL`, cols A–J. There is no inbound spreadsheet for aemdev.org. |
| `tools/migration/list-apply.mjs` (`list:plan`/`list:apply`) | `tools/tracker/sync-groups-from-index.mjs` | **REWRITE** | Same *job* — reconcile an authoritative page list into the DA group sheets, never deleting, marking off-list rows via `list-status` — but the authoritative list is now **`/en/query-index.json` + `/bios.json`**, not an xlsx snapshot. Keep the three-band refresh/preserve contract. |
| `tools/migration/build-rollup.mjs` | `tools/tracker/build-rollup.mjs` | **ADAPT** | Keep: token resolved **once** up front (missing token is one hard failure, not 23 per-group 401s), reading **DA source not the published copy**, per-group failure = warning but all-groups-failing throws, `summarize()` shared by group and subgroup rows, `readiness()`, both invariant assertions exiting non-zero (`ingesting + qaReady + qaOkCount === ingested <= ingestReady <= requirementsComplete <= total`, and per-column subgroup sums), the `meta` sheet for the timestamp (a bare top-level key is rejected by the content bus), no leading underscore in the path. |
| `tools/migration/build-escalations.mjs` | `tools/tracker/build-escalations.mjs` | **ADAPT** | Keep the ledger-as-source-of-truth-for-who, jsonl-last-line-for-detail, `attempts` desc sort, `problemLine` heterogeneous formatter, and **the nested read `report.judgement?.judge?.issues`** (reading it as `judgement.issues` returned an empty list with no error). **Fix F6:** replace `groupOf()`'s two hardcoded SAS URL segments with the real group resolver, and stop emitting singular template keys where every other surface uses the group name — that mismatch makes `escalation-list`'s and `work-queue`'s `group` values mutually incompatible and every non-PR/non-customer escalation unfilterable. |
| `tools/migration/watch-rollup.mjs` | `tools/tracker/watch-rollup.mjs` | **PORT-AS-IS** | 20 s poll, republish only when the doc minus `meta.generatedAt` changed. |
| `tools/migration/build-forms-rollup.mjs` | — | **DROP** | Forms subsystem. |
| `tools/migration/scaffold-forms-page.mjs` | — | **DROP** | Forms subsystem. |
| `tools/importer/import-customer-story.mjs` | — | **DROP** | SAS importer. |
| `tools/importer/lib/company-name.mjs` | — | **DROP** | SAS AEM DOM knowledge: `.titleshelf`, `ol[itemtype*="BreadcrumbList"]`, `h1 .xsmall-txt-light` eyebrow split on `•`, `.cite-company`, `LOGO_NOISE`. |
| `tools/importer/da-ingest.mjs` | — | **DROP** | AEM 6.5 → EDS ingest. The target has its own `tools/importer/` for WordPress. |
| `.migration/import-processes.json` | — | **DROP** | Two SAS importers with `urlPattern` regexes against `www.sas.com`. |
| `.migration/urls/*` | — | **DROP** | `pairs-<template>.txt`, `*-rejudge.txt`, `customer-story-company-names.json`, `edge-153-*.json`. |
| `.migration/source-list/*` | — | **DROP** | xlsx snapshots. |
| `.migration/forms/census-*.json` | — | **DROP** | Forms census. |

### A.6 EDS tracker pages / blocks (requirement 4)

All new blocks follow the target's convention exactly: `blocks/<name>/<name>.js` + `.css`, default export receiving the block element, `classList[0]` is the name, config read as key/value `:scope > div` rows with an allow-list of keys, no layout measurement in `decorate()` (sections are `display:none`), flat `.<block>-<part>` CSS, tokens from `styles/styles.css` (`--aem-red`, `--carbon`, `--spacing-*`, `--mono-font-family`), no dark-scheme blocks, `border-radius: 0`, modern color notation and range media queries for stylelint.

| source | target | verdict | reason |
|---|---|---|---|
| `blocks/migration-summary/*` | `blocks/tracker-summary/*` | **ADAPT** | KPI tiles + stacked funnel bar + escalation strip + provenance stamp is the right home screen. Drop the entire Forms band and its `.catch(() => null)` optional second fetch. Fix F7 (`${t.total} on ${t.total} pages`). |
| `blocks/translation-matrix/*` | `blocks/translation-matrix/*` | **ADAPT — closest to purpose-built** | Keep: two bars per locale (thin **coverage** meter with a CSS pixel minimum, full-width **progress** stack over the translated subset only), the lazy per-group disclosure, the legend + provenance + methodology prose, and above all **the stage vocabulary travelling with the data** (`stages`/`queues` tabs) so the block cannot drift from the model module. Fix F2 (`LANG_APP` hardcoded inline), F9 (the `lang-rollout` chip links to `filter=dnt`, a queue that does not exist), F17 (rolls its own `fetch`, bypassing the memoised data layer). |
| `blocks/group-readiness/*` | `blocks/group-progress/*` | **ADAPT** | Keep the real `<table>`, `<b>n</b><span>/total</span>` ratio cells with % titles, biggest-first sort, `—` at zero for Escalated (deliberately blank so the eye does not learn to skip it), the caret only when `subgroups > 0` expanding **sibling `<tr>`s of the same table**, and the footer notes. Fix F1 (`ORG`/`SITE`/`QA_APP` consts) by importing from `scripts/tracker/paths.js`. |
| `blocks/work-queue/*` | `blocks/work-queue/*` | **ADAPT** | Keep reading the **live group sheet** rather than the rollup (so an edit shows on reload), `data-status` badge from the raw stored value, the three deep links, and the empty state. Fix F5 (`group = 'press-releases'` default) — new default `technical-articles`. |
| `blocks/escalation-list/*` | `blocks/escalation-list/*` | **ADAPT** | Keep the cards-with-actual-defects shape, `problems` split on `\n`, the "No recorded detail (judge was uncertain)." fallback, `limit` + "Showing N of M." Fix F3 (hand-built duplicate of `qaNotesBrowseLink()` hardcoding org, repo **and** the notes base), F16 (`meta.generatedAt` read and never rendered — the one page with no provenance stamp), F17. |
| `blocks/status-primer/*` | `blocks/status-primer/*` | **ADAPT** | Rendering the primer **from the model with no data fetch** is exactly right for a page business users are told to trust. Sections become `en`, `translation`, `review`, `queues`, `path`. Fix F10 — it inlines a duplicate of the private `READINESS_STAGES` map, so a new stored value shows with a blank Position on the one page that must not drift. Export the map instead. |
| `blocks/data-quality/*` | `blocks/data-quality/*` | **ADAPT (phase 4, optional)** | Rule/severity/owner triage board is generic and useful (missing bios, stale `template` meta, trailing-slash 404s, pages absent from the index). The `RULE_HELP` map and every rule id are SAS-list-specific and get rewritten. Fix F4 (`www.sas.com` strip, hardcoded sheet link). |
| `blocks/forms-summary/*` | — | **DROP** | Forms subsystem. |
| `blocks/forms-matrix/*` | — | **DROP** | Forms subsystem. |
| — | `blocks/tracker-summary`… (all above) | **NEW: shared helpers** | Fix F18 while porting: `readConfig()` is copy-pasted verbatim into six blocks and `const el = (tag, cls, text) => …` into six. Extract both to `scripts/tracker/block-utils.js` once. |
| `scripts/scripts.js`, `scripts/ak.js`, `scripts/postlcp.js`, `scripts/lazy.js` | — | **DROP (use target's)** | The target's own AK loader is authoritative and diverges (two-wrapper section DOM `block-content`/`default-content`, no `.block`/`-wrapper`/`data-block-status`, `linkBlocks` with spotify, `applyTemplateByPath`, `templatedSections`). **Do not style against the source's section DOM.** |
| `head.html`, `styles/styles.css`, `img/favicons/sas.svg` | — | **DROP (use target's)** | Target `head.html` already loads Barlow Condensed / Inter / Space Mono, `/styles/styles.css` + `/styles/sections.css`, `/img/favicons/favicon.svg`. Never introduce `--sas-navy`, `#0766D1`, or `--qa-accent`. |
| `helix-query.yaml` | — | **DROP** | Untouched boilerplate indexing `/blog/**` and `/author/**` in the source (F14); the target's root `helix-query.yaml` and `config/query.yaml` are **both stale** — only `config/sites/aemdev/query.yaml` deploys. |

### A.7 DA app (requirement 5) — "Page Tracker"

The Page Tracker is **one app** that is a subset of `qa-signoff` plus the parts of `language-rollout` the translation lifecycle needs. Entry HTML sits **beside** the directory, per the target's convention (`tools/<name>.html` + `tools/<name>/`).

| source | target | verdict | reason |
|---|---|---|---|
| `tools/qa-signoff.html` | `tools/page-tracker.html` | **ADAPT** | Keep the ~30-line shell and **both critical decisions**: (a) it is deliberately **not** an EDS page — `/styles/styles.css` must **not** be linked, because that stylesheet's `header{display:none}` / `main > div{display:none}` contract hides the entire app UI; (b) the SDK is loaded **twice on purpose**, once from the document and once via `import DA_SDK`, because DA posts the init message within ~750 ms and a listener registered after it never resolves. |
| `tools/qa-signoff/qa-signoff.js` | `tools/page-tracker/page-tracker.js` | **ADAPT** | Keep the boot sequence and its ordering (`await DA_SDK` → `initDaSource(actions)` → `actorFrom(token, context)` → query params → rollup fetch → `buildShell` → `aria-busy=false` → load), the JWT decode used **only** for audit attribution and never to gate (a decode failure never blocks a save), the whole-boot try/catch rendering an actionable error, and the query-param validation posture: an invalid value is **never assigned blind**, and a `sub-group` naming nothing falls back to all pages **and says so on the counts line**. Add the target's dual-surface probe (`state.isPlugin = typeof actions?.sendHTML === 'function'`, `document.body.classList.add('is-plugin')`) so it can also run as a sidekick library plugin. |
| `tools/qa-signoff/da-source.js` | `tools/page-tracker/da-source.js` | **ADAPT — port the reasoning, not just the code** | Keep both asymmetries verbatim: reads come from `admin.da.live/source` (authoritative) **not** the published `.aem.page` JSON (which lags an un-previewed write, so a read-write app would show its own edits as stale); and **the app never writes a group sheet** (a sheet write POSTs the whole multi-sheet doc back, clobbering concurrent reviewers and any pipeline write mid-batch — the pipeline stays the single sheet writer, the sheet column is derived by `sync-review-status`). Keep the full write path: **re-read immediately before write** → `expectedVersion` conflict check → `If-None-Match: '*'` on create with a 412 meaning "take their doc and apply on top" → other 412 = conflict → POST preview (**failure downgrades the message, never fails the save**) → **read back and `confirm()`** rather than trusting the 200. Keep the probed versioning table: on `.html` docs DA issues **no ETag**, so `If-Match` is unusable and `If-Unmodified-Since` is ignored; `versionOf = ETag || Last-Modified`. Keep `docForm()`/`filenameFor()` — the target's own bio-manager uses the identical `FormData` field named `data`, so this matches house style. Missing feeds return `[]`, not a throw. |
| `tools/qa-signoff/rows.js` | `tools/page-tracker/rows.js` | **REWRITE** | The *shape* survives: `attachVerdicts(pages, readDoc, {concurrency:8, onPage})` as a bounded shift-queue worker pool with `cancel()`/`remaining()` so the board paints from the sheet immediately and fills in progressively; **the doc wins** over the sheet column in `effective*Status()`, because the column is derived by a sync that may not have run; non-reviewable rows **withheld and counted** with the counts line saying why, never silently dropped; `localStorage` branch memory. The *content* changes wholesale: no `migratedPathFromSource` grouping, no source-row collision (SAS's locale collapse has no analogue — aemdev keeps identical slugs across locales, so path is a clean key), and the row unit becomes **(page, locale)**. **Fix the source's live asymmetry** while porting: `language-rollout.js:539` stores the branch under the *group* key while `rows.js:107` reads it under the *locale* key, so a typed branch is stored where it is never read. |
| `tools/qa-signoff/table.js` | `tools/page-tracker/table.js` | **ADAPT** | Keep the 5-column layout, `updateRow()` rebuilding a `<tr>` and `replaceWith`-ing it while preserving `.qa-row-selected`, `stopPropagation()` on the link cell, whole-row keyboard activation, the struck-through dead span for a missing href, and the quick-verdict button omitted entirely in readonly. Take the **tier chips** from `language-rollout/table.js` — three chips, **always all three, always in order**, `pass`/`fail`/`skip`/`pending` derived from the stored pipeline status alone. Take its richer empty state ("Pages are in: `<Filter (n)>` · …" as clickable filter buttons). Drop the `N sources` collision chip. |
| `tools/qa-signoff/drawer.js` + `tools/language-rollout/drawer.js` | `tools/page-tracker/drawer.js` | **REWRITE (merge)** | Take from the QA drawer: the recorded-verdict line with "no doc yet; saving will create one", the warnings section, **Pipeline findings merging both sources** (escalation feed + the doc's own issue sections, each labelled with its origin and count), the note-required-per-verdict rules, and above all **one busy gate across every write control** (`writeControls[] + setBusy()`) — gating them separately left two writes in flight against the same doc each passing the same `expectedVersion`, and the second POST silently discarded the first. Take from the language drawer: the **compact inline link row** (five stacked cards pushed the pairs below the fold), the Status `<dl>` with the stage **re-derived live** from the effective verdict rather than the stale sheet-derived value, findings **grouped by owner**, and the centrepiece — the aligned **EN → `<locale>` pair list** from `textSample.pairs` (first 60, identical pairs highlighted) so the reviewer sees exactly what the judge saw, with a "run `npm run tx:batch …`" message when no report exists. Drop the entire Form QA section. |
| `tools/qa-signoff/qa-signoff.css` | `tools/page-tracker/page-tracker.css` | **ADAPT** | Keep the grid (`.qa-layout` `1fr` → `minmax(0,1fr) minmax(22rem,34rem)` when open, stacked below 60rem), badge `data-status` hooks, tier chips, locale-selector styles. **Rebase every token onto the target's palette with a tool-local prefix** (`--pt-red`, `--pt-display`, `--pt-md`), duplicated from `styles/styles.css` on purpose — per the target's own bio-manager comment, the app must not pull the site stylesheet into DA's iframe. Fonts come from a Google Fonts `<link>` in `page-tracker.html`. |
| `tools/language-rollout.html` + `tools/language-rollout/*` | — | **DROP as separate app; harvest into Page Tracker** | Two apps against one lifecycle is the source's shape, not the target's need. The locale selector must come across, though: **a row of buttons, not a `<select>`** — ten locales progress independently and a dropdown hides nine of them along with their counts; empty locales still shown, dimmed; counts read from the published rollup so the app and the hub agree by construction. |
| `tools/app-harness.mjs` | `tools/tracker/app-harness.mjs` | **ADAPT — port early, not last** | Boots the app in real headless Chrome against a local `node:http` server and exits non-zero on any console error, uncaught exception, failed repo-file request, `.qa-error` text, <200 rendered chars, or zero rows. Mechanics to keep: the **importmap** remapping `https://da.live/nx/utils/sdk.js` → a local `SDK_SHIM`; request interception rewriting `admin.da.live` → localhost; **read-only by construction** (the local server answers only GET, 405 otherwise, so a write cannot reach production); fixtures pulled from **live** feeds and cached (hand-written fixtures drift and stop catching anything — every app failure in the source came from a real-data shape); per-page doc requests answered with a real minimal doc rather than a 404 so the verdict path actually runs. Port to **playwright** (already a target dep). Keep the stated limitation: it serves off disk, so a refused extension looks perfect here. |
| `tools/check-browser-modules.mjs` | `tools/tracker/check-browser-modules.mjs` | **PORT-AS-IS** | See A.9. Keep entry-point **discovery** (everything under `blocks/`, plus any file matching `/from\s+['"]https:\/\/da\.live\/nx\/utils\/sdk\.js['"]/` — importing the SDK is the one thing every DA app does and no Node tool does), the real relative-import graph walk including dynamic `import()`, both invariants, the `browserGraph()` export, and the `invokedDirectly` guard so importing it does not `exit(1)`. |
| `tools/check-deployed-modules.mjs` | `tools/tracker/check-deployed-modules.mjs` | **PORT-AS-IS** | Fetches every module in that graph from **both** hosts. Checking one produces false confidence. |
| `test/scripts/qa-rows.test.js`, `test/scripts/qa-drawer.test.js` | `test/tools/page-tracker/{rows,drawer}.test.js` | **ADAPT** | Target uses `@esm-bundle/chai` + mocha globals + web-test-runner, same as source. Follow the target's exported-parser convention (`blocks/bio/bio.js` exports `parseBio`/`buildBio` for exactly this). |
| `docs/qa-signoff-app.md`, `docs/language-rollout-app.md` | `docs/tracker/page-tracker-app.md` | **ADAPT (merge)** | The probed DA versioning table lives here and nowhere else. |
| `docs/branch-testing.md` | `docs/tracker/branch-testing.md` | **PORT-AS-IS** | The two-host reasoning and post-merge procedure. |
| `docs/status-model.md` | `docs/tracker/status-model.md` | **REWRITE** | Becomes the translation-lifecycle spec (Section C is its outline). |
| `docs/QA-PROCESS.md`, `docs/customer-stories-qa-run.md` | — | **DROP** | SAS run logs. The `desktop + ~2360 + 390` width policy is the one thing worth carrying, and it belongs in `tx-visual.mjs`'s defaults. |

### A.8 Config & state

| source | target | verdict | reason |
|---|---|---|---|
| `.migration/orchestrator.json` | `.tracker/orchestrator.json` | **REWRITE** | New `publish`, no `map.pathRules`, 10 locales, 4 group entries instead of 23 `statusSheets`, no `formsSheet`. Keep `$comment` keys as inline docs and `escalation.maxAttempts` — but note nothing in the source ever **reads** it (`attempts` is incremented, never compared); either wire it or delete it. |
| `.migration/hosts/{fw13-ubuntu,tad-zbook}.json` | `.tracker/hosts/<hostname>.json` | **ADAPT** | Same shape. `role: 'writer'|'validator'` is what makes the driver default to `--validate-only`; keep it. Drop the SAS machine labels ("The Mule"), the `192.168.12.109` ssh block and the `~/git/sasaem/migration-status` repo path. |
| `.migration/qa-baselines/{customer-story,press-release,customers-index}.json` | `.tracker/qa-baselines/{technical-articles,meetups,bios,indexes}.json` | **DROP files, PORT format** | Keys survive (`comment`, `allowMissingHeadings`, `headingsNeverFail`, `wordRatio{failMin,warnMin,warnMax}`, `sourceBodySelector`) and the `comment` field carrying calibration provenance is the most valuable part. Every value is SAS: `^About SAS$`, `Facts (&|&amp;) Figures`, eight SAS customer names, `#page-content .container.social-left > .par.parsys`, `0.0/0.0/100.0`. Must be recalibrated on blessed aemdev pages. |
| `.migration/qa-requirements/*.md` | `.tracker/qa-requirements/*.md` | **DROP files, PORT both formats** | Keep the prose flavour's five-section shape (Approved Removals with strikethrough-plus-override so the history of a ruling stays legible; Approved Structural Transformations including *healing directives* not just tolerances; EDS Rendering Artifacts; Required Content; Authoring Notes with an explicit append point) and the structured flavour's Parts/ID/Status table. |
| `.migration/qa-requirements/glossary.md`, `glossary-de.md` | `.tracker/qa-requirements/glossary.md`, `glossary-<code>.md` | **REWRITE** | Format is right (never-translate table with position notes, always-translate list, unit rules, per-locale corrections). Content is 100% SAS (`SAS® Viya®`, `Notilyze Cloud`, `dMRV`, `CO₂/kWh/ha`). aemdev's list: `AEM`, `Edge Delivery Services`, `EDS`, `Document Authoring`, `DA`, `Adobe`, `aemdev.org`, block names, `adaptTo()`. |
| `.migration/project.json` | `.tracker/project.json` | **ADAPT** | `contentHostUrl` → `https://content.da.live/aemgdc/aemdev/` (already the value in the target's `config/sites/aemdev/site.json`). |
| `.migration/state/qa-ledger.json` | `.tracker/state/qa-ledger.json` | **PORT-AS-IS (schema)** | Two top-level keys, six fields per page, `attempts = (prior?.attempts||0)+1`, repo-relative `report` path so it git-syncs, skip on `status==='pass' && !force`, whole file rewritten once after the loop only when `!validateOnly`. Keep the schema; start empty. |
| `.migration/state/language-ledger.json` | `.tracker/state/tx-ledger.json` | **ADAPT** | Same shape plus `locale` and the persisted derived status. **Fix the slug quirk:** `${code}${localePath.replaceAll('/','--')}` yields `de--de--articles--x` with the locale twice; the app reproduces the expression verbatim to line up report lookups. Normalize to one locale segment **in both places at once**. |
| `.migration/state/escalations.jsonl`, `language-escalations.jsonl` | `.tracker/state/{qa,tx}-escalations.jsonl` | **PORT-AS-IS (schema)** | Append-only, 8 keys, `problems` = first 10 of `report.errors ++ judge.issues`, heterogeneous by design. |
| `.migration/state/mule-run.log`, `harness-fixtures/`, `reports/qa-local/` | `.tracker/state/…` | **PORT-AS-IS** | Add all three to `.gitignore`. `reports/qa-local/` being separate from the shared `reportsDir` is deliberate: "a validation is one machine's opinion, not batch state." |
| `.migration/reports/{qa,language}/` | `.tracker/reports/{qa,tx}/` | **PORT-AS-IS (schema)** | Report shape is the pipeline's whole contract; keep it, start empty. |

### A.9 The `.js`-vs-`.mjs` constraint — port this rule before any code

Non-negotiable and easy to lose. DA serves a DA app from `<branch>--<repo>--<org>.preview.da.live`, and **that host does not serve `.mjs`** — an existing `.mjs` answers **401** there (extension not on the static allowlist, falling through to the authenticated content path) while `.js` answers 200 and a genuinely missing file answers 404. Because a failed static import takes the whole module graph with it, **one `.mjs` anywhere in a browser-reachable graph means the app does not boot at all, for every user**, and the failure is invisible to anonymous testing: DA picks the host per session, so an authenticated user gets `preview.da.live` while anyone else falls back to `aem.live`, where the same file answers 200. Lint is happy, tests are happy, there is no build step, and a disk-serving harness serves `.mjs` cheerfully.

Consequences for the target: `scripts/tracker/*` is **`.js`**; `tools/page-tracker/*` is **`.js`**; `tools/tracker/*` is `.mjs` and Node-only, and no browser module may import it. The target's `package.json` already has `"type": "module"`, so `.js` files stay ESM under Node. `npm run lint:browser` and `npm run verify:host` must land in phase 0, not at the end.

---

## B. De-SAS surface — grep checklist

Run each grep against the ported tree; every hit must be zero before merge.

### B.1 Orgs, repos, hosts

| grep | occurrences to expect | replace with |
|---|---|---|
| `sasaem` | `migration-paths.js` `STATUS_SITE`; every `statusSheets` entry; `build-escalations` `outCfg`; `blocks/group-readiness` `ORG`; `blocks/translation-matrix` `LANG_APP`; `blocks/escalation-list` link; `blocks/data-quality` sheet link; `language-scan.mjs:703` printed URL; both apps' boot-failure messages; harness `SDK_SHIM` context | `aemgdc` |
| `migration-status` | same set | `aemdev` |
| `sas-institute-corp` | `PUBLISH`; `orchestrator.json` `publish`; `import-processes.json` `destination`; `project.json` `contentHostUrl`; `loadDntRules`'s **parameter defaults** (the one place the content org is baked into a signature) | `aemgdc` |
| `sas-da` | `PUBLISH.repo`; `edsPreviewLink`; `daEditLink`; `dnt.mjs` sheet URL; the `~/.migration/<site>.id` credential convention parsing `edge-150--sas-da--sasaem` | `aemdev` |
| `www\.sas\.com` | `SOURCE_HOST`; the strip regex **inside `canonicalNewPath`** (`^https?:\/\/\/?(www\.sas\.com)?` — note the `\/?` catching the malformed triple slash); `map.sourceHost`; `blocks/data-quality:113`; both `urlPattern` regexes; the link-healing whitelist; UI copy "The original page on www.sas.com"; `compare.mjs` `LIVE_MAP` + two comments | delete; **there is no legacy source host** — the reference side is now the EN page on `aemdev` |
| `sas-da-migration-qa` | `cfg.qa.userAgent` | `aemdev-tracker-qa` |
| `edge-150`, `edge-151`, `edge-335`, `edge-277`, `edge-153`, `EDGE-203`, `EDGE-277` | ledger `migrated` URLs (three generations of host spellings), `qa-signoff:branch:v2` (the `v2` exists to retire remembered `edge-335`), repair manifests, comments | none — target is single-branch `main`. Keep the branch **lower-casing** (a branch becomes a DNS label) and the `main` **default** (pages handed to QA must be reviewed on what is in production) |
| `main--migration-status--sasaem` | `language-scan.mjs:703` | `main--aemdev--aemgdc` |
| `content.da.live/sas-institute-corp/sas-da` | `project.json` | `https://content.da.live/aemgdc/aemdev/` |
| `da.live/apps/loc`, `Smartling` | prose, comments, `dnt.mjs` `PROTECTED_TABS` note | the target's chosen connector — **undecided (F)** |

### B.2 Env vars, tokens, machine identity

| grep | replace |
|---|---|
| `SAS_QA_HOST`, `SAS_QA_JUDGE_ENDPOINT`, `SAS_QA_JUDGE_MODEL`, `SAS_QA_TRIAGE_ENDPOINT`, `SAS_QA_TRIAGE_MODEL`, `SAS_QA_VISION_ENDPOINT`, `SAS_QA_VISION_MODEL` | `AEMDEV_QA_HOST`, `AEMDEV_QA_{JUDGE,TRIAGE,VISION}_{ENDPOINT,MODEL}` |
| `DA_TOKEN`, `~/today-da-token.txt`, `~/today-auth-token.txt` | keep `DA_TOKEN`; the two file paths are a local convention — keep or rename, but the discovery order is echoed in **five error strings** and hardcoded in `resolveToken()`; change all six together |
| `~/.migration/<site>.id` | `~/.tracker/<site>.id` |
| `fw13-ubuntu`, `tad-zbook`, `The Mule`, `192.168.12.109`, `~/git/sasaem/migration-status`, `$HOME/models` | host-profile filenames + ssh block; keep `role:'writer'|'validator'` semantics |
| `llm-judge`, `llm-triage`, `llm-vision` (systemd units) | keep or rename; the gate greps them and `visual-judge`'s error text names them |
| `.migration/` (path prefix, ~40 files) | `.tracker/` |

### B.3 Locales and path rules

| grep | what it is | replace with |
|---|---|---|
| `['ja','zh-tw','ko','es','it','fr','de','pt-br','pl']` (`config.mjs:125`) | nine hardcoded locales, **different order** from `TARGET_LOCALES`, and functionally dead on the language line | one list, one order, in `scripts/tracker/locales.js`; `cfg.locales` reads from it |
| `TARGET_LOCALES` (`migration-language.js`) | nine, drives crawl order, rollup sort, merge sort | the new **ten** (Section D / F) |
| `LOCALES` registry with `daCode` | `pl`→`pl-PL`, `pt-br`→`pt-BR`, `zh-tw`→`zh-TW` — three of nine disagree, recorded because that near-miss produces silent no-ops | keep the **two-vocabulary structure and `locale()` resolving either spelling case-insensitively**, whatever the new codes are |
| `map.pathRules` / `LOCALE_RULES`: `^/pt_br/`, `^/zh_tw/`, `^/([a-z]{2})_[a-z]{2}/`, `/sas/`, `\.html?$` | SAS's `en_us`-style language-only collapse, ordering-constrained (exceptions must precede the general rule) | **delete entirely.** aemdev is already `/en/<section>/<slug>` with no country variants and no `.html`. `pathForLocale()` swapping the leading segment is the whole path model. |
| `IA_RULES` — 24 prefix rewrites (`/company-information/→/company/`, `/whitepapers/→/resources/whitepapers/`, `/offers/→/campaigns/`, `/news/→/company/news/`, `/abm/→/resources/abm/`, …) | the "FINAL INFORMATION ARCHITECTURE - SAS.COM" table, 40 dirs → 11, longest-prefix-first | **delete.** No IA restructure. `applyIaRules` becomes identity; consider deleting the function so nobody re-seeds it. |
| `LANGUAGE_CODE = 'LANGUAGE-CODE'` | placeholder segment, hardcoded as a literal in **three** places (`LANGUAGE_CODE`, `EXCLUDED_PATH`, `LANG_SEGMENT`) | **delete.** With no locale collapse there is no placeholder slot; `new-path` is the real EN path and locale paths are derived by prefix swap. If kept, change all three. |
| `EXCLUDED_PATH = /^\/(?:LANGUAGE-CODE\|[a-z]{2}(?:-[a-z]{2})?)\/fragments\//i` and `EXCLUDED = /\/fragments\//i` | per-site exclusion decision | **invert for aemdev:** `/en/fragments/bios/**` is a **tracked page group** (requirement 3). Exclude only `/en/drafts/**`, `/en/sandbox/**`, `/tracker/**` — matching `config/sites/aemdev/query.yaml`'s existing excludes. |
| `NO_TRANSLATION_TIERS = ['TIER 0 - NO Translation','Images - NO Translation']` (duplicated in two modules with a test asserting equality) | SAS tier strings | delete both copies and the test |
| `lang-class` values `GLOBAL` / `LOCAL-ONLY`; `language-site` values `'All Languages'`/`'English Language'`/`'Japanese Language'`; `language-tier`; `country-tag`; `translate-scope`; `SAS_STATUS_SCOPE` markers (`'REQUIREMENTS DEFINITION'`, `'INITIAL PRODUCTION'`, `'READY FOR DESIGN'`, `'QA'`, `'GO-LIVE READY'`, `'READY FOR TRANSLATION'`, `'Styling ongoing; content released for translation'`) | SAS master-spreadsheet vocabulary; `language-site` is explicitly **untrusted** (203 GLOBAL rows read "English Language" while translating to nine) | delete all. Fan-out rule: **every page in a tracked group fans out to all 10 locales**; opt-out via one `translate: no` column if needed. |
| `tr` in three source URLs | a tenth locale nobody declared | n/a, but keep the *lesson*: `belongsToLocale`'s posture that a blank or unrecognised value must **never inflate a denominator** |
| `QUOTE_CONVENTIONS` for `de fr ja zh-tw ko` only | per-locale typography | re-derive for the new ten |
| `en-US` hardcode (`scripts/utils/date.js:46`, target) | target-side | make locale-aware if tracker pages ever localize |

### B.4 Template / group names

| grep | replace |
|---|---|
| `press-release`, `press-releases`, `customer-story`, `customer-stories`, `customers-index` | `technical-articles`, `meetups`, `bios`, `indexes` |
| the other 20 `statusSheets` keys: `snowflakes`, `webinars`, `awards`, `analyst-viewpoints`, `whitepapers`, `abm`, `company-information`, `solution-briefs`, `ebooks`, `events`, `industries`, `insights`, `leadership`, `legal`, `media-gallery`, `campaigns`, `partners`, `software-products`, `solutions`, `speaker-bureau`, `trust-center` | delete |
| `GROUP_BY_CONTENT_TYPE`, `SNOWFLAKES`, `LEGACY_TEMPLATE_KEYS` (`press-releases→press-release`, `customer-stories→customer-story`) | delete. **Make group name === template key === sheet basename in the target**; the source's key≠name split is the direct cause of F6 |
| `template === 'press-release'` (caption gate, `structural-qa.mjs`) | delete |
| `if (template === 'press-release')` truncating at `About SAS` (`judge.mjs cleanSourceText`) | delete |
| `APPROVED_ISSUE_PATTERNS['customer-story']` — 11 regexes | delete; keep the **mechanism** and the stated reason ("we can't rely on the model honoring negative constraints, so enforce the brief's approved-removals in CODE") |
| `DEFAULT_GROUP = 'press-releases'`; the rollup-unreachable fallback `[{name:'press-releases'},{name:'customer-stories'}]`; `work-queue`'s `group='press-releases'`; `escalation-list`'s `group='customer-story'` example | `technical-articles` |
| `DEFAULT_LOCALE = 'de'` | first locale with content, overridden at boot by highest `present` — keep that override |
| `contentDir: 'content/en/customers'`, `'content/en/news/press-releases'`; `--under=/customers` defaults | `/en/articles` etc. |
| `groupOf()`: `if (p.includes('/news/press-releases/'))` / `if (p.includes('/customers/'))` / `return 'other'` | the real group resolver (F6) |

### B.5 Brand regexes and brand-shaped logic

| grep | file | action |
|---|---|---|
| `.replace(/\s*\|\s*SAS\s*$/, '')` | `lib/extract.mjs` title extraction | delete (or parameterize a `titleSuffix` from config) |
| `/\bAbout SAS\b[\s\S]*$/i` | `judge.mjs cleanSourceText` | delete; keep the *pattern* of moving a boilerplate tail out of the compared text when a runtime fragment supplies it |
| `/\bSAS\s*(®\|\(R\))?\s*(Viya\|Visual Analytics\|Studio\|Institute)?\b.*\b(not translated\|remains? in English\|should be translated)\b/i` | `language-judge.mjs SUPPRESS` | rewrite for `AEM`, `Edge Delivery Services`, `Document Authoring`, `adaptTo()` |
| `/(layout\|section-metadata\|style\|columns-\d\|facts-figures\|disclaimer\|page-identifier\|cta-primary\|cta-secondary\|subheadline\|displayproperties)/i` | `language-judge.mjs SUPPRESS` logical-cell list | rewrite from the target's real block vocabulary (`blocks/` has 38 dirs: `bio`, `qa`, `insights`, `speakers`, `card`, `columns`, `carousel`, `figure`, `callout`, `pullquote`, `step`, `ticker`, `hero`, `home-hero`, `blog-post-hero`, `article-feed`, `author-rows`, `mtb-card`, `rapid-drop`, `speaking`, `update`, `dam-display`, `embed`, `code`, `table`, `advanced-tabs`, `section-metadata`, `metadata`, `fragment`, `schedule`, `youtube`, `spotify`, `search-*`, `results-panel`, `header`, `footer`) |
| `social-sidebar`, `quote-customer-story`, `facts-figures`, `filter-list`, `hero-customer-story`, `full-width-banner`, `listgroup-custom`, `title-shelf`, 13-digit **Brightcove** IDs, `/[a-z]{2,3}/fragments/([\w/-]+)` | `judge.mjs cleanMigratedText`, `language-judge.mjs`, `structural-qa.mjs`, `extract.mjs` | rewrite from the target's blocks. **Keep the fragment-path technique** — distinct per-fragment placeholders so two fragments do not read as duplicated content |
| `SHARE_LINK = /(facebook\.com\/sharer\|twitter\.com\/intent\|linkedin\.com\/(share\|cws)\|pinterest\.com\/pin\/create\|PAGEURL\|PAGETITLE)/i` | `extract.mjs` | delete or re-derive |
| `foldName`/`nameTokens`/`nameContains` (`bioMérieux`/`bioMerieux`, `S Bank`/`S-Bank`, `United Overseas Bank`/`(UOB)`) | `structural-qa.mjs` | delete |
| `LOGO_NOISE` regex | `importer/lib/company-name.mjs` | dropped with the file |
| AEM-6.5 source cleanup: inline CSS, `-webkit-*`, the `position\|overflow\|width\|height\|left\|top\|border\|background\|list-style` property list, `.swiper-*{…}` | `judge.mjs cleanSourceText` | delete — the reference side is an EDS page now, not AEM 6.5 |
| `sourceBodySelector: '#page-content .container.social-left > .par.parsys'` | `qa-baselines/customer-story.json` | delete; the EN side needs no parsys scoping |
| Named SAS pages/customers used as calibration evidence in comments: `world-wildlife-fund`, `abbank`, `fairclimatefund`, `aia-ifrs17-hk`, `absa`, `ABBANK`, `Georgia-Pacific`, `Kansas Water Institute`, `Shriram General Insurance`, `Liverpool FC`, `NC State`, `Moneta Money Bank`, `Notilyze Cloud`, `Kohlenstoffmarkttransaktionen` | throughout | delete |
| Measured SAS constants used as design justification: 2,598 / 191 / 584 / 924 / 676 / 33 / 203 / 1,340 / 11,187 / 207 / 1,301 / 1,309 / 685 KB / 866 / 572 / 109 / 164 / 461 / 421 / 3,081 / 2,890 / 3,059 | comments | **delete the numbers, keep the rules.** These justify the code; they are not thresholds to copy. |

### B.6 UI copy, branding, tokens

| grep | replace |
|---|---|
| `QA Sign-off — SAS migration`, `Language Rollout — SAS migration` | `Page Tracker — aemdev.org` |
| `/img/favicons/sas.svg` | `/img/favicons/favicon.svg` (already in the target's `head.html`) |
| `--qa-accent: #0766d1`; `theme-color #0766D1`; `--sas-navy`, `--sas-blue`, `--sas-cyan`, `--sas-violet`, `--sas-magenta`, "SAS Innovate palette", `--grad-text` | target tokens: `--aem-red` (`#eb1000`), `--carbon`, `--ink`/`--orange`/`--teal`, `--display-font-family`, `--body-font-family`, `--mono-font-family`, `--spacing-xs…xxl`, `--heading-font-size-*`, `--grid-content-width`. **Never hardcode `#eb1000`.** |
| "SAS's locale collapse maps every English country variant onto a single migrated page", "the `sas-da` branch the translated pages were rolled out on", "a content decision is outstanding from SAS", "N AEM 6.5 pages collapse onto this one migrated page" | rewrite; the collapse has no analogue |
| Column labels `6.5` / `EDS` / `AEM 6.5 source` in the Open-in cell | `EN` / `<LOCALE>` / `DA` |
| `ON24`, `EStars`, `Subscription centre`, `FORM_BACKENDS`, `FORM_QA_STATUSES`, `form-qa-*` metadata keys, `Form QA` sections | delete with the forms subsystem |
| npm-command references in UI copy: `npm run subgroup`, `npm run repair-new-path`, `npm run scaffold-locales`, `npm run dnt:audit`, `npm run lang:scan`, `npm run lang:batch`, `npm run qa:sync`, `npm run visual:customers` (**this one does not exist — stale doc**) | the new script names in Section E |
| `hostnames = ['authorkit.dev']` (source F12), `locales` map `'' /de /es /fr /hi /ja /zh` (source F13) | not ported — but **the target has the same two defects** and F13 is the blocker for requirement 2 (see F) |

### B.7 Structural things that look generic but are decisions

Keep, but decide explicitly and write the decision down:

- `readiness` as a column separate from `scope`. The source doc states the lesson twice: **one column, one owner.** Keep the split (Section C keeps `en-status` distinct from the crawl-derived truth) even though aemdev has a single source of truth today.
- **Locale tabs at all.** Now vestigial in the source (11,187 rows of derived data nothing reads; `language-scan` ignores them; the driver still hard-errors without them). But `emptyGroupDoc` creates them up front specifically because **da.live collapses a one-tab sheet to single-sheet on save**. Decision for the target: keep locale tabs, and make them **load-bearing again** — in the new model the (page, locale) row *is* the unit, so `translation-status` and `review-status` legitimately live there. Do **not** carry over the source's dead-tab state.
- `classify()` must **not** be run on locale rows. In the source this was a latent bug: locale tabs have no `readiness` column, so all 11,187 rows resolve to `identified` and the rollup's `locales` aggregate is meaningless. In the new model `classifyTranslation(page, locale)` is a **separate function modelled on `classifyLanguage()`**, and `classify()` handles the EN row only.
- `/qa-status` and `/lang-status` being **two parallel trees, deliberately not nested** — they answer different questions to different people. Preserved as `/tracker/qa/` and `/tracker/tx/`.
- One doc **per page** (and per page-per-locale), not sheet cells. DA has no partial-write API, so a sheet write POSTs the whole doc back; per-page docs remove the entire concurrent-write failure class and leave a single sheet writer. Non-negotiable.
- Doc-marker mirroring, **longest-alternation-first** regex construction (so `OK` cannot win against `NEEDS LAYOUT FIX`), and the visible-line + metadata dual write with per-field precedence.
- `review-status` sync **one-way, never clearing**; `content-escalation` **bidirectional**.

---

## C. Model redesign: migration lifecycle → translation lifecycle

### C.1 What actually changes

The source's status model answers *"how far along is this page's rebuild?"* — a per-page question with a long human-owned pre-build phase (four `readiness` values, three requirements sections, a design gate). The target's question is *"has this page's translation landed and is it correct?"* — a per-**(page, locale)** question with almost no pre-phase, because the EN page already exists.

So: **the source's English funnel collapses to two states, and its language funnel becomes the whole model.** Concretely, `classifyLanguage()` (not `classify()`) is the shape to build on, and `classify()` survives only as the small EN-side gate.

The second change is subtler and drives the state machine. In the source, "is it translated?" was **observable** — presence in the DA content tree, recomputed by crawl, stored nowhere, and the anti-staleness rule `!present → notTranslated, full stop` was the strongest rule in the file. In the target, requirement 2 names **"sent for translation"**, which is *not* observable: nothing in DA, on `aem.page` or on `aem.live` reflects it. That is the one genuinely new stored fact, and it needs the opposite discipline: a stored value nothing can contradict, so it must be timestamped and reconcilable.

The other four requested states *are* observable:

| requested state | how it is observed |
|---|---|
| "en published" | `HEAD https://main--aemdev--aemgdc.aem.live/en/<path>` → 200 |
| "sent for translation" | **not observable — stored** (`translation-status = sent`, with `sent-at`) |
| "previewed in `<lang>`" | `HEAD https://main--aemdev--aemgdc.aem.page/<lang>/<path>` → 200 |
| "auto QA complete" | stored pipeline verdict (`auto-qa-ok` / `visual-qa-ok`) |
| "online in `<lang>`" | `HEAD https://main--aemdev--aemgdc.aem.live/<lang>/<path>` → 200 |

Note that this makes `lang-preview.mjs`'s reason for existing (*existence in DA ≠ previewed*, so tier 1's `.plain.html` 404s and the driver records a technically-true, completely misleading `rollout-fail`) **structural rather than incidental** in the new model: `previewed` and `online` are now two *distinct crawled states*, so `tx-scan` must crawl **both** hosts per locale.

### C.2 State mapping

| source stage | new stage | note |
|---|---|---|
| `identified` | `catalogued` | in a group sheet, EN page exists, nothing sent |
| `needRequirements` | — | **DROP.** No pre-build phase; the EN page is the requirement. |
| `devReady` | — | **DROP** |
| `initialDevProduction` | — | **DROP** |
| `readyForIngest` | `enPublished` | **THE GATE.** Same role, same two-function split (see C.5) |
| `imported` / `structural-review` | `sentForTranslation` | the stored, unobservable state |
| — | `previewed` | **NEW.** Observable on `aem.page`. Fills the gap the source covered with tree presence. |
| `autoQaPass` (`judge-dredd-ok`) | `autoQaPass` | tier 1 + tier 2 clean |
| (`visual-qa-pass`) | `layoutQaPass` | tier 3 clean; promoted to a real funnel position because layout damage from text expansion is the target's most likely defect |
| `inQa` (`ready-for-review`) | `inReview` | human queue |
| `qaOk` (`QA OK`) | `reviewOk` | native-speaker sign-off, go-live ready |
| `live` | `online` | **now observable** (`aem.live` HEAD), not inferred from an absolute URL in a `new-path` cell. This fixes the source's `langLive` — declared, coloured in the hub's progress bar, and produced by nothing. |

Blockers map straight across, renamed to the new pipeline's vocabulary:

| source | new |
|---|---|
| `structural-fail` / `import-fail` | `send-fail` |
| `rollout-fail` | `preview-missing` |
| `judge-dredd-fail` / `lang-judge-fail` | `auto-qa-fail` |
| `judge-dredd-escalate` / `lang-judge-escalate` | `auto-qa-escalate` |
| `visual-qa-fail` / `lang-visual-fail` | `visual-qa-fail` |
| `dnt-violation` | `dnt-violation` (only if DNT ships — F) |
| `untranslated` | `untranslated` |
| `unlocalized-links` | `unlocalized-links` |
| — | `publish-fail` (**NEW** — previewed but never went live) |
| `needs-code-fix` / `design-review` | — **DROP** (no build phase) |
| `needs-content-fix` | — **DROP** (already legacy in the source) |
| `needs-retranslation` / `needs-dnt-fix` / `needs-layout-fix` | `needs-retranslation` / `needs-terminology-fix` / `needs-layout-fix` |

### C.3 New enum values

```js
// scripts/tracker/stages.js

// Derived funnel, per (page, locale). Never stored. STAGE_INDEX gives `order`.
export const PAGE_STAGES = [
  { id: 'catalogued',        label: 'Catalogued',        short: 'CAT'  },
  { id: 'enPublished',       label: 'EN published',      short: 'EN'   },
  { id: 'sentForTranslation',label: 'Sent',              short: 'SENT' },
  { id: 'previewed',         label: 'Previewed',         short: 'PREV' },
  { id: 'autoQaPass',        label: 'Auto QA passed',    short: 'AQA'  },
  { id: 'layoutQaPass',      label: 'Layout QA passed',  short: 'LAY'  },
  { id: 'inReview',          label: 'In native review',  short: 'REV'  },
  { id: 'reviewOk',          label: 'Review OK',         short: 'OK'   },
  { id: 'online',            label: 'Online',            short: 'LIVE' },
];

// Stored `en-status` — human/pipeline, the EN-side half. Blank is normal.
export const EN_STATUSES = ['', 'draft', 'en-previewed', 'en-published'];

// Stored `translation-status` — pipeline-written, per (page, locale).
export const TRANSLATION_STATUSES = [
  { value: '',                  label: 'Not sent',          actor: 'automated' },
  { value: 'sent',              label: 'Sent',              actor: 'human'     },
  { value: 'preview-ok',        label: 'Previewed',         actor: 'automated' },
  { value: 'auto-qa-ok',        label: 'Auto QA passed',    actor: 'judge'     },
  { value: 'visual-qa-ok',      label: 'Layout QA passed',  actor: 'automated' },
  { value: 'send-fail',         label: 'Send failed',       actor: 'automated', queue: 'send-issues'      },
  { value: 'preview-missing',   label: 'Never arrived',     actor: 'automated', queue: 'awaiting-preview' },
  { value: 'untranslated',      label: 'Still English',     actor: 'automated', queue: 'retranslate'      },
  { value: 'unlocalized-links', label: 'English links',     actor: 'automated', queue: 'link-issues'      },
  { value: 'auto-qa-fail',      label: 'Auto QA failed',    actor: 'judge',     queue: 'auto-qa-issues'   },
  { value: 'auto-qa-escalate',  label: 'Escalated',         actor: 'judge',     queue: 'escalations'      },
  { value: 'visual-qa-fail',    label: 'Layout QA failed',  actor: 'automated', queue: 'layout-issues'    },
  { value: 'publish-fail',      label: 'Publish failed',    actor: 'automated', queue: 'publish-issues'   },
];

// Stored `review-status` — the human verdict. The ONLY stored human input.
export const REVIEW_STATUSES = [
  { value: '',                       label: '—' },
  { value: 'ready-for-review',       label: 'Ready for review' },
  { value: 'TRANSLATION OK',         label: 'Translation OK' },      // literal, uppercase+space
  { value: 'needs-retranslation',    label: 'Needs retranslation',    queue: 'retranslate' },
  { value: 'needs-terminology-fix',  label: 'Needs terminology fix',  queue: 'terminology' },
  { value: 'needs-layout-fix',       label: 'Needs layout fix',       queue: 'layout-issues' },
];

export const TRACKER_QUEUES = [
  'send-issues', 'awaiting-preview', 'auto-qa-issues', 'escalations',
  'layout-issues', 'retranslate', 'terminology', 'link-issues',
  'publish-issues', 'content-escalation',
];

export const PROGRESS_BUCKETS = [
  'catalogued', 'enPublished', 'sent', 'previewed', 'autoQa', 'inReview', 'reviewOk', 'online',
];
```

`TRANSLATION OK` keeps the source's deliberate casing inconsistency (`QA OK`, `LANG OK`): a literal uppercase-with-space **stored** value, matched everywhere via `.toLowerCase()`. It survives because the value is also the human-visible doc marker's meaning and a human edits it in DA's rich-text editor; keeping the two spellings identical prevents a class of round-trip bug. `statusClass()` collapses it to `translation-ok` for CSS.

Doc markers (1:1 with `review-status`, built **longest-alternation-first**):

| `review-status` | marker |
|---|---|
| `''` | `PENDING` |
| `ready-for-review` | `READY FOR REVIEW` |
| `TRANSLATION OK` | `OK` |
| `needs-retranslation` | `NEEDS RETRANSLATION` |
| `needs-terminology-fix` | `NEEDS TERMINOLOGY FIX` |
| `needs-layout-fix` | `NEEDS LAYOUT FIX` |

### C.4 The state machine

Per (page, locale). `P` = previewed-host HEAD 200, `L` = live-host HEAD 200.

| from | to | trigger | advanced by |
|---|---|---|---|
| `catalogued` | `enPublished` | `en-status := en-published` (or EN live HEAD 200) | human (`set-en-status`) or `tx-scan` crawl |
| `enPublished` | `sentForTranslation` | `translation-status := sent`, `sent-at := <iso>` | **human** in Page Tracker, or `tx-send` batching a group×locale |
| `sentForTranslation` | `previewed` | `P` becomes true → `translation-status := preview-ok` | `tx-scan` (crawl) + `tx-preview` (which *causes* `P` when the connector writes to DA and stops) |
| `sentForTranslation` | `preview-missing` **[blocked]** | `sent-at` older than SLA and `!P` | `tx-scan` |
| `previewed` | `autoQaPass` | tier 1 clean + tier 2 `pass` → `auto-qa-ok` | `tx-driver` |
| `previewed` | `untranslated` / `unlocalized-links` / `auto-qa-fail` / `auto-qa-escalate` **[blocked]** | tier verdicts via `toTranslationStatus()` | `tx-driver` |
| `autoQaPass` | `layoutQaPass` | tier 3 `pass` → `visual-qa-ok` | `tx-driver --visual` |
| `autoQaPass` | `visual-qa-fail` **[blocked]** | tier 3 `fail` | `tx-driver --visual` |
| `autoQaPass`/`layoutQaPass` | `inReview` | `review-status := ready-for-review` | human (Page Tracker) |
| `inReview` | `reviewOk` | `review-status := TRANSLATION OK` | **human only** |
| `inReview` | `retranslate`/`terminology`/`layout-issues` **[blocked]** | `review-status := needs-*` | **human only** |
| `reviewOk` | `online` | `L` becomes true | `tx-scan` crawl (publish is a separate action) |
| `reviewOk` | `publish-fail` **[blocked]** | signed off, previewed, `!L` after SLA | `tx-scan` |
| *any* | `previewed`-clamped | `!P` — the page was withdrawn from preview | `tx-scan` |
| *any* | + `content-escalation` | flag column truthy | human, orthogonal, never removes a page from the funnel |

**Precedence in `classifyTranslation(page)`** — port `classifyLanguage()`'s strict ordering, not `classify()`'s:

1. `flagged = hasContentEscalation(row) ? ['content-escalation'] : []`, `withFlag()` applied to **every** return path. The source's first implementation returned early on `ready-for-review`/`QA OK` and lost the flag; that bug is the reason this is step 1.
2. `REVIEW_BLOCKERS[reviewStatus]` → blocked. A human verdict outranks a pipeline pass **and** a pipeline failure a native speaker has since accepted.
3. `ready-for-review` → `inReview`; `translation ok` → `L ? 'online' : 'reviewOk'`.
4. unknown non-blank `review-status` → warning, fall through.
5. **`!P` → clamp to `sentForTranslation` (or `enPublished` if never sent), full stop**, whatever any status column says — plus a warning if a forward status *was* recorded ("it was withdrawn, or the status is stale"). This is the source's anti-staleness rule and the single most load-bearing line: nothing ever clears a status column.
6. **Ungated guard:** `translation-status !== '' && !passedSendGate(row)` → return the EN-side stage plus warning `translation-status "<raw>" but en-status is not en-published — not counted as sent`.
7. `TRANSLATION_BLOCKERS[translationStatus]` → `{stage:null, order:-1, blocked:true}` + queue.
8. Forward map: `''`→`enPublished`; `sent`→`sentForTranslation`; `preview-ok`→`previewed`; `auto-qa-ok`→`autoQaPass`; `visual-qa-ok`→`layoutQaPass`; else `sentForTranslation` + `unknown translation-status: "<raw>"` warning.
9. Return `{ stage, order, queues, blocked, warnings }` — identical shape, so every consumer's plumbing is unchanged.

### C.5 Gates — keep the two-function split and the reason

```js
// THE SEND GATE. Requires an EXPLICIT en-published (never a derived default),
// and excludes any (page, locale) the pipeline already worked, so a rebuild
// cannot masquerade as new work.
export const isSendable = (row, locale) =>
  get(row, 'en-status') === 'en-published' && translationStatusFor(row, locale) === '';

// Stays true after the pipeline ran. This is the one classify() uses to decide
// whether a translation-status is believable.
export const passedSendGate = (row) => get(row, 'en-status') === 'en-published';
```

Also keep, verbatim in spirit:

- **`translationStage(status)` / `translationOrder(status)` existing separately from `classifyTranslation()`.** `classifyTranslation` folds in `review-status`, so a regression guard built on it compares equal in both directions — that is exactly how a reconcile in the source silently downgraded 33 `visual-qa-pass` rows to `judge-dredd-ok` (all carried `ready-for-review`). Port the function **and** the reason.
- **`countsAsPage(row)`**, with the exclusion set inverted for aemdev (B.3).
- **`progressBucket(row)`** furthest-along-first so every row lands in exactly one bucket.
- **`emptyStageCounts()` including a `blocked` key**, `emptyQueueCounts()`, `emptyBucketCounts()`.
- **`tally()` defined once** and used for both the locale row and the group drill-in — and this time actually honoured (fix the F8 shadowing: never spread `{...tally(x), ...stage}` where the two share key names).

### C.6 Sheet columns

**`data` (master) tab** — one row per EN page. Three ownership bands preserved (the band boundary is the contract the index-sync relies on: it may overwrite band 1, never bands 2–3).

```
Band 1 (index-derived, refreshed by sync-groups-from-index, safe to overwrite):
  page-path · title · template · pagetype · en-live · last-modified
Band 2 (ours, curated, never overwritten):
  subgroup · translate · notes
Band 3 (pipeline + human):
  en-status · content-escalation
```

`page-path` is the join key (replacing `source-url`). A blank `page-path` is a scaffold placeholder and is not counted. Note that dropping `source-url` also drops the source's whole `new-path`/`isUsableNewPath`/slug-agreement apparatus — there is no second path to reconcile.

**Locale tabs** — one per locale, one row per (page, locale). Now **load-bearing**, unlike the source's vestigial tabs.

```
page-path · locale · locale-path · sent-at · previewed · online
translation-status · review-status · review-updated
```

`LOCALE_PRESERVED = ['sent-at', 'translation-status', 'review-status', 'review-updated']` — a rebuild carries these over verbatim and never regenerates them. `previewed`/`online` are crawl output and *are* regenerated every scan. Additive-only: a column removal is data loss `git revert` cannot undo.

### C.7 Which source code keeps its shape, and which needs new semantics

| keeps its shape (rename + re-vocabulary only) | needs new semantics |
|---|---|
| `classify()`'s return contract, evaluation-order discipline, warnings-not-silent-bucketing | the forward map itself, and the two-host presence check replacing one-tree presence |
| the ingest/send gate pair and the ungated-status guard | what "gated" means (`en-published`, not `ready-for-ingest`) |
| `productionStage`/`productionOrder` regression guard | the ordering it guards |
| doc-marker mirroring, longest-first alternation, dual visible+metadata write, per-field precedence | the marker set and the section headings |
| `sheetRows`/`sheetTabs`, the `sheet()` envelope, the `:`-prefixed-keys-only content-bus rule, the multi-sheet-not-`:type:'sheet'` rule for indices, the size ceiling | nothing |
| `migration-subgroups.js` in full | nothing (verbatim) |
| `tally()`, the rollup invariant assertions, `checkSubgroupSum` | the columns summed |
| `attachVerdicts` worker pool, doc-wins-over-sheet, withheld-and-counted | the row unit (page → page×locale) |
| tier-1 finding model, `textSample.pairs` filters, quote verification, the 5-step merge ladder | `SUPPRESS`, the glossary, the block vocabulary |
| `language-visual`'s "worse than English" framing and geometry-over-pixels | widths, and puppeteer→playwright |
| all four `.migration/state` file schemas | the ledger key (drop the doubled locale segment) |
| **DROP entirely:** `readiness`'s four values, `requirements`' three-owner gate, `design-review`, `needs-code-fix`, `needs-content-fix`, `scope`/`SCOPE_STAGES`, `LANGUAGE_CODE`, `IA_RULES`, `LOCALE_RULES`, `isUsableNewPath`, `fansOut`, `lang-class`, the whole forms model | |

---

## D. Page groups

Four groups. **Group name === template key === sheet basename** — collapsing the source's key≠name split, which is the direct cause of F6 (escalation `group` values incompatible with `work-queue` `group` values, leaving 21 of 23 groups unfilterable).

| group | paths | source of truth for the page list | template | index target | notes |
|---|---|---|---|---|---|
| `indexes` | `/` (root home), `/en/articles/`, `/en/meetups/`, `/en/contact/` | **hand-authored list in the group sheet**, seeded from `/en/query-index.json` + one manual row for `/` | none (implicit default) | `/en/query-index.json` — **except `/`**, which sits at root, outside every index's `include: /en/**` | Small, hand-built, high-visibility, own baseline and brief — exactly the case the source's `snowflakes`+`subgroup=indexes` handled awkwardly. The root home page is the one page outside the `en` tree and needs a manual row. |
| `meetups` | `/en/meetups/**` | `/en/query-index.json` filtered on path prefix (**not** on `template`, see the two live bugs below) | `meetup` — **does not exist; must be created** as `templates/meetup/meetup.css` | `/en/query-index.json` | Per `docs/adaptto-2026/content-model.md`, 14 pages were already live at `/en/meetups/` as of 2026-08-16 while git still only has `meetup-recaps`. **Design against DA + query-index, not the git tree.** |
| `technical-articles` | `/en/articles/**` | `/en/query-index.json` filtered on path prefix | `blog` (exists: `templates/blog/blog.css`) | `/en/query-index.json` | The largest group and the one where text expansion will bite hardest. |
| `bios` | `/en/fragments/bios/**` | **`/bios.json`** — the bio-manager roster sheet (`Slug, Name, Title, Company, LinkedIn, Image, Path, Status, Updated`) | none; `bio` block + `metadata` block | **currently none** — `/en/fragments/**` is in `aemdev-en`'s `exclude`. Needs a new `aemdev-bios` index (Section E) | Owned by another session. Read-only coupling: the tracker reads `/bios.json` and never writes it. |

### D.1 Two live target bugs that gate the group definitions

1. `scripts/scripts.js:31` — `templatedSections = ['articles', 'meetup-recaps', 'meeting-recaps']`. **`'meetups'` is absent.** Since content moved to `/en/meetups/`, the path-based `template=blog` auto-injection no longer fires there, so those 14 pages have **no `template` metadata at all**. Consequences: (a) group membership must be resolved by **path prefix**, not by `template`; (b) `blocks/insights`'s `DEFAULT_TEMPLATES` filter will miss them; (c) the tracker's own group-sync would classify them as ungrouped. Either fix `templatedSections` (add `'meetups'`, decide whether `meetup` or `blog`) or accept path-prefix grouping permanently.
2. Landing pages hardcode their index paths as *authored content* (`/en/articles/query-index.json`), and both `blocks/article-feed` and `blocks/insights` hardcode `DEFAULT_INDEX = '/en/query-index.json'`. So the group's "source of truth" is duplicated in authored content, block defaults, and three competing `query.yaml` files (below). Pick one before building the sync.

Also: `docs/adaptto-2026/content-model.md:240` records that **trailing slashes 404** on these paths. The tracker must normalize trailing slashes in every URL key, or a group sync will happily record a 404 as a tracked page.

### D.2 Per-group artifacts

Each group gets five artifacts, mirroring the source's structure:

| # | artifact | path |
|---|---|---|
| 1 | tracking sheet (multi-sheet: `data` + 10 locale tabs) | DA `/tracker/data/groups/<group>.json` |
| 2 | registry entry keyed by group name | `.tracker/orchestrator.json` → `groups.<group>` = `{org:'aemgdc', repo:'aemdev', path:'/tracker/data/groups/<group>.json', sheet:'data', branch:'main', qaNotesPath:'/tracker/qa', txNotesPath:'/tracker/tx'}` |
| 3 | QA requirements brief (the judge contract) | DA `/tracker/requirements/<group>/production-requirements`, or local `.tracker/qa-requirements/<group>-brief.md` |
| 4 | structural QA baseline | `.tracker/qa-baselines/<group>.json` |
| 5 | per-(page, locale) review docs | DA `/tracker/tx/<locale-path>` |

Plus per-page EN QA docs at `/tracker/qa/<en-path>` for the EN-side findings the translation QA references.

### D.3 Group → QA requirements brief

Each brief's **QA Requirements** section is the only part the judge sees (`judgeBrief()` returns that section alone, or `null`). Seeded content per group, expressed in the `✓ ~ ? ✗` table form:

| group | must survive (judge FAILs if missing/altered) | may change (judge must NOT flag) | approved removals | visual checks |
|---|---|---|---|---|
| `indexes` | nav labels, section headings, the CTA set, item counts | **item ordering and item titles** — a locale index lists whatever is translated in that locale, so counts legitimately differ from EN | none | tile grid reflow at 390px; nav wrap |
| `meetups` | event date, location, speaker names (**DNT**), session titles, the recap video embed | body prose, session descriptions | none | date/location line wrap; `speakers` row overflow; video aspect |
| `technical-articles` | code blocks **verbatim** (the `code` block must be byte-identical — a translated identifier is a defect), headings, author name (**DNT**), publication date, block names inside prose | body prose, `displayDescription` | none | code-block horizontal overflow at 390px; heading rewrap; `figure` caption growth |
| `bios` | `Name` (DNT), `LinkedIn` (DNT), `Image` path (DNT), the presence of a `Bio` body | `Title`, `Company`, `Bio` body prose, `description` | none | photo/initials fallback; two-line role growth |

`bios`' translatable-vs-DNT split is already latent in the bio-manager data model (`Slug`/`Name`/`LinkedIn`/`Image`/`Path` are structural; `Title`/`Company`/`Bio`/`description` are prose), and `bio-status` (`placeholder` / `approved`) is a working precedent for a per-locale `bio-translation-status`.

### D.4 Subgroups

Port `migration-subgroups.js` verbatim and use it immediately — `technical-articles` will want `series` / `adaptto-2026` / `deep-dives`, and `bios` will want `speakers` / `contributors`. Keep both rules: **blank is normal and blank is not a subgroup** (rolls up as `(unassigned)`, forced last regardless of size, because early on most rows are unclassified and size-sorting buries the labels someone actually authored), and **a group's subgroups always re-add to the group's own total, per column** (asserted as a build invariant, which is why `(unassigned)` is a real bucket and not a filter). Keep the slug-form pin — the value *is* the `?sub-group=` query parameter on a Page Tracker deep link.

---

## E. Target architecture

### E.1 Directory layout

```
/home/tad/git/aemgdc/aemdev-tracker/
├── blocks/                                  # EXISTING 38 blocks untouched; 6 added
│   ├── tracker-summary/{tracker-summary.js,.css}
│   ├── translation-matrix/{translation-matrix.js,.css}
│   ├── group-progress/{group-progress.js,.css}
│   ├── work-queue/{work-queue.js,.css}
│   ├── escalation-list/{escalation-list.js,.css}
│   └── status-primer/{status-primer.js,.css}
├── scripts/
│   └── tracker/                             # SHARED MODEL — browser + Node, .js ONLY
│       ├── README.md                        # the .js rule + zero-dep/DOM-free contract
│       ├── stages.js                        # enums, classify, classifyTranslation, gates, buckets
│       ├── paths.js                         # SITE, tree bases, link builders
│       ├── locales.js                       # LOCALES registry, TARGET_LOCALES, path helpers
│       ├── detect.js                        # language detection (from migration-language.js)
│       ├── data.js                          # memoised browser data layer
│       ├── subgroups.js                     # verbatim port
│       ├── qa-doc.js                        # EN QA-notes doc model
│       ├── tx-doc.js                        # translation review doc model
│       └── block-utils.js                   # el() + readConfig(), extracted once (fixes F18)
├── tools/
│   ├── page-tracker.html                    # DA app entry (BESIDE the dir — house convention)
│   ├── page-tracker/
│   │   ├── page-tracker.js  da-source.js  rows.js  table.js  drawer.js
│   │   └── page-tracker.css                 # self-contained; tokens duplicated with --pt-* prefix
│   └── tracker/                             # NODE PIPELINE — .mjs, never browser-reachable
│       ├── config.mjs
│       ├── structural-qa.mjs  judge.mjs  qa-driver.mjs
│       ├── tx-qa.mjs  tx-judge.mjs  tx-visual.mjs  tx-driver.mjs
│       ├── tx-scan.mjs  tx-preview.mjs  tx-send.mjs  tx-heal-links.mjs
│       ├── tx-reconcile.mjs  sync-review-status.mjs  mark-tx-status.mjs
│       ├── visual-compare.mjs  visual-judge.mjs
│       ├── build-rollup.mjs  build-escalations.mjs  watch-rollup.mjs
│       ├── publish-tx-reports.mjs
│       ├── scaffold-group.mjs  finalize-group.mjs  scaffold-requirements.mjs
│       ├── upgrade-columns.mjs  set-en-status.mjs  set-subgroup.mjs  move-row.mjs
│       ├── sync-groups-from-index.mjs  emit-pairs.mjs
│       ├── app-harness.mjs  check-browser-modules.mjs  check-deployed-modules.mjs
│       ├── appliance/llmctl.sh
│       └── lib/{llm,extract,status-sheet,group-sheet,requirements,qa-doc-io,group-map,dnt,da-ims,scope,slug}.mjs
├── templates/
│   └── meetup/meetup.css                    # NEW — needs `git add -f` (templates/ is gitignored)
├── test/
│   ├── scripts/tracker/{stages,paths,locales,detect,subgroups,qa-doc,tx-doc}.test.js
│   ├── blocks/{tracker-summary,translation-matrix,group-progress,work-queue}.test.js
│   └── tools/page-tracker/{rows,table,drawer}.test.js
├── docs/tracker/{status-model,tx-qa-process,page-tracker-app,branch-testing,visual-compare}.md
├── .agents/skills/
│   ├── diff/scripts/{visual-diff.mjs,live-session.mjs,diff-profiles.mjs}   # upgrade in place
│   └── tx-qa/{SKILL.md,BRIEF-TEMPLATE.md}
└── .tracker/                                # config + state (parallel to source's .migration/)
    ├── orchestrator.json  project.json
    ├── hosts/<hostname>.json
    ├── qa-baselines/{indexes,meetups,technical-articles,bios}.json
    ├── qa-requirements/{BRIEF-TEMPLATE.md,<group>-brief.md,glossary.md,glossary-<code>.md}
    ├── urls/pairs-<group>-<locale>.txt
    ├── state/{qa-ledger.json,tx-ledger.json,qa-escalations.jsonl,tx-escalations.jsonl}
    │         {harness-fixtures/,run.log}    # last two gitignored
    └── reports/{qa/,tx/,qa-local/}          # qa-local/ gitignored
```

### E.2 The `/tracker/` DA tree (EDS pages + feeds)

Authored in DA, **not in git** — the target's `.gitignore` already excludes `en/`, `fragments/`, `templates/`, `index.plain.html` because "content lives in DA — local plain HTML files are working copies only". `/tracker/**` follows the same rule; add `tracker/` to `.gitignore`.

```
/tracker/                    home board        → tracker-summary, group-progress
/tracker/translations        the hub           → translation-matrix
/tracker/dev                 escalations       → escalation-list, work-queue
/tracker/how-to-use-this     the primer        → status-primer
/tracker/data-quality        (phase 4)         → data-quality

/tracker/data/rollup.json                      published EN+group rollup
/tracker/data/tx-rollup.json                   published translation rollup (locales/groups/stages/queues/meta)
/tracker/data/tx-index/<code>.json             per-locale page index (present pages only)
/tracker/data/tx-reports/<locale>--<slug>.json per-page reviewer subset
/tracker/data/escalations.json                 QA escalation feed
/tracker/data/tx-escalations.json              translation escalation feed
/tracker/data/groups/<group>.json              the four group sheets
/tracker/requirements/<group>/production-requirements
/tracker/qa/<en-path>                          one EN QA-notes doc per page
/tracker/tx/<locale-path>                      one review doc per (page, locale)
/tracker/escalations.json                      human-editable section escalations (deliberately OUTSIDE /tracker/data/)
```

Two rules carried from the source that bite here: every top-level key in a DA sheet doc must be `:`-prefixed or a `{total,limit,offset,data}` sheet object, or the content bus rejects the write with "error from content-bus" — hence the timestamp lives in a `meta` sheet. And the per-locale index **must be `:type:'multi-sheet'` with `:names`, never `:type:'sheet'`** — a single-sheet doc carries rows at the top level, so the malformed form is accepted by `admin.da.live` and then refused at *preview* with `400 error from content-bus`, leaving DA holding a file every reader 404s.

Path note: **no leading underscore anywhere** — Helix excludes `_`-prefixed paths from publishing, and these feeds must be served.

### E.3 noindex / nofollow — four layers, all needed

The target's precedent is exact: `tools/bio-manager/bio-manager.js:369` already writes `metaRow('robots', 'noindex, nofollow')` into every generated bio document, and the pipeline **hoists a `metadata` block into `<head>` server-side and strips the block from `main`** (verified on a live article: `grep -c 'class="metadata"'` on rendered HTML is 0 while all four authored meta names appear as real head tags). Arbitrary names pass through, so `robots` does too.

| layer | mechanism | covers |
|---|---|---|
| 1. per page | a `metadata` block row `\| robots \| noindex, nofollow \|` on every `/tracker/*` page | HTML pages, crawler-visible without JS |
| 2. out of the index | `/tracker/**` is **already outside** `aemdev-en`'s `include: /en/**` — nothing to change | keeps tracker pages out of `/en/query-index.json`, hence out of `/en/sitemap.xml` (which sources only that index) |
| 3. response header | add a `/tracker/**` glob to `config/sites/aemdev/headers.json` (today CORS only) → `x-robots-tag: noindex, nofollow`; deploy via the *Update Headers Configuration File* workflow | **the JSON feeds** — the only layer that covers non-HTML assets |
| 4. robots.txt | `Disallow: /tracker/` in `config/sites/aemdev/robots.txt` → *Update Robots.txt Configuration File* | belt-and-braces |

Do **not** rely on `blocks/metadata/metadata.js`'s client-side head injection: on a published page it never fires (the pipeline already removed the block), and it would run after first paint — useless for a non-JS crawler. Watch the two robots.txt sources of truth: `config/sites/aemdev/site.json` also carries `"robots": { "txt": ... }`, and the tracked root `/robots.txt` is stale (it still advertises `Sitemap: https://docs.da.live/sitemap.xml`).

The tracker pages are also **not access-controlled**. Unlike the source — where every page and feed returns 401 because site auth is on — everything under `/tracker/` on `main--aemdev--aemgdc.aem.live` is **publicly readable once previewed**. That makes the source's `publishable()` stripping (dropping the two prose blobs and the full `checks` block from published per-page reports) mandatory rather than prudent, and it is a decision the user must confirm (F).

### E.4 `query.yaml` — what needs an index, and the trap

**The trap first.** Three files in the target claim to configure indices and only one deploys:

| file | status |
|---|---|
| `/helix-query.yaml` (root) | **stale** — boilerplate |
| `/config/query.yaml` | **stale** — writes `/en/query-index.json` with a *different* property set than the one that deploys |
| `/config/sites/aemdev/query.yaml` | **authoritative** — `auto-generated: true`, index `aemdev-en`, deployed by `.github/workflows/update-index-configuration.yaml` reading `config/sites/<site>/query.yaml` and POSTing to `https://admin.hlx.page/config/aemgdc/sites/aemdev/content/query.yaml` with `Authorization: token <AUTH_TOKEN>` (**`token`, not `Bearer`** — that scheme is the DA/IMS side) |

Reconcile or delete the two stale files before adding anything, or the next person edits the wrong one.

**Mandatory procedure** (from `scripts/sync-site-configs.mjs`: *"pushing a stale local file silently deletes whatever the deployed config had that the repo copy lacked"*): run *Sync site configs* → pull → edit → commit to `main` (the workflow does `actions/checkout@v5`, it reads the repo not your worktree) → run *Update Index Configuration File* with `site: aemdev` → re-preview/publish the affected paths to backfill (pushing config does **not** backfill) → verify → run *Sync site configs* again to prove no drift. `allowedSites = new Set(['aemdev'])` guards both scripts.

**Indices needed:**

| index | why | include | target | key properties |
|---|---|---|---|---|
| `aemdev-bios` | `/en/fragments/**` is in `aemdev-en`'s `exclude`, so the bios group has no page list today. Required for group `bios`. | `/en/fragments/bios/**` | `/en/fragments/bios/query-index.json` | `title`, `bioName`, `bioTitle`, `bioCompany`, `bioStatus`, `robots` |
| `aemdev-tracker` | lets the Page Tracker and the boards read the tracker's own doc state — `robots`, `review-status`, `translation-status`, `content-escalation` — **in one fetch per group** instead of one doc read per page. This is the whole reason the QA-notes doc carries a metadata block. | `/tracker/qa/**`, `/tracker/tx/**` | `/tracker/query-index.json` | `review-status`, `review-actor`, `review-updated`, `translation-status`, `content-escalation`, `sent-at` |
| `aemdev-<locale>` × 10 | per-locale page lists, once translated content exists | `/<code>/**` | `/<code>/query-index.json` | mirror `aemdev-en` |
| add `robots` to `aemdev-en` | nothing indexes it today; a feed block that must skip noindexed pages cannot | — | — | `head > meta[name="robots"]` |

`config/sites/aemdev/sitemap.yaml` is separate and reads only `/en/query-index.json` — a new index target is absent from the sitemap until that file is edited and *Update Sitemap Configuration File* is run. It currently has exactly one language block (`en`, `hreflang: en`, `alternate: /en/{path}`); requirement 2 needs ten more, and nothing emits `hreflang` in `head.html` today.

### E.5 `package.json` scripts

Additions to the target's existing `scripts` block:

```jsonc
{
  // EN-side auto-QA
  "qa:page":       "node tools/tracker/structural-qa.mjs",
  "qa:judge":      "node tools/tracker/judge.mjs",
  "qa:batch":      "node tools/tracker/qa-driver.mjs",
  "qa:validate":   "node tools/tracker/qa-driver.mjs --validate-only",
  "qa:sync":       "node tools/tracker/sync-review-status.mjs",

  // translation lifecycle
  "tx:send":       "node tools/tracker/tx-send.mjs",
  "tx:scan":       "node tools/tracker/tx-scan.mjs",
  "tx:preview":    "node tools/tracker/tx-preview.mjs",
  "tx:page":       "node tools/tracker/tx-qa.mjs",
  "tx:judge":      "node tools/tracker/tx-judge.mjs",
  "tx:visual":     "node tools/tracker/tx-visual.mjs",
  "tx:batch":      "node tools/tracker/tx-driver.mjs",
  "tx:validate":   "node tools/tracker/tx-driver.mjs --validate-only",
  "tx:publish":    "node tools/tracker/publish-tx-reports.mjs",
  "tx:heal-links": "node tools/tracker/tx-heal-links.mjs",
  "tx:reconcile":  "node tools/tracker/tx-reconcile.mjs",

  // visual
  "visual:compare":"node tools/tracker/visual-compare.mjs",
  "visual:judge":  "node tools/tracker/visual-judge.mjs",

  // publish artifacts
  "rollup":        "node tools/tracker/build-rollup.mjs",
  "rollup:watch":  "node tools/tracker/watch-rollup.mjs",
  "escalations":   "node tools/tracker/build-escalations.mjs",

  // group / sheet management
  "group:scaffold":     "node tools/tracker/scaffold-group.mjs",
  "group:finalize":     "node tools/tracker/finalize-group.mjs",
  "group:sync":         "node tools/tracker/sync-groups-from-index.mjs",
  "group:requirements": "node tools/tracker/scaffold-requirements.mjs",
  "group:upgrade":      "node tools/tracker/upgrade-columns.mjs",
  "en-status":          "node tools/tracker/set-en-status.mjs",
  "subgroup":           "node tools/tracker/set-subgroup.mjs",
  "move-row":           "node tools/tracker/move-row.mjs",
  "pairs":              "node tools/tracker/emit-pairs.mjs",

  // guards — these run in CI, not at the end of the project
  "lint:browser":  "node tools/tracker/check-browser-modules.mjs",
  "verify:host":   "node tools/tracker/check-deployed-modules.mjs",
  "harness":       "node tools/tracker/app-harness.mjs --app=page-tracker",
  "verify":        "npm run lint:tracker && npm run lint:browser && npm test && npm run harness",

  // scoped lint — `npm run lint` is unusable (see below)
  "lint:tracker":  "eslint blocks/tracker-summary blocks/translation-matrix blocks/group-progress blocks/work-queue blocks/escalation-list blocks/status-primer scripts/tracker tools/tracker tools/page-tracker test/scripts/tracker test/tools && stylelint \"blocks/{tracker-summary,translation-matrix,group-progress,work-queue,escalation-list,status-primer}/*.css\" \"tools/page-tracker/*.css\""
}
```

Notes:

- **Do not run `npm run lint`.** The target's `lint:js` is `eslint .` against a pre-existing baseline of ~14,026 problems (~10,684 in `.agents/skills`, ~2,787 in the vendored `scripts/search` bundle). Lint your own paths, as above.
- `lint:css` is scoped to `blocks/**/*.css styles/*.css`, so **`tools/` and `templates/` CSS are not covered** by the existing script — `lint:tracker` covers them explicitly.
- Dependency deltas: `playwright`, `jsdom`, `sharp`, `form-data`, `node-fetch` are **already present**. **`puppeteer` is not** — which is why both puppeteer tools port to playwright rather than adding a second browser driver. `sharp` replaces the shelled-out Python PIL crop. **Zero new npm dependencies required.**
- Non-npm prerequisites: `llama-server` from llama.cpp plus the GGUFs, and for the vision tier its **mandatory `mmproj-*.gguf` projector** (easy to miss); `curl` for `llmctl.sh`'s health loop.
- Add to `.gitignore`: `.tracker/state/harness-fixtures/`, `.tracker/state/run.log`, `.tracker/reports/qa-local/`, `.tracker/urls/pending-*.txt`, `visual-compare-out/`, `tracker/`.

### E.6 App registration

Page Tracker launches at `https://da.live/app/aemgdc/aemdev/tools/page-tracker` regardless of registration; registration only controls whether it appears in DA's app menu (a row in the `apps` sheet of the site config at `https://da.live/config#/aemgdc/aemdev/`, pinned to `ref: main`). Optional params: `?readonly=1`, `?group=`, `?sub-group=`, `?filter=`, `?locale=`, `?branch=`, plus DA's own `?ref=<branch>` / `?ref=local`. Local dev: `aem up`, then `…/tools/page-tracker?ref=local&readonly=1`.

If it should also appear as a sidekick library plugin, add a row to `tools/sidekick/config.json` with an **absolute aem.live URL** (`https://main--aemdev--aemgdc.aem.live/tools/page-tracker.html`, `daLibrary: true`, `environments: ["edit"]`) — the target's existing `advanced-search` row is the model. Note the target's bio-manager header claims registration there and is **not actually in the file**; don't inherit that inconsistency.

---

## F. Risks and unknowns

### F.1 Needs a decision from the user before phase 1

| # | question | why it blocks |
|---|---|---|
| **F-1** | **Which 10 locales?** | `TARGET_LOCALES` drives crawl order, rollup sort, merge sort, locale tab names on every group sheet, the locale-selector button row, the sitemap language blocks, and the ten new `query.yaml` indices. The target's `scripts/scripts.js` declares six (`de es fr hi ja zh`); the source used nine (`de es fr it pl pt-br ja ko zh-tw`). Neither is ten. Also needed per locale: the connector's own code spelling (the source's `daCode` mismatches `pl`/`pl-PL`, `pt-br`/`pt-BR`, `zh-tw`/`zh-TW` are recorded precisely because that near-miss produces silent no-ops), `script` (latin/kana/hangul/han — the detection script gate depends on it), and the number-format `group`/`decimal` signature. |
| **F-2** | **Is `/en` a locale, or is the root the locale?** | `scripts/scripts.js`'s `locales` map has **no `/en` key**, so on `/en/articles/foo` `getLocale` matches only `''`: prefix `''`, and `localizeUrl` returns `null` immediately via the root-locale early return. All content sits under `/en/` while the framework thinks the root locale is `/`. Consequences today: `/en` is a plain folder not a locale, no link localization happens at all, `#_dnt` is inert, and header/footer fragments resolve to `/fragments/nav/header` (no `/en`) while bios live at `/en/fragments/bios` — two inconsistent fragment roots. **The tracker's entire path→locale mapping depends on this answer**, and requirement 2 cannot ship without it. |
| **F-3** | **What is the translation mechanism?** | Everything downstream of "sent for translation" depends on it. If it is DA's loc connector + Smartling (as in the source), then `tx-preview`, `tx-heal-links` and the DNT subsystem all apply nearly unchanged and `.da/translate` must be configured. If it is anything else — a different TMS, a human process, machine translation — then `tx-send` has no API to call, DNT does not exist, and the `sent` state must be recorded manually in the Page Tracker. **`tx-send.mjs` cannot be written until this is answered.** |
| **F-4** | **Is the tracker allowed to be publicly readable?** | The source's tracker sat behind site auth on a separate site; every page and feed returned 401. The target has one site with no auth, so `/tracker/**` is public once previewed. noindex is not access control. If the sign-off history, reviewer notes and per-page findings must be private, the tracker needs a separate site or a Fastly/headers ACL — a much larger change than Section E describes. |
| **F-5** | **Which host runs the LLM judges, and does it exist?** | The pipeline needs `llama-server` on ports 8080/8081/8082 with `qwen2.5-14b-instruct`, `qwen3-4b-instruct` and `qwen2.5-vl-7b-instruct` + its mmproj projector. If no such host exists, the tracker still works — `LlmUnavailable` maps to **exit 2, not 3**, deliberately ("the page holds, the pipeline continues") — but tier 2 and the vision judge produce nothing, and "auto QA complete" means tier 1 + tier 3 geometry only. Decide whether that is acceptable, or whether to swap `lib/llm.mjs`'s openai dialect for a hosted API (it is one tier config away, but the target has no LLM SDK and adding one is a new dependency and a new cost). |
| **F-6** | **Who holds DA write authority, and how?** | Every write path needs a token. The source's `resolveToken()` order is `DA_TOKEN` → cached S2S → `~/today-da-token.txt` → `~/today-auth-token.txt`, i.e. **~24 h IMS tokens a human refreshes manually**, and the source's own docs flag that the durable fix needs an IMS technical-account credential only an Adobe org admin can create. Without one, the tracker cannot run unattended, and `tx-scan` (which must run on a schedule for `previewed`/`online` to be current) becomes a manual chore. |

### F.2 Likely to break

| # | risk | mitigation |
|---|---|---|
| **F-7** | **The other session's bio-manager.** `tools/bio-manager/` and `tools/bio-manager.html` are **untracked** (`git status` `??`), forked from `arbory-da @ origin/bio-list` and deliberately not synced. Group `bios` depends on `/bios.json`'s exact column set (`Slug, Name, Title, Company, LinkedIn, Image, Path, Status, Updated`) and the fragment doc's metadata keys (`bio-name`, `bio-title`, `bio-company`, `bio-status`, `robots`). | Treat `/bios.json` as a **read-only contract**; never write it. Pin the column names in one adapter (`lib/group-map.mjs`) so a schema change is a one-file fix. Coordinate the `bio-translation-status` field explicitly — it belongs in the tracker's locale tab, not in the roster. |
| **F-8** | **`.agents/skills/diff/` already exists in the target at an older revision** (292 vs 370 lines, no `live-session.mjs`). Copying the source file wholesale breaks its import of `resolveProfile` if the target's `diff-profiles.mjs` has diverged, and creating a parallel copy leaves two diff tools. | Diff the two revisions and merge the source's delta (BotChallengeError, gotoLive, newLiveContext, per-side waitUntil) into the target file. Add `live-session.mjs`. Do not fork. |
| **F-9** | **`templates/` is gitignored in the target**, yet `templates/blog/blog.css` is tracked. A new `templates/meetup/meetup.css` will be silently ignored. | `git add -f templates/meetup/meetup.css`. |
| **F-10** | **`'meetups'` is missing from `templatedSections`**, so the 14 live meetup pages carry no `template` metadata (D.1). Any group sync that keys on `template` classifies them as ungrouped. | Group by **path prefix**, and separately fix `templatedSections`. |
| **F-11** | **Three competing `query.yaml` files**, two stale, both writing `/en/query-index.json` with different property sets (E.4). Editing the wrong one is a silent no-op; pushing a stale file **deletes deployed keys the repo copy lacks**. | Delete or clearly mark `/helix-query.yaml` and `/config/query.yaml`. Always sync-down before editing. |
| **F-12** | **Index config deployment is a manual GitHub Actions run**, gated on the `AUTH_TOKEN` secret and the `main` environment, and **pushing config does not backfill** — affected paths must be re-previewed at ≤10 req/s. A tracker that needs `aemdev-tracker` and `aemdev-bios` cannot self-provision them. | Sequence the index work as an explicit phase-1 gate with a named owner, not an implementation detail. |
| **F-13** | **`admin.hlx.page` is 10 req/s.** `tx-preview` at concurrency 6 plus `tx-scan` HEADing two hosts × 10 locales × N pages will hit it. | Port the source's `createRateLimiter`-equivalent posture and the source's retry-on-429/5xx-only rule; the target's own `tools/da/publish.js` already uses `createRateLimiter(10, 3000)`. |
| **F-14** | **The DA `.html` doc has no ETag**, so `If-Match` is unusable and `If-Unmodified-Since` is ignored. The residual race is the millisecond window between the pre-write read and the POST. | This is *why* the design is one doc per (page, locale) rather than sheet writes. Keep it, keep the re-read → conflict-check → `If-None-Match: '*'` on create → read-back-and-confirm sequence, and keep **one busy gate across all write controls**. |
| **F-15** | **The published index has a hard size ceiling.** 1,301 rows / 685 KB was refused outright by the content bus (while a 38 KB rollup went through), and the source's fix — list present pages only — merely defers it. With 4 groups × 10 locales the target is far below the ceiling today, but the ceiling scales with rollout, not the catalogue. | Keep `meta[0] = {expected, listed, withheld}` so a short index reads as explained rather than as lost data, and keep the per-(locale, group) split path open — the app's `?locale=&group=` navigation already supports it. |
| **F-16** | **Single-writer contention.** `tx-driver` prints `⚠ single-writer: stop any pipeline run on another machine first` for a reason: 7 of 9 sheet writes 412'd running nine locales back to back, from the previous locale's preview settling inside the read-to-write window. Ten locales makes this worse. | Port the batched-one-write-per-run design and the single 412 retry (not a loop). Port the writer lock. |
| **F-17** | **The source's tier-status truth lives in a gitignored single-machine JSON file.** `language-scan.mjs` reads `lang-production-status` from the Mule's local ledger, while `language-driver.mjs` writes it to a locale tab nobody reads. The survey calls this "the weakest link in the whole state model". | Do not reproduce it. In the new model the locale tab is the single source of truth for `translation-status`; the ledger is run bookkeeping only. `tx-scan` reads the sheet. |
| **F-18** | **`visual-judge.mjs`'s exit codes are fiction** — it always exits 0 on a successful call regardless of what the model said, so any gate shelling out to it passes unconditionally. | Do not wire it into a gate before the JSON-verdict rewrite lands. |
| **F-19** | **Judge confidence violates its own schema.** Live reports carry `"confidence": 95` against a 0..1 schema; llama.cpp's `strict` schema forcing does not enforce numeric ranges, nothing normalizes it, and nothing gates on it despite the header comment claiming "low confidence → escalate". | Normalize on read (`c > 1 ? c/100 : c`), and either implement the confidence gate or delete the claim. |
| **F-20** | **`escalation.maxAttempts: 3` has no reader.** `attempts` is incremented and never compared. A page can loop forever. | Wire it or delete it, and say which. |
| **F-21** | **Trailing slashes 404** on aemdev article paths (documented in `content-model.md:240`). A crawl that follows an authored trailing-slash link records a 404 as a tracked page. | Normalize trailing slashes in every tracker URL key, at the one place paths enter the model. |
| **F-22** | **`config/sites/aemdev/site.json` contains a live `apiKeys` entry and a plaintext Fastly `authToken`.** | Do not extend that pattern. Every tracker secret goes in GitHub Actions secrets or the env, never a committed config. |

---

## G. Build order

Eight phases. Parallel lanes within a phase are marked ‖.

### Phase 0 — Foundations and guards (blocks everything; ~1 session)
1. Answer **F-1** (locales) and **F-2** (`/en` as a locale). Nothing downstream is correct without these.
2. `scripts/tracker/` skeleton + `README.md` stating the `.js`-not-`.mjs` rule.
3. ‖ Port `tools/tracker/check-browser-modules.mjs` and `check-deployed-modules.mjs`; wire `lint:browser` / `verify:host`. **These land first, not last** — one `.mjs` in the app's graph means the app does not boot for anyone, and the failure is invisible to anonymous testing.
4. ‖ `.tracker/` skeleton; `.gitignore` additions; `lint:tracker` script.
5. Port `tools/tracker/config.mjs` (new env prefix, new `publish`, new locale list, four-group registry) + `lib/llm.mjs` **as-is** + `lib/da-ims.mjs` + `lib/status-sheet.mjs` (keeping the `W/` weak-validator strip).

### Phase 1 — Model modules and their tests (gates 2, 3, 5, 6)
6. `scripts/tracker/stages.js` — Section C in full, with unit tests before any consumer exists. This is the one file everything else agrees through.
7. ‖ `scripts/tracker/locales.js`, `paths.js`, `subgroups.js` (verbatim), `block-utils.js`.
8. ‖ `scripts/tracker/detect.js` — carve out of `migration-language.js`, minus SAS brand terms, with the script gate / `WORD_WEIGHTS` / `evidence()` / confidence-split tests intact.
9. `scripts/tracker/qa-doc.js` + `tx-doc.js` (+ jsdom-based Node tests). Marker regexes built **longest-alternation-first**.
10. `scripts/tracker/data.js`.
11. **Gate:** `npm run lint:browser` clean; model tests green.

### Phase 2 — Group scaffolding and the first sheets (gates 4, 6, 7)
12. `lib/group-sheet.mjs` (new `DATA_COLUMNS`/`LOCALE_COLUMNS`), `lib/group-map.mjs` (path-prefix resolver), `lib/scope.mjs`.
13. `scaffold-group.mjs`, `finalize-group.mjs`, `upgrade-columns.mjs`, `set-en-status.mjs`, `set-subgroup.mjs`, `move-row.mjs`.
14. `sync-groups-from-index.mjs` — the rewritten `list-apply`, reading `/en/query-index.json` + `/bios.json`.
15. Create the four group sheets in DA; run a sync; eyeball the row counts.
16. ‖ `scaffold-requirements.mjs` + `lib/requirements.mjs`; author the four `-brief.md` files (Section D.3) and the four baselines.
17. **Gate (F-12, manual):** deploy `aemdev-bios` and `aemdev-tracker` indices; verify the targets return JSON.

### Phase 3 — EN-side auto-QA (requirement 1, first half)
18. `structural-qa.mjs` (de-SAS'd) → `judge.mjs` (de-SAS'd, confidence normalized) → `qa-driver.mjs`, ledger, escalations jsonl.
19. `lib/extract.mjs`, `lib/qa-doc-io.mjs`, `sync-review-status.mjs`.
20. `build-rollup.mjs` (both invariant assertions live from the first run) + `build-escalations.mjs` (**F6 fixed**) + `watch-rollup.mjs`.
21. **Gate:** `npm run qa:batch` on `technical-articles` produces reports, a ledger, `/tracker/data/rollup.json`, and per-page docs at `/tracker/qa/`.

### Phase 4 — EDS tracker pages (requirement 4) ‖ Phase 5
22. `blocks/status-primer` first — it renders from the model with **no data fetch**, so it validates the enums before any feed exists. Fix F10 by exporting the map.
23. ‖ `blocks/tracker-summary`, `blocks/group-progress` (F1 fixed), `blocks/work-queue` (F5 fixed), `blocks/escalation-list` (F3, F16, F17 fixed).
24. Author `/tracker/`, `/tracker/dev`, `/tracker/how-to-use-this` in DA, each with a `\| robots \| noindex, nofollow \|` metadata row.
25. **Gate (E.3):** deploy the `/tracker/**` `x-robots-tag` header and the robots.txt Disallow; verify `/tracker/` is absent from `/en/sitemap.xml` and that the feeds carry the header.

### Phase 5 — Page Tracker DA app (requirement 5) ‖ Phase 4
26. `tools/tracker/app-harness.mjs` **before** the app, on playwright, with live-pulled cached fixtures. Read-only by construction.
27. `tools/page-tracker.html` + `da-source.js` (both asymmetries, the full write path, the versioning table) + `page-tracker.js` boot.
28. `rows.js` → `table.js` (with the always-three tier chips and the clickable empty state) → `drawer.js` (merged; **one busy gate**; the EN→locale pair list).
29. `page-tracker.css`, tokens rebased onto the target palette with `--pt-*`.
30. Tests: `test/tools/page-tracker/{rows,table,drawer}.test.js`.
31. **Gate:** `npm run harness` exits 0; `npm run verify:host` green on both hosts; `?readonly=1` clickthrough.

### Phase 6 — Translation pipeline (requirement 2) — depends on F-3
32. `tx-scan.mjs` first — it is the only thing that observes `previewed` and `online`, so it gates every other translation tool. Crawls **both** hosts per locale. F8 shadowing fixed, duplicate marker parser deleted.
33. `tx-send.mjs` (shape depends entirely on F-3) and `tx-preview.mjs`.
34. `tx-qa.mjs` (tier 1) → `tx-judge.mjs` (tier 2, new SUPPRESS + glossary) → `tx-driver.mjs`.
35. ‖ `tx-visual.mjs` (tier 3, playwright, three widths) — independent of tiers 1–2 and can be built in parallel.
36. `publish-tx-reports.mjs`, `tx-reconcile.mjs`, `tx-heal-links.mjs`, `mark-tx-status.mjs`.
37. `blocks/translation-matrix` (F2, F9, F17 fixed) + `/tracker/translations`.
38. Extend the Page Tracker with the locale-selector button row and per-locale filters.
39. **Gate:** one page, one locale, end to end — `catalogued → enPublished → sentForTranslation → previewed → autoQaPass → layoutQaPass → inReview → reviewOk → online`, with the hub and the app agreeing on every count.

### Phase 7 — Visual comparison, optional subsystems, hardening
40. ‖ Merge the source's `visual-diff.mjs` delta into the target's copy; add `live-session.mjs`; strip the skill finding numbers from `diff-profiles.mjs`.
41. ‖ `visual-compare.mjs` (playwright, config-driven URL map, both documented defects fixed) and `visual-judge.mjs` (**JSON verdict + real exit codes**, `sharp` cropping).
42. ‖ `lib/dnt.mjs` — **only if F-3 says there is a `.da/translate` contract.** Port the throw-on-unparseable safety asymmetry verbatim.
43. ‖ `blocks/data-quality` + `/tracker/data-quality` with aemdev rules (missing bios, stale `template` meta, trailing-slash 404s, pages absent from the index).
44. `docs/tracker/*.md`; `.agents/skills/tx-qa/`; `npm run verify` in CI.

**Critical path:** F-1/F-2 → phase 1 (`stages.js`) → phase 2 (sheets) → phase 6 step 32 (`tx-scan`) → phase 6 step 39. Phases 4, 5 and 7 are fully parallelizable against phase 6 once phase 2 lands, and phase 3 is independent of phase 6 entirely. F-3 blocks only phase 6 steps 33 and 42; the rest of phase 6 can be built against a manually-set `sent` status.