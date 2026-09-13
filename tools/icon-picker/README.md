# Icon Picker

A DA editor palette for inserting icons, plus the tooling that keeps the icon
library it reads from in step with git.

Ported from the `icon-manager` plugin in `rsm-it-cmg/rsm-da`. That one exists to
fan a single icon out to three sibling sites and is mostly machinery for keeping
them identical; aemdev has one site, so the fan-out, the site registry sheet and
the cross-site rollback are gone. What is left is the part authors touch — the
picking — with adding and removing kept behind a **Manage** toggle.

## The library is DA content, in two halves

| | where | what |
|---|---|---|
| artwork | `/icons/<key>.svg` | one SVG per icon |
| manifest | `/docs/library/icons.json` | `{ key, icon }` rows naming each file's insert key |

Both live on **this** site, so the palette renders every icon same-origin — no
cross-site fetch, so no CORS. The manifest's `icon` value is an absolute
`content.da.live` URL on purpose: the DA Library renders it as an `<img src>` from
the da.live origin, so a root-relative path would resolve against `da.live` and 404.

## Picking inserts `:key:`

Clicking an icon sends the EDS token `:key:` into the document, which publishes as
`<span class="icon icon-key">`. From there `scripts/utils/icons.js` swaps in

```html
<svg class="icon icon-key"><use href="{codeBase}/img/icons/key.svg#key"></use></svg>
```

— note **`img/icons/`, not the DA folder**. That is the part worth remembering:

> The DA `/icons/` folder feeds the **palette**. `img/icons/` in git feeds the
> **page**. An icon needs a copy in both, under the same key, or it can be
> inserted but renders as nothing.

`library/` here holds the DA copies; `img/icons/` holds the runtime copies of the
same set. The two differ only in their root attributes: the DA copies carry an
explicit `fill="#000000"`, the runtime copies carry `id="<key>"` (required by the
`#key` fragment reference) and `fill="currentColor"` so CSS can colour them.

## Files

| file | |
|---|---|
| `icon-picker.html` | palette entry point |
| `icon-picker.js` | the web component: grid, filter, pick, add, remove |
| `icon-store.js` | DA source I/O; add/delete with rollback |
| `icon-config.js` | paths, org/site from the DA SDK, key rules |
| `library/*.svg` | the DA copies, checked in so the library rebuilds from git |
| `seed-icons.mjs` | push `library/` into DA |
| `register-picker.mjs` | add the palette row to the DA site config |

## Setting it up

Order matters. DA loads the palette HTML from the **live origin**, so the code has
to be deployed before the palette row is registered — otherwise every author gets
an entry that 404s. `register-picker.mjs` checks for this and says so.

```bash
# 1. seed the library (idempotent; additive — it keeps manifest keys it does not define)
node tools/icon-picker/seed-icons.mjs              # dry run
node tools/icon-picker/seed-icons.mjs --apply --live

# 2. deploy the branch carrying tools/icon-picker/

# 3. register the palette
node tools/icon-picker/register-picker.mjs         # dry run; reports if the path is not live
node tools/icon-picker/register-picker.mjs --apply

# any time after
node tools/icon-picker/seed-icons.mjs --check      # does DA match library/?
node tools/icon-picker/register-picker.mjs --check # is the row there, and does its path resolve?
```

Both scripts take a token from the usual chain — `DA_TOKEN`, then the S2S cache,
then `~/today-da-token.txt` (see `tools/tracker/da-token.mjs`).

Both write the same way `register-app.mjs` does, and for the same reason: GET the
live document, change exactly one thing, PUT it back, then **re-read and diff** —
a config API has no preview step, so the read-back is the only evidence the write
was stored. `register-picker.mjs` additionally refuses to trust its own 200 by
diffing every sheet it did not mean to touch.

## Adding an icon later

Through the palette's **Manage** toggle is the quick path; it writes the SVG and
the manifest row together and rolls both back if either fails. That only updates
DA, though — for the icon to render on a page, add the matching
`img/icons/<key>.svg` (with `id="<key>"`) and, to keep git authoritative, drop the
black-filled copy into `library/` too.

## Where `experience: dialog` comes from

The DA site config has three sheets that register tools, and they are not
interchangeable:

- `apps` — full-screen, opened from `da.live/apps`
- `prepare` — preflight-style checks on a document
- `library` — palettes opened from inside the editor ← this one

`experience: 'dialog'` opens the palette as a modal rather than in the narrow side
rail, which is what a grid of icons needs.
