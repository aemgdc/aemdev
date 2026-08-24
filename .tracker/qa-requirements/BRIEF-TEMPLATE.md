# Production requirements — <group>

> Copy this file to `<group>-brief.md`, fill it in, and commit it. Mirror it to DA at
> `/tracker/requirements/<group>/production-requirements` so the whole team can read it
> (`briefToHtml()` in tools/tracker/lib/requirements.mjs renders it).
>
> Blockquote lines like this one are stripped before the model sees the brief — they are
> notes from one human to another, and a model shown them will act on them.

**REQUIREMENTS STATUS: DRAFT**

**SCOPE:** <which pages this governs, e.g. `pagetype = meetup`>

**Golden master:** <the representative page the baseline is calibrated on>

---

> ## The four glyphs
>
> | glyph | meaning | what the judge does |
> |---|---|---|
> | `✓` | must survive verbatim | FAILS the page if it is missing or altered |
> | `~` | may change | must NOT flag it; the Note says how far |
> | `✗` | approved removal | absent by decision, not by accident |
> | `?` | **UNRESOLVED** | **blocks the whole batch** |
>
> Trailing prose in a Status cell is fine — `✓ (see note)` parses. Only the first
> character is read.
>
> `?` is the correct thing to write when the answer is not yours to invent. It is a
> gate, not a warning: `qa:batch` refuses to run, by design, rather than letting the
> judge quietly pass a page against a requirement nobody stated.
>
> A double-quoted string inside a `✓` row is checked EXACTLY, by tier 1, for free —
> `The date line must read "28-30 September"`. Use it for anything that must not drift.
> Only put a group-WIDE literal there; a per-page string will fail on every other page.
>
> Add `JUDGE_MODE: audit` anywhere in the brief for an index or listing page, whose
> visible content is assembled at runtime from a query index and therefore cannot be
> compared against anything authored.

## Content Requirements

> What the content owner asked for. The architect reads this. The judge never sees it.

## Implementation Requirements

> How it is built — which blocks, what structure, what to reuse. Developers read this.
> The judge never sees it.

## QA Requirements

> THE ONLY SECTION THE JUDGE SEES. Keep it about content fidelity: what must survive,
> what may change, what was intentionally dropped. Everything here becomes a pass/fail
> criterion. At least 12 words of real content, or `judgeBrief()` returns null and the
> judge runs with no contract at all.

| ID | Requirement | Status | Note |
|---|---|---|---|
| Q1 | <what must survive on every page in this group> | ? | |
| Q2 | <what may legitimately differ page to page> | ? | |

## Visual QA

> Criteria for the visual tier. Stripped before the text judge sees the brief — a text
> model shown "tile grid reflow at 390px" will report confidently on layout it has
> never seen.

| ID | Requirement | Status | Note |
|---|---|---|---|
| V1 | <what must not break at 390 / 1280 / 2360> | ? | |

## Open Questions

> For humans. Stripped before the model sees the brief. Anything here that turns into a
> requirement belongs in a row above with a real glyph.
