# StreamX Search

This directory contains the StreamX Search distribution files used by the Adobe Edge Delivery Services project.

The files are copied from the StreamX Search library build output and **must not
be modified directly** - the next copy would silently overwrite the edit.

## Updating

Change the library source, then re-copy the build output:

1. In the library repo: `npm run build`
2. Copy `dist/*.js`, `dist/*.css` and `dist/eds/*.js` into this directory.
3. Delete any previously copied bundle whose hash no longer appears in `dist`.

Copy **`.js` and `.css` only** - no `.map` and no `.d.ts`.

## Directory structure

```text
search/
├── streamx-search-inline.js          # entry points
├── streamx-search-results-panel.js
├── streamx-search-tabs.js
├── <name>-<hash>.js                  # shared chunks, renamed on every build
├── streamx-search.css
├── README.md
└── eds/                              # EDS block decorators
    ├── search-results-panel.js
    ├── search-tab.js
    └── search-tabs.js
```

The hashed chunk files are referenced by the entry points, so they are replaced
as a set - copying only some of them leaves the entries pointing at files that
no longer exist.
