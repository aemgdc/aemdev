# Production requirements — meetups

**REQUIREMENTS STATUS: DRAFT**

**SCOPE:** `/en/meetups/**` and `/en/meetup-recaps/**` — 14 live pages as of 2026-08-16, `template: meetup`, `status` one of `announced` / `upcoming` / `recap`. Both prefixes are accepted: the `/en/meetup-recaps/` → `/en/meetups/` rename has already happened on the live site while `helix-query.yaml` and `scripts/scripts.js` still carry the old spelling, and a partial revert must not silently drop 14 pages out of every count. The section LANDING page `/en/meetups` is not in this group — it belongs to `indexes`.

**Golden master:** none yet — nothing is translated.

## Content Requirements

| ID | Requirement | Status | Note |
| --- | --- | --- | --- |
| C1 | Every page states the event date, the city / venue and the speaker line-up | ✓ | These are the facts somebody came to the page for |
| C2 | A `recap` page carries the recording embed and the session list | ✓ | The recording is the whole point of a recap |
| C3 | An `announced` / `upcoming` page carries the registration route | ✓ | A registration link that is missing costs attendance |
| C4 | `status` metadata tracks reality (`announced` → `upcoming` → `recap`) | ✓ | Owned by the content author, not by translation |

## Implementation Requirements

| ID | Requirement | Status | Note |
| --- | --- | --- | --- |
| I1 | `templates/meetup/meetup.css` exists | ? | It does not. The `meetup` template is authored on 14 live pages with no template CSS behind it, so a locale page and its English source fall back to the same styling — consistent, but not a decision anybody made, and the visual tier has no template baseline to calibrate |
| I2 | `'meetups'` is in `templatedSections` in `scripts/scripts.js` | ✗ | It is not, and that is now load-bearing the other way: group membership resolves by PATH PREFIX precisely because template metadata cannot be relied on. Adding it would not break the tracker, and nothing here needs it |
| I3 | The structural metadata is never translated | ✓ | `custom-doc-rules` translates only `title`, `description`, `displaydescription` and `og:title` from the `metadata` block, so `speakers`, `event-date`, `location`, `recap-video` and `status` are do-not-translate at the connector. Q3, Q4 and Q9 below are the judge's half of the same rule |
| I4 | The recap embed renders from authored markup, not from a client-side lookup | ✓ | `custom-doc-rules` marks `embed`, `youtube` and `spotify` do-not-translate. An embed that needs JavaScript could not be checked from `.plain.html` anyway |

## EN QA Requirements

What a meetup page must contain, judged on its own. No comparison, no locale: this is the
section `tools/tracker/judge.mjs` is shown in baseline mode, and the `## QA Requirements`
section below is the separate translation contract. Every row here is transcribed from the
Content Requirements above (C1-C4) plus what was measured across the 14 live pages on
2026-08-24 — it is not new policy, and it needs the content owner's sign-off like any other.

| ID | Requirement | Status | Note |
| --- | --- | --- | --- |
| E1 | The page states its event date as readable prose, not only as metadata | ✓ | From C1. The `event-date` meta key is checked deterministically by the group baseline's `requiredMetadata`; this row is about a reader being able to see the date on the page |
| E2 | The page names the city or the venue | ✓ | From C1. `Virtual` is a location and satisfies this |
| E3 | The page names its speakers, or says the line-up is not yet announced | ~ | From C1. An `announced` page legitimately has no line-up yet — saying nothing at all is the defect, not the absence |
| E4 | A `recap` page carries the recording and a list of what was covered | ✓ | From C2. A recap that lost its recording has lost its entire reason to exist, and the prose around it still reads correctly, so nothing else catches it |
| E5 | An `announced` or `upcoming` page carries a way to register or attend | ✓ | From C3. A missing registration route costs attendance |
| E6 | No placeholder text survives publication | ✓ | Measured: live pages in this group carry `⬜ Placeholder — add links to content, repos, demos, or docs discussed during the session`. Either fill it in before publishing or delete the row — a published placeholder tells a reader the page is unfinished |
| E7 | No fact is stated two different ways on one page | ✓ | Two different dates or two different start times for one event. Common when a page is edited from `upcoming` to `recap` and one line is missed |
| E8 | Body length varies widely with `status` | ~ | Measured 29 to 670 words across the group. An announcement is three sentences and a recap is an article; neither is wrong |
| E9 | Site chrome, nav and footer are out of scope | ✗ | They come from shared fragments and are not this page's content. Never report on them |

## QA Requirements

Compare the translated meetup page against its English source.

