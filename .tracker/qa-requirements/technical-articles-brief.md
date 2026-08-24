# Production requirements — technical-articles

**REQUIREMENTS STATUS: DRAFT**

**SCOPE:** `/en/articles/**`, `template: blog` (`templates/blog/blog.css` exists). One live article today; the largest group as the site grows, and the one where text expansion bites hardest. The section LANDING page `/en/articles` is not in this group — it belongs to `indexes`.

**Golden master:** none yet — nothing is translated.

## Content Requirements

| ID | Requirement | Status | Note |
| --- | --- | --- | --- |
| C1 | Every article names its author and its publication date | ✓ | Attribution is not optional on technical writing |
| C2 | Code examples are runnable as printed | ✓ | An article whose code does not run is worse than no article |
| C3 | Headings form a usable outline | ✓ | Technical articles are scanned before they are read |

## Implementation Requirements

| ID | Requirement | Status | Note |
| --- | --- | --- | --- |
| I1 | Code is authored in a `code` BLOCK, not as pre-formatted prose | ✓ | This is what makes Q1 enforceable at all. `custom-doc-rules` marks the `code` block do-not-translate, so the connector will not touch it — but code pasted as a paragraph is indistinguishable from prose and WILL be translated, with no rule able to save it |
| I2 | `template: blog` metadata is present on every article | ✓ | Present today via `templatedSections`, which does include `'articles'` |
| I3 | The structural metadata is never translated | ✓ | `custom-doc-rules` translates only `title`, `description`, `displaydescription` and `og:title`, so `author`, `publication-date`, `category`, `tags` and `image` are do-not-translate at the connector. Q4 and Q5 are the judge's half of the same rule |

## QA Requirements

Compare the translated article against its English source.

**Q1 is the rule this group exists for.** A translated identifier is not a translation
error, it is a broken example: `const feed = await fetchIndex()` becoming
`const zufuhr = await indexAbrufen()` produces code that does not compile, in an article
whose only job is to be copied and pasted.

