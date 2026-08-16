# Master plan

## The session

- **Slot:** 30 minutes, adaptTo() 2026, Berlin, 28–30 Sep 2026 (exact day/time TBC — confirm with organizers and update this line).
- **Thesis:** DA's authoring surface is not a fixed product. It is a plugin host. Anything
  your authors need — taxonomy, iconography, structured people data, forms, governance —
  can be built as a small static app and dropped into the authoring experience, in days,
  not quarters. The "spiritually succeeding AEM" framing: the *authoring affordances*
  enterprises bought AEM for are reachable in EDS/DA, without buying back the stack.
- **Proof:** we build a real page live, and every customization earns its place in the build.

## Time budget

| Segment | Minutes | Owner |
| --- | --- | --- |
| Framing: why author customization decides EDS adoption | 3 | Tad |
| How DA plugins actually work (SDK, config, hosting) | 5 | Tad |
| Guided demo — Acts 1–4 | 16 | Laurel drives, Tad narrates |
| Close + Q&A | 4 | Both |
| Hard buffer | 2 | — |

16 demo minutes across 6 live tools is **~2.5 minutes each**. That number is the whole
reason for the tiering below. Anything not rehearsed to fit gets cut, not rushed.

## Scope tiering

Recommended. Adjust if you disagree — but decide by **29 Aug** ([schedule.md](schedule.md)),
because Tier 3 items stop getting build time after that.

### Tier 1 — live in the demo, must ship

| Tool | Why it's Tier 1 |
| --- | --- |
| Bio Manager | Most visually surprising; a real structured-content editor inside DA |
| Icon Picker | Fastest "oh, you can just *do* that" moment; cheap to build |
| AEM Tag Picker | The literal AEM-to-EDS bridge — the session's title argument |
| Form Picker | Net-new, and the one nobody in the room believes is possible yet |
| Preflight + publish workflow | Governance is the #1 objection to EDS from AEM shops |

### Tier 2 — live, abbreviated (2 min, Act 3)

| Tool | Why |
| --- | --- |
| Advanced Search | Already ported into this repo; huge with the bulk-ops crowd. Doesn't fit the "build one page" arc, so it gets its own short act *after* publish |

### Tier 3 — slide + 20–30s screen capture, no live driving

| Tool | Why |
| --- | --- |
| Translation Tracker | Belongs to the SAS programme, not this repo. A Berlin audience will love a German-translation beat, but it is not worth the integration cost or the live-demo risk |

## Demo narrative

**Scenario:** "The AEM Global Developer Collective is running a Berlin meetup the week after
adaptTo(). I need an invitation page live before I leave this stage."

Target page: `/en/events/2026-10-berlin-meetup`.

### Act 1 — Assemble the page (≈7 min)

1. **Start from a template.** New page in DA from the event-invite template. Show the
   unadorned DA surface first — *this is what you get out of the box* — so the contrast lands.
2. **Bio Manager.** The meetup has two speakers. Open the plugin, search existing bios, pull
   one in; create the second from scratch (name, headshot via Adobe Asset Selector, blurb).
   It writes a fragment and a row in the bios sheet. Reference the fragment on the page.
   *Point: structured people-data with a real editor, no AEM content fragment model.*
3. **Icon Picker.** Agenda / venue / what-to-bring rows each need an icon. Browse the SVG
   library, filter, insert. *Point: 200 lines of static JS replaces an asset-picker project.*
4. **Tag Picker.** Tag the page from the AEM taxonomy on the PRD sandbox —
   `topic|edge-delivery`, `event|meetup`, `region|emea`. Laurel's enhancement reads the tags
   already on the page and shows them as pre-selected, so this is edit, not re-enter.
   *Point: your AEM taxonomy is the source of truth; EDS pages consume it live over HTTP.*

### Act 2 — Make it do something (≈4 min)

5. **Form Picker.** RSVP. Open the picker, see the real form list from Forms Cloud Service
   (RSVP, CFP submission, newsletter, feedback), pick RSVP, it drops a configured block.
   *Point: Forms CS and EDS are not separate products to your author.*

### Act 3 — Govern it (≈5 min)

6. **Preflight.** Run it. It **fails on purpose** — one missing alt text, one missing
   `event-date` metadata, one link to the dead `/en/insights`. Fix two live, wave at the third.
   *Point: this is where the "EDS has no governance" objection dies.*
