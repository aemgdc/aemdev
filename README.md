# aemdev.org

This is a community project of the [AEM Global Development Collective](https://www.aemdev.org). Contributions are welcome!

It is an [Author Kit](#author-kit) site driving [www.aemdev.org](https://www.aemdev.org).

**Site owners:** Tad Reeves - contact on Linkedin or Slack 

---

## Author Kit
For projects that want a few more batteries. Built by the team who brought you da.live and adobe.com.

## Getting started

### 1. Github
1. Use this template to make a new repo.
1. Install [AEM Code Sync](https://da.live/bot).

### 2. DA content
1. Browse to https://da.live/start.
2. Follow the steps.

### 3. Local development
1. Clone your new repo to your computer.
1. Install the AEM CLI using your terminal: `sudo npm install -g @adobe/aem-cli`
1. Start the AEM CLI: `aem up`.
1. Open the `{repo}` folder in your favorite code editor and buil something.
1. **Recommended:** Install common npm packages like linting and testing: `npm i`.

## Features

### Localization & globalization
* Language only support - Ex: en, de, hi, ja
* Region only support - Ex: en-us, en-ca, de-de, de-ch
* Hybrid support - Ex: en, en-us, de, de-ch, de-at
* Fragment-based localized 404s
* Localized Header & Footer
* Do not translate support (#_dnt)

### Flexible section authoring
* Optional containers to constrain content
* Grids: 1-6
* Columns: 1-12
* Color scheme: light, dark
* Gap: xs, s, m, l, xl, xxl
* Spacing: xs, s, m, l, xl, xxl
* Background: token / image / color / gradient

### Base content
* Universal buttons w/ extensive styles
* Images w/ retina breakpoint
* Color scheme support: light, dark
* Modern favicon support
* New window support
* Deep link support
* Modal support

### Header and footer content
* Brand - First link in header
* Main Menu - First list in header
* Actions - Last section of header
* Menu & mega menu support
* Disable header/footer via meta props

### Scheduled content
* Schedule content using spreadsheets

### Sidekick & pre-production
* Quick Edit
* Extensible plumbing for plugins
* Schedule simulator
* Convert production links to relative

### Performance
* Extensible LCP detection

### Developer tools
* Environment detection
* Extensible logging (console, coralogix, splunk, etc.)
* Buildless reactive framework support (Lit)
* Hash utils patterns (#_blank, #_dnt, etc)
* Modern CSS scoping & nesting
* AEM Operational Telemetry

### Operations
* Cloudflare Worker reference implementation

## Patterns
### Page
A page is what holds your content. It can be styled using a metadata property called `template` which will load styles that apply to the entire page.

### Section
A section is a sub-section of your page. It can be styled using a `section-metadata` block. A section will control the layout of blocks.

### Block
Blocks are children of sections. A block adds visual context to parts of a page.

### Auto Block
An auto block is a block generated from a pre-defined piece of content. Often times from a link that matches a particular pattern. Link-based auto blocks can be helpful when additional nesting of content is required.

### Default content
Default content is content that lives outside a block.

## Design System

### Spacing & Gap
XS, S, M, L, XL, XXL

### Emphasis
quiet, default, strong, negative

### Buttons
accent, primary, secondary, negative
(w/ outline variations)

### Columns
1 - 12

### Grid
1 - 6

### Color tokens
blue, gray, green, magenta, organge, red, purple, yellow
(w/ 100-900 variations)

### Color schemes
light, dark

---
_Test commit - 2026-04-05_

## Daily Popular Articles (GA4)

This repo includes an automated workflow to generate a daily top-10 popular articles list from GA4 and publish it in two formats:

- JSON for feed/index consumers: `data/popular-articles.json`
- Static fragment source for SEO/reuse: `fragments/brands/popular-articles.plain.html`

Workflow file:

- `.github/workflows/daily-popular-articles.yml`

### Required GitHub Secrets

- `GA4_PROPERTY_ID`: GA4 numeric property ID.
- `GA4_SERVICE_ACCOUNT_JSON`: Full JSON for a Google service account with `analytics.readonly` access.

Optional secret for DA publish (Phase 2):

- `DA_TOKEN`: Token used to upload to DA and trigger preview/live publish.

### Optional GitHub Variables

- `POPULAR_LOOKBACK_DAYS` (default: `1`)
- `POPULAR_LIMIT` (default: `10`)
- `POPULAR_INCLUDE_REGEX` (default: `^/en/`)
- `POPULAR_EXCLUDE_REGEX` (default excludes fragments, drafts, index, and utility paths)

### Manual Run

Use workflow dispatch in GitHub Actions and optionally set:

- `lookback_days`
- `limit`

### Local Commands

- Generate outputs: `npm run popular:generate`
- Publish generated fragment to DA: `npm run popular:publish`
