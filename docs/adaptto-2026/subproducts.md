# Subproduct build list

Everything that has to exist as code. Content is in [content-plan.md](content-plan.md);
dates are in [schedule.md](schedule.md).

**Legend — State:** `none` (not started) · `ported` (in this repo, unverified against
`aemgdc/aemdev`) · `exists` (in this repo, working) · `external` (lives in another repo,
needs porting).

## Summary

| # | Subproduct | Tier | State | Owner | Est. | Due |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | DA plugin registration + tools shell | — | none | Tad | 0.5d | 23 Aug |
| S2a | TagsServlet fix + `aemdev` tag namespace (AEM side) | 1 | broken backend | **Tad** | 1.5d | 28 Aug |
| S2b | Tag Picker config + page tag read-back (DA plugin) | 1 | ported | **Laurel** | 2d | 5 Sep |
| S3 | Icon Picker | 1 | none | Laurel | 2.5d | 5 Sep |
| S4 | Bio Manager | 1 | external | Tad | 2d | 12 Sep |
| S5 | Advanced Search | 2 | ported | Laurel | 1d | 12 Sep |
| S6 | Form Picker | 1 | none | Tad | 3d | 12 Sep |
| S7 | Preflight + publish workflow | 1 | exists (generic) | Tad | 2d | 12 Sep |
| S8 | Translation Tracker cameo | 3 | external | Tad | 0.5d | 18 Sep |
| S9 | Event blocks + events index | — | none | Tad | 2d | 5 Sep |
| S10 | Fixture/offline mode across plugins | — | none | Laurel | 1d | 18 Sep |

---

## S1 — DA plugin registration + tools shell

**Tier:** foundation (nothing else demos without it). **Owner:** Tad. **Est:** 0.5d.

This repo has no `tools/sidekick/config.json`. `tools/sidekick/sidekick.js` is an *AEM
Sidekick* customization (it wires `custom:scheduler` and `custom:quick-edit` events) — that
is a different surface from DA's plugin/library panel, and the session is about the latter.

Reference pattern, from `arbory-da` (`origin/bio-list:tools/sidekick/config.json`):

```json
{
  "project": "AEM Global Developer Collective",
  "editUrlLabel": "Document Authoring",
  "editUrlPattern": "https://da.live/edit#/{{org}}/{{site}}{{pathname}}",
  "plugins": [
    {
      "id": "da-tags",
      "title": "Tag Browser",
      "environments": ["edit"],
      "daLibrary": true,
      "url": "https://main--arbory-da--arbory-digital-inc.hlx.live/tools/tags.html"
    }
  ]
}
```

**Work:**
- Create `tools/sidekick/config.json` registering all six live plugins, pointed at
  `https://main--aemdev--aemgdc.aem.live/tools/<name>.html`.
- Confirm the DA-side config location for `aemgdc/aemdev` (DA reads a config from the
  content bus, not from git — the repo file is the source, but it has to be synced/published).
  Document the exact sync step here once verified; this is the kind of thing that silently
  doesn't take effect.
- Establish plugin ordering — it is the demo's running order, and reordering on stage is a
  fumble.
- One shared `tools/shared/` module: `DA_SDK` bootstrap, auth headers, error banner, the
  fixture-mode flag (S10). Every plugin below imports it rather than re-implementing.

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

**The backend is broken and there is no taxonomy.** Verified 16 Aug 2026 against the PRD
sandbox:

```
GET /services/tagsservlet           → HTTP 500
GET /services/tagsservlet.all       → HTTP 500
GET /services/tagsservlet.aemdev    → HTTP 200, body: "ERROR: Invalid Tag Catgegory"
GET /services/tagsservlet.topic     → HTTP 200, body: "ERROR: Invalid Tag Catgegory"
GET /services/tagsservlet.industry  → HTTP 200, body: "ERROR: Invalid Tag Catgegory"
GET /   (publish root)              → HTTP 200   (the instance itself is healthy)
```

Two separate problems, and they map cleanly onto the split:

1. The full-tree endpoints 500. That is the call the picker makes on init, so the picker
   renders nothing today.
2. *Every* named category — including `aemdev` — returns the invalid-category error, so there
   is no namespace authored for this site at all. Nothing to pick even once the 500 is fixed.

Also note the servlet returns **HTTP 200 with an error body**, so the client cannot currently
distinguish "no such category" from success. Fixing that is part of S2a.

---

### S2a — TagsServlet fix + `aemdev` tag namespace

