# Production requirements — bios

**REQUIREMENTS STATUS: DRAFT**

**SCOPE:** `/en/fragments/bios/**` — speaker and contributor bio fragments. The page list comes from the `/bios.json` roster (`Slug, Name, Title, Company, LinkedIn, Image, Path, Status, Updated`), which is **owned by another session**: the tracker READS it and never writes it. `/en/fragments/**` is in `aemdev-en`'s `exclude`, so this group has no query index and legitimately syncs zero rows today.

**Golden master:** none yet — nothing is translated.

## Content Requirements

| ID | Requirement | Status | Note |
| --- | --- | --- | --- |
| C1 | Every bio carries a name, a role and a photo or initials fallback | ✓ | A bio without a name is not a bio |
| C2 | `bio-status` is `placeholder` or `approved` | ✓ | Owned by the bio manager. A `placeholder` bio should not be sent for translation at all — that is what the `translate` column on the group sheet is for |
| C3 | The bio body is a short paragraph, not a CV | ✓ | Length is a content decision, and it is what makes the two-line role growth in V2 tolerable |

## Implementation Requirements

| ID | Requirement | Status | Note |
| --- | --- | --- | --- |
| I1 | The group has a machine-readable page list | ? | It does not. `/en/fragments/**` is excluded from `aemdev-en`, so `group:sync` reports zero rows for `bios` and that is currently CORRECT rather than broken. Until an `aemdev-bios` index is deployed or `/bios.json` is wired into the sync, every row in this group is entered by hand |
| I2 | A per-locale translation status exists for a bio | ? | `bio-status` (`placeholder` / `approved`) is a working precedent for a per-locale equivalent, but `/bios.json` is owned elsewhere and the tracker must not write it. Whether the roster grows the column or the group sheet's locale tabs stay the sole record is somebody else's decision, and it changes where a reviewer looks |
| I3 | The roster's structural columns are never translated | ✓ | The `dnt` sheet in `.tracker/da-translate.json` marks `Slug, Path, Image, LinkedIn, Updated` do-not-translate on every sheet, and `Name` is covered by `dnt-content-rules` instead — which catches it in body prose as well as in the cell |
| I4 | Bio fragments are rendered by the `bio` block plus a `metadata` block | ✓ | Present today. `custom-doc-rules` also marks the `fragment` block do-not-translate |

## QA Requirements

Compare the translated bio fragment against its English source.

A bio is the clearest split in the whole tracker between structural fields and prose:
`Slug` / `Name` / `LinkedIn` / `Image` / `Path` are identifiers, and `Title` / `Company` /
the body are language. The judge's job is to hold that line.

