# Content model — dates, redirects, metadata

Working doc for the decisions that have to be settled **before** the corpus gets authored.
Every one of these is cheap now (one real page on the site) and expensive later.

Related: [content-plan.md](content-plan.md) · [S9](subproducts.md#s9--meetup-blocks--the-enmeetups-rename) ·
[S11](subproducts.md#s11--query-index--config-hygiene)

---

## 1. The date field — settled

### The bug was bigger than reported

Earlier I flagged that `insights` sorts on a `date` column that doesn't exist. Checking every
consumer, **both** index consumers read `article.date`, and *nothing* in the codebase reads
`publicationDate`:

| File | Line | Use |
| --- | --- | --- |
| [blocks/insights/insights.js](../../blocks/insights/insights.js) | 200 | `dateValue(b.date) - dateValue(a.date)` — sort |
| [blocks/article-feed/article-feed.js](../../blocks/article-feed/article-feed.js) | 164 | same sort |
| [blocks/article-feed/article-feed.js](../../blocks/article-feed/article-feed.js) | 143, 174 | **displays** `card.date` |

So `article-feed` doesn't just sort wrong — it renders no date at all, because the column it
reads was never emitted. Grep confirms zero consumers of `publicationDate`, `eventDate`,
`releaseDate` or `lastModified` anywhere in `blocks/` or `scripts/`.

### Decision: rename the index property, don't add one

`publicationDate` → **`date`** in [config/sites/aemdev/query.yaml](../../config/sites/aemdev/query.yaml).
Same selector (`head > meta[name="publication-date"]`), same passthrough value — only the
column name changes.

Rejected alternatives:

- *Add a `date` column alongside `publicationDate`* — two identical columns, and a future
  reader has to guess which is authoritative.
- *Change the blocks to read `publicationDate`* — one-line change, but it leaves the site's
  canonical sort key named after only one of the two content streams. `date` is the neutral name.

`eventDate` **stays** as a separate field. It is semantically different — a meetup on 12 Oct
written up on 20 Oct has two real dates, and the [lifecycle model](content-plan.md#lifecycle-status)
sorts upcoming-vs-past on the event date, not the publication date.

### Format: ISO `yyyy-mm-dd`, and fix it now

Current metadata on the one real page:

```html
<meta name="publication-date" content="06-26-2026">
<meta name="event-date"       content="06-26-2026">
```

That is MM-DD-YYYY, while [scripts/utils/date.js](../../scripts/utils/date.js) documents
"Page metadata standardises on ISO `yyyy-mm-dd`" and parses ISO explicitly, treating anything
else via native `Date` fallback. `new Date('06-26-2026')` happens to work in V8, so this is
currently a latent inconsistency rather than a visible break — but the fallback is exactly the
path `date.js` was written to avoid, since it reintroduces the timezone bug the ISO branch fixes.

**Standardise on ISO `yyyy-mm-dd`** for `publication-date`, `event-date` and any future date
field. Three reasons: it matches the documented contract, it sorts lexically, and `06-10-2026`
is genuinely ambiguous to a European audience — we are presenting this in Berlin.

**Cost of deciding now vs later:** one page. After the corpus, 16.

### Follow-through

- [x] `publicationDate` → `date` in the repo config
- [x] `status` added alongside it
- [x] Pushed via `update-index-configuration` — run 31980075227, and the live index now
      carries both columns
- [x] Existing recap migrated to ISO dates, `status: recap`, `template: meetup` and canonical tags
- [x] Every corpus page authored with ISO dates from the start

### Bonus: the reindex flushes the stale columns

My earlier "config drift" diagnosis was **wrong**, and the sync run proved it. The read-back
returned only whitespace changes — a trailing newline and a comment indent — so the repo copy
and the deployed config were already identical at 16 properties.

The 8 extra columns in the live index (`bookAuthor`, `bookPublishDate`, `bookTypeTitle`,
`displayLabel`, `eventDateTime`, `eventDisplayLabel`, `eventDisplayTime`, `offDateTime`) aren't
drift between repo and config service — **the published index is stale**. It was generated
under an older config and still carries columns nothing backs any more.

Which means the earlier warning ("pushing would silently drop 8 columns") was backwards: those
columns are already orphaned, and a reindex clears them.
No decision needed, no data lost.

**Update:** the config push and a reindex of the 8 meetup pages landed `date` and `status`,
but the stale columns are **still present** — the index emits the union across *all* pages, and
the untouched ones (`/en/`, `/en/contact`, …) still carry them. Clearing them needs a full-site
reindex, not a partial one.

That the sync surfaced this within a day of being built is the argument for keeping it on cron.

---

## 2. Redirect mapping for `/en/meetup-recaps/` → `/en/meetups/`

> ### ✅ Done — 16 Aug 2026
>
> The move is executed and verified. `/en/meetups/` holds 8 pages, old URLs 301, images
> render, and the index carries `status` and `date`. What follows is kept as the record of
> how it was done and what bit us. **Four corrections to what this section originally said
> are marked inline below.**
>
> The old `/en/meetup-recaps/` content was **left in place**, not deleted — the redirects
> shadow it, so it is unreachable and harmless. Deleting it is a separate, deliberate step.

### Complete inventory

The DA MCP server 503s on every call, but the `admin.da.live` REST API works with a bearer
token, so this list is authoritative rather than inferred from published output.

**`/en/meetup-recaps/` contains exactly one document**, plus the landing page one level up:

| Old | New | Note |
| --- | --- | --- |
| `/en/meetup-recaps.html` | `/en/meetups.html` | landing page |
| `/en/meetup-recaps/20260625-bring-your-complicated-eds-integration-story-meetup.html` | `/en/meetups/20260625-…` | the only real body content |
| `/en/meetup-recaps/.20260625-…/` | `/en/meetups/.20260625-…/` | hidden media folder — hero v1.4.jpg, hero v1.8.jpg, screenshot png |
| `/en/meetup-recaps/.aem-gdc-complicated-eds-integration-recap/` | see below | hidden media folder — orphaned slug, 1 png, **still referenced** |
| `/en/meetup-recaps/aem-gdc-june-2026-eds-cdn-recap` | — | **doesn't exist** in DA, preview or live |

For the rest of the site: `/en/articles/` holds one authored-but-unpublished document,
`aem-eds-content-modeling-deep-dive.html`, and `/en/drafts/` is empty.

> **Don't trust `admin.da.live/list` for media.** It reported 1 file in
> `.20260625-…/` while the document references two more hero JPGs from that same folder — all
> three return 200 on a direct source GET. The list API under-reports hidden-folder contents.
> Verify media by fetching it, not by listing it.

### ⚠️ The move requires rewriting the document source, not just moving files

This is the finding that changes the procedure. Images in the DA source are **absolute
`content.da.live` URLs with the old path baked in**:

```html
src="https://content.da.live/aemgdc/aemdev/en/meetup-recaps/.20260625-…/hero-v1.4.jpg"
```

(The rendered page shows `./media_<hash>.jpg` — EDS resolves and re-hosts these at publish
time. That relative form is *output*, not source, so it is not what has to be maintained.)

Moving the document and its media folder therefore leaves every `src`/`srcset` pointing at
`/en/meetup-recaps/…`. Worst case is not a visible break: the old URLs keep resolving until the
old folder is cleaned up, so the page looks fine and then breaks later, after the demo content
is frozen.

**So the move is: move documents → move media folders → find-and-replace
`/en/meetup-recaps/` → `/en/meetups/` inside every document's source → republish → verify.**

That find-and-replace across a folder is precisely what
[Advanced Search](subproducts.md#s5--advanced-search) does. Worth doing the rename *with* the
tool — it dogfoods S5 on a real task before the demo, and it is a better rehearsal than any
staged case.

### Evidence this trap is already live

`.aem-gdc-complicated-eds-integration-recap/` is a media folder named for a slug **no page
uses** — the current page is `20260625-bring-your-complicated-eds-integration-story-meetup`.
Its PNG is still referenced by the live document.

So this page has already been renamed at least once, and the media references were never
updated. The stale-reference problem isn't hypothetical; it is in the content right now, on the
one real page, and the upcoming rename would have repeated it at corpus scale.

Fold the orphan into the move: repoint that image at the page's own media folder, or leave the
reference intact and move the folder as-is. Either is fine — silently moving the page and
leaving the URL pointing at a path scheduled for deletion is not.

### The third link is a forward reference, not a ghost

> **Correction.** This section originally said `aem-gdc-june-2026-eds-cdn-recap` should be
> repointed at the `20260625-…` slug. **That was wrong**, and the anchor text is what gave it
> away.

`aem-gdc-june-2026-eds-cdn-recap` 404s on `aem.page` *and* `aem.live`, so it was never
created. But it is linked from *inside* the existing recap document (not only the home page),
and its anchor text reads:

> AEM GDC June 2026 — EDS CDN Architecture & Advanced Search

That is the **Cary NC meetup** — a different event from the page linking to it, and one of the
three B2 blog conversions. The link was authored in anticipation of a page that hadn't been
written yet.

So the fix was to **create that page**, not repoint the link. It now exists at
`/en/meetups/aem-gdc-june-2026-eds-cdn-recap`, keeping the slug the link already expected.

**Open question for Tad:** the slug says June 2026 and the link text says June 2026, but the
Arbory blog post reads as February 2026. I used 2026-06-25 to match the link and the sibling
recap. **Confirm the real date** — if it's February, the slug and both dates need changing,
and doing that before the corpus grows is much cheaper.

### Inbound links to update

The home page carries three references, one of them dead:

```
href="/en/meetup-recaps"                                    → /en/meetups
href="/en/meetup-recaps/"                                   → /en/meetups/
href="/en/meetup-recaps/aem-gdc-june-2026-eds-cdn-recap/"   → repoint to the 20260625 slug
```

Redirects catch these, but they should be fixed at source anyway — a nav that 301s on every
click is a smell, and Preflight ([S7](subproducts.md#s7--preflight--publish-workflow)) will
flag them, which is awkward if the demo's own site is the thing failing.

Also update the nav/footer document in DA, not just the home page body.

### Media moves with the pages

### Implementation

Two options; pick one, don't do both:

1. **EDS `redirects` sheet in DA** — a two-column sheet (`Source`, `Destination`) at the
   content root. Versioned as content, editable by anyone, no deploy. **Recommended** — it is
   also demoable, which the Fastly path is not.
2. **Fastly VCL** — [config/fastly/www-aemdev-org/](../../config/fastly/www-aemdev-org/) is
   already versioned and synced daily. Correct for infrastructure-level redirects, heavier for
   two content URLs.

### What actually bit us — three gotchas worth keeping

**1. DA's copy API silently no-ops on hidden folders.** `da_copy_content` returned `{}` — a
success-shaped response — for both `.`-prefixed media folders, and copied nothing. The source
was untouched (so nothing was lost), but a script trusting that return value would have moved
the documents and left the images behind. **Media had to be downloaded and re-uploaded file by
file** via `POST /source/…` with multipart `data`. Verify copies by fetching the destination,
never by trusting the response.

**2. `admin.da.live/list` under-reports hidden folders.** It showed 1 file in
`.20260625-…/` when there were 3. Direct source GETs found all of them. Enumerate media from
the document's own `src`/`srcset` references, not from a listing.

**3. Trailing slashes 404.** `/en/meetups/aem-gdc-june-2026-eds-cdn-recap/` 404s while the
same path without the slash is 200. The pre-existing link carried a trailing slash, so it
would have stayed broken even after the target page existed. Fixed at source.
`/en/articles/aem-eds-content-modeling-deep-dive/` has the **same defect** and is still broken
— that article is also unpublished, so it needs both fixes.

### Sequence

1. Move the two documents **and both hidden media folders** to `/en/meetups/`.
2. **Rewrite `/en/meetup-recaps/` → `/en/meetups/` inside the document source** — the media
   `src`/`srcset` URLs. Use Advanced Search.
3. Add the redirects (2 rows).
4. Update `include:` / `target:` in the index config, push via `update-index-configuration`,
   reindex.
5. Fix the home page and nav links at source, and repoint the ghost link at the `20260625-…` slug.
6. Verify, in this order: old URL 301s → new URL 200s → **images still render** → page appears
   in `/en/meetups/query-index.json`.
7. Only after all of that is green, delete the old folder. Not before — the old media path is
   load-bearing until step 2 is confirmed.

Do this **before** authoring the corpus — the whole point of renaming while the site holds one
page is that this list stays two rows long.

---

## 3. Document metadata — settled

All three open questions are answered. The rule that falls out of them:

> **Taxonomy carries what a thing *is*. Metadata carries what state it's *in* and what it
> *points at*.**

Classification (topic, category, region) lives in the `aemdev` tag namespace as canonical IDs.
Lifecycle (`status`), dates, and references (`speakers`, `rsvp-form`) stay plain metadata,
because they change over the page's life or point at another document — neither is a taxonomy
concept.

### Existing metadata, from the one real page

`template`, `author`, `publication-date`, `category`, `event-date`, `recap-video`, `speakers`,
`location`, plus `article:tag` × 6 (`AEM`, `EDS`, `Edge Delivery`, `Integrations`, `Meetup`,
`GDC`) — display labels, which is what changes below.

### The settled set for `/en/meetups/`

| Field | Required | Values | Note |
| --- | --- | --- | --- |
| `title` / `description` | yes | free text | og tags, already working |
| `template` | yes | `meetup` | today's page says `blog` |
| `status` | yes | `announced` \| `upcoming` \| `recap` | **metadata, not a tag** — it changes as the page ages; re-tagging a page through its lifecycle would abuse the taxonomy |
| `publication-date` | yes | ISO `yyyy-mm-dd` | indexed as `date` |
| `event-date` | if not `announced` | ISO `yyyy-mm-dd` | sorts upcoming vs past |
| `location` | if not `announced` | free text, or `Virtual` | already in use |
| `speakers` | if not `announced` | **bio slugs**, comma-separated: `tad-reeves, laurel-timko` | resolves to `/en/fragments/bios/<slug>` |
| `recap-video` | if `recap` | YouTube URL | already in use |
| `rsvp-form` | if `upcoming` | form id/path | [S6](subproducts.md#s6--form-picker) |
| `article:tag` | yes | **canonical IDs**: `aemdev:topic/edge-delivery` | includes the category tag |

**`event-type` is dropped.** It was going to duplicate the category tag exactly —
`event-type: meetup` alongside `aemdev:category/meetup` is the same fact twice, and two copies
of a fact drift. The category tag carries it.

### Tags: canonical IDs

Page metadata stores the AEM-canonical form, namespace included:

```html
<meta property="article:tag" content="aemdev:topic/edge-delivery">
<meta property="article:tag" content="aemdev:category/meetup">
<meta property="article:tag" content="aemdev:region/emea">
```

This makes S2b's read-back exact instead of a guess. The
[current picker normalisation](subproducts.md#s2b--tag-picker-configuration--page-tag-read-back)
— lowercase, spaces→hyphens, `&`→"and" — is lossy and can't be reversed reliably; with IDs on
the page there is nothing to reverse.

#### Consequences, all real work

1. **The picker's output format changes.** [tools/tagpicker/](../../tools/tagpicker/) currently
   emits pipe-delimited `category|subcategory|tag` per its README. It must emit
   `aemdev:topic/edge-delivery`. This is an [S2b](subproducts.md#s2b--tag-picker-configuration--page-tag-read-back)
   work item that only exists because of this decision.
2. **Blocks must resolve IDs to labels for display.** Nothing renders a raw
   `aemdev:topic/edge-delivery` to a reader. See the label map below.
3. **`insights`' authored filter values change.** The block filters on `tag | EDS, GDC` and
   `category | Meetup Recap` matched case-insensitively against authored values. Those authored
   rows must become IDs, or the block must resolve labels before matching. Pick one and write
   it in the block's doc comment — it is authored config, so getting it wrong is silent.
4. **The existing page's 6 tags get rewritten** to IDs. One page today.

### Label translation — the mechanism already exists

The reference implementation at `https://www.jmp.com/services/tagsservlet` is live and healthy,
and it is worth Tad diffing against while fixing the Arbory one
([S2a](subproducts.md#s2a--tagsservlet-fix--aemdev-tag-namespace)). Verified 16 Aug:

| Request | Returns |
| --- | --- |
| `/services/tagsservlet` | HTTP 200, 24KB — full tree, namespaced under `/content/cq:tags/jmp/`, translations inline as `jcr:title.de`, `jcr:title.ja`, … |
| `/services/tagsservlet.all` | flat array of category **titles**: `["Industry","Product","Capability",…]` |
| `/services/tagsservlet.de` | **flat map, 128 entries, 6KB**: `{"country|france": "Frankreich", "resource-type|customer-story": "Kundenerfahrungen", …}` |
| `/services/tagsservlet.industry\|academic.de` | plain text: `Akademisch` |

**`.{lang}` is the label resolver.** One 6KB fetch returns every label for a language, keyed by
pipe-delimited ID, with untranslated tags falling back to English. That is exactly what a block
needs, and it is what makes the German beat in Berlin a config change rather than a feature.

Two things the reference also demonstrates, both worth knowing before authoring:

- **The two ID forms.** AEM-canonical is `jmp:industry/academic`; the servlet's map keys are
  `industry|academic`. Conversion is mechanical — strip the `aemdev:` prefix, swap `/` for `|`.
  Pages carry the canonical form; the label lookup converts. Do this in one shared helper, not
  in each block.
- **Translation coverage is patchy and language keys are inconsistent.** Only 5 of JMP's 14
  categories have any translations, and `country` carries both `zh_cn` and `zh-hans`, both `ko`
  and `ko_kr`. The aemdev picker README already documents a normalisation map for exactly this.
  Expect to normalise, and expect fallback-to-English to be the common path, not the edge case.

#### Labels are synced, not fetched at render time — settled

**Agreed (Tad).** The client pulls translated labels from AEM directly only in rare cases; the
normal path is a synced artefact.

Fetching the label map from AEM publish on every page view would put an AEM round-trip in front
of every reader — in a talk arguing EDS is fast, on a site whose own tag rendering would then
depend on an AEM instance being up.

**Instead: sync the label map into the content bus** as `/en/tags-<lang>.json` (or one file
keyed by language), refreshed by a scheduled job — the same pattern as
[sync-site-configs](../../.github/workflows/sync-site-configs.yaml), which is already working
and surfaced a real problem within a day of being built. Label resolution becomes a local fetch
of a cached ~6KB JSON, the AEM dependency moves to build time, and the tag picker's
[cached fallback](subproducts.md#s2b--tag-picker-configuration--page-tag-read-back) reuses the
same artefact rather than maintaining a second one.

An AEM outage during the talk then degrades label rendering to nothing visible, rather than to
a hang.

**Note the dependency:** the sync source is `/services/tagsservlet.{lang}`, which is one of the
three endpoints currently returning **HTTP 500**
([S2a root cause](subproducts.md#-root-cause-found--its-one-hard-coded-line)). The label-map
sync cannot be built until that fix lands.

This is a third artefact following the same shape — Fastly config, site config, and now tag
labels. Worth factoring the "fetch, write, commit if changed" scaffolding once rather than a
third time.

### Speakers: bio slugs

```html
<meta name="speakers" content="tad-reeves, laurel-timko">
```

Each slug resolves to `/en/fragments/bios/<slug>`, which is exactly where
[S4's Bio Manager](subproducts.md#s4--bio-manager) writes fragments — its `FRAGMENTS_FOLDER` is
already `/en/fragments/bios` and its sheet already carries a `DA Fragment URL` column.

So the meetup block resolves speakers automatically, and the demo's payoff is real: create a bio
in the Bio Manager, add its slug to `speakers`, and the page pulls in the rendered bio.

Two things to settle when building the block:

- **A slug with no fragment must degrade visibly**, not silently vanish — the same
  orphan-handling rule as unresolvable tags.
- **Display names come from the fragment**, so a page can't show a speaker name until the bio
  exists. The current page's `speakers: TBD` becomes either a real slug or empty; there is no
  slug for "TBD".

### Category as a tag

`aemdev:category/meetup` rather than the free-text `Meetup Recap` in use today.

The one snag: the `category` **index column** is populated from
`head > meta[name="category"]`, and `insights` filters on it. With category moving into
`article:tag`, either keep a `category` meta carrying the same ID (denormalised, but keeps the
index column and the block working unchanged), or drop the column and teach `insights` to filter
on tags. **Recommendation: keep the `category` meta carrying the canonical ID.** It is one
duplicated value, it avoids touching a working block during build-out, and the index column is
genuinely useful for filtering without parsing a tag list.

### What the tag namespace must now contain

This supersedes the category list in
[content-plan.md](content-plan.md#aem-taxonomy--the-aemdev-namespace) — `event` becomes
`category`, since `event-type` is gone:

| Category | Tags |
| --- | --- |
| `aemdev:topic/*` | edge-delivery, document-authoring, aemaacs, 6-5-lts, migration, performance, forms, personalization, cdn, authoring-ux |
| `aemdev:category/*` | meetup, conference, webinar, workshop, lightning-talk, article, news |
| `aemdev:region/*` | emea, north-america, apac, virtual |

German (`de`) titles on at least `topic` and `category` — that is what makes the
`.de` label map worth demoing.

[S2a](subproducts.md#s2a--tagsservlet-fix--aemdev-tag-namespace) is now unblocked: the ID format
is decided, so the namespace can be authored.

### What the tag namespace should mirror

Once the above is settled, the [`aemdev` namespace](content-plan.md#aem-taxonomy--the-aemdev-namespace)
should mirror it exactly — the `event` category matching `event-type` one-for-one is already
the plan, and the same should hold for whatever we decide about topics and regions. A taxonomy
that disagrees with the page metadata makes the tag picker's read-back unbuildable, since
there'd be nothing to match against.

**Do not author the namespace until question 1 is answered** — it determines whether tag values
on pages are IDs or labels, and therefore what the picker writes.

---

## 4. Corpus status — 16 Aug 2026

`/en/meetups/` holds **14 published pages**, inside the 12–16 target. All carry `status`, ISO
dates and canonical `aemdev:` tags, and all appear in `/en/query-index.json`.

### Upcoming and announced — from Tad's confirmed schedule

| Status | Event date | Slug | Note |
| --- | --- | --- | --- |
| `upcoming` | 2026-08-27 | `aem-meetup-washington-dc` | Adobe's new Experience Workspace / "DA 2.0" — subject locked |
| `upcoming` | 2026-09-28 | `adaptto-2026-berlin` | **our talk is Tue 29 Sep** |
| `upcoming` | 2026-10-02 | `aem-meetup-munich` | adapted adaptTo() themes; topic TBC |
| `upcoming` | 2026-10-23 | `adobe-developers-live-san-jose-2026` | developer architecture focus; topic TBC |
| `announced` | — | `aem-meetup-miami` | tentative Nov 2026; Tad Reeves + Rick Reich (Better Digital) |

### Recaps

| Event date | Slug | Source |
| --- | --- | --- |
| 2026-06-26 | `20260625-bring-your-complicated-eds-integration-story-meetup` | pre-existing, migrated |
| 2026-06-25 | `aem-gdc-june-2026-eds-cdn-recap` | Arbory blog — Cary NC |
| — | `sites-optimizer-eds-localization-atlanta` | Arbory blog — Atlanta |
| — | `aem-65-lts-vs-eds-vs-aemaacs-columbus` | Arbory blog — Columbus |
| 2025-03-26 | `aemug-midwest-summit-2025-insights` | YouTube `jl4QcE7MSxE` |
| — | `post-adaptto-2025-meetup` | YouTube `LcaELGePm70` |
| — | `champions-office-hours-sites-optimizer-agentic-ai` | YouTube `K8OMHxffUK8` |
| — | `champions-office-hours-2025-wrap-up` | YouTube `q4bzAhUxOO8` |
| — | `aem-frontend-showdown-classic-jamstack-eds` | YouTube `WpmKqMaqdb0` |

Tags are **notional** — assigned from what each session actually covered. Review them; they are
a starting point, not a decision.

### On the missing event dates

Seven recaps have no `event-date`. That is deliberate, not an oversight: for the YouTube-derived
pages the only hard date is the video's *publish* date, which sits in `publication-date`. A
recorded meetup is usually uploaded days after it happened, so deriving one from the other would
be inventing data. `aemug-midwest-summit-2025-insights` has a real event date only because the
video title states it.

They can be backfilled from the AEM AUG event listings. Until then, a `recap` with no
`event-date` is a good candidate for a Preflight **warning** — which is a better demo than a
contrived rule, because it is a real gap in real content.

### Taxonomy gaps this exercise found

Mapping real content onto the taxonomy surfaced three missing topics, all now in
`arbory-aemaacs/scripts/aemdev-taxonomy.json`:

- **`topic/localization`** — the Atlanta session is half about translation on DA.
- **`topic/governance`** — nothing covered preflight, publishing rules or content ops.
- **`topic/ai`** ("AI & Agentic AEM" / "KI & Agentic AEM") — **two of the five** YouTube
  sessions are about Sites Optimizer and agentic AI, and there was nowhere to put them.

The taxonomy is now 13 topics / 7 categories / 4 regions = 27 label-map entries. Every one of
those gaps came from authoring content, not from planning the taxonomy — which is the argument
for doing them in this order.

### Still open

- **`speakers` slugs have no bio fragments yet** — `tad-reeves`, `laurel-timko`,
  `wilson-faure`, `rick-reich`. They resolve to nothing until S4's Bio Manager creates them,
  which is the intended demo payoff; the meetup block must degrade visibly, not silently.
- **`/en/articles/aem-eds-content-modeling-deep-dive`** is authored, unpublished, and linked
  with a trailing slash. Two defects, one page.
- **The stale index columns persist.** A partial reindex does not clear them, since the index
  emits the union across all pages.
- **Old `/en/meetup-recaps/` content is still in place**, shadowed by redirects. Deleting it is
  a separate deliberate step.
