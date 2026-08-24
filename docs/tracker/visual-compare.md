# The visual / layout QA tier

Three tools and one shared library. They answer three different questions and it is
worth being precise about which, because using the wrong one on a translated page
produces a report that is 100% noise.

| tool | npm | question |
| --- | --- | --- |
| `visual-compare.mjs` | `npm run visual:compare` | *What do these two URLs look like, side by side, at three widths?* Produces evidence. Holds no opinion. |
| `visual-judge.mjs` | `npm run visual:judge` | *Does a vision model see LAYOUT DAMAGE in that evidence?* Emits a JSON verdict and a real exit code. |
| `tx-visual.mjs` | `npm run tx:visual` | *Is the TRANSLATED page WORSE than the English one?* Tier 3. Geometry first, vision only for the residue. |
| `check-deployed-modules.mjs` | `npm run verify:host` | *Does every browser module actually serve from the real delivery hosts?* |

`tools/tracker/lib/shots.mjs` holds what all three share: the width list, the settle
procedure, element capture, side-by-side composition, the pixel diff, and tiling.

## The widths: 2360, 1280, 390

- **390** is where text expansion breaks first and worst — the narrower the column, the
  sooner a longer string wraps or overflows — and it is the width most likely to be
  skipped in review. Below 768 the tools emulate a **phone**: mobile user agent, touch,
  `deviceScaleFactor: 2`, so a 390 capture is 780px wide.
- **1280** is the design target.
- **2360** catches the opposite failure: a component that centres or stretches wrongly
  when there is too much room, which a translation can trigger by changing a flex
  item's intrinsic width.

Widest first, so an interrupted run has already produced the desktop evidence a human
looks at.

## Pixels versus semantics

**A pixel diff is the right tool for a preview-versus-live pair of the same page and
the wrong tool for a translated pair.** On a translated pair every pixel containing
text differs *by design*, so the diff map is solid and the one real defect is invisible
inside it. That is why:

- `visual-compare` has `--no-diff`, and you should pass it whenever the two sides are in
  different languages;
- `visual-judge`'s prompt spends its first paragraph forbidding the model to report
  wording, colour, font and spacing differences;
- `tx-visual` does not take screenshots to compare at all. It measures **geometry** in
  the DOM — same components, same order, text fitting inside its box, nothing
  overflowing, siblings still lining up — and only asks the vision model about blocks
  geometry has already flagged.

The bar for a **FAIL** is: a block **missing**, **reordered**, **clipped**,
**overflowing**, **colliding**, or a row that no longer **aligns**. A reskin, a spacing
change or a font-antialiasing difference is a **PASS**.

## visual-compare

```bash
# preview vs live, the default question: did publishing change the page?
npm run visual:compare -- --path=/en/meetups/aem-meetup-munich

# English preview vs the German preview of the same page (pass --no-diff)
npm run visual:compare -- --path=/en/meetups/x --locale=de --no-diff

# two arbitrary sides, one selector
npm run visual:compare -- --a=/en/meetups/x --b=live:/en/meetups/x --selector=main

# an external reference
npm run visual:compare -- --a=/en/articles/x --b=https://example.com/reference
```

A **side spec** is one of: a full `https://` URL, `preview:<path>`, `live:<path>`,
`prod:<path>`, or a bare `<path>` (which means `preview:`). Every non-literal form is
built by `scripts/tracker/paths.js`, so **there are no hosts in this file** — the thing
the source got wrong, which told you to edit its source code to add a page.

### Adding a reusable pair

Do **not** edit the tool. Register it in `.tracker/orchestrator.json`:

```jsonc
"visual": {
  "widths": [2360, 1280, 390],
  "pairs": {
    "munich-live-drift": {
      "a": "preview:/en/meetups/aem-meetup-munich",
      "b": "live:/en/meetups/aem-meetup-munich",
      "selectors": ["main"]
    }
  }
}
```

then `npm run visual:compare -- --pair=munich-live-drift`. An unknown `--pair` refuses
the run and lists what is registered.

### Output

```
visual-compare-out/<page-slug>/
  manifest.json
  w2360/  a-0-main.png  b-0-main.png  side-0-main.png  diff-0-main.png
  w1280/  …
  w390/   …
```

`visual-compare-out/` is gitignored — it is scratch evidence, not committed state. The
directory is named after the page's locale-independent slug, so an EN-vs-de comparison
of one page lands in one directory; two genuinely different pages get both slugs.

`manifest.json` records every URL, width, selector, output file and diff ratio, and is
the input to `visual-judge --from=`.

### The two defects this fixes

The tool this is ported from documented both in its own README and shipped neither fix.

1. **`--mobile` never applied the 390px width it documented.** It set `isMobile: true`
   and left the viewport at `--width` (1280), so the "mobile" capture was a
   mobile-emulated page at a desktop width — a combination no real device produces, and
   the width where expansion breaks first was never actually photographed. Here widths
   are a **list** and phone emulation is **derived from the width**, so the two cannot
   disagree.
