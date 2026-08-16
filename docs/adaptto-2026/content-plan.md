# Content plan

Content is a **first-class workstream**, not week-5 dressing. Several demo beats are
impossible without it: Advanced Search needs pages to search, Preflight needs real broken
links to catch, the Tag Picker needs an authored taxonomy, the Form Picker needs published forms.

## Where the site actually stands

Verified 16 Aug 2026 against `www.aemdev.org`, `main--aemdev--aemgdc.aem.live` and `.aem.page`:

| Path | Live | Preview | Note |
| --- | --- | --- | --- |
| `/` | 301 → `/en/` | 301 | fine |
| `/en/` | 200 | 200 | home page renders |
| `/en/contact` | 200 | — | exists |
| `/en/meetup-recaps` | 200 | 200 | landing page |
| `/en/meetup-recaps/20260625-bring-your-complicated-eds-integration-story-meetup` | 200 | — | **the only real body content on the site** |
| `/en/meetup-recaps/aem-gdc-june-2026-eds-cdn-recap` | **404** | — | **linked from the home page — broken** |
| `/en/articles` | **404** | 200 | authored, never published |
| `/en/insights` | **404** | **404** | **linked from the home-page CTA — a live broken link** |
| `/en/meetups` | 404 | 404 | doesn't exist yet — the rename target |
| `/en/fragments/rapid-drop-articles` | — | **404** | referenced by the home hero's `rapid-fragment` row |
| **`/en/query-index.json`** | **200** | — | **works** — 4 rows, 25 columns |
| `/en/articles/query-index.json` | 404 | — | doesn't exist; `article-feed`'s doc comment points at it |
| `/en/sitemap.xml` | 200 | — | generated from `/en/query-index.json` |
| `/sitemap.xml` | 200 | — | empty `<urlset>` — the real one is `/en/sitemap.xml` |

