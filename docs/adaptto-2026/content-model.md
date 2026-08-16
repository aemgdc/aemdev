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
- [ ] Push via `update-index-configuration` (this triggers a reindex — see below)
- [ ] Update the existing recap page's two date values to ISO
- [ ] Author every corpus page with ISO dates from the start

### Bonus: the reindex flushes the stale columns

My earlier "config drift" diagnosis was **wrong**, and the sync run proved it. The read-back
returned only whitespace changes — a trailing newline and a comment indent — so the repo copy
and the deployed config were already identical at 16 properties.

The 8 extra columns in the live index (`bookAuthor`, `bookPublishDate`, `bookTypeTitle`,
`displayLabel`, `eventDateTime`, `eventDisplayLabel`, `eventDisplayTime`, `offDateTime`) aren't
drift between repo and config service — **the published index is stale**. It was generated
under an older config and still carries columns nothing backs any more.

Which means the earlier warning ("pushing would silently drop 8 columns") was backwards: those
columns are already orphaned, and the reindex triggered by this `date` change will clear them.
No decision needed, no data lost.

That the sync surfaced this within a day of being built is the argument for keeping it on cron.

---

## 2. Redirect mapping for `/en/meetup-recaps/` → `/en/meetups/`

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

### The third link is a ghost, not an unpublished page

`aem-gdc-june-2026-eds-cdn-recap` 404s on `aem.page` *and* `aem.live`. If it were authored but
unpublished it would render in preview. It doesn't — so it was never created, or was created
under a different slug and the link never followed.

**Do not write a redirect for it.** Redirecting a URL that never existed to a page that isn't
its content is worse than a 404. Fix the home-page link instead — it should point at the
`20260625-…` slug, which is the recap it was presumably meant to reference.

Confirm that reading before changing it; I'm inferring from the slug, not from evidence.

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

Body images are referenced **relatively**:

```html
srcset="./media_12984561cd75341adc01c40d91ccc899ecbd376b2.jpg?width=2000&format=webply"
```

`./media_…` resolves against the page's own folder, so the references survive a folder move
**provided the media moves with the documents**. At least three media files live under
`/en/meetup-recaps/`. The absolute `og:image` URL is generated at publish time from the
relative path, so it re-points itself.

**Verify after the move:** load the moved recap and confirm the images render. A folder move
that leaves media behind produces a page that looks fine in DA and broken on the site.

### Implementation

Two options; pick one, don't do both:

1. **EDS `redirects` sheet in DA** — a two-column sheet (`Source`, `Destination`) at the
   content root. Versioned as content, editable by anyone, no deploy. **Recommended** — it is
   also demoable, which the Fastly path is not.
2. **Fastly VCL** — [config/fastly/www-aemdev-org/](../../config/fastly/www-aemdev-org/) is
   already versioned and synced daily. Correct for infrastructure-level redirects, heavier for
   two content URLs.

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

## 3. Document metadata — proposal, not yet settled

This is the piece to agree before the corpus and before the
[`aemdev` tag namespace](content-plan.md#aem-taxonomy--the-aemdev-namespace) gets built,
since the namespace should mirror whatever we settle here.

### Existing metadata, from the one real page

`template`, `author`, `publication-date`, `category`, `event-date`, `recap-video`, `speakers`,
`location`, plus `article:tag` × 6 (`AEM`, `EDS`, `Edge Delivery`, `Integrations`, `Meetup`, `GDC`).

Note `speakers: TBD` and `location: Virtual` — the fields exist and are already being used as
free text.

### Proposed set for `/en/meetups/`

| Field | Required | Values | Why |
| --- | --- | --- | --- |
| `title` / `description` | yes | free text | og tags, already working |
| `template` | yes | `meetup` | today's page says `blog`; a dedicated template drives the lifecycle block |
| `status` | yes | `announced` \| `upcoming` \| `recap` | the [lifecycle model](content-plan.md#lifecycle-status); drives listing split and Preflight rules |
| `event-type` | yes | `meetup` \| `conference` \| `webinar` \| `workshop` \| `lightning-talk` | mirrors the `event` tag category exactly |
| `event-date` | if not `announced` | ISO `yyyy-mm-dd` | sorts upcoming vs past |
| `publication-date` | yes | ISO `yyyy-mm-dd` | indexed as `date`; sorts the article stream |
| `location` | if not `announced` | free text, or `Virtual` | already in use |
| `speakers` | if not `announced` | comma-separated names | free text today; see the open question below |
| `recap-video` | if `recap` | YouTube URL | already in use |
| `rsvp-form` | if `upcoming` | form id/path | [S6](subproducts.md#s6--form-picker) |
| `category` | yes | `Meetup Recap`, `Meetup`, … | `insights` filters on it |
| `article:tag` | yes | from the `aemdev` namespace | what [S2b](subproducts.md#s2b--tag-picker-configuration--page-tag-read-back) reads and writes |

### Three open questions — these are yours to call

**1. Do tags carry canonical AEM tag IDs or display labels?**
Today they're display labels (`Edge Delivery`, `AEM`). The tag picker's normalization is
[lossy](subproducts.md#s2b--tag-picker-configuration--page-tag-read-back), so reversing a label
back to a taxonomy node is guesswork — which is exactly what the read-back feature has to do.
Storing `aemdev:topic/edge-delivery` and rendering a label at display time makes matching
exact. It also changes every existing tag value and what the blocks render.

**This is the highest-leverage decision on the list**, because S2b's core feature depends on it
and the corpus will bake in whichever we choose.

**2. Is `speakers` free text or references to bio fragments?**
Free text is simplest and works today. But [S4's Bio Manager](subproducts.md#s4--bio-manager)
creates fragments at `/en/fragments/bios/<slug>`, and the demo's payoff is a page pulling in a
real bio. If `speakers` held slugs, the meetup block could resolve them automatically. A middle
path: keep `speakers` as display text, add `speaker-bios` as a comma-separated slug list.

**3. Does `category` survive, given `event-type` and tags?**
Three overlapping classification axes is one too many. `insights` filters on `category`, so it
can't just be dropped — but it may be that `category` is for the article stream and `event-type`
for meetups, which is defensible if written down.

### What the tag namespace should mirror

Once the above is settled, the [`aemdev` namespace](content-plan.md#aem-taxonomy--the-aemdev-namespace)
should mirror it exactly — the `event` category matching `event-type` one-for-one is already
the plan, and the same should hold for whatever we decide about topics and regions. A taxonomy
that disagrees with the page metadata makes the tag picker's read-back unbuildable, since
there'd be nothing to match against.

**Do not author the namespace until question 1 is answered** — it determines whether tag values
on pages are IDs or labels, and therefore what the picker writes.