2. **`--out` was not width-namespaced.** Files were `local-<i>.png` / `live-<i>.png` /
   `compare-<i>.png`, with no width and no page in the name, so a second width — or a
   second page — silently overwrote the first and the survivors were
   indistinguishable. Output is now `<page>/w<width>/<side>-<i>-<selector>.png`.

## visual-judge

```bash
# judge a whole visual-compare run, one verdict per width
npm run visual:judge -- --from=visual-compare-out/<page>/manifest.json

# a single pair, or an already-composited side-by-side
npm run visual:judge -- --a=…/a-0-main.png --b=…/b-0-main.png --label-b=live
npm run visual:judge -- --compare=…/side-0-main.png --section=hero
```

Tall pages are cut into **tiles** with `sharp` (`--tile-height`, default 1200;
`--max-tiles`, default 4) and each tile is composited **per side at the same y** before
being sent, so the two halves of a tile are the same band of both pages. Every finding
names its tile. A run that hit `--max-tiles` says so — "only the top N px was examined"
— rather than implying the rest was clean.

The model is forced onto `VERDICT_SCHEMA`, and the exit code comes from the parsed
verdict:

| exit | meaning |
| --- | --- |
| 0 | pass — no layout damage in any tile |
| 1 | fail — `damaged: true`, or any `error` finding |
| 2 | **no verdict** — service down, unparseable answer after one retry, or the model hedged (warnings only). The page holds its status. |
| 3 | usage or configuration error |

**The tool this replaces always exited 0** on a successful model call, whatever the
model had said, so any gate shelling out to it passed unconditionally. That is worse
than having no gate, because it reads as evidence.

Cost, measured on this box against the 7B VL tier on CPU: **first sight of a 1600px
tile is minutes**; a re-ask of the same image is seconds, because the server caches the
image tokens. Budget accordingly, and prefer fewer, taller tiles to many small ones.

## tx-visual (tier 3)

```bash
npm run tx:visual -- --locale=de --path=/en/meetups/aem-meetup-munich
npm run tx:visual -- --locale=ja --path=/en/articles/x --vision
```

Checks, all phrased as *worse than English* so the tier does not re-report the site's
existing layout debt on ten locales:

| check | severity | what it means |
| --- | --- | --- |
| `page-overflow` | error | the page scrolls sideways and English does not |
| `clipped` | error | the box hides overflow and the content no longer fits — the text is **gone** and the page looks intact |
| `escaped` | error | the element's box now extends past its parent's |
| `rewrapped` | note / warning / error | more line boxes than English in a button or heading; **error** if it overflows a fixed height |
| `grew` | warning | taller than the locale's own text expansion explains |
| `sparse` | note | a contracting locale in a box that did not contract with it |
| `misaligned` | warning | a row equal in height in English no longer is |

**`expansion` from `scripts/tracker/locales.js` is load-bearing.** German at 1.3x means
growth up to 1.63x is *expected* and silent; the finding is when growth **clips** or
**overflows**. A button gaining a line is a note in an expanding locale and a
**warning** in a contracting one, because shorter text needing more lines usually means
an untranslated identifier or a string with no break opportunity. CJK at 0.5x leaving a
container looking empty is a **note**, never a failure.

It writes `tiers.visual` of `.tracker/reports/tx/<code>--<slug>.json` and leaves
`tiers.structural`, `tiers.judge` and the top-level `verdict` exactly as it found them —
merging the tiers is the driver's job.

**A page that is not there is exit 2, never exit 1.** Every locale tree on this site is
empty today, so the usual outcome is a page nobody has translated yet, and it prints
that in as many words: *"Nothing was compared at this width. This is NOT a pass."*

## verify:host

```bash
npm run verify:host                 # ref from config publish.branch
npm run verify:host -- --ref=HEAD   # this worktree's branch
npm run verify:host -- --all-hosts  # add preview.da.live
```

Fetches every module in `browserGraph()` from each delivery host and prints the two
diagnoses **separately**, because the fix is different and conflating them costs hours:

- **404 — the file is ABSENT** at this ref. Not pushed, not previewed, not published.
- **401 — the EXTENSION is not served.** The file may well be there; the host does not
  serve that extension and fell through to the authenticated content path. Rename it;
  publishing again will not help.

Measured on this site:

```
/scripts/sync-configs.mjs   aem.page 200   preview.da.live 401
/scripts/scripts.js         aem.page 200   preview.da.live 200
/scripts/scripts.mjs        aem.page 404   preview.da.live 401
```

The middle row is the trap: a real, deployed, correct `.mjs` answers **401**, so the
outage reads as an auth problem — and a `.mjs` that does not exist *also* answers 401,
so on that host the code cannot even tell you whether the file is there. A static
import that fails takes the whole module graph with it, so one bad extension means the
app does not boot at all.
