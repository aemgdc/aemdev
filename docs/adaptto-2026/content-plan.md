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
| `/en/meetup-recaps` | 200 | 200 | **one** recap: `aem-gdc-june-2026-eds-cdn-recap` |
| `/en/articles` | **404** | 200 | authored, never published |
| `/en/insights` | **404** | **404** | **linked from the home-page CTA — a live broken link** |
| `/en/events` | 404 | 404 | doesn't exist; the demo needs it |
| `/en/fragments/rapid-drop-articles` | — | **404** | referenced by the home hero's `rapid-fragment` row |
| `/en/articles/query-index.json` | 404 | — | no published index |
| `/en/meetup-recaps/query-index.json` | 404 | — | no published index |
| `/sitemap.xml` | 200 | — | **empty** `<urlset>` |

So: the home page renders and links to two things that 404, no index is published anywhere,
and there is one piece of real body content on the whole site.

Two of those broken links are *useful* — `/en/insights` is exactly the kind of thing Preflight
should catch (S7). **Do not fix `/en/insights` until after the talk.** Note it here so nobody
"helpfully" repairs the demo's planted failure. (Do fix the hero fragment reference — a
broken hero is just a broken hero.)

## What to build

### Batch A — Structural (due 5 Sep)

| Item | Why | Owner |
| --- | --- | --- |
| Publish `/en/articles` + its query-index | Home page links to article content; Preflight and search both want real pages | Tad |
| Create `/en/insights` — **but leave unpublished** | Ready to publish as the Preflight fix moment, if we want a live save | Tad |
| Fix `/en/fragments/rapid-drop-articles` | Home hero references a missing fragment | Tad |
| Create `/en/events/` landing + events index (S9) | The demo publishes into it | Tad |
| DA **template** for the event invitation | Act 1 starts from a template, not a blank page | Tad |
| Nav + footer updated for `/en/events` | So the published page is reachable on screen | Tad |

### Batch B — Demo fuel (due 12 Sep)

**Meetup recaps — 12–14 pages under `/en/meetup-recaps/`.** This is the single most important
content item: it is the corpus Advanced Search operates on in Act 3, and the bulk-replace has
no impact at 3 pages.

- 3–4 **real** recaps (June 2026 EDS/CDN one already exists; add genuine past AEM GDC and
  Columbus AUG sessions — the home page's `speaking` block lists real talks with YouTube links
  to draw from).
- 8–10 plausible dummy recaps. Real-looking titles, dates spread across 2025–2026, real-sounding
  speakers, varied tags.
- **Critical:** every one of them must contain the *old* RSVP form block reference, so the
  Act 3 search+replace has 12+ genuine hits. Bake this in when authoring, not after.
- Each needs `event-date`, `event-location`, `event-speakers` metadata (already indexed).

**Speaker bios — 8–10 under `/en/fragments/bios/`** plus the backing bios sheet (S4).
Mix of real community figures (with permission) and invented ones. The Bio Manager's "search
existing bios" step needs a list long enough to be worth searching.

**Icon library** — 40–60 SVGs under `icons/` with the manifest (S3). Must cover the agenda
row's needs (calendar, clock, map-pin, ticket, coffee, mic, laptop, beer) plus enough breadth
that search is meaningful. A 12-icon picker doesn't demonstrate a picker.

**Headshots in DAM** — 8–10 images in a dedicated folder on the PRD sandbox for the Asset
Selector step. Point `DAM_DEFAULT_PATH` at it.

### Batch C — Backing services (due 12 Sep)

#### AEM taxonomy

On the PRD sandbox at `/content/cq:tags`, authored to match the servlet's pipe-delimited
`category|subcategory|tag` model. Blocked on the S2 servlet fix.

| Category | Tags |
| --- | --- |
| `topic` | edge-delivery, document-authoring, aemaacs, 6-5-lts, migration, performance, forms, personalization, cdn, authoring-ux |
| `event` | meetup, conference, webinar, workshop, lightning-talk |
| `region` | emea, north-america, apac, virtual |
| `format` | in-person, hybrid, virtual |

Add German (`de`) translations on at least the `topic` tags — the servlet supports multi-language
and it is a free, well-earned laugh in Berlin.

#### Forms in Forms Cloud Service

Four published forms so the picker has a real list (S6):

1. **AEM GDC Berlin RSVP** — the one we pick. Name, email, company, dietary, +1.
2. **AEM GDC Call for Speakers** — a decoy with different field types.
3. **Newsletter Signup** — short.
4. **Meetup Feedback Survey** — the "old" form the Act 3 bulk-replace is retiring.

#### Preflight rules sheet

The config sheet driving S7's checks, authored in DA so the "governance owns this, not
engineering" claim is demonstrably true.

#### German invitation page

`/de/events/2026-10-berlin-meetup` — one translated page for the S8 translation-tracker cameo
and the multi-language tag demo. Low effort, high Berlin value.

## The page built on stage

`/en/events/2026-10-berlin-meetup`

- **Pre-staged:** the template, the two speakers' headshots in DAM, one of the two bios
  already in the sheet, the RSVP form published in Forms CS, the taxonomy authored.
- **Built live:** the page itself — hero, agenda with icons, speaker fragments, tags, RSVP
  block, preflight pass, publish.
- **Planted failures for Preflight:** one image with no alt text, one missing `event-date`,
  one link to `/en/insights`.
- **Reset procedure:** written down, tested, and runnable in under 3 minutes so the page can
  be rebuilt between rehearsals and before the talk. Put it in this doc once it exists.

## Content freeze

**18 Sep.** After that date, no new pages, no metadata changes, no republishing. Rehearsals
#2 and #3 run against frozen content so the timings mean something.

Between the freeze and the talk, the *only* content that changes is the stage page itself,
reset via the documented procedure.
