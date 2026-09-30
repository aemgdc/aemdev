# aemdev.org

This repo drives [www.aemdev.org](https://www.aemdev.org), the site of the **AEM Global
Developer Collective**, along with the authoring tools its authors use in
[Document Authoring (DA)](https://da.live). The site runs on
[Edge Delivery Services](https://www.aem.live), with content authored in DA.

It is a resource for AEM developers:

- **Take what you need.** Every plugin, app and block here is plain HTML, CSS and JavaScript
  served from this repo. There is no build step and no separate deploy. You can copy one into
  your own project and change the org and site names.
- **Share what works.** The site hosts [meetups](https://www.aemdev.org/en/meetups), recaps
  and articles on AEM best practices, in eleven languages.

Contributions are welcome. **Site owners:** Tad Reeves. Contact on LinkedIn or Slack.

| | |
| --- | --- |
| Live site | [www.aemdev.org](https://www.aemdev.org) |
| DA org / site | `aemgdc` / `aemdev` ([da.live/#/aemgdc/aemdev](https://da.live/#/aemgdc/aemdev)) |
| Full-screen apps | [da.live/apps#/aemgdc/aemdev](https://da.live/apps#/aemgdc/aemdev) |
| Presented at | [adaptTo() 2026, Berlin](https://adapt.to/2026/schedule/spiritually-succeeding-aem-advanced-author-customization-in-da): *Spiritually-Succeeding AEM: Advanced Author Customization in DA* (Tad Reeves, Laurel Timko) |

---

## Authoring tools

These tools were shown at adaptTo() 2026. They come in two kinds:

- A **library plugin** opens from the Library panel while you edit a document in DA. It reads
  the open page, and it writes to that page.
- A **full-screen app** opens at `da.live/app/aemgdc/aemdev/tools/<name>` or from its card at
  [da.live/apps](https://da.live/apps#/aemgdc/aemdev). It works across many pages.

| Tool | Kind | What it does | Code |
| --- | --- | --- | --- |
| [AEM Tags](#aem-tags) | library plugin | Edits a page's tags using the live AEM tag taxonomy | [`tools/tagpicker/`](tools/tagpicker/) |
| [Icon Picker](#icon-picker) | library plugin (dialog) | Searchable SVG icon library; inserts `:icon:` tokens | [`tools/icon-picker/`](tools/icon-picker/) |
| [Bio Picker](#bio-picker) | library plugin | Picks a page's speakers from the bio roster | [`tools/bio-picker/`](tools/bio-picker/) |
| [Bio Manager](#bio-manager) | full-screen app and library plugin | Creates, edits and publishes structured bios | [`tools/bio-manager/`](tools/bio-manager/) |
| [Form Picker](#form-picker) | library plugin (dialog) | Sets up a form block and inserts it | [`tools/splitforms-picker/`](tools/splitforms-picker/) |
| [Advanced Search](#advanced-search) | full-screen app | Block-aware search and bulk edit across a folder tree, with undo | [`tools/advanced-search/`](tools/advanced-search/) |
| [Translation Tracker](#translation-tracker) | full-screen app, public boards and a Node pipeline | Tracks every page in every language, with QA run by local LLMs | [`tools/page-tracker/`](tools/page-tracker/), [`tools/tracker/`](tools/tracker/) |

### AEM Tags

Your AEM tag taxonomy (`/content/cq:tags`), used live inside DA. This is the tool for teams
who don't want to give up AEM's managed taxonomy when they move authoring to DA.

- **Browse the real taxonomy.** The plugin reads the tag tree from a small Sling servlet on the
  AEM as a Cloud Service publish tier. You get hierarchical menus, a breadcrumb, and a list of
  saved tags. The servlet also returns localized titles (`.de`, `.ja`, …), so labels can follow
  the page's language.
- **An editor, not just an inserter.** When the plugin opens, it reads the tags already on the
  page from DA source and pre-selects them. A tag that is no longer in the taxonomy is flagged
  as invalid, and you must remove it before you can save.
- **Replace, don't append.** Saving rewrites the `tags` row of the page's `metadata` block in
  `category|subcategory|tag` form. It creates the row if the page doesn't have one.

**To reuse it:**

1. Deploy [`TagsServlet.java`](tools/tagpicker/TagsServlet.java) to your AEMaaCS repo, and
   point it at your tag namespace.
2. Let `/services/tagsservlet` through the CDN.
3. Allow CORS from your `aem.live` / `da.live` origins. On publish, set this in the dispatcher
   (Apache vhost) config. The dispatcher strips the `Origin` header, so an OSGi CORS policy
   there never sees it.
4. Point `tagURL` in [`tagpicker.js`](tools/tagpicker/tagpicker.js) at your publish host.

Full notes are in the [tool README](tools/tagpicker/README.md).

### Icon Picker

A grid of the site's SVG icons with live filtering. Click an icon to insert the EDS token
`:key:`. It publishes as an inline SVG sprite, coloured by CSS with `currentColor`.

- **The icon library is DA content.** Each icon is a file at `/icons/<key>.svg`, listed in a
  manifest at `/docs/library/icons.json`. Both are seeded from git by
  [`seed-icons.mjs`](tools/icon-picker/seed-icons.mjs), so the library can be rebuilt from the
  repo.
- **Manage mode.** A toggle lets you add or remove icons. The plugin writes the SVG and its
  manifest row together, and rolls both back if either write fails.
- **Registration is scripted.** [`register-picker.mjs`](tools/icon-picker/register-picker.mjs)
  adds the palette to the `library` sheet of the DA site config, then reads the config back and
  diffs it. It also refuses to register a path that isn't deployed yet.
- **The gotcha:** the DA `/icons/` folder feeds the *palette*, and `img/icons/` in git feeds
  the *page*. An icon needs a copy in both places, under the same key. Otherwise you can insert
  it, but it renders as nothing.

See the [tool README](tools/icon-picker/README.md).

### Bio Picker

A library plugin for event pages. Search the bio roster that [Bio Manager](#bio-manager)
maintains, select one or more people, and insert them.

- The plugin loads the speakers already on the page, so it edits the list rather than
  starting over.
- It writes their slugs to the `speakers` row of the page's `metadata` block, and creates the
  row if it is missing.
- The [`bios`](blocks/bios/) and [`speakers`](blocks/speakers/) blocks render the roster from
  that metadata. An empty block on a meetup page needs no other authoring.

### Bio Manager

Structured speaker and author bios, managed inside DA. The same code runs as a **full-screen
app** (roster, editor with live preview, headshot upload) and as a **library plugin** with an
`Insert` action.

- **One bio is one document.** Each bio lives at `/en/fragments/bios/<slug>` as a key/value
  block, so a person can still hand-edit it in DA. The headshot is stored at
  `/media/bios/<slug>.<ext>`, and the bio gets a row in the roster sheet `/bios.json`.
- **Full lifecycle.** Saving previews and publishes the bio. Removing it unpublishes both
  tiers first, then deletes the document and its headshot, so no public URL is left pointing
  at nothing.
- **Three ways onto a page:**
  - a `bios` grid, driven by the page's `speakers` metadata
  - a `speakers` row list, driven by the same metadata
  - a plain fragment link, which is what `Insert` writes
- **Offline harness.** In [`fixtures/`](tools/bio-manager/fixtures/), an import map swaps the
  DA SDK for an in-memory DA. The *unmodified* app then runs with no network, and no fixture
  code ships in the plugin.

See the [tool README](tools/bio-manager/README.md), which covers the traps, including why a
bio must not carry `robots: noindex`.

### Form Picker

A palette for placing a working form: pick a form type, set its options, check the exact
table you're about to insert, then insert it.

- **One file defines the forms.** Add a form type to
  [`form-catalog.js`](tools/splitforms-picker/form-catalog.js) and it appears in the palette.
  The picker only knows how to render option *types*: `text`, `number`, `choice` and `switch`.
- **Minimal output.** An option becomes a row only when it differs from the block's default.
  The table you get back is the one you would have typed yourself.
- **It checks itself.** On load, the picker compares its catalog with the form names the
  [`splitforms`](blocks/splitforms/) block actually supports. It warns about a form nobody can
  pick, and raises an error for one that would silently fall back to the contact form.
- **Inserts a table, not divs.** DA's paste parser only accepts the table shape. If you send
  the div shape (the one you see when you read a document through the Source API), nothing is
  inserted and no error appears.

Submissions go to [splitforms.com](https://splitforms.com), so there is no server code. The
block floats beside the section's existing copy. See the
[tool README](tools/splitforms-picker/README.md).

### Advanced Search

A full-screen app for content operations across a whole folder tree. It is aware of blocks, so
it works on content structure as well as text.

- **Search** by block, property row, HTML tag or attribute, keyword (optionally
  case-sensitive), publish status (published, previewed or unpublished), or empty values. The
  page tree picker ([`tools/pagetree/`](tools/pagetree/)) sets the starting path.
- **Results** expand to show each match on the page, together with the page's publish
  status. You can export them to CSV.
- **Bulk edit safely.** First, version every matching page in one click. Then:
  - replace text
  - prepend, append or replace a property's value (the whole value, or each item of a
    multi-value field)
  - add, delete, rename or merge block rows
- **Undo** puts every modified page back to the state it was in when you searched. That is
  what makes a bulk-edit demo land instead of terrify.

### Translation Tracker

**Where is every page, in every language?** The tracker answers this for
aemdev.org's English source plus 10 locales: `de fr es it pt pl ja ko zh-cn zh-tw`. It can also
run automated QA on a translation as soon as one lands.

This is a brand-anonymized version of a tracker we built for a customer's enterprise-scale,
multi-language site migration. There, it follows every page through import, automated QA,
human sign-off, translation and rollout. The first pass of QA runs on local open-weight LLMs
on a dedicated box: no content leaves the building, and there is no per-token bill. The QA
pipeline hands its judgements to people through review documents in DA. The work and its
state are published as dashboards. This port keeps the model and the QA tiers, and swaps the
migration for the site's own translation rollout.

**The model.** Pages are organised in groups: indexes, meetups, articles and bios. Each group
is a DA sheet synced from the site's query index, with one tab per locale. Every (page, locale)
pair moves through a nine-stage funnel:

> Catalogued → EN published → Sent for translation → Previewed → Auto QA passed → Layout QA
> passed → In native review → Review OK → Online

Anything that needs a person goes into a work queue with a named owner, instead of being
guessed at. Publish state is observed from the Admin API rather than stored, so it can't go
stale.

**Automated QA in three tiers.** These are Node CLIs. The models run locally on
[llama.cpp](https://github.com/ggml-org/llama.cpp)'s `llama-server`:

1. **Structural** (`tx:page`): compares the English page with the translated one. Headings,
   blocks, links, images and metadata must line up, and taxonomy values must never have been
   translated. Language detection with a script gate catches pages that were never
   translated.
2. **Translation fidelity** (`tx:judge`): a local LLM judge (Qwen2.5-14B, with a small
   Qwen3-4B for triage) reads each pair against a per-group QA brief that is authored in DA.
   The judge returns a JSON verdict.
3. **Layout** (`tx:visual`): screenshots at 2360, 1280 and 390 px, side by side. Geometry
   diffs run first, and a vision model (Qwen2.5-VL-7B) looks only at what remains. This catches
   the damage longer translated strings do to a layout, which usually shows first on a phone.

When the judge can't decide, the case becomes an **escalation** for a human. The judge does
not guess.

**Where you see it:**

- **Public boards:** [`/tracker`](https://www.aemdev.org/tracker) (top line),
  [`/tracker/translations`](https://www.aemdev.org/tracker/translations) (the page × locale
  matrix), [`/tracker/dev`](https://www.aemdev.org/tracker/dev) (work queue and escalations),
  and [`/tracker/how-to-use-this`](https://www.aemdev.org/tracker/how-to-use-this), which is
  generated from the model itself. These are ordinary EDS blocks that read published JSON feeds.
- **Page Tracker:** the DA app at
  [da.live/app/aemgdc/aemdev/tools/page-tracker](https://da.live/app/aemgdc/aemdev/tools/page-tracker).
  It shows one page across all ten locales, and it is where reviewers record verdicts. It
  reads DA source rather than the lagging published feeds, and it writes only an allow-listed
  set of columns.
- **Review documents** in DA at `/tracker/tx/<locale-path>`, one per translated page, where
  a native reviewer signs off.

**It plugs into DA Translate.** The live `.da/translate.json` is mirrored into
[`.tracker/da-translate.json`](.tracker/da-translate.json) with its credentials stripped, and
`tx:scan` detects what has been sent. The companion [`tools/l10n/`](tools/l10n/) toolkit
repairs a rollout after it lands:

- links the connector made absolute
- brand terms that should not have been translated
- block-by-block canary diffs against English

**Entry points:**

- `npm run group:sync` syncs the groups from the index.
- `npm run tx:scan` records what has been sent.
- `npm run tx:batch` runs the QA tiers.
- `npm run rollup -- --apply --publish` publishes the feeds.

The shapes of the feeds, sheets and reports are specified in
[`docs/tracker/data-contract.md`](docs/tracker/data-contract.md). The handover notes are in
[`docs/tracker/RESUME.md`](docs/tracker/RESUME.md), and the visual tier is documented in
[`docs/tracker/visual-compare.md`](docs/tracker/visual-compare.md).

### Other tools

| Tool | What it does |
| --- | --- |
| [Preflight](tools/preflight/) | A pre-publish checks panel, built with Lit, with results by category and severity |
| [Page tree](tools/pagetree/) | A folder and page picker modal, used by Advanced Search |
| [`tools/l10n/`](tools/l10n/) | Post-rollout localization CLIs: link-heal, term-heal, canary check, exact doc edits, publish ([README](tools/l10n/README.md)) |
| [`tools/da/`](tools/da/) | Node scripts that seed DA: pages, articles, bios, collages, popular articles |
| [`tools/importer/`](tools/importer/) | A blog-post importer into DA |
| [`tools/lib/register-library-row.mjs`](tools/lib/register-library-row.mjs) | Shared helper that registers a palette in the DA site config's `library` sheet, with read-back |
| Quick Edit, Scheduler | Author Kit sidekick plugins ([`tools/quick-edit/`](tools/quick-edit/), [`tools/scheduler/`](tools/scheduler/)). Present, but not registered in the sidekick config |

---

## Blocks

Blocks built for the site, on top of the Author Kit base (header, footer, hero, columns,
cards, fragment, section metadata and so on):

| Area | Blocks |
| --- | --- |
| Meetups and people | [`bio`](blocks/bio/), [`bios`](blocks/bios/), [`speakers`](blocks/speakers/), [`schedule`](blocks/schedule/), [`speaking`](blocks/speaking/), [`splitforms`](blocks/splitforms/) (working forms) |
| Home and listings | [`home-hero`](blocks/home-hero/), [`insights`](blocks/insights/) (index-driven cards; locale-aware with an English fallback), [`article-feed`](blocks/article-feed/), [`ticker`](blocks/ticker/), [`rapid-drop`](blocks/rapid-drop/), [`mtb-card`](blocks/mtb-card/) |
| Editorial | [`blog-post-hero`](blocks/blog-post-hero/), [`author-rows`](blocks/author-rows/), [`callout`](blocks/callout/), [`code`](blocks/code/), [`figure`](blocks/figure/), [`pullquote`](blocks/pullquote/), [`qa`](blocks/qa/), [`step`](blocks/step/), [`update`](blocks/update/), [`table`](blocks/table/), [`carousel`](blocks/carousel/), [`advanced-tabs`](blocks/advanced-tabs/) |
| Embeds and media | [`youtube`](blocks/youtube/), [`spotify`](blocks/spotify/), [`linkedin`](blocks/linkedin/), [`strava`](blocks/strava/), [`embed`](blocks/embed/), [`dam-display`](blocks/dam-display/) (renders AEM DAM assets) |
| Site search | [`search-config`](blocks/search-config/), [`search-tabs`](blocks/search-tabs/), [`search-tab`](blocks/search-tab/), [`results-panel`](blocks/results-panel/) |
| Translation Tracker boards | [`tracker-summary`](blocks/tracker-summary/), [`translation-matrix`](blocks/translation-matrix/), [`group-progress`](blocks/group-progress/), [`work-queue`](blocks/work-queue/), [`escalation-list`](blocks/escalation-list/), [`status-primer`](blocks/status-primer/) |

---

## Lessons worth stealing

Each of these cost us time. All of them apply to any DA or EDS project.

- **Ship browser modules as `.js`, never `.mjs`.** `preview.da.live` answers `.mjs` with a 401,
  which looks like an auth failure rather than a missing file. `npm run lint:browser` enforces
  the rule here.
- **DA's paste parser only accepts tables.** A plugin that inserts a block must send
  `<table>` markup. The div shape inserts nothing, and it fails silently.
- **Register a palette only after its code is live.** DA loads plugin HTML from the live
  origin. If you register first, every author gets an entry that 404s.
- **Plugin vs app: check `context.view === 'edit'`.** The SDK hands `actions.sendHTML` to both,
  so testing for it tells you nothing.
- **`content.da.live` needs auth.** A plain `<img src>` on `aem.live` can't load it. Fetch the
  image through the Source API and show it as a blob URL.
- **`robots: noindex` removes a page from the query index.** The indexer refuses the page, and
  no error appears anywhere. To keep crawlers off a folder you still want indexed, use
  `Disallow:` in `robots.txt`.
- **A browser's `fetch` caches.** Node's doesn't. To read back a write inside a DA app, you
  need both `cache: 'no-store'` and a `?nocache=` parameter, because Cloudflare fronts
  `admin.da.live`.
- **Only one query config is live.** For this DA site, the index is
  [`config/sites/aemdev/query.yaml`](config/sites/aemdev/query.yaml), pushed through the config
  service. `helix-query.yaml` is not read, so edits to it fail silently.

---

## Developing

Content lives in DA. `en/`, `templates/`, `fragments/` and `index.plain.html` are gitignored,
so local copies are only working copies.

1. Clone the repo, then install dependencies with `npm i`.
2. Install the AEM CLI (`npm install -g @adobe/aem-cli`) and run `aem up`.
3. Before you push, run `npm run verify`: lint, the browser-module guard, Node tests and
   browser tests.

Planning docs for the adaptTo() talk are in [`docs/adaptto-2026/`](docs/adaptto-2026/). They
are a historical record of the build, and some of their findings have since been fixed.

### Built on Author Kit

This is an [Author Kit](https://github.com/aemsites/author-kit) site, from the team who built
da.live and adobe.com. It includes:

- **Localization:** language, region and hybrid locale trees, fragment-based localized 404s,
  a localized header and footer, and do-not-translate (`#_dnt`)
- **Flexible sections:** optional containers, grids 1–6, columns 1–12, light and dark color
  schemes, gap and spacing tokens (xs–xxl), and backgrounds from a token, image, color or
  gradient
- **Base content:** universal buttons, retina images, modern favicons, new-window and deep
  links, and modals
- **Header and footer:** brand, main menu and actions, mega menus, and a switch to disable
  them through metadata
- **Sidekick and pre-production:** Quick Edit, extensible plugin plumbing, schedule simulator,
  and conversion of production links to relative ones
- **Developer tools:** environment detection, extensible logging, buildless Lit support, hash
  utilities, modern CSS scoping and nesting, and AEM Operational Telemetry

**Authoring patterns:**

- A **page** takes a `template` metadata property.
- A **section** is styled with `section-metadata` and controls the layout of its blocks.
- A **block** adds visual context inside a section.
- An **auto block** is generated from matching content, usually a link.
- **Default content** is anything outside a block.

### Popular articles (GA4)

[`tools/analytics/generate-popular-articles.mjs`](tools/analytics/generate-popular-articles.mjs)
builds a top-10 popular-articles list from GA4 in two forms: JSON
(`data/popular-articles.json`) and a static fragment
(`fragments/brands/popular-articles.plain.html`).

- `npm run popular:generate` builds both.
- `npm run popular:publish` uploads the fragment to DA and triggers preview and publish.

The script needs `GA4_PROPERTY_ID` and `GA4_SERVICE_ACCOUNT_JSON` (a service account with
`analytics.readonly`), and `DA_TOKEN` to publish. Optional tuning:

- `POPULAR_LOOKBACK_DAYS` (default `1`)
- `POPULAR_LIMIT` (default `10`)
- `POPULAR_INCLUDE_REGEX` (default `^/en/`)
- `POPULAR_EXCLUDE_REGEX`

There is no scheduled workflow for it in this repo yet.