| ID | Requirement | Status | Note |
| --- | --- | --- | --- |
| Q1 | Every `code` BLOCK is byte-identical to English | ✓ | **DNT, absolutely.** Identifiers, keywords, string literals, the comments inside the code, whitespace and line breaks — all of it. A single translated identifier fails the page. Comments inside code are part of the code |
| Q2 | Every inline `code` SPAN is byte-identical to English | ✓ | **DNT.** Same rule, same reason: an inline `` `queryIndex` `` is a symbol a reader will type, not a word. Note that the connector's block-level `code` rule does NOT cover inline spans, so this one is the judge's alone |
| Q3 | Block names, class names and file paths in prose are byte-identical | ✓ | **DNT.** `article-feed`, `blocks/insights/insights.js` and `query-index.json` are identifiers that happen to be spelled in English |
| Q4 | The AUTHOR NAME is byte-identical | ✓ | **DNT.** A personal name is not a phrase; transliterating it or reordering given and family name is a defect |
| Q5 | The PUBLICATION DATE is present and denotes the same day | ✓ | A missing or shifted publication date misrepresents when the technical content was true. See Q6 for formatting |
| Q6 | The publication date's FORMATTING may follow locale convention | ~ | `16 August 2026` → `16. August 2026` → `2026年8月16日` is correct localisation. The DAY must not move |
| Q7 | Every HEADING present in English is present, at the same level and in the same order | ✓ | The WORDING is translated; the outline is not. A dropped `h3`, or an `h2` demoted to `h3`, breaks the structure a reader navigates by |
| Q8 | Heading wording is translated | ~ | A heading left in English on a translated page is an untranslated-content defect |
| Q9 | Body prose is translated | ~ | The bulk of the page, expected to change completely |
| Q10 | `displayDescription` and the summary line are translated | ~ | Prose, and explicitly in the connector's translate list |
| Q11 | The COUNT of `code` blocks matches English | ✓ | A dropped example is a silent defect: the surrounding prose still reads correctly and refers to code that is no longer there |
| Q12 | The COUNT and ORDER of images and figures matches English | ✓ | A dropped diagram is the same class of defect as a dropped code block |
| Q13 | Figure captions are translated | ~ | Captions are prose. Growth is expected — see V3 |
| Q14 | Image alt text on a SCREENSHOT of English UI: translated, or preserved? | ? | Translating the alt of a screenshot describes something the reader will not see in that language; preserving it leaves an English string on a translated page. Both are defensible, and the judge inverts on the answer. Alt text is not covered by any `custom-doc-rules` entry, so the connector will translate it either way |
| Q15 | External links point at the same destination | ✓ | The link TEXT is translated; the href is not. Do not localise a link into documentation that has no translated equivalent |
| Q16 | Internal links point inside the same locale tree | ✓ | An `/en/…` href on a `/de/…` page is the defect `tx-heal-links` cleans up. Report it |
| Q17 | Link slugs are NOT translated | ✓ | `pathForLocale()` maps `/en/articles/x` to `/de/articles/x`; a translated slug resolves to nothing |
| Q18 | Numbers, version numbers and units keep their value | ✓ | Digit grouping and decimal separators may follow locale convention. `AEM 6.5` may not become `AEM 6,5` — that is a version, not a decimal |
| Q19 | `section-metadata` layout directives are byte-identical | ✓ | `custom-doc-rules` marks the block do-not-translate; it is grid, columns, gap and colour with no prose in it |
| QC1 | Is English site chrome (header, footer, nav) on a translated page a defect to report? | ? | The nav and footer fragments resolve to `/fragments/nav/header`, OUTSIDE `/en`, so no `/en → /<code>` translation project will ever contain them and every translated page renders ENGLISH chrome. That is certain; whether the judge should report it is not. Answer this or the judge either reports it on every page in every locale or never |
| QC2 | Must a translated page carry `hreflang` / a canonical link to its English source? | ? | Nothing emits `hreflang` in `head.html`, and `config/sites/aemdev/sitemap.yaml` carries exactly one language block. If they are required, their absence is a defect on every page and the judge should say so; if not, it must never mention them |
| QC3 | Terms in `glossary.md` are never translated | ✓ | The shared glossary's NEVER TRANSLATE list, mirrored by `dnt-content-rules` in `.tracker/da-translate.json` — the connector wraps each in `translate="no"`. A term rendered in the target language is a defect |
| QC4 | A term with no required rendering in `glossary-<code>.md` may be translated any consistent way | ~ | The per-locale tables are authored but their right-hand columns are still blank. Until they are filled, a defensible translation of `block` or `preview` is NOT a finding — only inconsistency inside one page is |

## Visual QA

| ID | Requirement | Status | Note |
| --- | --- | --- | --- |
| V1 | Code blocks scroll horizontally inside their own container at 390px | ✓ | Code is byte-identical, so its width is identical — a code block that overflows the PAGE at 390px is a TEMPLATE defect present in English too. Report it once against the template, not once per locale |
| V2 | Headings rewrap without clipping or overlapping the content below | ✓ | German headings run ~1.3× English |
| V3 | Figure captions may grow to more lines than in English | ~ | Expected. Only a caption that overlaps the next figure is damage |
| V4 | The article body may be substantially longer OR SHORTER than English | ~ | `expansion` is 0.6 for ja and 0.5 for zh-cn, so a translated article is visibly shorter and that is normal, not truncation. Check the tail content is present rather than trusting the height |
| V5 | Inline `code` spans do not break the line box | ✓ | A long identifier in a narrow column is the classic overflow, and it is worse in a locale whose surrounding words are longer |

## Open Questions

| ID | Question | Owner | Blocks |
| --- | --- | --- | --- |
| QC1 | Is English site chrome on a translated page a defect, or the intended state until link localisation lands? | site owner; port manifest F-2 | every group |
| QC2 | Are `hreflang` / canonical links required on translated pages? | site owner | every group |
| Q14 | Screenshot alt text: translate it, or preserve the English? | content owner | this group only |