7. **Publish → workflow.** Publish kicks the post-publish hook: Slack/announcement + AEM
   workflow ping. Show the notification land.
8. **Advanced Search (Tier 2).** "That form block I just used? Fourteen older meetup pages
   still point at the retired one." Search by block + property across `/en/meetup-recaps/`,
   version them, bulk-replace, show the undo. *Point: bulk safety at scale.*

### Close (≈2 min)

9. **Translation Tracker cameo (Tier 3).** Slide + short capture: the German version of the
   invite, tracked to source. "We're in Berlin — of course there's a German version."
10. Land the thesis: every one of these is a static page + `DA_SDK`, in this repo, MIT-ish.
    Point at the repo URL.

## Division of labour

- **Laurel:** Tag Picker enhancement (page tag read-back), Advanced Search verification on
  `aemgdc/aemdev`, Icon Picker. Drives the live demo.
- **Tad:** Bio Manager port, Form Picker, Preflight + publish workflow, event blocks,
  content build-out, slides, AEM-side (TagsServlet fix + taxonomy). Narrates.
- **Shared:** rehearsals, backup recording, freeze discipline.

Estimated total ≈ 22–24 person-days over 6 weeks across two people. That is aggressive but
not fantasy — *provided* Tier 3 stays Tier 3 and the freeze gates in
[schedule.md](schedule.md) hold.

## Risks

| # | Risk | Severity | Mitigation |
| --- | --- | --- | --- |
| **R1** | **TagsServlet returns 500 on `/services/tagsservlet` and `.all`; named categories return `ERROR: Invalid Tag Catgegory`.** The picker's init call fails. Verified 16 Aug. | **Critical** | Two-track: (a) fix the servlet + author a real taxonomy on the PRD sandbox — owner Tad, due 29 Aug; (b) ship a cached-JSON fallback in the picker so a servlet outage on stage degrades to a static taxonomy rather than an empty panel. Do **both**; (b) is also the conference-wifi insurance. |
| **R2** | aemdev.org is effectively unpublished (see [content-plan.md](content-plan.md)). Everything downstream — Advanced Search results, Preflight link checks, the events index — needs real pages to act on. | **High** | Content is a first-class workstream with its own owner and its own freeze date (18 Sep), not a week-5 scramble. |
| **R3** | Forms Cloud Service form-list API, auth and CORS from a DA-hosted plugin are unproven. | **High** | Time-boxed spike in week 1 (by 23 Aug). If the live API can't be reached from the plugin, fall back to a published forms manifest sheet and say so honestly on the slide. |
| **R4** | Live demo over conference wifi, against AEM publish + DA + Forms CS + Slack. | **High** | Full backup screen recording by 23 Sep. Local fixture mode for every plugin (a `?fixtures=1` flag reading committed JSON). Phone hotspot as backup uplink. Rehearse the *recording-fallback* switch itself. |
| **R5** | DA platform drift between now and 28 Sep — `da.live/nx/utils/sdk.js` is loaded live from a URL we don't control. | Medium | Re-verify every plugin against live DA at code freeze (21 Sep) and again the morning of the talk. Note in slides that the SDK is a hosted dependency. |
| **R6** | Two presenters, one laptop, 30 minutes, handoffs. | Medium | Single driver (Laurel) for the whole demo; Tad never touches the keyboard. Fixed handoff points written into [slides.md](slides.md). |
| **R7** | Seven tools do not fit in 16 minutes. | Medium | The tiering above. Rehearsal #1 (16 Sep) is timed with a stopwatch; whatever runs over gets demoted, and that decision is made on 16 Sep, not on stage. |
| **R8** | Bio Manager on `arbory-da` lives on an unmerged branch (`origin/bio-list`) and hard-codes Arbory paths (`/private-bios`, `/en/fragments/bios`). | Low | Port with paths lifted into a config block; do not try to keep the two copies in sync. |

## Working conventions

This repo's [AGENTS.md](../../AGENTS.md) requires the `.agents/skills/` workflow for block and
core-script work — start with `content-driven-development`. Applies to everything in
[subproducts.md](subproducts.md) that touches `blocks/` or `scripts/`; standalone tools under
`tools/` are lighter-touch but should still follow the repo's lint config (`npm run lint`).
