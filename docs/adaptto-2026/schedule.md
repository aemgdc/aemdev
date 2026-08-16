# Schedule

**Today:** Sun 16 Aug 2026. **Conference:** Mon 28 – Wed 30 Sep 2026, Berlin.
**Build window:** Mon 17 Aug → Fri 25 Sep — **six weeks**, minus travel.

Item codes (S1–S10) are from [subproducts.md](subproducts.md); content batches from
[content-plan.md](content-plan.md).

## Freeze gates

Non-negotiable. Every one of these exists because something downstream depends on it being
still.

| Date | Gate |
| --- | --- |
| **Fri 28 Aug** | Spikes resolved (Forms CS reachability, TagsServlet root cause). Tier decisions final. |
| **Fri 18 Sep** | **Content freeze.** No new pages, no metadata edits, no republishing. |
| **Mon 21 Sep** | **Code freeze.** Bugfixes only, and only for things that break the demo path. |
| **Wed 23 Sep** | **Backup recording done.** Full 16-minute demo captured end-to-end. |
| **Fri 25 Sep** | **Slides final.** Deck exported to PDF and to a local offline copy. |

## Week 0 — Mon 17 – Sun 23 Aug: unblock everything

The week is about removing unknowns, not shipping features. Two spikes decide the shape of
the rest of the plan.

