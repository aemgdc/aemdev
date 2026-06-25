# Structured Data Reference

## Content Type Signals

Use these signals to determine the appropriate schema.org type from page content:

| Content Type | Signals |
|---|---|
| Article / Blog Post | Publication date, author, article body with multiple paragraphs, `template: article` metadata |
| FAQ Page | Pattern of questions (headings) followed by answers (paragraphs) |
| How-To | Step-by-step instructions, numbered lists, possibly with images per step |
| Product | Product name, price, description, images, specifications |
| Organization | About page with company name, logo, contact info, social links |
| Event | Date, time, location, event name, registration link |
| BreadcrumbList | Any page with a defined path hierarchy |
| WebSite | Homepage or any page needing a sitewide SearchAction |
| LocalBusiness | Contact page with address, phone, hours of operation |
| VideoObject | Embedded video with title, description, thumbnail |

Multiple types can apply to a single page (e.g., Article + BreadcrumbList).

## Metadata Extraction Sources

### From `<head>` (full HTML)

- `<title>` -- page title
- `<meta name="description">` -- page description
- `<meta name="author">` -- author name
- `og:image`, `og:title`, `og:description` -- Open Graph data
- Custom metadata: `publication-date`, `modified-date`, `template`, `schema-type`, `category`, `tags`

### From `.plain.html` body

- **H1** -- primary heading (maps to `headline` or `name`)
- **First paragraph** -- summary or description
- **Images** -- `src` and `alt` attributes (maps to `image`)
- **Ordered lists** -- may indicate steps (HowTo) or items
- **Question/answer patterns** -- headings followed by paragraphs (FAQ)
- **Dates** -- publication and modification dates
- **Links** -- author pages, category pages, related content
- **Tables** -- product specs, event details, pricing

## Troubleshooting

| Problem | Cause | Solution |
|---------|-------|----------|
| Cannot determine content type | Generic content without clear signals | Ask the user what type of page it is; default to `WebPage` |
| Missing required properties | Page lacks metadata like author or publication date | Note the gaps; recommend adding metadata to the source document's metadata table |
| Image URLs are relative | EDS sometimes uses relative `/media/` paths | Convert to absolute URLs using the production domain |
| Structured data not appearing in search | Google has not recrawled, or the data has errors | Validate with Rich Results Test; request indexing via Search Console |
| JSON-LD in source document does not work | EDS generates HTML from docs; raw JSON-LD renders as text | JSON-LD must go in head.html or be injected via scripts.js |
| Multiple schema types conflict | Two types claim to be the main entity | Use `mainEntityOfPage` on the primary type only; others are supplementary |
| Dates in wrong format | Author used human-readable dates instead of ISO 8601 | Convert in scripts.js when reading from metadata; advise ISO format in docs |

## Metadata-Driven Approach

Add a `schema-type` property to the metadata table in the source document, then read it in scripts.js to determine which structured data to generate:

| Key | Value |
|-----|-------|
| schema-type | Article |
| author | Jane Smith |
| publication-date | 2026-01-15 |

This lets content authors control structured data type from within the document while the code handles generation.