| ID | Requirement | Status | Note |
| --- | --- | --- | --- |
| Q1 | `Name` is byte-identical | ✓ | **DNT.** A personal name is not a phrase. Transliteration, reordering given and family name, and translating a name that happens to be a common noun are all defects. This is the field a reader searches for, and a transliteration into a CJK locale is very hard to spot in review |
| Q2 | The `LinkedIn` URL is byte-identical | ✓ | **DNT.** A translated profile URL 404s. The link's visible LABEL may be translated; the href may not |
| Q3 | The `Image` path is byte-identical | ✓ | **DNT.** A translated asset path resolves to nothing and the photo silently disappears, leaving the initials fallback — which looks intentional, so nothing else catches it |
| Q4 | `Slug` and `Path` are byte-identical | ✓ | **DNT.** The slug is the join key between the roster, the fragment and every page that embeds it |
| Q5 | `Title` (the person's role) is translated | ~ | A role left in English on an otherwise translated fragment is an untranslated-content defect. See V2 for the layout consequence |
| Q6 | `Company` is translated | ~ | Per this group's translatable set. A company that does not localise its own name reads the same in every locale, and that is not a defect either — a translator leaving `Adobe` as `Adobe` is correct |
| Q7 | Which wins when a bio's `Company` IS a glossary term? | ? | Q6 declares `Company` translatable and `glossary.md` declares `Adobe` never-translate. For `Adobe` the two agree by luck. For a company whose name contains an ordinary word they do not, and the judge needs to be told which rule outranks the other before it can report on one |
| Q8 | The `Bio` body prose is translated | ~ | The main translatable content of the fragment |
| Q9 | The `description` metadata is translated | ~ | Prose, and in the connector's translate list |
| Q10 | The bio body is PRESENT | ✓ | A fragment that arrived with an empty body is the defect this row exists for: the name, role and photo all render, so it looks complete and reads as a person with nothing to say |
| Q11 | The number of bio fragments in a locale may differ from English | ~ | Same rule as an index page: a locale carries whatever is translated. Not a finding |
| Q12 | Internal links in the body point inside the same locale tree | ✓ | An `/en/…` href on a `/de/…` fragment is the defect `tx-heal-links` cleans up. Report it |
| Q13 | Named credentials, certifications and award titles are byte-identical | ✓ | **DNT.** An "Adobe Certified Expert" is a specific credential, not a description of one |
| Q14 | Event and conference names are byte-identical | ✓ | `glossary.md` names `adaptTo()`, `Adobe Developers Live` and `AEM GDC`. A DESCRIPTIVE reference — "the Berlin meetup" — is prose and is translated |
| QC1 | Is English site chrome (header, footer, nav) on a translated page a defect to report? | ? | The nav and footer fragments resolve to `/fragments/nav/header`, OUTSIDE `/en`, so no `/en → /<code>` translation project will ever contain them and every translated page renders ENGLISH chrome. That is certain; whether the judge should report it is not. Answer this or the judge either reports it on every page in every locale or never |
| QC2 | Must a translated page carry `hreflang` / a canonical link to its English source? | ? | Nothing emits `hreflang` in `head.html`, and `config/sites/aemdev/sitemap.yaml` carries exactly one language block. If they are required, their absence is a defect on every page and the judge should say so; if not, it must never mention them |
| QC3 | Terms in `glossary.md` are never translated | ✓ | The shared glossary's NEVER TRANSLATE list, mirrored by `dnt-content-rules` in `.tracker/da-translate.json` — the connector wraps each in `translate="no"`. A term rendered in the target language is a defect |
| QC4 | A term with no required rendering in `glossary-<code>.md` may be translated any consistent way | ~ | The per-locale tables are authored but their right-hand columns are still blank. Until they are filled, a defensible translation of `block` or `preview` is NOT a finding — only inconsistency inside one page is |

## Visual QA

> Bios are checked as EMBEDDED fragments, not as standalone pages: a fragment reviewed
> in isolation has no layout to damage, and judging one against its own `.plain.html`
> would report a missing header on every single bio.

| ID | Requirement | Status | Note |
| --- | --- | --- | --- |
| V1 | The photo renders, or the initials fallback renders | ✓ | If Q3 was violated this is what the reader sees, and it looks deliberate. Worth checking visually as well as structurally |
| V2 | A role that takes two lines does not overlap the name or the body | ✓ | `Title` is translated and grows ~1.3× in German; the card is sized for one line in English |
| V3 | The bio card may be taller than in English | ~ | Expected growth. Only overlap or clipping is damage |
| V4 | The initials fallback renders correctly for a non-Latin name | ~ | ja / ko / zh names produce different initials. Not a defect unless the glyph is missing or boxed |

## Open Questions

| ID | Question | Owner | Blocks |
| --- | --- | --- | --- |
| QC1 | Is English site chrome on a translated page a defect, or the intended state until link localisation lands? | site owner; port manifest F-2 | every group |
| QC2 | Are `hreflang` / canonical links required on translated pages? | site owner | every group |
| Q7 | Does `Company` translatability or the glossary's never-translate list win? | content owner | this group only |
| I1 | Deploy `aemdev-bios`, or wire `/bios.json` into `group:sync` | whoever owns the bio manager + `query.yaml` | this group only |
| I2 | Does the roster grow a per-locale status column, or do the locale tabs stay the sole record? | whoever owns the bio manager | this group only |
