# Translation glossary — Chinese (Traditional) (zh-tw)

The per-locale half of the terminology contract. Read together with `glossary.md`, which
holds the never-translate list and the concepts every locale file has to answer for.

Native name: **繁體中文**. Sheet tab and URL prefix: `zh-tw` / `/zh-tw`.
Connector code: `zh-TW` — note the case difference from our own id; see scripts/tracker/locales.js.

## Terms with one required rendering

One row per concept from `glossary.md`. **A blank right-hand column is not a pass, it is
an unanswered question** — the judge can only check terminology it has been told about, so
an empty table means tier 2 is judging meaning and register alone on this locale.

| English | Required Chinese (Traditional) | Note |
| --- | --- | --- |
| block | | |
| section | | |
| author (the person) | | |
| to author (the verb) | | |
| meetup | | |
| recap | | |
| index / query index | | |
| preview (verb) | | |
| publish (verb) | | |

## Locale conventions

Facts about Chinese (Traditional) that tier 1 already enforces deterministically. They are written
down here so a reviewer reading a judge verdict knows what was NOT the judge's business —
and so nobody adds a glossary line asking the model to check one of them.

| Convention | Value | Enforced by |
| --- | --- | --- |
| Thousands separator | `,` | `extractNumbers` compares figures as VALUES, so `176,000` → `176,000` passes and `1.5` → `15` does not. |
| Decimal separator | `.` | same |
| Quotation marks | 「…」 | `quoteStyleCheck`, as a NOTE only |
| Text expansion vs English | 0.5x | `measureExpansion` divides the observed ratio by this before applying `qa.wordRatio`, so Chinese (Traditional) running 0.5x longer is expected and not a finding |
| Small numbers spelled out | 0–12, per `NUMBER_WORDS` | reported as a note, never a warning — it is house style |
| ISO-8601 dates | byte-identical | `checkDates`. A date written in words (`2 October 2026`) SHOULD be localized; `2026-10-02` must not be touched. |

## Observed defects

**Empty because nothing has been translated into Chinese (Traditional) yet.** Every row added here is
a real defect a reviewer found, written down so the next batch cannot reproduce it.

The shape to use — the upstream pipeline's own worked example, kept because it is the
clearest illustration of what belongs here and what does not:

> `Director` (a job title, in a quote attribution) came back as `Regisseur` — a FILM
> director. Not a DNT problem: the rule correctly permits translating that cell, and no
> deterministic check can see it. A glossary line is the only durable fix.

| Date | Page | English | Wrong | Correct | Class |
| --- | --- | --- | --- | --- | --- |

Classes: `terminology` (add a row above) · `dnt` (fix `.tracker/da-translate.json`,
THEN re-translate — re-translating first reproduces the identical defect) · `meaning`
(re-translate) · `register` (a note, not a re-run) · `layout` (a developer; nobody can
make Chinese (Traditional) shorter).
