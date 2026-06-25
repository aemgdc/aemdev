# Internal Linking Reference

Supporting reference material for the internal-linking skill.

## Recommendation Format Template

When generating linking recommendations, follow this format for each one:

**Target page (needs links):** `/blog/advanced-seo-tips` — "Advanced SEO Tips for 2026"

**Suggested link from:** `/blog/seo-basics` — "SEO Basics: A Beginner's Guide"

**Placement:** In the paragraph that reads "Once you have mastered the fundamentals, there are more advanced techniques to explore."

**Suggested sentence with link:** "Once you have mastered the fundamentals, explore [advanced SEO techniques](/blog/advanced-seo-tips) to take your rankings further."

**Rationale:** Both pages are in the Blog silo and cover related SEO topics. The basics article is a natural entry point to the advanced article.

---

## Troubleshooting

| Problem | Cause | Solution |
|---------|-------|----------|
| Query index returns 404 | Site may not have a query index, or the path is different | Try `/query-index.json?limit=500`; ask the user for the index URL |
| Query index is empty or has few entries | Pages may not be published, or the index sheet is filtered | Ask if the site uses a custom index configuration |
| `.plain.html` returns 404 for some pages | Page may not exist or may use a non-standard setup | Skip the page and note it in the report |
| Too many pages to fetch individually | Large sites with hundreds of pages | Scope to a path prefix; sample a representative subset |
| Navigation links dominate the graph | Every page links to the same nav targets | Separate nav/footer links from body links; focus analysis on body links |
| Links use absolute URLs with different domains | Preview, live, and production domains in links | Normalize all links to paths before comparison |

---

## Link Classification Reference

| Type | Description |
|---|---|
| **Body contextual** | A link within a paragraph, heading, or list item in the main content. Most valuable for SEO. |
| **Block link** | A link inside an EDS block (cards, columns, teaser, etc.). Semi-contextual — placed by the author but in a structured layout. |
| **CTA / button** | A link styled as a button (EDS convention: a link that is the sole content of a `<p>` and wraps a `<strong>` or `<em>`). |

## Table Templates

Use these table formats when presenting results:

### Most/Least Linked Pages

| Page | Path | Inbound Body Links | Inbound Total |
|------|------|-------------------|---------------|

### Orphan Pages

| Page | Path | Outbound Links | In Nav? | In Footer? |
|------|------|---------------|---------|------------|

### Hub Pages

| Page | Path | Outbound Body Links | Role |
|------|------|--------------------|------|
