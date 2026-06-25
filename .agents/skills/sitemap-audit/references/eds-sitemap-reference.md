# EDS Sitemap Reference

Detailed reference for AEM Edge Delivery Services sitemap configuration, conventions, and troubleshooting.

## helix-sitemap.yaml Configuration

The `helix-sitemap.yaml` file lives at the repository root. Its basic structure:

```yaml
sitemaps:
  default:
    include:
      - /**
    exclude:
      - /drafts/**
      - /fragments/**
    properties:
      lastmod: lastModified
```

**Key fields:**

- **`sitemaps`** -- top-level map of named sitemaps. Most sites use a single `default` sitemap. Multilingual sites add additional entries (e.g., `de`, `fr`) to generate separate sitemap files per language, which EDS combines into a sitemap index.
- **`include`** -- glob patterns for paths to include. `/**` includes all paths. Use more specific patterns like `/blog/**` to limit scope.
- **`exclude`** -- glob patterns for paths to exclude. Patterns are evaluated after includes. Common exclusions: `/drafts/**`, `/fragments/**`, `/nav`, `/footer`.
- **`properties.lastmod`** -- maps a field name from the query index to the `<lastmod>` element in the sitemap XML. The value `lastModified` refers to the `lastModified` column in the query index sheet. If this property is missing, the sitemap omits `<lastmod>` entirely.

## Glob Pattern Rules

- `/**` matches all paths recursively.
- `/blog/**` matches `/blog/post-1`, `/blog/2026/recap`, etc.
- `/blog/*` matches only direct children like `/blog/post-1`, not `/blog/2026/recap`.
- Patterns are case-sensitive and match against the URL path (no domain).

## Multilingual Sitemap Index

```yaml
sitemaps:
  en:
    include:
      - /en/**
    exclude:
      - /en/drafts/**
      - /en/fragments/**
    properties:
      lastmod: lastModified
  de:
    include:
      - /de/**
    exclude:
      - /de/drafts/**
      - /de/fragments/**
    properties:
      lastmod: lastModified
```

This generates `/sitemap-en.xml` and `/sitemap-de.xml`, combined under a `/sitemap.xml` index. When auditing multilingual sites, fetch and validate each sub-sitemap independently.

## Fragment and Draft Paths

EDS sites use two path conventions for content that should never appear in a sitemap:

- **`/fragments/`** -- reusable content blocks (navigation, footer, modals, shared sections) assembled into pages at render time. These paths return valid HTML but are not standalone pages. They must be excluded from the sitemap.
- **`/drafts/`** -- work-in-progress content that authors have published to preview but is not ready for public discovery. These paths are accessible but should not be indexed.

Both should be listed in the `exclude` patterns of `helix-sitemap.yaml`. If they appear in the sitemap, the exclude configuration is either missing or misconfigured (e.g., `/fragments/*` instead of `/fragments/**`, which misses nested paths).

## EDS robots.txt Behavior

EDS auto-generates a `robots.txt` from the site configuration. Relevant behaviors:

- On `.aem.live` and `.aem.page` domains, the default `robots.txt` typically disallows all crawling (these are preview/development origins).
- On the production custom domain, `robots.txt` allows crawling and includes a `Sitemap:` directive pointing to the sitemap URL.
- The `Sitemap:` directive must use the production domain, not the `.aem.live` origin. A mismatch causes search engines to either ignore the directive or fetch the wrong sitemap.
- If `robots.txt` contains a `Disallow` rule that blocks the sitemap path itself (rare but possible with overly broad rules), search engines cannot discover the sitemap via robots.txt.

## Query Index as Ground Truth

The query index (`/query-index.json`) is the canonical list of all published pages on an EDS site. EDS populates it automatically from published content metadata. For sitemap auditing:

- **Every URL in the sitemap should have a corresponding entry in the query index.** A sitemap URL without a query index entry means the page was unpublished or deleted after the sitemap was generated, or the sitemap configuration includes paths outside the query index scope.
- **Every non-excluded URL in the query index should appear in the sitemap.** A query index entry missing from the sitemap means the `helix-sitemap.yaml` exclude patterns are too broad, or the include patterns are too narrow.
- **The `lastModified` field in the query index is the source of truth for `<lastmod>` dates.** If the sitemap `lastmod` does not match the query index `lastModified`, the `properties.lastmod` mapping in `helix-sitemap.yaml` is misconfigured.
- **The query index may be paginated.** Fetch all pages by following `offset` and `limit` parameters until the returned data is empty. Do not assume a single fetch captures all entries.

## Troubleshooting

| Problem | Cause | Solution |
|---------|-------|----------|
| `sitemap.xml` returns 404 | No `helix-sitemap.yaml` configured or sitemap not published | Add a `helix-sitemap.yaml` to the repository root and publish |
| `query-index.json` returns 404 | Query index not configured or not published | Audit sitemap without cross-reference; note the limitation |
| Query index is paginated | Large site with many pages | Fetch all pages using `?offset=X&limit=Y` pagination |
| Fragment or draft URLs in sitemap | Missing or misconfigured exclude patterns in `helix-sitemap.yaml` | Add `/drafts/**` and `/fragments/**` to the exclude list |
| `robots.txt` Sitemap directive points to `.aem.live` | Site config not updated for production domain | Update the site configuration to use the custom domain |
| `robots.txt` blocks sitemap path | Overly broad `Disallow` rule | Narrow the `Disallow` rule or add an `Allow: /sitemap.xml` exception |
| All `lastmod` dates are identical | `properties.lastmod` not configured or pointing to a uniform field | Set `properties.lastmod: lastModified` in `helix-sitemap.yaml` |
| `lastmod` does not match query index | `properties.lastmod` maps to the wrong field name | Verify the field name matches the column in the query index sheet |
| Sitemap URLs use `.aem.live` domain | Sitemap generated before custom domain was configured | Regenerate by publishing after domain setup; URLs derive from the serving domain |
| Large sitemap causes timeout | Too many URLs to validate | Spot-check a sample of 50 URLs; note the limitation |
| Multilingual sub-sitemaps missing | Only `default` sitemap defined | Add named sitemaps per language in `helix-sitemap.yaml` |