| | Item | Owner |
| --- | --- | --- |
| ▢ | **Confirm the exact session slot** with adaptTo() organizers; update [plan.md](plan.md) | Tad |
| ▢ | **Spike: TagsServlet 500.** Reproduce in sandbox logs, identify root cause (R1) | Tad |
| ▢ | **Spike: Forms CS.** Form-list endpoint, auth, CORS from an `aem.live` origin (R3) | Tad |
| ▢ | S1 — DA plugin registration + `tools/shared/` bootstrap | Tad |
| ▢ | Verify S2b tagpicker and S5 advanced-search open at all under `aemgdc/aemdev` | Laurel |
| ▢ | **Agree the [S2 interface contract](subproducts.md#s2-interface-contract)** — endpoint shape, namespace root, fixture path. Locked 28 Aug. | Both |
| ▢ | Demo script v0 — the beat sheet, no polish | Both |
| ▢ | Slide skeleton — section titles and the argument only ([slides.md](slides.md)) | Tad |

**End-of-week checkpoint (Fri 21 Aug):** do we know why the servlet 500s, and can a browser
plugin reach Forms CS? If either answer is "no", the fallback path for that item becomes the
plan — decide it then, not in September.

## Week 1 — Mon 24 – Sun 30 Aug: foundations

| | Item | Owner |
| --- | --- | --- |
| ▢ | **S2a** — TagsServlet fix deployed to PRD sandbox; status-code contract corrected | Tad |
| ▢ | **S2a** — `aemdev` tag namespace authored at `/content/cq:tags/aemdev` (`topic`/`event`/`region`/`format` + `de` on topics), activated to publish | Tad |
| ▢ | **S2a** — real response captured to `tools/tagpicker/fixtures/tags.json` and committed — this is the handoff to Laurel | Tad |
| ▢ | S9 — `events` index in `helix-query.yaml`; `event-invite` block started | Tad |
| ▢ | S3 — Icon Picker: icon set curated, manifest approach decided, grid UI started | Laurel |
| ▢ | **S2b** — picker configured for `aemdev` + namespace scoping; on-page tag format decided and written down | Laurel |
| ▢ | **S2b** — page tag read-back ported from `jmp-da`, developed against the S2a fixture | Laurel |
| ▢ | Content Batch A started | Tad |
| ▢ | **Fri 28 Aug: tier decisions locked** — anything still Tier 3 stops getting build time | Both |

## Week 2 — Mon 31 Aug – Sun 6 Sep: the visible tools

| | Item | Owner |
| --- | --- | --- |
| ▢ | S3 — **Icon Picker done** | Laurel |
| ▢ | **S2b** — **Tag Picker done**, incl. orphan-tag handling and cached-taxonomy fallback, verified against the live servlet | Laurel |
| ▢ | S9 — **Event blocks + DA template done** | Tad |
| ▢ | S4 — Bio Manager port started (config hoist, retarget to `aemgdc/aemdev`) | Tad |
| ▢ | S6 — Form Picker started (design settled off the week-0 spike) | Tad |
| ▢ | **Content Batch A complete** (5 Sep) | Tad |
| ▢ | Demo script v1 — full narration, timed on paper | Both |

## Week 3 — Mon 7 – Sun 13 Sep: the rest of the build

The heaviest week. If anything is going to slip, it slips here — which is why the tier list
exists.

| | Item | Owner |
| --- | --- | --- |
| ▢ | S4 — **Bio Manager done** | Tad |
| ▢ | S6 — **Form Picker done** | Tad |
| ▢ | S7 — **Preflight rules + publish webhook done** | Tad |
| ▢ | S5 — **Advanced Search verified** on `aemgdc/aemdev` incl. undo | Laurel |
| ▢ | **Content Batch B + C complete** (12 Sep) — 12–14 recaps, bios, icons, forms, taxonomy | Tad |
| ▢ | First end-to-end walkthrough, untimed, expect it to be a mess | Both |

**Fri 11 Sep checkpoint:** anything not feature-complete gets demoted to a slide. Make that
call on the 11th.

## Week 4 — Mon 14 – Sun 20 Sep: integration and first real rehearsal

| | Item | Owner |
| --- | --- | --- |
| ▢ | S10 — fixture/offline mode across all Tier 1 plugins | Laurel |
| ▢ | S8 — translation tracker capture recorded and scrubbed | Tad |
| ▢ | Stage-page reset procedure written and tested | Laurel |
| ▢ | **Wed 16 Sep — Rehearsal #1, stopwatch, live network.** Cut whatever runs over. | Both |
| ▢ | Slides v2 — full deck, real screenshots | Tad |
| ▢ | Fixes from rehearsal #1 | Both |
| ▢ | **Fri 18 Sep — CONTENT FREEZE** | — |

Rehearsal #1 is the honest one. Expect it to run 22 minutes and expect that to hurt. That is
what the 16th is for.

## Week 5 — Mon 21 – Sun 27 Sep: freeze, rehearse, pack

| | Item | Owner |
| --- | --- | --- |
| ▢ | **Mon 21 Sep — CODE FREEZE** | — |
| ▢ | **Mon 21 Sep — Rehearsal #2, network disabled, fixture mode only** | Both |
| ▢ | **Wed 23 Sep — Backup recording**, full 16-minute demo, clean take | Both |
| ▢ | **Thu 24 Sep — Rehearsal #3**, live network, full 30 min incl. slides and handoffs | Both |
| ▢ | **Fri 25 Sep — SLIDES FINAL.** PDF export + offline copy + USB stick | Tad |
| ▢ | Travel kit assembled (below) | Both |
| ▢ | Re-verify all plugins against live DA — SDK drift check (R5) | Laurel |
| ▢ | Travel to Berlin (Sun 27) | Both |

## Conference — Mon 28 – Wed 30 Sep

| | Item |
| --- | --- |
| ▢ | Morning of the talk: re-run the full demo path on venue wifi |
| ▢ | Reset the stage page via the documented procedure |
| ▢ | Confirm projector resolution; check the icon grid and DA panel legibility at that size |
| ▢ | Confirm the backup recording plays from local disk |
| ▢ | Deliver |
| ▢ | Post-talk: push the repo link, publish the slides, note follow-ups |

## Travel kit

- Laptop + a **second** machine with the demo path verified independently
- Backup recording on local disk **and** a USB stick
- Slides as PDF, local, not cloud-only
- Phone hotspot, tested, with roaming enabled for Germany
- HDMI + USB-C adapters, both directions
- Printed one-page beat sheet with timings — for the moment the screen dies

## Effort reality check

≈22–24 person-days across two people over six weeks. That is comfortable if this is
full-time-ish work and tight if it is evenings and weekends. The plan holds together on one
condition: **Tier 3 stays Tier 3.** The failure mode for this talk is not that a tool doesn't
work — it is that seven tools half-work and the demo runs 25 minutes.
