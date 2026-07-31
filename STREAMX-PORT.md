# Porting StreamX search onto Author Kit

Status: **proposal**. Nothing in this document has been implemented.

The StreamX search blocks were copied into this repo verbatim from
`arbory-digital-inc/arbory-dev` (commit "Copy the StreamX search implementation
from arbory-dev"). That source repo is an **AEM Boilerplate** site; this one is
an **Author Kit** site. The blocks are in the tree but not wired up, and several
of their assumptions do not hold here.

This document is the plan for closing that gap. It is ordered so that each phase
leaves the repo in a state you can look at.

For how the *content* side works — what an author types into a page's metadata
table to make it searchable and filterable — read
[arbory-dev's README, "Search: tags, categories and facets"](https://github.com/arbory-digital-inc/arbory-dev/blob/main/README.md#search-tags-categories-and-facets).
That behaviour is a property of the StreamX ingest pipeline, not of the front
end, so it carries over here unchanged and is not restated below.

---

## 1. What came across, and what it does

| Path | Role |
| --- | --- |
| `blocks/search-tabs/` | The results page. Query input + a tab per data source, each tab owning its own results panel. Also adds the sliding tab indicator, an authored-content tab, and the facet filter/"show more" controls the library does not ship. |
| `blocks/search-tab/` | Headless. One per tab; its key/value rows configure a tab on `search-tabs`, which reads and then removes it. |
| `blocks/results-panel/` | A standalone (untabbed) results panel. Also the home of the shared hit renderer, the icon set, and `observeFacets` — `search-tabs` imports all three from here. |
| `blocks/search-config/` | Headless. Key/value config for the nav's inline search. A no-op decorator that exists only so the block loader gets a 200. |
| `scripts/search/` | The StreamX Search library build output. **Copy-in only** — see its `README.md`. `scripts/search/eds/` holds the library's own EDS decorators, which our blocks wrap. |
| `.github/workflows/streamx-publish.yaml` | On AEM's `resource-published` dispatch, tells StreamX to fetch and index the page. |
| `.github/workflows/unpublish-from-streamx.yaml` | The mirror: removes the page from the index. |
| `.github/workflows/webresource-{publish-to,sync-with}-streamx.yaml` | Web-resource (static asset) sync. Two near-identical files. |

Deliberately **not** copied:

- `blocks/search/` — that is the AEM Boilerplate's own query-index search block.
  It has nothing to do with StreamX and depends on `scripts/aem.js` helpers
  (`fetchPlaceholders`, `createOptimizedPicture`) that Author Kit does not have.
- arbory's `scripts/delayed.js` and its `blocks/header/header.js` nav-search
  code. Those *are* the nav inline search, but pasting them here would break
  this repo's working header. They are reproduced as needed in §6 instead.

### The good news

The blocks import **nothing** from `scripts/aem.js`. Their entire dependency
surface is:

```
blocks/search-tab/search-tab.js       → scripts/search/eds/search-tab.js
blocks/search-tabs/search-tabs.js     → scripts/search/eds/search-tabs.js
                                      → blocks/results-panel/results-panel.js
                                      → blocks/fragment/fragment.js  (loadFragment)
blocks/results-panel/results-panel.js → scripts/search/eds/search-results-panel.js
                                      → scripts/search/streamx-search-results-panel.js
```

Only one line — `loadFragment` — actually crosses into boilerplate-specific
code. Everything else is either self-contained or in the vendored library. So
this is not a rewrite. The work is concentrated in CSS, theming, the nav search,
and the ingestion configuration.

---

## 2. Where the block contract differs

Author Kit's `scripts/ak.js` is not a renamed `scripts/aem.js`. The differences
that matter here:

**Block markup.** `decorateSections` ([`scripts/ak.js:252`](scripts/ak.js:252))
groups a section's children into `.default-content` and `.block-content`
wrappers, then collects blocks as `.block-content > div[class]`. It does **not**
add a `block` class, does **not** wrap each block in `<div class="{name}-wrapper">`,
and does **not** set `data-block-status`.

*Impact:* none, as it happens. Grepping the copied CSS for `-wrapper` turns up
only the library's own `.stx-query-input__suggestions-wrapper`. Both blocks are
already scoped by their own class (`.search-tabs …`, `.results-panel …`), which
is what Author Kit wants. **No change needed** — recorded because it is the
first thing anyone will check.

**Block internals are untouched.** `groupChildren` operates on sections, not on
block bodies, so a block's authored `div` rows survive intact and the library's
`getEDSConfig` ([`scripts/search/eds-helper-B2lm9102.js:16`](scripts/search/eds-helper-B2lm9102.js:16))
reads them exactly as before. **No change needed.**

**Load order.** `loadArea` ([`scripts/ak.js:299`](scripts/ak.js:299)) awaits
sections in order but fires every block *within* a section concurrently. So
`search-tabs` and its `search-tab` siblings decorate in parallel, and
`search-tabs` calls `tab.remove()` on elements whose own decorator may not have
run yet.

*Impact:* benign but sloppy. `search-tab.js` only adds a class and logs a
console error if `.stx-tabs` is absent, so the worst case is a spurious console
error on a fast machine, or a decorator running against a detached node.

*Proposed:* keep the library decorator as-is and have `blocks/search-tab/search-tab.js`
bail out early when the element is already detached:

```js
export default function decorate(block) {
  if (!block.isConnected) return;   // search-tabs consumed it first
  decorateSearchTab(block);
}
```

Also document the authoring constraint: **put `search-tabs` and all its
`search-tab` blocks in the same section.** It happens to work across sections —
`getEDSConfig` reads raw DOM, and later sections are in the document from the
start — but relying on that is asking for trouble.

**`codeBase` may not be the site root.** `setConfig`
([`scripts/ak.js:37`](scripts/ak.js:37)) derives `codeBase` from
`import.meta.url`, precisely so Author Kit code can be served from an origin
other than the content origin. The library ignores this: both EDS decorators
hardcode `loadCssFile("/scripts/search/streamx-search.css")`.

*Impact:* on a split-origin setup the library stylesheet 404s and the search UI
renders unstyled. Also, `loadCssFile` does not de-duplicate — one `<link>` per
decorator call, so a tabbed page plus a standalone panel injects it twice.

*Proposed:* stop letting the library load its own stylesheet. Have each block
load it through Author Kit's own `loadStyle`, which is both `codeBase`-relative
and de-duplicating:

```js
import { getConfig, loadStyle } from '../../scripts/ak.js';
// …
const { codeBase } = getConfig();
await loadStyle(`${codeBase}/scripts/search/streamx-search.css`);
```

The library's own call still fires and still 404s harmlessly on a split origin.
Suppressing it means either patching the vendored bundle (against its README) or
asking the library for a `cssUrl` option — **the latter is the right ask**, and
worth raising with the StreamX team as part of this work.

**`loadFragment` is not the same function.** This is the one real API break.

| | arbory (`blocks/fragment/fragment.js`) | here ([`blocks/fragment/fragment.js:31`](blocks/fragment/fragment.js:31)) |
| --- | --- | --- |
| Fetches | `${path}.plain.html` | `path` verbatim (full page HTML) |
| On failure | returns `null` | **throws** `Error` |
| Returns | `<main>` with `.section` children | `<div class="fragment-content">` with `.section` children |

`search-tabs.js` checks `if (!fragment)` and logs a friendly error. Here that
branch is dead and a bad `contentTabPath` produces an unhandled promise
rejection inside the tab-activation handler instead.

*Proposed:* wrap the call.

```js
let fragment;
try {
  fragment = await loadFragment(path);
} catch (e) {
  getConfig().log(`The "${label}" search tab could not load its content from "${path}".`, e);
  return;
}
```

Note this also routes the error through Author Kit's configurable `log`
([`scripts/ak.js:13`](scripts/ak.js:13)) rather than a bare `console.error`,
which is the house style here and the reason `scripts/utils/error.js` exists.
The same substitution applies to the two `console.error` calls in
`search-tabs.js` and the one in `search-config.js`'s comment.

---

## 3. Layout: the blocks will render full-bleed

In AEM Boilerplate, arbory's `styles/styles.css` centres **every** section child:

```css
@media (min-width: 900px) {
  .section > div { max-width: 1200px; margin: auto; }
}
```

Author Kit centres only default content
([`styles/styles.css:230`](styles/styles.css:230)):

```css
.section > .default-content {
  max-width: var(--grid-content-width);
  width: var(--grid-container-width);
  margin: 0 auto;
}
```

Blocks are expected to constrain themselves. Neither `search-tabs.css` nor
`results-panel.css` does, because it never had to.

*Impact:* the query input, tab row, facet column and results all run edge to
edge of the viewport.

*Proposed:* give each block the same measure the rest of the site uses, at block
root:

```css
.search-tabs,
.results-panel {
  max-width: var(--grid-content-width);
  width: var(--grid-container-width);
  margin-inline: auto;
}
```

This has a knock-on: `search-tabs.css` computes the facet indent from
`--stx-facet-column: 25%` plus `--stx-facet-gap`, and 25% of a 1140px measure is
not 25% of the viewport. Re-check the header/results alignment described in the
comment at `blocks/search-tabs/search-tabs.css:68` after constraining the block.

Also worth deciding: whether a results page should carry a **template**
([`scripts/ak.js:80`](scripts/ak.js:80)) the way articles carry `blog`. A
`templates/search/search.css` would be the natural place for page-level
concerns — suppressing the article measure, giving the facet column room —
rather than pushing them into the block. Recommend yes.

---

## 4. Theming: the copied CSS is hardcoded dark, in tokens this repo does not define

Two separate problems that look like one.

**Undefined tokens.** The copied CSS reads six boilerplate token names. None of
them exist in this repo:

| Token the CSS reads | Defined here? | Author Kit equivalent |
| --- | --- | --- |
| `--text-color` | no | `--color-text` |
| `--background-color` | no | `--color-background` |
| `--link-color` | no | `--color-link` |
| `--link-hover-color` | no | `--color-link-hover` |
| `--border-radius` | no | *none — this design system has no radius* |
| `--fixed-font-family` | no | `--mono-font-family` |
| `--body-font-family` | **yes** | — |
| `--heading-font-family` | **yes** | — |

`--link-color` is the worst of these: `search-tabs.css` feeds it into four
`color-mix()` calls for the search button's mesh gradient and the field's border
ring. An undefined token makes each `color-mix()` invalid, so those decorations
fall back to nothing and the field loses its focus ring.

`--border-radius` is a design decision, not a rename.
[`styles/styles.css:4`](styles/styles.css:4) says "No border-radius" outright.
The copied CSS derives two radii from it (`--stx-field-radius`, and
`--stx-control-radius` as `calc(var(--border-radius) - 6px)` for concentric
corners). **Recommend setting both to `0`** and deleting the concentric-corner
logic rather than inventing a radius token this design system has rejected.

**Hardcoded dark palette.** Both files open by pinning the library's theme to
arbory's dark site:

```css
/* blocks/results-panel/results-panel.css:3 */
:root main { --stx-color-text: #fff; --stx-color-background: #191b22; … }

/* blocks/search-tabs/search-tabs.css:7 */
.search-tabs { --stx-color-text: #fff; --stx-color-surface: rgb(255 255 255 / 6%); … }
```

This repo is light-first, and `.dark-scheme` is currently a deliberate no-op
([`styles/styles.css:401`](styles/styles.css:401): "dark scheme intentionally
disabled for Rev 3").

*Impact:* white text on a near-white page. Unreadable, not merely off-brand.

Note also that `:root main` scopes those variables **inside `<main>`**, and this
repo's `<header>` is a sibling of `<main>` ([`wrapper.html:3`](wrapper.html:3)).
So a nav search input inherits none of them — relevant to §6.

*Proposed:* replace both token blocks with a single **theme bridge** that maps
the library's `--stx-*` surface onto Author Kit tokens, and put it in one place
both blocks can use. Sketch:

```css
.search-tabs,
.results-panel {
  --stx-color-text: var(--color-text);
  --stx-color-muted: var(--muted);
  --stx-color-background: transparent;
  --stx-color-surface: var(--color-shaded);
  --stx-color-border: var(--border);
  --stx-color-focus: var(--color-accent);
  --stx-color-text-query-input: var(--color-text);
  --stx-field-radius: 0;
  --stx-control-radius: 0;
}
```

The mesh-gradient block (`--stx-mesh-*`, `blocks/search-tabs/search-tabs.css:21`)
needs a call, not a mapping. It is a four-stop animated gradient tuned to
arbory's palette. Options, in order of preference:

1. **Drop it** and give the search button a flat `--color-accent`. Simplest, and
   consistent with a design system that says no radius and light-only.
2. Re-tune the four stops around `--aem-red`. Keeps the effect; costs a design
   review.

Recommend (1) for the first working version, and treat (2) as a follow-up if
someone actually wants it.

Where to put the bridge: it is shared, so `styles/styles.css` is tempting, but it
would ship on every page for the sake of two. Better to duplicate the block into
both stylesheets — which is already the pattern
`blocks/results-panel/results-panel.css:48` documents for the facet controls.
Note that comment: `results-panel.css` only loads when a `.results-panel` block
is on the page, so `search-tabs.css` must carry its own copy of anything shared.

---

## 5. Global CSS collisions

Author Kit sets some very broad rules that the copied CSS was never tested
against.

**`svg { width: 20px; height: 20px }`** ([`styles/styles.css:364`](styles/styles.css:364)).
The search and clear icons come from `renderItem`'s sibling helpers
(`blocks/results-panel/results-panel.js:61-65`) as `viewBox`-sized inline SVG
with no intrinsic dimensions. `search-tabs.css` happens to size them explicitly
(lines 249, 272); `results-panel.css` does not, and neither does
`scripts/search/streamx-search.css`.

*Impact:* under `.results-panel`, both icons get clamped to 20×20 inside a 40px
button. Not broken, but not what was designed either.

*Proposed:* size them in `results-panel.css` the way `search-tabs.css` already
does, so neither block depends on the global.

**`img { width: 100%; height: auto; display: block }`**
([`styles/styles.css:358`](styles/styles.css:358)). No result renderer currently
emits an `img`, so this is latent. Flagged because adding a thumbnail to
`renderItem` is an obvious next feature and it will render full-width.

**`main > div, div[data-status] { display: none }`**
([`styles/styles.css:383`](styles/styles.css:383)). Author Kit's anti-FOUC
mechanism: a section stays hidden until `.section` is added and `data-status` is
deleted. Nothing in the copied code touches `data-status`, so this is fine —
but be aware that a block whose decorator throws leaves its section visible with
the block undecorated, because `loadBlock` catches and logs
([`scripts/ak.js:70`](scripts/ak.js:70)). Failures here will be quiet.

**`main input` is not styled here.** Four places in the copied CSS work around
arbory's `main input { margin-bottom: 1rem; max-width: 50rem; padding: … }`:
`blocks/results-panel/results-panel.css:60` and
`blocks/search-tabs/search-tabs.css:174`, `:671`, `:810`. This repo has no such
rule — only `input { font: inherit }`
([`styles/styles.css:350`](styles/styles.css:350)). Those workarounds are now
dead weight and should be removed along with their comments, not left to confuse
the next reader. The `:810` one is the fiddliest: it strips margin and padding
off the facet checkbox to keep the control square, and the custom tick mark is
positioned against that padding box — so re-check the checkbox rendering rather
than deleting the rule on faith.

Same for `blocks/results-panel/results-panel.js:191`, whose comment explains
that `more.hidden` is clamped because arbory's `styles.css` puts
`display: inline-block` on every button. Not true here. The clamp is harmless
and arguably still correct defensively — keep the code, fix the comment.

---

## 6. The nav inline search has to be rebuilt

This is the largest piece of net-new work, and the one with the least to copy.

In arbory, nav search is three cooperating parts:

1. `blocks/header/header.js` finds an authored `span.icon-search` in the nav
   tools section, replaces it with an expanding search box, and separately finds
   a `search-config` block in the nav fragment, parses its rows, removes it, and
   stashes the result as JSON on the input's `dataset.searchConfig`.
2. `scripts/delayed.js` reads that dataset, imports
   `scripts/search/streamx-search-inline.js`, and calls `createSearchInput(…)`
   to replace the placeholder input with the library's real one.
3. `blocks/header/header.css` styles the expand/collapse, including a mobile
   takeover.

None of that maps onto this repo's header:

- The header is a **fragment** at `/fragments/nav/header`
  ([`blocks/header/header.js:7`](blocks/header/header.js:7)), decorated into
  brand / nav / actions sections.
- Actions are **link-pattern widgets**, not icons:
  `HEADER_ACTIONS = ['/tools/widgets/scheme', '/tools/widgets/language', '/tools/widgets/toggle']`
  ([`blocks/header/header.js:8`](blocks/header/header.js:8)). `decorateAction`
  ([`blocks/header/header.js:94`](blocks/header/header.js:94)) finds the link,
  converts it to a `<button>`, and hands it to a per-widget decorator.
- There is no `scripts/delayed.js`. The equivalent hook is
  [`scripts/lazy.js`](scripts/lazy.js).
- The header is outside `<main>`, so the `:root main` token block from §4 does
  not reach it.

*Proposed:* rebuild it as a fourth widget, following the existing pattern rather
than porting arbory's shape.

1. Add `'/tools/widgets/search'` to `HEADER_ACTIONS` and a `decorateSearch(btn)`
   alongside `decorateScheme` / `decorateLanguage` / `decorateNavToggle`. It owns
   the expand/collapse and the Escape/click-outside behaviour — arbory's
   `createNavSearch` is a reasonable reference for the interaction, but the
   markup should match this repo's `action-wrapper` convention.
2. Keep the `search-config` block as the config carrier, but read it from the
   **header fragment** rather than a nav block, and mount it in the fragment at
   `/fragments/nav/header`. `blocks/search-config/search-config.js` stays a
   no-op; only the parser moves. arbory's `parseSearchConfig` is a 10-line
   duplicate of `getEDSConfig` — import the library's version here instead of
   duplicating it again, since the header already imports from `blocks/`.
3. Mount the library input from `scripts/lazy.js`, guarded on the widget
   actually being present:

   ```js
   if (document.querySelector('.action-wrapper.search')) {
     import('./utils/nav-search.js').then(({ default: init }) => init());
   }
   ```

   Putting the body in `scripts/utils/nav-search.js` keeps `lazy.js` a manifest,
   which is what it currently is.
4. Because the header sits outside `<main>`, the `--stx-*` bridge from §4 must
   also be applied to the nav search's own root. One more reason the bridge
   belongs on a block/component selector rather than on `main`.

**Open question for the site owner:** does aemdev.org want nav search at all in
the first cut, or is a `/en/search` results page enough? The results page is
self-contained and ships in phase 1; nav search is a header change on every page
and can follow. Recommend deferring it, and this document assumes that split
in §9.

---

## 7. The vendored bundle breaks `npm run lint`

`npm run lint:js` is `eslint .`. `scripts/search/` is minifier-adjacent build
output — tabs, double quotes, no trailing newlines — and produces **2777 errors**
under `@adobe/eslint-config-helix`. `npm run lint` currently fails on this repo.
(It fails in arbory too; its `.eslintignore` only ever covered
`helix-importer-ui`. The copy inherited a pre-existing bug.)

The hand-written blocks are clean — `eslint blocks/search-*  blocks/results-panel`
and `stylelint` on their CSS both pass with zero findings. So this is purely
about where the vendored files live.

*Proposed:* move the distribution to `deps/streamx-search/`.
[`eslint.config.js:7`](eslint.config.js:7) already carries
`globalIgnores(['**/deps'])`, and `deps/` is where this repo already keeps
third-party build output (`deps/lit/dist/`, `deps/rum.js`). That makes the fix a
`git mv` plus five import-path updates, with no new lint configuration and no
per-file `eslint-disable` headers.

It also reads correctly: `scripts/` here is first-party code, and the StreamX
bundle is not. `scripts/search/README.md` moves with it.

The alternative — adding `scripts/search` to `globalIgnores` — works but leaves a
vendored bundle sitting in the first-party directory and needs someone to
remember why the ignore is there.

---

## 8. Ingestion: nothing is configured yet

The two publish workflows are copied and syntactically fine, but they will not
run, and if they did they would fail.

**Missing repository variables** (verified: this repo currently has **no**
Actions variables at all):

| Variable | Used by | Value for this site |
| --- | --- | --- |
| `EDS_DOMAIN_URL` | `streamx-publish.yaml` | The origin StreamX should fetch, e.g. `https://main--aemdev--aemgdc.aem.live` |
| `STREAMX_INGESTION_URL` | all four | StreamX ingestion endpoint |
| `STREAMX_INGESTION_INCLUDES` | both webresource workflows | Glob patterns for static assets |

**Missing secrets** (existing secrets are `AUTH_TOKEN`, `CONFIG_AUTH_TOKEN`,
`FASTLY_API_TOKEN`, `FASTLY_SERVICE_ID` — no StreamX token):

| Secret | Used by |
| --- | --- |
| `STREAMX_INGESTION_GH_TOKEN` | `streamx-publish.yaml`, `unpublish-from-streamx.yaml` |
| `STREAMX_INGESTION_TOKEN` | both webresource workflows |

**Both webresource workflows are gated on arbory's branch.** Each has
`pull_request: branches: [china]`. There is no `china` branch here, so the PR
trigger is dead; only `workflow_dispatch` fires. They are also **near-duplicates
of each other** — same two jobs, same inputs, differing only in a
`permissions:` block. *Proposed:* delete
`webresource-sync-with-streamx.yaml`, retarget the survivor's branch filter to
`main`, and decide whether web-resource sync is wanted here at all before
spending effort on it. It is not needed for page search to work.

**The dispatch itself needs verifying.** Both page workflows trigger on
`repository_dispatch: types: [resource-published]`, which AEM emits when a page
is published. Whether that reaches *this* repo depends on the AEM Code Sync app
installation, and it is not something
[`config/sites/aemdev/site.json`](config/sites/aemdev/site.json) records — so it
cannot be confirmed by reading the repo. **Verify empirically before building
anything on top of it:** publish any page from DA and check the Actions tab for
a `Publish to StreamX` run. If nothing appears, the dispatch is not wired and
that is the first thing to fix — every other piece of this port is downstream of
it.

**Path shape checks out.** The namespace regex
(`^/([a-z]{2}(-[a-z]{2})?)(/|$)`) turns `/en/insights/foo.md` into subject
`en:/en/insights/foo`, and content here lives under `/en/**`
([`config/sites/aemdev/query.yaml`](config/sites/aemdev/query.yaml)). No change
needed. The publish job also skips `/nav` and `/footer`; this repo's equivalents
live under `/fragments/**`, so consider widening that skip list — indexing
header and footer fragments as pages would put junk in the results.

**Unrelated but noticed while reading configs:** `config/sites/aemdev/site.json`
has a live admin API key and the Fastly `authToken` committed in plaintext. Out
of scope for this port, worth rotating.

---

## 9. Suggested phasing

Each phase is independently reviewable and leaves the repo working.

**Phase 0 — prove the pipeline.** §8. Set the variables and secret, publish a
page, confirm the workflow runs and the document lands in the index. Nothing
front-end matters until this works, and it may be entirely someone else's
configuration to make.

**Phase 1 — make the results page correct.** §7 (`git mv` to `deps/`), §2
(`loadFragment` guard, `codeBase` stylesheet, detached-tab guard), §3 (measure
+ optional `templates/search/`), §4 (theme bridge, drop the mesh gradient and
the radii), §5 (icon sizing, delete the dead workarounds). Ends with a working,
on-brand `/en/search` — no header changes anywhere.

**Phase 2 — clean up the workflows.** §8: delete the duplicate, retarget the
branch filter, widen the fragment skip list.

**Phase 3 — nav search, if wanted.** §6. Deliberately last: it is the only part
that touches every page, and the §6 open question should be answered before any
of it is written.

## 10. What to check at the end of Phase 1

Not automated tests — this is a visual, integration-heavy block and the honest
check is a browser.

- `npm run lint` passes.
- `/en/search` renders inside the site measure, in the light palette, with
  readable text.
- Facet groups over five values get a filter field and a "show N more" that
  hides itself when there is nothing left to reveal.
- Selecting a facet adds a removable badge; clicking the badge clears the filter
  and re-runs the search.
- Tab switching moves the indicator and updates the `stx-tab` URL parameter;
  deep-linking `?stx-tab=<id>` opens the right tab.
- A `contentTabPath` pointing at a nonexistent page logs one error and leaves the
  rest of the page usable — no unhandled rejection.
- The results-page container is not the only thing on screen: check the header
  and footer still lay out, since §3 and §4 both touch shared measures.
