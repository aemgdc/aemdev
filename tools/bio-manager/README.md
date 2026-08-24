# Bio Manager

Structured speaker and author bios for `aemgdc/aemdev`, authored inside DA.

One codebase, two DA surfaces:

| Surface | Where it appears | Extra capability |
| --- | --- | --- |
| **Fullscreen app** | a card at `da.live/apps#/aemgdc/aemdev`, and directly at `da.live/app/aemgdc/aemdev/tools/bio-manager` | — |
| **Library plugin** | the Library panel while editing a document | `Insert` — drops a fragment reference into the open doc |

Forked from `arbory-da` @ `origin/bio-list`. **Not** kept in sync with it: headshots
live in DA here rather than AEM Assets, the schema carries title/company/LinkedIn/review
status, and every path lives in one place.

## What it writes

| Thing | Path | Notes |
| --- | --- | --- |
| Bio document | `/en/fragments/bios/<slug>` | The unit of content. Previewed and published on save. |
| Headshot | `/media/bios/<slug>.<ext>` | DA's documented "media folder" pattern. |
| Roster sheet | `/bios.json` | Never previewed, so it stays off the public site and out of `/en/query-index.json`. Openable at `da.live/sheet#/aemgdc/aemdev/bios`. |

All three, plus the document format itself, are defined in
[`bio-doc.js`](bio-doc.js) — imported by both the browser app and
[`tools/da/push-bios.js`](../da/push-bios.js), so a seeded bio and an
author-created one are byte-identical in shape.

### The document

A two-column key/value block, so a human can hand-edit a bio in DA without
knowing this app exists:

| Bio | |
| --- | --- |
| Photo | *[image]* |
| Name | Eric Van Geem |
| Title | Director, Technology |
| Company | Huge |
| LinkedIn | `https://www.linkedin.com/in/ericvangeem/` |
| Bio | rich text |

Plus a `metadata` block carrying `bio-name`, `bio-title`, `bio-company`,
`bio-linkedin`, `bio-image` and `bio-status`. The Edge Delivery pipeline moves
that into `<head>` and strips it from both the rendered body and `.plain.html` —
which is why a bio pulled into a host page cannot overwrite that page's own
metadata.

**There is deliberately no `robots: noindex` on a bio.** The Helix indexer
honours that meta and refuses the document outright —
`POST /index/aemgdc/aemdev/main/en/fragments/bios/<slug>` answers
*"requested path has 'noindex' property set"* — so a noindex bio would never
reach `aemdev-bios`. Crawlers are kept off with `Disallow: /en/fragments/` in
[config/sites/aemdev/robots.txt](../../config/sites/aemdev/robots.txt) instead,
which is the right layer for a path-wide rule and covers every fragment rather
than just bios. Bios are already absent from `sitemap.xml`, which is generated
from `/en/query-index.json` and that index excludes `/en/fragments/**`.

The trade-off, stated plainly: `Disallow` is a weaker signal than `noindex`. A
URL discovered some other way can still surface as a URL-only result. For
composed content fragments that is an acceptable trade; if it ever isn't, the
fix is to drop the `aemdev-bios` index, not to re-add the meta.

`bio-status` is `placeholder` or `approved`. Placeholder means *nobody has
confirmed this is accurate about a real person*. It is surfaced on every roster
card, and it is the flag Preflight should eventually refuse to publish over.

## How a bio reaches a page

Two ways, both live:

1. **`speakers` metadata** — `<meta name="speakers" content="tad-reeves, laurel-timko">`.
   Drop an empty `speakers` block on the page and [`blocks/speakers`](../../blocks/speakers/speakers.js)
   resolves each slug to `/en/fragments/bios/<slug>` and renders the roster. Every
   `/en/meetups/*` page already carries this metadata, so those pages need no
   re-authoring. A slug with no document renders a visible "no bio yet" row.
2. **A fragment reference** — the plugin's `Insert` action writes a plain anchor to
   `/en/fragments/bios/<slug>`. `linkBlocks` in [`scripts/scripts.js`](../../scripts/scripts.js)
   auto-blocks any href containing `/fragments/`, so it becomes a `fragment` block
   with no extra authoring. This is the path for a page with no `speakers`
   metadata, such as an article.

Both render through [`blocks/bio`](../../blocks/bio/bio.js).

## Setup

Three steps. Only the first is not in this repo.

### 1. The app card — DA config (manual, once)

The apps sheet lives in DA, not in git. Open
`https://da.live/config#/aemgdc/aemdev/`, add a tab called **`apps`**, and add
this row:

| title | description | image | path | ref |
| --- | --- | --- | --- | --- |
| Bio Manager | Speaker and author bios as structured content | `https://main--aemdev--aemgdc.aem.live/img/tools/bio-manager.png` | `https://da.live/app/aemgdc/aemdev/tools/bio-manager` | |

Save, and the card appears at the top of `da.live/apps#/aemgdc/aemdev`.

This is deliberately **not** scripted. The same DA config holds permissions, and
writing it back from a guessed payload is not worth the blast radius for a
30-second edit.

### 2. The library plugin — already committed

[`tools/sidekick/config.json`](../sidekick/config.json) carries it, first in the
demo running order. The config service picks the repo file up automatically; no
push, no workflow. Verify with:

```bash
curl -s https://admin.hlx.page/sidekick/aemgdc/aemdev/main/config.json | python3 -m json.tool
```

### 3. The bios query index — deployed

[`config/sites/aemdev/query.yaml`](../../config/sites/aemdev/query.yaml) defines
`aemdev-bios` over `/en/fragments/bios/**`, and it is **live**:

```bash
curl -s https://www.aemdev.org/en/fragments/bios/query-index.json | python3 -m json.tool
```

7 rows, 9 columns. `/en/query-index.json` is untouched — `aemdev-en` is
property-for-property identical to what was already deployed.

The S11 drift this was supposed to be blocked on **no longer exists**: verified
23 Aug 2026 against both the deployed config and `/en/query-index.json`, the
eight orphaned properties the 16 Aug audit found are gone from both. So the push
added exactly one index and deleted nothing.

Still run `sync-site-configs` before any *future* push. A push replaces the
deployed config wholesale, so anything the local file lacks is deleted from it.

Note that nothing in the demo path depends on this index anyway —
`blocks/speakers` resolves slugs to documents directly, so a bio renders the
moment it is previewed.

## Seeding the placeholder corpus

Already done — all seven are live. To re-run (it is idempotent):

```bash
node tools/da/push-bios.js --dry-run
DA_TOKEN=$(cat ~/today-da-token.txt) node tools/da/push-bios.js
```

Reads [`seed/bios.json`](seed/bios.json) — seven bios covering the three
speakers named on the June 2026 meetup page plus the four slugs already
referenced by live `/en/meetups/*` pages, so no page is left with a dangling
speaker.

Headshots are read from `seed/headshots/<slug>.jpg`. **That directory is
gitignored on purpose**: they are other people's photographs, taken from the
public OpenGraph preview each profile publishes, and a versioned copy is one
nobody can retract. `--fetch-headshots` refills it. A bio with no headshot still
seeds — it renders with initials.

Every seeded bio is `status: placeholder`. They are written from public profile
and company pages, and not one of these people has reviewed what it says about
them.

Other flags: `--only slug,slug`, `--no-publish` (preview only).

## Working on it without DA

```
http://localhost:3000/tools/bio-manager/fixtures/preview.html
http://localhost:3000/tools/bio-manager/fixtures/preview.html?plugin=1
http://localhost:3000/tools/bio-manager/fixtures/blocks.html
```

The [fixtures](fixtures/) run the real app against an in-memory DA — no network,
no login. An import map swaps the hosted DA SDK for a mock, and `window.fetch`
is replaced before the app's module loads. `blocks.html` renders `bio` and
`speakers` against fixture documents, including the orphan-slug row.

This is the per-plugin half of S10's fixture mode. It is a development harness,
not a stage fallback: the fallback for a DA outage on stage is the recording.

## Files

| File | What it is |
| --- | --- |
| [`../bio-manager.html`](../bio-manager.html) | The app shell. At `tools/` root so the app URL is `/tools/bio-manager`, with no path segment repeated. |
| [`bio-manager.js`](bio-manager.js) | Roster, editor, live preview, DA I/O. |
| [`bio-manager.css`](bio-manager.css) | Reskinned to [DESIGN.md](../../DESIGN.md). Tokens are duplicated on purpose — this app must not pull the whole site stylesheet into DA's iframe. |
| [`bio-doc.js`](bio-doc.js) | Paths, sheet columns, and the document format. Pure strings, runs in Node. |
| [`seed/bios.json`](seed/bios.json) | The placeholder corpus, with its sources. |
| [`fixtures/`](fixtures/) | Offline harness. |
| [`../da/push-bios.js`](../da/push-bios.js) | Seed script. |
| [`../../blocks/bio/`](../../blocks/bio/) | Renders one bio. |
| [`../../blocks/speakers/`](../../blocks/speakers/) | Renders a page's roster. |
| [`../../test/blocks/`](../../test/blocks/) | 29 unit tests across both blocks. |
