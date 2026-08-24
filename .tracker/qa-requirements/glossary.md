# Translation glossary — shared

The terminology contract handed to the tier-2 judge (`npm run tx:judge`) for **every**
locale. The per-locale half lives in `glossary-<code>.md`; this file holds the terms that
are the same in all ten, because duplicating them ten times is how ten copies drift.

**This is where an observed defect goes so it cannot recur.** A translation problem that
is not written down here is one the next batch reproduces for free.

## How it is used

`tx-judge.mjs` concatenates this file and `glossary-<code>.md` and puts them in front of
the model as the terminology contract, before it sees a single line of page text. The
judge is asked four questions and terminology is the second of them — and it is the one
where machine translation actually fails, because meaning usually survives and a product
name usually does not.

The judge is *also* told, in code, not to report a brand or product name left in English.
That suppression and this list are two halves of one rule: the list says which words are
names, the suppression stops the model reporting a correctly-preserved one as a miss.

## NEVER TRANSLATE

Seeded from `dnt-content-rules` in `.tracker/da-translate.json`, which is the same list
the DA connector wraps in `translate="no"`. **The two must stay in step**: a term added
here and not there will be translated by the connector and then correctly flagged by the
judge every single run, which is a permanent finding nobody can clear.

### Product and platform names

| Term | Note |
| --- | --- |
| Adobe Experience Manager | Never expanded, never translated. `AEM` likewise. |
| AEMaaCS | AEM as a Cloud Service. The acronym is the name. |
| Edge Delivery Services | The single most-translated-by-mistake term on this site. `Servicios de entrega perimetral` is wrong in every locale. `EDS` likewise. |
| Document Authoring | The product, not the activity. When the English means the *activity* it is lowercase and may be translated. |
| Adobe Experience Cloud | |
| Adobe | The company. Never transliterated, including into CJK. |

### Event and organisation names

| Term | Note |
| --- | --- |
| AEM Global Development Collective | The full name. |
| AEM GDC | The short name. Both spellings appear in body copy. |
| adaptTo() | Including the parentheses and the lowercase `a`. It is a wordmark. |
| Adobe Developers Live | |
| aemdev.org | A domain. Never translated, never localized to a country TLD. |

### People

Speaker and author names are load-bearing content in the `meetups` and `bios` groups, and
a transliterated name into a CJK locale is both wrong and very hard to spot in review.

| Term | Note |
| --- | --- |
| Tad Reeves | |
| Laurel Timko | |
| Wilson Faure | |

> The roster at `/bios.json` (column `Name`) is the source. Keeping this list and
> `dnt-content-rules` in step with it as bios are authored is a real maintenance cost.
> The alternative — translating people's names — is worse.

### Technical identifiers, by shape rather than by name

These are protected by SHAPE in `dnt-sheet-rules` and checked deterministically by tier
1, so the judge should never see one. Listed here because a reviewer reading this file
needs to know the boundary:

- anything beginning `http://` or `https://`
- anything beginning `/` (a site path)
- anything beginning `aemdev:` (a taxonomy tag id)
- anything beginning `#` (this site's link-target authoring language — `#_blank`, `#_dnt`)
- an ISO-8601 date (`2026-10-02`)
- **block names, file paths, CLI flags and shell commands** — `article-feed`,
  `blocks/article-feed/article-feed.js`, `helix-query.yaml`, `mvn clean install`. On this
  site these appear inside prose, wrapped in `<code>`. Tier 1 requires them byte-identical.

## Terms with one required rendering

Words that DO get translated, but only one way. A machine translator will happily use
three synonyms for one concept across one page, and a reader cannot tell whether two
names mean two things.

Fill in per locale in `glossary-<code>.md` — there is nothing locale-independent to say
here, which is exactly why the file is split. What belongs in THIS section is the list of
CONCEPTS whose rendering must be consistent, so every locale file answers the same
questions:

| Concept | Where it appears | Why one rendering |
| --- | --- | --- |
| block | every technical article | The EDS unit of composition. Rendered three ways in one paragraph, a reader cannot tell whether they are three things. |
| section | technical articles | Distinct from `block`. If the two collapse onto one word the content model becomes unreadable. |
| author (the person) vs. to author (the verb) | technical articles, bios | Many languages need two different words; English uses one. |
| meetup | meetups group | An event, not a meeting. Several locales keep the English word; say which. |
| recap | meetups group | Paired with `meetup`. |
| index / query index | technical articles | A data artifact, not a book index. |
| preview / publish | technical articles | The two EDS lifecycle verbs. They must stay distinguishable from each other. |

## Register

Technical practitioner prose, addressed to developers and architects. Not marketing copy
and not documentation: the site's voice is a colleague explaining something. The judge is
asked about register last and a register-only issue never fails a page — a translation
that reads slightly flat is worth a note and not a re-run.
