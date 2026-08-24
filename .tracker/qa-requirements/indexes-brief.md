# Production requirements — indexes

**REQUIREMENTS STATUS: DRAFT**

**SCOPE:** `/` (root home), `/en` (locale home), `/en/articles`, `/en/meetups`, `/en/contact` — the five landing pages listed in `LANDING_PAGES` in `tools/tracker/lib/group-map.mjs`, matched BEFORE any path prefix so `/en/meetups` belongs here and `/en/meetups/berlin` does not.

**Golden master:** none yet — nothing is translated, so there is no blessed locale page to calibrate against.

JUDGE_MODE: audit

> Audit mode is deliberate and this is the group it was added for. An index page's
> visible content is assembled at RUNTIME from a query index, so it is absent from the
> authored text by design and comparing the two sides produces nothing but false
> positives. The judge evaluates the page against the checklist below instead.

## Content Requirements

| ID | Requirement | Status | Note |
| --- | --- | --- | --- |
| C1 | Each index page carries the section's own heading and standing intro prose | ✓ | The prose is translated; its presence is not optional |
| C2 | Each index page carries a feed of the section's pages | ✓ | Rendered by `article-feed` / `insights`, not authored row by row |
| C3 | `/en/contact` carries the contact routes it carries in English | ✓ | Addresses and handles are not localised content |

## Implementation Requirements

| ID | Requirement | Status | Note |
| --- | --- | --- | --- |
| I1 | The feed block reads a LOCALE-scoped index | ? | It does not, and the mechanism guarantees it will not: `custom-doc-rules` marks the `insights` / `article-feed` `index` config cell do-not-translate (correctly — a path must never be translated), and both blocks hardcode `DEFAULT_INDEX = '/en/query-index.json'`. So `/de/articles` renders the ENGLISH feed, and no amount of translation fixes it. Somebody has to decide whether to make the blocks locale-aware or accept it |
| I2 | Ten `aemdev-<code>` query indices exist, one per locale tree | ? | None exist. Port manifest section E.4 specifies them; nothing has deployed them. Without them there is no per-locale page list for a feed to read even after I1 |
| I3 | The tracker's own boards are never translated | ✓ | `custom-doc-rules` marks `tracker-summary`, `translation-matrix`, `group-progress`, `work-queue`, `escalation-list` and `status-primer` do-not-translate |

## QA Requirements

Evaluate the translated index page against this checklist.

**Q1 is the rule this group exists for.** An index page lists whatever exists in its own
locale, so a locale index with fewer items than English is a rollout in progress, not a
defect. A judge that treats a count difference as a finding fails every index page in
every locale on every run, and the noise buries every real finding behind it.

| ID | Requirement | Status | Note |
| --- | --- | --- | --- |
| Q1 | The NUMBER of items in a feed may differ from English | ~ | A locale index lists what is translated in that locale. Fewer items, more items, or none at all is expected and is **NOT a finding**. Never report a count difference |
| Q2 | The ORDER of items in a feed may differ from English | ~ | The feed sorts by date over a different set of pages, so the order follows from Q1. Not a finding |
| Q3 | Individual item TITLES may differ from the English list | ~ | An item's title is the translated page's own title, and an untranslated item may legitimately still show its English title. Not a finding at the index level — an untranslated PAGE is caught on that page's own row |
| Q4 | The page's own heading and intro prose are present and in the target language | ✓ | Missing prose is a defect. Untranslated prose is a defect. This is the check Q1–Q3 exist to protect from noise |
| Q5 | Every navigation label present in English is present | ✓ | Presence, not wording. A dropped nav item is a defect |
| Q6 | The call-to-action set is present and unchanged in number and destination | ✓ | A CTA's LABEL is translated; a CTA that vanished is a defect |
| Q7 | Internal links point inside the same locale tree | ✓ | An `/en/…` href on a `/de/…` page is the defect `tx-heal-links` exists to clean up. Report it; do not fix it |
| Q8 | Link slugs are NOT translated | ✓ | `pathForLocale()` maps `/en/articles/x` to `/de/articles/x`. A translated slug resolves to nothing. `dnt-sheet-rules` already marks any cell beginning `/` do-not-translate |
| Q9 | `/en/contact`: postal addresses, phone numbers, e-mail addresses and social handles are byte-identical | ✓ | A translated e-mail address is unreachable |
| Q10 | Numbers in prose keep their value | ✓ | Digit grouping and decimal separators may follow locale convention; the value may not change |
| Q11 | Must a locale index list ONLY translated items, or fall back to English ones? | ? | This decides whether an English title in a `/de` feed is correct behaviour or a defect, and Q3 is written permissively only because nobody has answered it. Answering it makes Q3 enforceable in one direction or the other |
| Q12 | `section-metadata` layout directives are byte-identical | ✓ | `custom-doc-rules` marks the block do-not-translate — it is grid, columns, gap and colour, with no prose in it. A translated `grid` value silently changes the layout |
| QC1 | Is English site chrome (header, footer, nav) on a translated page a defect to report? | ? | The nav and footer fragments resolve to `/fragments/nav/header`, OUTSIDE `/en`, so no `/en → /<code>` translation project will ever contain them and every translated page renders ENGLISH chrome. That is certain; whether the judge should report it is not. Answer this or the judge either reports it on every page in every locale or never |
| QC2 | Must a translated page carry `hreflang` / a canonical link to its English source? | ? | Nothing emits `hreflang` in `head.html`, and `config/sites/aemdev/sitemap.yaml` carries exactly one language block. If they are required, their absence is a defect on every page and the judge should say so; if not, it must never mention them |
| QC3 | Terms in `glossary.md` are never translated | ✓ | The shared glossary's NEVER TRANSLATE list, mirrored by `dnt-content-rules` in `.tracker/da-translate.json` — the connector wraps each in `translate="no"`. A term rendered in the target language is a defect |
| QC4 | A term with no required rendering in `glossary-<code>.md` may be translated any consistent way | ~ | The per-locale tables are authored but their right-hand columns are still blank. Until they are filled, a defensible translation of `block` or `preview` is NOT a finding — only inconsistency inside one page is |

## Visual QA

| ID | Requirement | Status | Note |
| --- | --- | --- | --- |
| V1 | The tile / card grid reflows at 390px without overlap or clipping | ✓ | Compare against the English page at the same width, not against a design |
| V2 | Navigation wraps rather than overflowing horizontally | ✓ | German labels run ~1.3× English (`expansion` in `scripts/tracker/locales.js`); wrapping is expected, a horizontal scrollbar is not |
| V3 | A longer heading may push the fold | ~ | Growth is expected. Only overlap, clipping or an unreachable control is a defect |
| V4 | Card heights may differ between locales | ~ | Text length differs by design; ragged cards are not damage unless content is cut off |

## Open Questions

| ID | Question | Owner | Blocks |
| --- | --- | --- | --- |
| QC1 | Is English site chrome on a translated page a defect, or the intended state until link localisation lands? | site owner; port manifest F-2 | every group |
| QC2 | Are `hreflang` / canonical links required on translated pages? | site owner | every group |
| Q11 | Must a locale index list only translated items, or fall back to English ones? | content owner | this group only |
| I1 | Make the feed blocks locale-aware, or accept that a locale index renders the English feed | whoever owns `blocks/article-feed` and `blocks/insights` | this group only |
| I2 | Deploy the ten per-locale query indices | whoever owns `config/sites/aemdev/query.yaml` | this group only |
