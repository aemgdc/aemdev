# Slide outline

Target: **~10 slides, 8 minutes**, front-loaded before the demo, plus 2 closing slides.
Everything else is the live demo. The deck's job is to make the audience understand *how*
this is possible so that the demo reads as reproducible rather than as a magic trick.

Speaker notes below each slide are the argument, not the script — write the script into the
demo runbook, not here.

---

## 1 — Title

**Spiritually-Succeeding AEM: Advanced Author Customization in DA**
Tad Reeves · Laurel Fulford · adaptTo() 2026

*Notes:* 20 seconds. Names, the repo URL on screen from slide one so people photograph it early.

---

## 2 — The objection we all keep hearing

> "Edge Delivery is great, but our authors need the taxonomy picker / the asset workflows /
> the governance we already have in AEM. We can't move."

*Notes:* Name the real blocker honestly. It is almost never rendering performance or
developer experience that stalls an EDS rollout in an AEM shop — it's that the authoring
affordances feel like a downgrade. Get the room nodding here; the whole talk is the answer
to this slide.

---

## 3 — What people assume DA is

A clean, fast, deliberately minimal document editor. Screenshot of stock DA.

*Notes:* Give it credit — the minimalism is a genuine feature. But set up the misread: people
see the minimal surface and conclude it is a *fixed* surface.

---

## 4 — What DA actually is

A **plugin host**. Diagram: DA editor ↔ `DA_SDK` ↔ your static app on `aem.live` ↔ anything
(AEM publish, Forms CS, DAM, sheets, your own APIs).

*Notes:* The pivot. A DA plugin is an HTML page, some JS, and `import DA_SDK from
'https://da.live/nx/utils/sdk.js'`. It gets page context and an auth token, and it can write
back. That is the whole extension model. No Java, no OSGi, no deploy pipeline, no dispatcher
flush.

---

## 5 — The anatomy of a plugin

Real code on screen — the smallest complete plugin, ~15 lines. Registration snippet from
`tools/sidekick/config.json` next to it.

*Notes:* Make it concrete and small enough to read from the back row. The point people should
leave with: *I could write one of these this afternoon.* Show the `daLibrary: true` flag and
the `aem.live`-hosted URL — the plugin is served from the same repo as the site.

---

## 6 — Seven things we built

One line each, with an icon:

| | |
| --- | --- |
| AEM Tag Picker | your `/content/cq:tags` taxonomy, live, in DA |
| Icon Picker | searchable SVG library |
| Bio Manager | structured people-data editor |
| Form Picker | Forms Cloud Service, in the page |
| Preflight | governance rules your governance team edits |
| Advanced Search | block-aware bulk find/replace with undo |
| Translation Tracker | status against source |

*Notes:* Do not explain any of them here. This slide is a promise, and the demo is the
payment. 45 seconds maximum.

---

## 7 — Effort, honestly

A build-cost table. Days, not quarters. Note which ones were ported from another EDS project
in an afternoon.

*Notes:* This is the slide that converts skeptics, and it only works if the numbers are true.
Fill in real figures after the build — not estimates. Include the ones that were harder than
expected; credibility is the asset here.

---

## 8 — The demo

**"I need an invitation page for next week's Berlin meetup, live, before I leave this stage."**

*Notes:* Hand off to Laurel. Tad narrates, Laurel drives, and Tad does not touch the keyboard
for the next 16 minutes. Beat sheet lives in the demo runbook.

---

> **[16 minutes of live demo — Acts 1–4 per [plan.md](plan.md#demo-narrative)]**

---

## 9 — What made this possible

- Plugins are static pages — same repo, same deploy, no separate lifecycle
- `DA_SDK` gives page context + auth in one import
- Your AEM instance is still useful as an **API** — taxonomy, DAM, workflow — without being
  the delivery tier
- Config as content: rules and lists in sheets, editable by the people who own them
- Everything degrades: cached fallbacks mean a backend outage is a notice, not a blank panel

*Notes:* The architectural takeaway. "Spiritually succeeding AEM" means keeping what AEM was
genuinely good at — taxonomy, structured content, governance, workflow — while dropping the
delivery-tier weight. The bridge is HTTP.

---

## 10 — Take it

Repo URL, big. QR code. What's MIT-licensed, what's sample code, what's environment-specific.
Where to file issues. Where the AEM GDC meets next.

*Notes:* Close on the real invitation — we published one on stage. Point at it. Then Q&A.

---

## Production notes

- **Contrast and size.** Conference projectors are dim and the back row is far. DA's UI is
  light-on-light in places; screenshots may need contrast treatment. Test at the venue.
- **Live-vs-screenshot rule.** Every slide that shows a plugin should show a *screenshot*, not
  a promise — even though the demo is live. If the demo dies, the deck alone still tells the story.
- **Handoffs are on the slides.** Slide 8 is Tad → Laurel; the return is after Act 3. Marked
  in the deck so neither of you has to guess.
- **Offline.** PDF export on local disk and on a USB stick by 25 Sep. No cloud-only decks.
- **Client-safe.** The translation-tracker capture (S8) comes from SAS work — scrub identifying
  content before it goes in the deck. Check this explicitly at slide freeze.
- **Slide count discipline.** If the deck grows past 12 slides, the demo is getting squeezed.
  Cut slides, never demo minutes.
