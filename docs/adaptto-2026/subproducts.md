# Subproduct build list

Everything that has to exist as code. Content is in [content-plan.md](content-plan.md);
dates are in [schedule.md](schedule.md).

**Legend — State:** `none` (not started) · `ported` (in this repo, unverified against
`aemgdc/aemdev`) · `exists` (in this repo, working) · `external` (lives in another repo,
needs porting).

## Summary

| # | Subproduct | Tier | State | Owner | Est. | Due |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | DA plugin registration + tools shell | — | **3 of 6 live** | Tad | 0.5d | 23 Aug |
| S2a | TagsServlet fix + `aemdev` tag namespace (AEM side) | 1 | **root cause found** | **Tad** | 1d | 28 Aug |
| S2b | Tag Picker config + page tag read-back (DA plugin) | 1 | ported | **Laurel** | 2d | 5 Sep |
| S3 | Icon Picker | 1 | none | Laurel | 2.5d | 5 Sep |
| S4 | Bio Manager | 1 | external | Tad | 2d | 12 Sep |
| S5 | Advanced Search | 2 | ported | Laurel | 1d | 12 Sep |
| S6 | Form Picker | 1 | none | Tad | 3d | 12 Sep |
| S7 | Preflight + publish workflow | 1 | exists (generic) | Tad | 2d | 12 Sep |
| S8 | Translation Tracker cameo | 3 | external | Tad | 0.5d | 18 Sep |
| S9 | Meetup blocks + `/en/meetups/` rename | — | none | Tad | 2.5d | 5 Sep |
| S10 | Fixture/offline mode across plugins | — | none | Laurel | 1d | 18 Sep |
| S11 | Query index & config hygiene | — | partial | Tad | 1d | 28 Aug |

---

## S1 — DA plugin registration + tools shell

**Tier:** foundation (nothing else demos without it). **Owner:** Tad. **Est:** 0.5d.

**Status: registered and live server-side. Browser check outstanding.**
[`tools/sidekick/config.json`](../../tools/sidekick/config.json) is deployed — the resolved
config now returns all three plugins:

```
$ curl -s https://admin.hlx.page/sidekick/aemgdc/aemdev/main/config.json
  plugins: 3
  - tag-picker       .../tools/tagpicker/tagpicker.html
  - preflight        .../tools/preflight/preflight.html
  - advanced-search  .../tools/advanced-search.html
```

