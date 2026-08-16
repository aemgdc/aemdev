# adaptTo() 2026 — "Spiritually-Succeeding AEM: Advanced Author Customization in DA"

Planning workspace for the 30-minute session at [adaptTo() 2026](https://adapt.to/2026/schedule/spiritually-succeeding-aem-advanced-author-customization-in-da),
**Berlin, 28–30 September 2026** (exact slot TBC).

Presenters: Tad Reeves, Laurel Timko.
Demo surface: [www.aemdev.org](https://www.aemdev.org) — DA org/site `aemgdc/aemdev`, code in this repo.

## Documents

| Doc | What it covers |
| --- | --- |
| [plan.md](plan.md) | Scope, tiering, the demo narrative, time budget, risks |
| [subproducts.md](subproducts.md) | The build list: every tool/block, its source, state, owner, acceptance criteria |
| [content-model.md](content-model.md) | Dates, redirect mapping, and the metadata/taxonomy proposal to settle |
| [content-plan.md](content-plan.md) | Content that must exist on aemdev.org (and in AEM / Forms CS) before the demo works |
| [schedule.md](schedule.md) | Week-by-week milestones and freeze gates |
| [slides.md](slides.md) | Slide outline and speaker notes skeleton |

## Two findings that shape this plan

Both verified on **16 Aug 2026**; both are on the critical path.

1. **The TagsServlet is half-broken and there is no taxonomy.** `/services/tagsservlet` and
   `/services/tagsservlet.all` on the PRD sandbox return **HTTP 500** — that's the call the
   picker makes on init. Every named category, including `aemdev`, returns HTTP 200 with a
   plain-text body `ERROR: Invalid Tag Catgegory` (sic), so no namespace is authored for this
   site either. The tag picker cannot be demoed today. Split into
   [S2a](subproducts.md#s2a--tagsservlet-fix--aemdev-tag-namespace) (Tad, AEM side) and
   [S2b](subproducts.md#s2b--tag-picker-configuration--page-tag-read-back) (Laurel, DA side);
   risk **R1**.

2. **aemdev.org is almost empty.** Live has exactly two things: `/en/` and
   `/en/meetup-recaps/` (one recap). `/en/articles` exists in preview but not live.
   `/en/insights` — linked from the home page — 404s everywhere. There is no published
   `query-index.json` at any path, and `sitemap.xml` is an empty `<urlset>`.
   Content build-out is not a garnish on this project; it is roughly a third of the work.
   See [content-plan.md](content-plan.md).

## The one-line version

We build a **user-group meetup invitation** live on stage, and every DA customization we
ship is the thing that makes the next step of that build possible.