**Correction:** an earlier version of this table said no `query-index.json` was published
anywhere. That was wrong — I checked `/query-index.json` and two per-section paths, but not
`/en/query-index.json`, which is the one the deployed config actually produces. The indexing
machinery works; it just has four rows in it. Details and the config traps underneath it are
in [S11](subproducts.md#s11--query-index--config-hygiene).

So: the home page renders and links to **three** things that 404, and there is one piece of
real body content on the whole site.

Two of those broken links are *useful* — `/en/insights` is exactly the kind of thing Preflight
should catch (S7). **Do not fix `/en/insights` until after the talk.** Note it here so nobody
"helpfully" repairs the demo's planted failure. Do fix the other two: the hero fragment
reference and the stale recap link (the real recap is at the `20260625-...` slug) — a broken
hero and a dead nav link are just breakage, and Preflight only needs one planted failure.

## The `/en/meetups/` model

**Decision to confirm, then everything below follows from it.**

Rename `/en/meetup-recaps/` → **`/en/meetups/`** and make it the single home for the whole
event lifecycle — announced, upcoming, and recapped — rather than a backward-looking archive.

**Do this in week 0, before authoring anything.** Right now exactly one page lives under
`/en/meetup-recaps/`, so the rename costs one redirect. Every page authored under the old path
before the rename multiplies that cost, and Batch B adds a dozen.

### This replaces `/en/events/`

The original plan had the demo publishing into a separate `/en/events/` tree
([S9](subproducts.md#s9--meetup-blocks--the-enmeetups-rename)). Two folders for the same thing is exactly
the split this rename exists to avoid. **Recommendation: collapse them — `/en/meetups/` only.**

Consequences, all of them improvements:

- The stage page becomes **`/en/meetups/2026-10-berlin-meetup`**, not `/en/events/...`.
- One index in [helix-query.yaml](../../helix-query.yaml), not two.
- The page the demo builds lands in the *same* corpus Advanced Search operates on in Act 3,
  which makes Act 3 a natural continuation instead of a change of subject.
- Non-meetup events (DevLive, adaptTo(), a conference) still live here; `event-type`
  distinguishes them, and it maps 1:1 onto the `event` category already specced in the
  [`aemdev` taxonomy](#aem-taxonomy--the-aemdev-namespace) — meetup, conference, webinar,
  workshop, lightning-talk. The taxonomy and the content model agree for free.

### Lifecycle status

One template, one folder, three states driven by a `status` metadata value:

| `status` | Means | Page shows |
| --- | --- | --- |
| `announced` | Date and/or venue not yet fixed | Title, city, "full details coming soon", join-the-Collective form |
| `upcoming` | Confirmed, not yet happened | Agenda, speakers, venue, RSVP form |
| `recap` | Event is over | Video, photos, timestamped highlights, slides, speaker bios |

A page moves `announced → upcoming → recap` in place. Same URL the whole way, so a link shared
in March still works in December — worth one sentence on stage, because it is the thing
folder-per-year event structures get wrong.

This also gives Preflight ([S7](subproducts.md#s7--preflight--publish-workflow)) genuinely
useful status-conditional rules: an `upcoming` page with no `event-date` is an error; a `recap`
page with no video is a warning; an `announced` page is allowed to be sparse.

### Rename work items

| Item | Note |
| --- | --- |
| Move DA content `/en/meetup-recaps/*` → `/en/meetups/*` | One page today: `aem-gdc-june-2026-eds-cdn-recap` |
| 1:1 redirect old → new | EDS `redirects` sheet in DA is the simplest route. This repo also has Fastly VCL under [config/fastly/www-aemdev-org/](../../config/fastly/www-aemdev-org/) if a CDN-level redirect is preferred — pick one, don't do both |
| Rename the `meetup-recaps` index in `helix-query.yaml` | `include: /en/meetups/**`, `target: /en/meetups/query-index.json`; add `status`, `event-type`, `rsvp-form` properties |
| Nav + footer | Update the `/en/meetup-recaps` links (the home page links it twice) |
| Verify the old URL 301s and the new one 200s | Before any bulk authoring starts |

Drop the separate `events` index from S9 if this is confirmed.

## What to build

### Batch A — Structural (due 5 Sep)

| Item | Why | Owner |
| --- | --- | --- |
| **Rename `/en/meetup-recaps/` → `/en/meetups/` + redirect** | **Week 0 — blocks all of Batch B** | Tad |
| Publish `/en/articles` + its query-index | Home page links to article content; Preflight and search both want real pages | Tad |
| Create `/en/insights` — **but leave unpublished** | Ready to publish as the Preflight fix moment, if we want a live save | Tad |
| Fix `/en/fragments/rapid-drop-articles` | Home hero references a missing fragment | Tad |
| `/en/meetups/` landing page + index (S9) | Lists upcoming and past; the demo publishes into it | Tad |
| DA **template** for the meetup page, all three states | Act 1 starts from a template, not a blank page | Tad |
| Nav + footer updated for `/en/meetups` | So the published page is reachable on screen | Tad |

### Batch B — Demo fuel (due 12 Sep)

**Target: 12–16 pages under `/en/meetups/`.** This is the single most important content item —
it is the corpus Advanced Search operates on in Act 3, and a bulk edit across 3 pages
demonstrates nothing.

The good news: **the four sources below get us there with real content.** The 8–10 fabricated
recaps in the original plan are no longer needed — keep them only as a fallback if the real
sources come up short of 12, and label them clearly if used. Real pages survive audience
scrutiny; invented ones are exactly what a room full of AEM practitioners will notice.

#### B1 — Recaps from the AEM User Groups YouTube channel

Source: [the AEM User Groups channel](https://www.youtube.com/@adobeexperiencemanageruser7261),
filtered to Tad's sessions.

**Unresolved: I could not enumerate this list.** YouTube's channel-search pages render
client-side, so they come back empty to a server-side fetch, and `yt-dlp` isn't installed on
this machine. The video count is therefore unknown — which matters, because it drives whether
we hit 12 pages. **Enumerate it first, in week 0**, one of:

```bash
pipx install yt-dlp
yt-dlp --flat-playlist --print "%(id)s|%(title)s|%(upload_date)s" \
  "https://www.youtube.com/@adobeexperiencemanageruser7261/search?query=tad"
```

…or the YouTube Data API `search.list` with `channelId` + `q=tad`, or simply opening the page
and pasting the list. Record the result in this doc so the page count stops being a guess.

Known already, from the home page's `speaking` block:

| Video | Session |
| --- | --- |
| [`87PyVSF3Enc`](https://www.youtube.com/watch?v=87PyVSF3Enc) | EDS & AEM Infrastructure, CDN & Edge Workers, Safe Mass Search-Replace on DA (Cary, NC) |
| [`riIwPPiK8NI`](https://www.youtube.com/watch?v=riIwPPiK8NI) | AEM 6.5 LTS vs Edge Delivery vs AEMaaCS (Columbus AUG) |

Per-page generation: title, `event-date`, `event-location`, `event-speakers`, `event-type`,
`status: recap`, video embed (this repo already has [blocks/youtube/](../../blocks/youtube/) and
[blocks/embed/](../../blocks/embed/)), a summary, and timestamped highlights where the
description has chapters. Speaker bios come later — these pages are the **demo fuel for the
Bio Manager**: leave the speaker slots empty at first so backfilling them is a real task, not
a staged one.

Reuse the existing tooling rather than writing new: [tools/importer/](../../tools/importer/) and
[tools/da/push-articles.js](../../tools/da/push-articles.js) already push generated pages into DA.

#### B2 — Three converted Arbory blog posts

Port these into `/en/meetups/`, reframed as AEM User Group recaps:

| Source | Event | Speakers | Video |
| --- | --- | --- | --- |
| [eds-cdn-architecture-advanced-search-aem-meetup-cary-nc](https://blog.arborydigital.com/en/blog/eds-cdn-architecture-advanced-search-aem-meetup-cary-nc) | Cary, NC — hosted at JMP Statistical Discovery, Feb 2026 | Tad Reeves; Laurel Timko (Senior Software Engineer, JMP) | `87PyVSF3Enc` |
| [sites-optimizer-eds-da-localization-at-atlanta-aem-meetup](https://blog.arborydigital.com/en/blog/sites-optimizer-eds-da-localization-at-atlanta-aem-meetup) | Atlanta — hosted at Cox Communications HQ | Tad Reeves; Wilson Faure (3× AEM Champion, Director of Digital Marketing Platforms, Cox) | none — not recorded |
| [aem-6-5-lts-edge-delivery-and-aemaacs-aem-columbus-meetup](https://blog.arborydigital.com/en/blog/aem-6-5-lts-edge-delivery-and-aemaacs-aem-columbus-meetup) | AEM Columbus User Group | Tad Reeves | `riIwPPiK8NI` |

**What "vendor-neutral" means here** — be precise, because over-scrubbing is its own failure:

- **Remove:** "Contact Us" / "We'd love to talk!" CTAs, "leads Arbory Digital's AEM practice"
  positioning, the Spotify podcast promo, and author-bio-as-marketing framing.
- **Keep:** speaker names and their employers. Naming JMP, Cox and Arbory as the speakers'
  affiliations is *attribution*, not promotion — and dropping them would misrepresent who
  presented. Neutrality is treating all three the same way, not erasing all three.
- **Keep:** venue host credit ("hosted at Cox Communications HQ"). Hosts earn the mention, and
  it is the model we want other companies to copy.
- **Reframe:** author bio → speaker bio. These become the seed rows for the Bio Manager sheet,
  so write them in that shape.
- **Re-voice:** first-person-Arbory ("we ran a meetup") → user-group voice ("the group met").
  [PRODUCT.md](../../PRODUCT.md) has the intended register — peer-to-peer, practitioner, not
  vendor.

Two checks before publishing: confirm the posts can be relicensed onto aemdev.org (Tad wrote
them, so this should be a formality), and **do not republish the attendee photo galleries
without asking** — identifiable people at a private company's office is a different permission
question from reusing your own prose.

#### B3 — Placeholder pages for upcoming events

`status: announced` or `upcoming`, all on the same template, each stating plainly that full
details are coming — then converted in place to a recap after the event.

| Event | Date | Status |
| --- | --- | --- |
| Adobe Developers Live — San Jose | **23 Oct 2026**, in-person (no livestream) | `upcoming` |
| AEM Meetup — Washington DC | **TBC** — confirm via [aem-augs.adobe.com](https://aem-augs.adobe.com/) or [the DC meetup group](https://www.meetup.com/adobe-experience-cloud-dc/) | `announced` |
| AEM Meetup — Munich | **TBC** — confirm date and venue | `announced` |
| adaptTo() 2026 — Berlin | 28–30 Sep 2026 | `upcoming` |

Adding adaptTo() itself is worth it: the talk can point at its own page on the site, and it
makes the Berlin meetup the demo builds sit in a real, populated neighbourhood rather than
alone in an empty folder.

DC and Munich dates were not findable from public sources — chase them in week 0, and if they
stay unknown, that is *fine*: an `announced` page with "date coming soon" is the honest state
and it is exactly what the status model exists to represent.

#### B4 — Supporting content

**Speaker bios — 8–10 under `/en/fragments/bios/`** plus the backing bios sheet (S4).
B1 and B2 supply most of the real names (Tad, Laurel Timko, Wilson Faure, plus whoever the
YouTube enumeration turns up). Ask before publishing a bio and headshot of a real person who
hasn't offered one; fill any remainder with clearly-fictional entries. The Bio Manager's
"search existing bios" step needs a list long enough that searching it looks necessary.

**Icon library** — 40–60 SVGs under `icons/` with the manifest (S3). Must cover the agenda
row's needs (calendar, clock, map-pin, ticket, coffee, mic, laptop, beer) plus enough breadth
that search is meaningful. A 12-icon picker doesn't demonstrate a picker.

**Headshots in DAM** — 8–10 images in a dedicated folder on the PRD sandbox for the Asset
Selector step. Point `DAM_DEFAULT_PATH` at it.

### Batch C — Backing services (due 12 Sep)

#### AEM taxonomy — the `aemdev` namespace

**Owner: Tad ([S2a](subproducts.md#s2a--tagsservlet-fix--aemdev-tag-namespace)). Due 28 Aug**
— earlier than the rest of Batch C, because Laurel's fixture and the picker's scoping both
key off it.

Authored on the Arbory Digital PRD sandbox author, under a dedicated namespace at
**`/content/cq:tags/aemdev`**, then activated to publish. Namespacing keeps the demo taxonomy
isolated from anything else in that sandbox and lets the picker request `.aemdev` instead of
walking the whole tag repository.

Verified 16 Aug: `/services/tagsservlet.aemdev` returns `ERROR: Invalid Tag Catgegory` — the
namespace does not exist yet.

| Category | Tags |
| --- | --- |
| `topic` | edge-delivery, document-authoring, aemaacs, 6-5-lts, migration, performance, forms, personalization, cdn, authoring-ux |
| `event` | meetup, conference, webinar, workshop, lightning-talk |
| `region` | emea, north-america, apac, virtual |
| `format` | in-person, hybrid, virtual |

So `/content/cq:tags/aemdev/topic/edge-delivery`, and so on.

Add German (`de`) titles on at least the `topic` tags — the servlet supports multi-language
with English fallback, and it is a free, well-earned laugh in Berlin.

Once authored, capture a real response to `tools/tagpicker/fixtures/tags.json` and commit it.
That fixture is the handoff to [S2b](subproducts.md#s2b--tag-picker-configuration--page-tag-read-back)
and the cached fallback the picker degrades to on stage.

#### Forms in Forms Cloud Service

Every `/en/meetups/` page eventually carries a form in its footer — **join the Collective** or
**host an event**. Strictly speaking the pages don't need one; the point is to show an AEM Form
placed by an author, on a real page, as a normal part of the authoring flow. That is a good
enough reason on its own, and it should be said that plainly on stage rather than pretending
the form is load-bearing.

Five published forms so the picker has a real list (S6):

1. **AEM GDC Berlin RSVP** — the one we pick live. Name, email, company, dietary, +1.
2. **Join the Collective** — the footer form backfilled across the corpus in Act 3.
3. **Host an AEM GDC Event** — venue offer; different field types, so the picker's preview
   has something to distinguish.
4. **Call for Speakers** — a decoy.
5. **Newsletter Signup** — short decoy.

##### This gives Act 3 a better story

The original Act 3 had us retiring an "old" form we'd have had to plant in 14 pages first —
a contrivance, and the kind an audience of practitioners smells.

**Use the real task instead:** every meetup page is supposed to end with the *Join the
Collective* form. The dozen pages generated in B1/B2 won't have it, because they were
generated from videos and blog posts. So the Act 3 line becomes:

> "We just decided every meetup page gets this form. There are fourteen of them. I'm not
> opening fourteen pages."

Block-aware search across `/en/meetups/`, version all, bulk-append the form block, show the
undo. It is a genuine content-operations task, it is the honest reason the tool exists, and it
needs no planting — **just don't add the footer form to B1/B2 pages when authoring them.**
Note that in the generation script so nobody "finishes the job" and deletes the demo.

Update [S5](subproducts.md#s5--advanced-search) and
[plan.md](plan.md#demo-narrative) if this is adopted.

#### Preflight rules sheet

The config sheet driving S7's checks, authored in DA so the "governance owns this, not
engineering" claim is demonstrably true.

#### German invitation page

`/de/meetups/2026-10-berlin-meetup` — one translated page for the S8 translation-tracker cameo
and the multi-language tag demo. Low effort, high Berlin value.

## The page built on stage

**`/en/meetups/2026-10-berlin-meetup`** — `status: upcoming`, `event-type: meetup`.

- **Pre-staged:** the template, the two speakers' headshots in DAM, one of the two bios
  already in the sheet, the RSVP form published in Forms CS, the taxonomy authored.
- **Built live:** the page itself — hero, agenda with icons, speaker fragments, tags, RSVP
  block, preflight pass, publish.
- **Planted failures for Preflight:** one image with no alt text, one missing `event-date`
  (which the status model makes an *error* on an `upcoming` page — the rule earns its
  existence), one link to `/en/insights`.
- **Lands in the same folder** as the twelve-plus pages from Batch B, which is what lets Act 3
  follow on without changing subject.
- **Reset procedure:** written down, tested, and runnable in under 3 minutes so the page can
  be rebuilt between rehearsals and before the talk. Put it in this doc once it exists.

## Content freeze

**18 Sep.** After that date, no new pages, no metadata changes, no republishing. Rehearsals
#2 and #3 run against frozen content so the timings mean something.

Between the freeze and the talk, the *only* content that changes is the stage page itself,
reset via the documented procedure.