| ID | Requirement | Status | Note |
| --- | --- | --- | --- |
| Q1 | The EVENT DATE is present and denotes the same day | ✓ | A missing, shifted or invented date is a defect. See Q2 for formatting |
| Q2 | The event date's FORMATTING may follow locale convention | ~ | `16 August 2026` → `16. August 2026` → `2026年8月16日` is correct localisation, not drift. The DAY must not move; the spelling of it may, and month NAMES are translated |
| Q3 | The LOCATION — city, venue name, street address — is byte-identical | ✓ | **DNT.** A venue is a place you physically go to; a translated venue name cannot be found on a map or asked for at a door. "Berlin" reading as "Berlin" in every locale is correct, not a missed translation |
| Q4 | SPEAKER NAMES are byte-identical | ✓ | **DNT.** A personal name is not a phrase. Transliteration, reordering of given and family name, and translating a name that happens to be a common noun are all defects. A transliteration into a CJK locale is the hardest of these to spot in review |
| Q5 | Speaker employers and affiliations are byte-identical | ✓ | **DNT.** A company's registered name is not translatable |
| Q6 | SESSION TITLES are present, one per English session, in the same order | ✓ | The TEXT of a title is translated (Q7); a session that vanished or was merged is a defect |
| Q7 | Session title wording is translated | ~ | A title left in English on an otherwise translated page is an untranslated-content defect, not a DNT success |
| Q8 | The RECAP VIDEO EMBED survives | ✓ | The embed element and its video identifier must both be present on a `recap` page. A recap that lost its recording is the worst defect this group has: the page's entire reason to exist is gone and the prose around it still reads correctly, so nothing else catches it |
| Q9 | The embed's video ID is byte-identical to English | ✓ | The connector cannot change it — the block is DNT and the `recap-video` metadata row is not translated — so a difference means a human changed it. See Q10 before reporting one |
| Q10 | May a locale substitute a subtitled or dubbed recording? | ? | If yes, a different video ID is correct and Q9 must not fire on it. If no, any difference is a defect. The two answers invert the same check, and nobody has given one |
| Q11 | Body prose and session descriptions are translated | ~ | The bulk of the page, expected to change completely |
| Q12 | Registration and RSVP links point at the same destination | ✓ | The label is translated; the href is not. An event registration URL is external and not localised |
| Q13 | Internal links point inside the same locale tree | ✓ | An `/en/…` href on a `/de/…` page is the defect `tx-heal-links` cleans up. Report it |
| Q14 | Link slugs are NOT translated | ✓ | `pathForLocale()` maps `/en/meetups/x` to `/de/meetups/x`; a translated slug resolves to nothing |
| Q15 | Times and time zones keep their value | ✓ | `18:00 CET` may be written `18.00 CET` or `6:00 PM CET`; it may not become `18:00 JST` or shift by an hour |
| Q16 | Attendee and capacity numbers keep their value | ✓ | Digit grouping may follow locale convention; the number may not change |
| Q17 | Image alt text is translated | ~ | Alt text is prose describing a photograph, and describing a photograph in the reader's language is correct |
| QC1 | Is English site chrome (header, footer, nav) on a translated page a defect to report? | ? | The nav and footer fragments resolve to `/fragments/nav/header`, OUTSIDE `/en`, so no `/en → /<code>` translation project will ever contain them and every translated page renders ENGLISH chrome. That is certain; whether the judge should report it is not. Answer this or the judge either reports it on every page in every locale or never |
| QC2 | Must a translated page carry `hreflang` / a canonical link to its English source? | ? | Nothing emits `hreflang` in `head.html`, and `config/sites/aemdev/sitemap.yaml` carries exactly one language block. If they are required, their absence is a defect on every page and the judge should say so; if not, it must never mention them |
| QC3 | Terms in `glossary.md` are never translated | ✓ | The shared glossary's NEVER TRANSLATE list, mirrored by `dnt-content-rules` in `.tracker/da-translate.json` — the connector wraps each in `translate="no"`. A term rendered in the target language is a defect |
| QC4 | A term with no required rendering in `glossary-<code>.md` may be translated any consistent way | ~ | The per-locale tables are authored but their right-hand columns are still blank. Until they are filled, a defensible translation of `block` or `preview` is NOT a finding — only inconsistency inside one page is |

## Visual QA

| ID | Requirement | Status | Note |
| --- | --- | --- | --- |
| V1 | The date / location line wraps rather than clipping | ✓ | One dense line in English, ~1.3× in German |
| V2 | The `speakers` row does not overflow horizontally | ✓ | Compare against the English page at the same width |
| V3 | The video embed keeps its aspect ratio and is not clipped at 390px | ✓ | A letterboxed or cropped recording is a real defect |
| V4 | Speaker name / role text may take two lines where English takes one | ~ | Expected growth. Only overlap or clipping is damage |
| V5 | Session list items may be taller than in English | ~ | Expected growth |

## Open Questions

| ID | Question | Owner | Blocks |
| --- | --- | --- | --- |
| QC1 | Is English site chrome on a translated page a defect, or the intended state until link localisation lands? | site owner; port manifest F-2 | every group |
| QC2 | Are `hreflang` / canonical links required on translated pages? | site owner | every group |
| Q10 | May a locale substitute a subtitled or dubbed recap recording? | whoever owns meetup content | this group only |
| I1 | Create `templates/meetup/meetup.css`, or record that the template is deliberately unstyled | whoever owns the meetup template | this group only |