**Tier:** 1. **Owner:** Tad. **Est:** 1.5d. **Due:** Fri 28 Aug (matches the week-0 spike gate
in [schedule.md](schedule.md#freeze-gates)). **Repo:** `~/git/arbory-digital-inc/arbory-aemaacs`,
Arbory Digital PRD sandbox author → publish.

1. **Root-cause the 500** on `/services/tagsservlet` and `.all`. Reproduce in the sandbox
   logs first — do not guess from `TagsServlet.java`. Prime suspect is the full-tree walk
   hitting a node type or a property it doesn't expect, or a permission boundary on
   `/content/cq:tags` for the anonymous publish user.
2. **Create the `aemdev` tag namespace** on the Arbory author at
   `/content/cq:tags/aemdev`, with the category/tag structure in
   [content-plan.md](content-plan.md#aem-taxonomy--the-aemdev-namespace). Namespacing it means the demo taxonomy is
   isolated from whatever else lives in that sandbox, and the picker can be scoped to
   `.aemdev` rather than pulling the whole repository.
3. **Add German (`de`) titles** on at least the `topic` tags. The servlet already supports
   multi-language with English fallback; it is a free Berlin moment.
4. **Fix the status-code contract.** Invalid category → 404 (or 400) with a JSON body, not
   HTTP 200 with a plain-text string. Laurel's fallback logic in S2b keys off this.
5. **Activate to publish** and re-verify the CDN rule allowing `/services/tagsservlet`
   through — the picker reads from publish, not author.
6. **Hand off the fixture** (see contract below) — commit a real captured response to
   `tools/tagpicker/fixtures/tags.json` so S2b is never blocked on sandbox availability.

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
- Point `tagURL` at the PRD sandbox and scope the request to the `aemdev` namespace.
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

**Acceptance:** on `/en/events/2026-10-berlin-meetup`, opening the picker shows the page's
existing tags pre-selected and any orphan tag flagged; adding two and inserting rewrites the
metadata correctly; removing one removes it from the page; cutting network access to the
sandbox degrades to the cached taxonomy with a visible notice rather than an empty panel.

---

### S2 interface contract

Fix this in week 0 so S2a and S2b proceed in parallel. Neither side changes it unilaterally
after **28 Aug**.

| | |
| --- | --- |
| **Endpoint** | `GET https://publish-p121227-e1306133.adobeaemcloud.com/services/tagsservlet.aemdev[.{lang}]` |
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
2. Point `DAM_DEFAULT_PATH` at a DAM folder on the PRD sandbox that actually has headshots
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
4. **Build the demo case:** the Act 3 bulk-replace needs 12–14 meetup pages that genuinely
   contain the old form block. That's [content-plan.md](content-plan.md), and it gates this.
5. Rehearse the *undo* — showing undo is what makes bulk-edit demos land instead of terrify.

**Acceptance:** a block+property search across `/en/meetup-recaps/` returns ≥12 pages,
versions them, replaces, and undoes cleanly — in under 2 minutes with narration.

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
   and an AEM workflow kickoff on the PRD sandbox. Implement in `workers/` (this repo already
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

## S9 — Event blocks + events index

**Tier:** foundation. **Owner:** Tad. **Est:** 2d. **State:** none.

The demo builds an *event invitation*. This repo has `/en/articles/**` and
`/en/meetup-recaps/**` indices in [helix-query.yaml](../../helix-query.yaml), with
`event-date`, `event-location`, `event-speakers`, `recap-video` properties — but **no events
or invitation path**. Recaps look backwards; an invitation looks forwards.

**Work:**
1. Add an `events` index to `helix-query.yaml` for `/en/events/**` — reuse the meetup-recaps
   property set plus `rsvp-form`, `capacity`, `event-end-date`.
2. New `event-invite` block: date/time/venue header, agenda rows (icon + time + item — this
   is what S3 feeds), speaker fragment slots (S4), RSVP slot (S6).
3. `event-card` / listing block for `/en/events/` so the new page appears somewhere after publish.
4. A DA **template** for the event page, so Act 1 starts from a template rather than a blank
   doc. This is what makes the live build fit in 7 minutes.
5. Reuse before building: this repo already has `blocks/schedule/`, `blocks/speaking/`,
   `blocks/card/`, `blocks/author-rows/`, `blocks/callout/`, `blocks/step/`. Check each before
   writing anything new.

Follow the repo's `content-driven-development` skill for this one — it touches `blocks/`.

**Acceptance:** a hand-authored event page renders correctly at preview and appears in
`/en/events/query-index.json`; the template opens clean in DA.

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