What that proves: the file deployed, the config service merged it, and the plugin URLs
resolve. What it does *not* prove: that they render and run inside DA's Library panel — that
needs a browser and a DA login. See [Remaining work](#remaining-work).

### How registration actually works (verified 16 Aug)

An earlier draft of this doc said DA reads its config from the content bus and the repo file
"has to be synced/published". **That was wrong — the repo file is picked up automatically.**
The config service merges `tools/sidekick/config.json` from the code repo with the
auto-derived hosts and serves the result at:

```
https://admin.hlx.page/sidekick/{org}/{site}/{ref}/config.json
```

Confirmed against a working reference — `arbory-da`'s resolved config returns its `plugins`
array verbatim from the repo file, alongside `previewHost` / `liveHost` / `host` /
`contentSourceUrl`. No config-service POST, and **none of the `update-*-configuration`
workflows apply to it** — those push `config/sites/aemdev/*` (see [S11](#s11--query-index--config-hygiene)).

aemdev's resolved config before this change:

```json
{"previewHost":"main--aemdev--aemgdc.aem.page","liveHost":"main--aemdev--aemgdc.aem.live",
 "host":"www.aemdev.org","contentSourceUrl":"https://content.da.live/aemgdc/aemdev/",
 "contentSourceType":"markup"}
```

No `plugins` key at all, which is why the DA library panel was empty.

### ⚠️ Use `aem.live`, not `hlx.live`

The `arbory-da` config we modelled this on points its plugin at
`main--arbory-da--arbory-digital-inc.hlx.live/tools/tags.html`, and **that URL returns 403**.
The same path on `aem.live` returns 200. So the reference implementation's Tag Browser plugin
is almost certainly broken in DA right now — worth fixing in `arbory-da` separately, and worth
not copying here. All three URLs in our config use `aem.live` and were verified 200.

### Registered now

| Order | Plugin | URL | Live |
| --- | --- | --- | --- |
| 1 | Tag Picker | `/tools/tagpicker/tagpicker.html` | 200 |
| 2 | Preflight | `/tools/preflight/preflight.html` | 200 |
| 3 | Advanced Search | `/tools/advanced-search.html` | 200 |

Note the path shapes differ — `advanced-search.html` sits at `tools/` root while the other two
are inside their own directories. Both work; don't "fix" one to match the other without
checking the relative imports inside each HTML file.

### Still to add

Bio Manager (S4), Icon Picker (S3) and Form Picker (S6) don't exist yet. Each is a 6-line
addition to the `plugins` array when it lands.

**Final running order** — plugins render in array order, and reordering on stage is a fumble,
so land this order before rehearsal #1: Bio Manager → Icon Picker → Tag Picker → Form Picker →
Preflight → Advanced Search. The current three are already in their correct relative order.

### Remaining work {#remaining-work}

- **Verify in DA.** Open `da.live/edit#/aemgdc/aemdev/...` and confirm all three appear in the
  Library panel and open without console errors. This is the acceptance test and it can't be
  done from the CLI — it needs a browser and a DA login.
- **Decide on `scheduler` / `quick-edit`.** [tools/sidekick/sidekick.js](../../tools/sidekick/sidekick.js)
  wires `custom:scheduler` and `custom:quick-edit` listeners, but nothing has ever fired them —
  there was no config.json to declare those plugins. They are currently dead code. Either
  register them or accept they stay dormant through the talk; deliberately left out of the
  config for now to keep the demo panel to demo plugins.
- **One shared `tools/shared/` module:** `DA_SDK` bootstrap, auth headers, error banner, the
  fixture-mode flag (S10). Every plugin should import it rather than re-implementing.

**Acceptance:** all six plugins appear in the DA library panel for `aemgdc/aemdev`, in the
demo's running order, each opening without console errors.

---

## S2 — AEM Tag Picker (split: S2a AEM / S2b plugin)

Split into two independently-owned pieces so neither person blocks the other. **Tad owns
everything on the AEM side of the wire (S2a); Laurel owns everything on the DA side (S2b).**
The [interface contract](#s2-interface-contract) between them is fixed in week 0 so S2b can
start before S2a lands.

**Shared starting state:** already in this repo at [tools/tagpicker/](../../tools/tagpicker/) —
`tagpicker.js` (~4.1k), `tagpicker.css`, `tagpicker.html`, a thorough
[README.md](../../tools/tagpicker/README.md), and the `TagsServlet.java` source. Hierarchical
browse, breadcrumb, add-to-list, batch insert, pipe-delimited `category|subcategory|tag`
output, 9 languages.

### Environments — DEV, not PRD

**Design decision (Tad):** aemdev.org points DA at the **DEV** publisher, not PRD. This is a
demo site, and pointing at DEV keeps the whole loop in one environment.

| Role | Host |
| --- | --- |
| Author (tag authoring) | `https://author-p121227-e1183758.adobeaemcloud.com/ui#/aem/` |
| Publish (what the picker reads) | `https://publish-p121227-e1183758.adobeaemcloud.com` |
| Deploys from | `develop` branch of `~/git/arbory-digital-inc/arbory-aemaacs` |

Same program (`p121227`), different environment — PRD was `e1306133`, DEV is `e1183758`. Every
endpoint in this doc that used to say PRD now means DEV.

**Workflow:** feature branch → PR into `develop` → deploys to DEV AEMaaCS. Authoring the tags
themselves can be done directly against author via the AEM MCP, no deploy needed.

### The backend is broken and there is no taxonomy

Verified 16 Aug 2026 against **DEV** publish (PRD behaves identically):

```
GET /services/tagsservlet             → HTTP 500
GET /services/tagsservlet.all         → HTTP 500
GET /services/tagsservlet.de|.en|.es  → HTTP 500      ← language selectors also fail
GET /services/tagsservlet.aemdev      → HTTP 200, "ERROR: Invalid Tag Catgegory"
GET /services/tagsservlet.topic|foo   → HTTP 200, "ERROR: Invalid Tag Name"
GET /   (publish root)                → HTTP 200      (the instance itself is healthy)
```

### 🔎 Root cause found — it's one hard-coded line

No log-diving needed. [`TagsServlet.java:46`](https://github.com/arbory-digital-inc/arbory-aemaacs/blob/develop/core/src/main/java/com/arborydigital/core/servlets/TagsServlet.java)
on `develop`:

```java
private static final String TAGS_PATH = "/content/cq:tags/jmp";
```

**The servlet is hard-coded to JMP's tag namespace.** It was lifted from JMP's implementation —
the OSGi component still declares `Constants.SERVICE_VENDOR + "=JMP"`. There is no
`/content/cq:tags/jmp` node on the Arbory instance, so `resolver.getResource(TAGS_PATH)` returns
`null`.

Three methods then call `.adaptTo(Node.class)` on that null without a guard:

| Method | Line | Endpoint it serves |
| --- | --- | --- |
| `getAllTags` | 194–196 | `/services/tagsservlet` — **the picker's init call** |
| `getAllTagCategories` | 200–201 | `.all` |
| `getTagsByLanguage` | 291–292 | `.{lang}` — **the label map** |

Each NPEs. The `catch` block only handles `RepositoryException`, so the NPE escapes the servlet
and Sling turns it into a 500.

By contrast `getTagsByCategory` (215) and `getTagByName` (233) *do* null-check — which is
exactly why those return HTTP 200 with an error string instead of failing. That asymmetry
explains the whole observed behaviour, and it means the 500 and the misleading-200 are two
separate defects in the same file.

Note the third row: **`.{lang}` is the label-map endpoint** the whole translation design depends
on. It is currently a 500, so fixing this is not optional polish.

### The fix

Small, and all in one file:

1. **`TAGS_PATH` → `/content/cq:tags/aemdev`.** Better: make it an OSGi config property so the
   namespace isn't a recompile. It is the reason this servlet isn't reusable, and the talk is
   partly about reusable authoring tooling.
2. **Null-guard the three lookups** — return 404 with a JSON error body, not an NPE.
3. **Fix the status-code contract** — invalid category should be 404 + JSON, not 200 +
   plain text. Laurel's fallback logic keys off this.
4. **Fix the typo** — `Invalid Tag Catgegory`, twice. It ships in the response body.
5. **`SERVICE_VENDOR`** → Arbory, while you're in there.

Compare against the healthy reference throughout: `https://www.jmp.com/services/tagsservlet`
is the same servlet working correctly, and its response shapes are documented in
[content-model.md](content-model.md#label-translation--the-mechanism-already-exists).

---

### S2a — TagsServlet fix + `aemdev` tag namespace

**Tier:** 1. **Owner:** Tad. **Est:** 1d (down from 1.5 — the root cause is found).
**Due:** Fri 28 Aug. **Repo:** `~/git/arbory-digital-inc/arbory-aemaacs`, **DEV** author →
publish.

The two halves are independent and can go in either order — the namespace is authored
through the UI/MCP and needs no deploy; the servlet fix needs a PR.

**Servlet (feature branch → PR into `develop` → deploys to DEV):**

1. Apply [the fix above](#the-fix) — `TAGS_PATH`, the three null guards, the status-code
   contract, the typo. Root-causing is done; this is a patch, not an investigation.
2. Verify against DEV publish, from outside the network.
3. Re-check the CDN rule allowing `/services/tagsservlet` through — the picker reads from
   publish, not author.

**Namespace (directly against DEV author, via the AEM MCP or the UI):**

4. **Create `/content/cq:tags/aemdev`** with `topic` / `category` / `region` and the tags in
   [content-model.md](content-model.md#what-the-tag-namespace-must-now-contain). Note this
   supersedes the older `event`/`format` list.
5. **Add German (`de`) titles** on at least `topic` and `category` — this is what makes the
   `.de` label map worth demoing, and `.{lang}` is one of the endpoints the fix repairs.
6. **Activate to publish.**
7. **Hand off the fixture** — capture a real response to
   `tools/tagpicker/fixtures/tags.json` and commit it. That unblocks S2b regardless of
   environment availability.

**Acceptance:**
- `GET /services/tagsservlet.aemdev` returns HTTP 200 with the full `aemdev` hierarchy as JSON.
- `GET /services/tagsservlet` and `.all` return 200, not 500.
- `GET /services/tagsservlet.nonsense` returns 404 with a JSON error body.
- `GET /services/tagsservlet.aemdev.de` returns German titles for the topic tags.
- All four verified from outside the network, against the publish host, by 28 Aug.

---

### S2b — Tag Picker configuration + page tag read-back

**Tier:** 1. **Owner:** Laurel. **Est:** 2d. **Due:** Fri 5 Sep. **Depends on:** the S2a
fixture (not the live servlet — start against the fixture on day one).

**1. Configure the picker for `aemdev`.**
- Point `tagURL` at **DEV publish** (`publish-p121227-e1183758`) and scope to the `aemdev` namespace.
- Decide and document the on-page output format (see the matching trap below).
- Register in `tools/sidekick/config.json` per [S1](#s1--da-plugin-registration--tools-shell).

**2. Page tag read-back — the actual feature.** Read the tags already on the current DA page
and render them as pre-selected in the hierarchy, so the picker is an **editor** of the page's
tags rather than an append-only inserter. This is the work Laurel is doing on
`~/git/jmphlx/jmp-da` — port it here rather than maintaining a fork.

Design decisions worth settling before writing code:

- **Read from DA source, not the rendered page.** Fetch
  `https://admin.da.live/source/{org}/{site}{path}.html` with the `DA_SDK` token and parse the
  `metadata` block's tags row. Reading the `.aem.page` render instead would miss tags on a
  page the author hasn't previewed yet — which is exactly the page they're editing.
- **The matching trap.** Per the tagpicker README, values are display-normalized on the way
  out: lowercased, spaces → hyphens, `&` → "and", and a `(intro-stats)-` prefix stripped.
  That transform is **lossy**, so reversing a stored string back to a taxonomy node is
  guesswork. Two options — pick one and write it down:
  - *(preferred)* store the canonical AEM tagID on the page and render a friendly label from
    the taxonomy at display time. Clean matching, but it changes the on-page format, so
    check it against what [helix-query.yaml](../../helix-query.yaml) indexes from
    `head > meta[property="article:tag"]` and what `blocks/` consume.
  - normalize both sides at compare time and accept that collisions are possible.
- **Unresolvable tags must survive.** A tag on the page that no longer exists in the taxonomy
  has to be shown as an unknown/orphan chip, not silently dropped. Dropping an author's tags
  on save is a data-loss bug, and on stage it would be a visible one.
- **Write-back is replace, not append** — that is what makes it an editor. Confirm the insert
  path replaces the whole tags row.

**3. Cached-taxonomy fallback** (R1 mitigation). Fall back to the committed
`tools/tagpicker/fixtures/tags.json` on any non-2xx, timeout, or malformed response, with a
visible "using cached taxonomy" notice. Outage insurance *and* conference-wifi insurance;
also what lets this plugin participate in fixture mode ([S10](#s10--fixture--offline-mode)).

**Acceptance:** on `/en/meetups/2026-10-berlin-meetup`, opening the picker shows the page's
existing tags pre-selected and any orphan tag flagged; adding two and inserting rewrites the
metadata correctly; removing one removes it from the page; cutting network access to the
sandbox degrades to the cached taxonomy with a visible notice rather than an empty panel.

---

### S2 interface contract

Fix this in week 0 so S2a and S2b proceed in parallel. Neither side changes it unilaterally
after **28 Aug**.

| | |
| --- | --- |
| **Endpoint** | `GET https://publish-p121227-e1183758.adobeaemcloud.com/services/tagsservlet.aemdev[.{lang}]` — **DEV**, not PRD |
| **Success** | HTTP 200, JSON array of nodes: `{ "jcr:title", "jcr:title.{lang}", "path", "children": [] }` |
| **Invalid category** | HTTP 404, JSON error body |
| **Namespace root** | `/content/cq:tags/aemdev` |
| **Fixture** | `tools/tagpicker/fixtures/tags.json` — a real captured response, committed by Tad, refreshed whenever the taxonomy changes |

The fixture is the contract's teeth: Laurel builds and rehearses entirely against it, so an
AEM-side delay slips S2a only, never S2b.

---

## S3 — Icon Picker

**Tier:** 1. **Owner:** Laurel. **Est:** 2.5d. **State:** none — net-new, and the cheapest
big-impact item on the list.

**Work:**
- Icon source: SVGs committed under `icons/` in this repo, indexed by a build step or a
  small manifest sheet (name, keywords, category). Decide manifest-vs-scan by 29 Aug; a
  committed `icons/manifest.json` generated by an npm script is the low-risk choice.
- Grid UI with live search over name + keywords, category filter, hover preview, size and
  colour-token selection.
- Insert path: emit whatever the site's icon convention is (EDS `:icon-name:` shorthand vs.
  inline `<span class="icon icon-name">`). Match what `scripts/scripts.js` already decorates
  — check before building, don't invent a second convention.
- Empty/failed state that doesn't look broken on a projector.

**Acceptance:** searching "calendar" filters to the calendar icons in under a keystroke's
lag; inserting places an icon that renders correctly on preview without hand-editing.

**Note:** this is the tool most likely to be judged on *polish* rather than function — it's
2.5 minutes of pure visual demo. Budget the time for the grid to look good at projector
resolution.

---

## S4 — Bio Manager

**Tier:** 1. **Owner:** Tad. **Est:** 2d. **State:** external.

**Source:** `~/git/arbory-digital-inc/arbory-da`, branch **`origin/bio-list`** (unmerged):

```
tools/bio-manager.html
tools/bio-manager/bio-manager.css
tools/bio-manager/bio-manager.js     (1041 lines)
```

It already does the hard parts: `DA_SDK` auth, Adobe Asset Selector integration for
headshots, create/manage tabs, a bios sheet as the index, fragment creation under a folder
chain via `https://admin.da.live/source`, slugify, validation, retry banners.

**Hard-coded Arbory specifics to lift into config:**

```js
const SHEET_PATH = '/private-bios';
const FRAGMENTS_FOLDER = '/en/fragments/bios';
const DAM_DEFAULT_PATH = '/content/dam/blog/hero-images/';
const FOLDER_CHAIN = ['/en', '/en/fragments', '/en/fragments/bios'];
const COL_EMAIL = 'Email'; COL_PATH = 'DA Fragment URL'; COL_NAME = 'Name'; COL_CREATED = 'Created';
```

**Work:**
1. Copy to `tools/bio-manager/`, hoist the constants above into a single `CONFIG` object at
   the top of the file, retarget to `aemgdc/aemdev` paths.
2. Point `DAM_DEFAULT_PATH` at a DAM folder on **DEV** that actually has headshots
   in it — the Asset Selector opening on an empty folder is a bad stage moment.
3. Extend the schema for the demo's needs: `Role`, `Company`, `Talk Title`, `Social`.
   Podcast-guest fields from the Arbory version can stay if harmless, but don't demo them.
4. Author-facing polish: the create form must be fillable in ~40 seconds on stage.
   Pre-stage the headshot so the Asset Selector step is a pick, not a hunt.

**Acceptance:** creating "Jane Doe, Principal Engineer" with a headshot produces a fragment
at `/en/fragments/bios/jane-doe`, adds a sheet row, and the fragment renders on the event
page via a `fragment` block reference.

**Do not** attempt to keep this in sync with `arbory-da`. Fork it, note the provenance in a
header comment, move on.

---

## S5 — Advanced Search

**Tier:** 2. **Owner:** Laurel. **Est:** 1d (verification, not build). **State:** ported.

**Already in this repo** at [tools/advanced-search/](../../tools/advanced-search/) —
`search.js`, `ui.js`, `replace.js`, `publish.js`, `helper.js`, `search.css`, plus
`tools/advanced-search.html`. Upstream is `~/git/jmphlx/jmp-da/tools/search/` (~1.7k lines
across `search.js` 661, `ui.js` 645, `replace.js` 344, `publish.js` 42) with a
[strong README](https://github.com/jmphlx/jmp-da/tree/main/tools/search).

Capabilities worth naming on stage: block-centric search, property-row search, publish-status
search, empty-row search, bulk versioning before modification, **undo**, prepend/replace/append
text modification, add/delete/merge rows, permissions sheet gating.

**Work — this is a verification and diff task, not a build:**
1. Diff `tools/advanced-search/` against current `jmp-da/tools/search/`; pull forward any
   fixes made upstream since the port.
2. Retarget org/repo defaults, the default search path, and the permissions sheet to
   `aemgdc/aemdev`.
3. Confirm the `pagetree` modal (this repo has [tools/pagetree/](../../tools/pagetree/)) opens
   for custom-path selection.
4. **The demo case is now a bulk *append*, not a replace.** Every `/en/meetups/` page is
   supposed to end with the *Join the Collective* form; the dozen pages generated from videos
   and blog posts won't have one, because nothing put it there. So the operation is "add this
   block to fourteen pages", which is a real content-operations task rather than a planted
   one. See [content-plan.md](content-plan.md#this-gives-act-3-a-better-story) — and note the
   corresponding instruction *not* to add the footer form when generating those pages.
5. Rehearse the *undo* — showing undo is what makes bulk-edit demos land instead of terrify.

**Acceptance:** a block+property search across `/en/meetups/` returns ≥12 pages, versions them,
bulk-appends the form block, and undoes cleanly — in under 2 minutes with narration.

---

## S6 — Form Picker

**Tier:** 1. **Owner:** Tad. **Est:** 3d. **State:** none — the largest net-new item and the
biggest unknown.

**Goal:** browse forms published in Forms Cloud Service, preview, pick one, and place a
configured form block on the page.

**Related prior art:** `~/git/arbory-digital-inc/arbory-forms` (aem-boilerplate-forms based —
has `component-definition.json`, `component-models.json`, `component-filters.json`, and a
commit "Adding configurable logic for forms testing & endpoint"); `~/git/arbory-digital-inc/sas-da`
branches `forms`, `test-forms`, `SANDBOX/bryce_aem-forms-demo`.

**Week-1 spike (by 23 Aug) — answer these three, then commit to a design:**
1. What endpoint lists published forms on the target Forms CS environment, and what does it
   return?
2. Does it authenticate in a way a browser-side DA plugin can use, and does CORS permit the
   `aem.live` origin?
3. What markup does the EDS forms block expect — a form path, a full URL, an embed?

**If the spike fails** (likely enough to plan for): fall back to a published forms manifest
sheet in DA, populated by a scheduled sync, and say so plainly on the slide — "your author
sees a live list; how it's populated is your integration choice." That is an honest and
still-impressive demo.

**Work:**
- Form list with search/filter and form-type facets.
- Preview pane — thumbnail or field summary. A form picker that can't show you the form is
  a dropdown with extra steps.
- Insert a correctly-configured forms block; verify it renders on preview.

**Acceptance:** picking "AEM GDC Berlin RSVP" from a list of ≥4 real forms places a block
that renders a working RSVP form on the preview URL.

---

## S7 — Preflight + publish workflow

**Tier:** 1. **Owner:** Tad. **Est:** 2d. **State:** exists, generic.

**Already here:** [tools/preflight/preflight.js](../../tools/preflight/preflight.js) — ~18KB,
Lit 3.2.1 from esm.sh, `DA_SDK`, standalone (no da-live deps), inline Adobe S2 icons,
collapsible category results with success/info/warn/error badges. Solid foundation.

**Work:**
1. **Site-specific rules for aemdev.** The demo needs a rule set that fails *believably*:
   - required metadata per template (`event-date`, `event-location`, `event-speakers` — these
     are already indexed in [helix-query.yaml](../../helix-query.yaml) for meetup-recaps)
   - image alt text
   - internal link validity (`/en/insights` is currently a real broken link from the home
     page — use it)
   - heading order / a11y basics
   - tag presence (ties S2 into the governance story)
2. **Rules as content, not code.** Drive them from a config sheet in DA so the slide can say
   "your governance team edits this, not your developers." Strong beat.
3. **Publish hook.** On publish, fire a webhook → Slack post announcing the new event page,
   and an AEM workflow kickoff on **DEV**. Implement in `workers/` (this repo already
   has a `workers/` directory and Fastly config under `config/fastly/`) or as a small
   listener. **Show the notification arrive on screen** — an unobserved webhook is not a demo.
4. Blocking vs. advisory: demo it as advisory-with-teeth (publish allowed, warnings logged).
   Claiming a hard block we haven't built is the kind of thing an adaptTo() audience catches.

**Acceptance:** preflight on the unfinished event page reports exactly 3 failures; fixing two
live re-runs green-ish; publishing posts to Slack within ~10 seconds, visible on screen.

---

## S8 — Translation Tracker cameo

**Tier:** 3. **Owner:** Tad. **Est:** 0.5d. **State:** external (SAS programme).

Not built here. Deliverable is **one slide + a 20–30 second screen capture** taken from the
SAS environment, showing translation status tracked against source, with a German version of
a page. Berlin audience, German translation — the beat is worth 30 seconds and zero live risk.

**Constraint:** scrub client-identifying content from the capture before it goes in the deck.
Check this explicitly at slide freeze.

**Acceptance:** capture recorded and in the deck by 18 Sep, or the beat is cut. No live driving.

---

## S9 — Meetup blocks + the `/en/meetups/` rename

**Tier:** foundation. **Owner:** Tad. **Est:** 2d (+0.5d rename). **State:** none.

**Scope changed** — this was "event blocks + a new `/en/events/` index". It is now the
`/en/meetups/` lifecycle model: one folder for announced, upcoming and recapped events, with
the rename done first. Rationale and the full work list are in
[content-plan.md](content-plan.md#the-enmeetups-model). There is no `/en/events/` tree.

Today this repo has `/en/articles/**` and `/en/meetup-recaps/**` indices in
[helix-query.yaml](../../helix-query.yaml) with `event-date`, `event-location`,
`event-speakers`, `recap-video` — a backward-looking shape. An announced or upcoming event has
no video and may not have a date yet, so the model has to carry status.

**Work:**

1. **Rename first, week 0.** `/en/meetup-recaps/` → `/en/meetups/`, 1:1 redirect, nav and
   footer updated. One page exists today, so this is cheap now and expensive after Batch B
   authors a dozen more. **Blocks all content work.**
2. Rename the index in `helix-query.yaml`: `include: /en/meetups/**`,
   `target: /en/meetups/query-index.json`. Add `status` (`announced` | `upcoming` | `recap`),
   `rsvp-form`, `event-end-date`. Classification comes from the `aemdev:category/*` tag, not a
   parallel field. Keep `recap-video` — it just goes empty on
   non-recap pages.
3. **`meetup-hero` block** rendering all three states from one authored structure:
   date/venue/status header, with the agenda, speaker and RSVP regions degrading gracefully
   when empty. Do **not** build three blocks; the whole point is a page that changes state in
   place without being rebuilt.
4. Agenda rows (icon + time + item) — this is what [S3](#s3--icon-picker) feeds. Speaker
   fragment slots — [S4](#s4--bio-manager). RSVP / footer form slot — [S6](#s6--form-picker).
5. `meetup-card` listing block for `/en/meetups/`, splitting upcoming from past off `status`
   and `event-date`, so the page published on stage visibly appears in a list afterwards.
6. A DA **template** carrying the three states, so Act 1 starts from a template rather than a
   blank doc. This is what makes the live build fit in 7 minutes.
7. Reuse before building: this repo already has `blocks/schedule/`, `blocks/speaking/`,
   `blocks/card/`, `blocks/author-rows/`, `blocks/callout/`, `blocks/step/`,
   `blocks/youtube/`, `blocks/embed/`. Check each before writing anything new — B1's recap
   pages need video embeds and B2's need photo galleries, and both may already exist.

Follow the repo's `content-driven-development` skill for this one — it touches `blocks/`.

**Acceptance:** the old `/en/meetup-recaps/...` URL 301s to `/en/meetups/...`; a page authored
in each of the three states renders correctly at preview; all appear in
`/en/meetups/query-index.json` with `status` populated; the listing block sorts upcoming above
past; the template opens clean in DA.

---

## S10 — Fixture / offline mode

**Tier:** foundation (R4 insurance). **Owner:** Laurel. **Est:** 1d.

Every plugin gets a `?fixtures=1` flag that serves committed JSON instead of calling out to
AEM / Forms CS / DA search. Same code path, same UI, no network.

**Work:** fixture JSON per plugin under `tools/<plugin>/fixtures/`; a shared loader in
`tools/shared/`; a visible-but-unobtrusive badge when fixtures are active (never demo from
fixtures without knowing it).

**Acceptance:** with wifi off, every Tier 1 plugin opens and completes its demo path.

Rehearsal #2 (**21 Sep**) is run entirely in fixture mode with the laptop's network disabled.
If that rehearsal passes, conference wifi cannot ruin the talk.

---

## S11 — Query index & config hygiene

**Tier:** foundation. **Owner:** Tad. **Est:** 1d. **State:** partially working, with traps.

### Correction: the index is not missing

An earlier draft of [content-plan.md](content-plan.md) said "no published `query-index.json`
at any path". **That was wrong** — I probed `/query-index.json`,
`/en/articles/query-index.json` and `/en/meetup-recaps/query-index.json` but not the one that
actually exists. Verified 16 Aug:

```
GET /en/query-index.json  → HTTP 200, 4 rows, 25 columns
GET /en/sitemap.xml       → HTTP 200
```

The four indexed pages are `/en/`, `/en/contact`, `/en/meetup-recaps`, and one recap:
`/en/meetup-recaps/20260625-bring-your-complicated-eds-integration-story-meetup`
(`template: blog`, `category: Meetup Recap`, tags `AEM, EDS, Edge Delivery, Integrations,
Meetup, GDC`).

So the machinery works. The problem is that four rows can't feed a demo — and there are three
config traps underneath it.

### Trap 1 — `helix-query.yaml` is dead config

This site is `version: 8` with `content.source.type: markup` (DA). Its index config is served
from the **config API**, pushed by
[.github/workflows/update-index-configuration.yaml](../../.github/workflows/update-index-configuration.yaml)
→ [scripts/update-configs.mjs](../../scripts/update-configs.mjs) →
`POST https://admin.hlx.page/config/aemgdc/sites/aemdev/content/query.yaml`,
sourced from **[config/sites/aemdev/query.yaml](../../config/sites/aemdev/query.yaml)**.

There are three query configs in this repo and **only one is live**:

| File | Lines | Status |
| --- | --- | --- |
| `config/sites/aemdev/query.yaml` | 76 | **authoritative** — pushed by the workflow |
| `helix-query.yaml` | 98 | **dead** — legacy `fstab`-era location, not read for a v8/DA site |
| `config/query.yaml` | 46 | **dead** — not referenced by any workflow |

This matters because earlier planning docs told you to edit `helix-query.yaml` for the
`articles`, `meetup-recaps` and new `meetups` indices. Editing it would have had **no effect**
and the failure would have been silent. All of [S9](#s9--meetup-blocks--the-enmeetups-rename)
and the `/en/meetups/` rename must target `config/sites/aemdev/query.yaml` instead.

**Action:** delete or clearly comment the two dead files. A repo with three query configs and
no marking of which is real will burn someone again — probably during freeze week.

### Trap 2 — the repo copy has drifted from what's deployed

`config/sites/aemdev/query.yaml` is marked `auto-generated: true` but is **not** a faithful
copy of the live config. The deployed index emits 8 properties the repo file doesn't define:

```
bookAuthor, bookPublishDate, bookTypeTitle, displayLabel,
eventDateTime, eventDisplayLabel, eventDisplayTime, offDateTime
```

(Nothing goes the other way — the repo file is a strict subset.)

**So running `update-index-configuration` today would silently drop 8 columns and trigger a
full reindex.** That may well be desirable — the `book*` fields look like boilerplate
inherited from another project — but it must be a decision, not a surprise, and not something
discovered mid-rehearsal.

#### Why the drift was invisible — and the fix

The `update-*-configuration` workflows are **push-only**. `sync-site-json` reads `site.json`
back, but nothing read back `query.yaml`, `headers.json`, `robots.txt` or `sitemap.yaml`. So
the repo could diverge from the deployed config indefinitely with no signal, and the first
symptom would be a push silently deleting live config.

**Built:** [scripts/sync-site-configs.mjs](../../scripts/sync-site-configs.mjs) +
[.github/workflows/sync-site-configs.yaml](../../.github/workflows/sync-site-configs.yaml) —
the read-back counterpart, modelled on the Fastly pattern already in this repo: daily cron,
fetch each config, write it into `config/sites/<site>/`, commit if anything changed. Drift now
shows up as a commit instead of as a surprise.

Two details worth knowing:

- **The API path is not always the local filename.** `query.yaml` → `content/query.yaml` and
  `sitemap.yaml` → `content/sitemap.yaml`, while `headers.json` and `robots.txt` map
  straight through. The mapping lives in one table at the top of the script; keep it in step
  with the `CONFIG_NAME` values in the `update-*` workflows.
- **A 404 is treated as "not set" and skips the file** rather than truncating the local copy,
  and an empty 200 body is a hard error for the same reason. A sync job that can blank your
  versioned config is worse than no sync job.

**Untested against the live API** — it needs `secrets.AUTH_TOKEN`, which isn't available
locally. Syntax and lint are clean. First run should be a manual `workflow_dispatch` with the
diff reviewed by hand before trusting the cron.

**Action, in this order:**
1. Run `sync-site-configs` manually. The resulting diff *is* the drift report.
2. Decide on those 8 properties — keep (reconcile the repo file) or drop (accept the deletion
   deliberately).
3. Only then make index changes and push with `update-index-configuration`.

Doing it in the other order pushes a stale file and the drift is gone before you've seen it.

### Trap 3 — `insights` sorts on a column that doesn't exist

[blocks/insights/insights.js:200](../../blocks/insights/insights.js) sorts with
`dateValue(b.date) - dateValue(a.date)`, but the index has **no `date` column** — it has
`publicationDate`, `eventDate` and `releaseDate`. `dateValue(undefined)` returns `0`, so every
row ties and the sort is a silent no-op; ordering is whatever the index happens to return.

There's a format inconsistency alongside it: [scripts/utils/date.js](../../scripts/utils/date.js)
documents ISO `yyyy-mm-dd`, while the live recap row carries `eventDate: 06-26-2026`
(MM-DD-YYYY). The ISO branch won't match, so it falls through to native `Date` parsing.

**Action:** pick one — add a `date` property to the index config, or change the block to sort
on `publicationDate`. Standardise the metadata on ISO while the corpus is still four pages;
doing it after Batch B authors a dozen more is much worse.

Also note [blocks/article-feed/article-feed.js:18](../../blocks/article-feed/article-feed.js)
documents `index | /en/articles/query-index.json` as an authored option — that path 404s.
Either create the index or fix the doc comment before someone authors it during Batch B.

### Design decision — one index or several?

Both consumers (`insights`, `article-feed`) default to `/en/query-index.json`, which already
covers `/en/**` minus drafts, sandbox and fragments. **Recommendation: keep the single index**
and let blocks filter by `category` / `template` / `tags`, which `insights` already supports.
Adding per-section indices means more config surface, more reindex triggers, and more ways for
a path to silently 404 mid-demo.

What the single index does need for [S9](#s9--meetup-blocks--the-enmeetups-rename):

- `status` (`announced` | `upcoming` | `recap`) — drives the lifecycle model
- classification via the `aemdev:category/*` tag (`event-type` was dropped as a duplicate)
- a normalised `date` (Trap 3)
- the `include` path updated when `/en/meetup-recaps/` → `/en/meetups/`

**Acceptance:** one authoritative query config with the dead files removed; live config and
repo copy diffed and reconciled; `/en/query-index.json` carries `status` and a
working sort key; `insights` renders in correct date order against real content; a documented
read-back path so the next drift is visible.
