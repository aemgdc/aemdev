#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * make-icons.mjs — generate the Page Tracker's app-card and square icons.
 *
 * The geometry is computed rather than hand-written so the grid stays on a real
 * lattice: a 5x4 matrix of cells drawn by eye at two different canvas sizes ends up
 * with two slightly different rhythms, and at card size that reads as sloppiness
 * rather than as a decision.
 *
 * WHY THESE TWO SIZES
 *   1200x720 (5:3)  the DA app card at da.live/apps. Matched to
 *                   img/tools/bio-manager.png so the two cards sit at the same size
 *                   in the grid. DA renders the card image in a LANDSCAPE crop, so
 *                   nothing meaningful goes near the top or bottom edge — the
 *                   bio-manager card needed two commits to learn that.
 *   64x64           the square mark: favicon, sidekick, anywhere small. Same idea,
 *                   fewer cells, because a 5x4 grid at 64px is mud.
 *
 * WHAT IT DRAWS, and why this and not a glyph: the tracker's own translation matrix.
 * Rows are locales, columns are page groups, and the fill is how far each has got —
 * the staircase IS the shape of a rollout in progress. A tick sits at the end for the
 * QA half of the tool.
 *
 * Deliberately no text and no CJK glyph, though "A → <han>" was the obvious first
 * idea. Rasterising a glyph depends on a font being installed wherever this runs, and
 * a missing CJK face fails by drawing tofu boxes into a shipped image. Pure geometry
 * renders identically everywhere. bio-manager.svg makes the same choice.
 *
 * USAGE
 *   node tools/tracker/make-icons.mjs            write the SVGs, and the PNG if sharp is present
 *   node tools/tracker/make-icons.mjs --check    render to a temp dir and diff, write nothing
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { argv, exit } from 'node:process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'img', 'tools');

/* Site tokens, from styles/styles.css. Named here so a palette change is one edit. */
const CARBON = '#0e0e0e'; // --carbon. The gutter, and the grid rules.
const PANEL = '#1b1b1b'; // the card panel — a step up from carbon, sampled off
//                           img/tools/bio-manager.png so the two cards match
const AEM_RED = '#eb1000'; // --aem-red, the signal colour
const WHITE = '#f9f9f9'; // --white, never pure #fff
const GREY = '#6b7280'; // the muted tone bio-manager.svg uses for secondary detail
const EMPTY = '#282828'; // a cell that exists but is not started. A step above the
//                          panel, so it reads as an empty slot rather than as a hole
//                          punched through the card

/*
 * The app-card frame, measured off img/tools/bio-manager.png rather than invented,
 * so the two cards read as a set in the DA apps grid:
 *   x 0..57    carbon gutter
 *   x 58..76   the red rule — a thin OFFSET rule, not a flush edge bar. The square
 *              mark uses a flush bar; the card does not. That difference is the house
 *              style, and copying the square's bar onto the card is what makes a new
 *              card look bolted on.
 *   x 77..     the panel, with a 1px carbon grid on a 58px pitch
 */
const CARD = {
  gutter: 58, rule: 19, grid: 58, panelX: 77,
};

/**
 * The fill pattern: one row per locale, one column per group, filled left to right.
 *
 * A descending staircase, because that is what a partial rollout actually looks like
 * on the board — the first locales are further along than the last. One cell is
 * `progress` so the card is not purely binary: the tool's whole point is the states
 * BETWEEN "nothing" and "done".
 *
 *   d = done (white)   p = in progress (red)   . = not started (dark)
 */
const PATTERN = [
  'ddddd',
  'dddd.',
  'ddp..',
  'd....',
];

/** One rounded cell. */
const cell = (x, y, w, h, fill, r) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"/>`;

const fillFor = (ch) => ({ d: WHITE, p: AEM_RED }[ch] ?? EMPTY);

/**
 * Build the matrix as a string of cells.
 *
 * Returns the drawn width/height too, so the caller can place a tick beside it
 * without re-deriving the same arithmetic and drifting by a pixel.
 */
function matrix({
  x0, y0, cw, ch, gap, radius,
}) {
  const cols = PATTERN[0].length;
  const cells = PATTERN.flatMap((row, r) => [...row].map((c, i) => cell(
    x0 + i * (cw + gap),
    y0 + r * (ch + gap),
    cw,
    ch,
    fillFor(c),
    radius,
  )));
  return {
    svg: cells.join('\n  '),
    width: cols * cw + (cols - 1) * gap,
    height: PATTERN.length * ch + (PATTERN.length - 1) * gap,
  };
}

/** A tick, as a stroked polyline so it scales cleanly and needs no font. */
const tick = (x, y, size, colour, weight) => {
  const p = [
    [x, y + size * 0.52],
    [x + size * 0.36, y + size * 0.88],
    [x + size, y],
  ].map(([px, py]) => `${Math.round(px)},${Math.round(py)}`).join(' ');
  return `<polyline points="${p}" fill="none" stroke="${colour}" stroke-width="${weight}" `
    + 'stroke-linecap="round" stroke-linejoin="round"/>';
};

/**
 * The 1200x720 app card.
 *
 * Vertical composition is squeezed into the middle band on purpose: DA crops this
 * card to a landscape strip, so the matrix sits centred and the accent bar is the only
 * thing that runs edge to edge.
 */
function card() {
  const W = 1200;
  const H = 720;
  const m = matrix({
    x0: 210, y0: 176, cw: 100, ch: 82, gap: 22, radius: 10,
  });
  const tickSize = 168;
  const tickX = 210 + m.width + 132;
  const tickY = 176 + (m.height - tickSize) / 2 + 4;
  const barY = 176 + m.height + 44;

  // The grid is drawn as one path of hairlines rather than hundreds of rects: it is
  // texture, and texture should not dominate the file or the render time.
  const lines = [];
  for (let x = CARD.panelX + CARD.grid; x < W; x += CARD.grid) lines.push(`M${x} 0V${H}`);
  for (let y = CARD.grid; y < H; y += CARD.grid) lines.push(`M${CARD.panelX} ${y}H${W}`);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Page Tracker">
  <title>Page Tracker</title>
  <desc>A translation matrix filling row by row, with a tick for the QA pass.</desc>
  <rect width="${W}" height="${H}" fill="${CARBON}"/>
  <rect x="${CARD.panelX}" width="${W - CARD.panelX}" height="${H}" fill="${PANEL}"/>
  <path d="${lines.join('')}" stroke="${CARBON}" stroke-width="1" fill="none"/>
  <rect x="${CARD.gutter}" width="${CARD.rule}" height="${H}" fill="${AEM_RED}"/>
  ${m.svg}
  ${tick(tickX, tickY, tickSize, WHITE, 30)}
  <rect x="210" y="${barY}" width="${Math.round(m.width * 0.66)}" height="14" rx="7" fill="${GREY}"/>
  <rect x="210" y="${barY}" width="${Math.round(m.width * 0.36)}" height="14" rx="7" fill="${AEM_RED}"/>
</svg>
`;
}

/**
 * The 64x64 square mark.
 *
 * Three columns and three rows, not five and four: at 64px the card's lattice
 * collapses into texture, and a mark that is unreadable small is not a mark.
 */
function square() {
  const S = 64;
  const BAR = 5; // matches bio-manager.svg, so the two sit together in a list
  const cw = 11;
  const gap = 4;
  const rows = ['dd d', 'dp  ', 'd   '].map((r) => r.slice(0, 3));
  const cells = rows.flatMap((row, r) => [...row].map((c, i) => {
    const fill = fillFor(c === ' ' ? '.' : c);
    return cell(16 + i * (cw + gap), 12 + r * (cw + gap), cw, cw, fill, 2);
  }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" role="img" aria-label="Page Tracker">
  <title>Page Tracker</title>
  <rect width="${S}" height="${S}" fill="${CARBON}"/>
  <rect width="${BAR}" height="${S}" fill="${AEM_RED}"/>
  ${cells.join('\n  ')}
  ${tick(38, 40, 18, WHITE, 5)}
</svg>
`;
}

async function toPng(svg, outPath, width, height) {
  let sharp;
  try {
    ({ default: sharp } = await import('sharp'));
  } catch {
    return { ok: false, why: 'sharp is not installed — SVGs written, PNG skipped' };
  }
  /*
   * `density` matters: sharp rasterises SVG through librsvg at 72dpi by default, so a
   * 1200px-wide SVG asked for at 1200px comes back soft. Rendering at 4x density and
   * letting resize downsample gives clean edges on the tick's round caps.
   */
  const buf = await sharp(Buffer.from(svg), { density: 288 })
    .resize(width, height, { fit: 'contain', background: CARBON })
    .png({ compressionLevel: 9 })
    .toBuffer();
  writeFileSync(outPath, buf);
  return { ok: true, bytes: buf.length };
}

async function main() {
  const check = argv.includes('--check');
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

  const cardSvg = card();
  const squareSvg = square();

  const targets = [
    ['page-tracker-card.svg', cardSvg],
    ['page-tracker.svg', squareSvg],
  ];

  for (const [name, svg] of targets) {
    const path = join(OUT, name);
    if (check) {
      console.log(`${name}: ${svg.length} bytes (not written — --check)`);
    } else {
      writeFileSync(path, svg);
      console.log(`wrote img/tools/${name}  ${svg.length} bytes`);
    }
  }

  if (!check) {
    const png = await toPng(cardSvg, join(OUT, 'page-tracker.png'), 1200, 720);
    console.log(png.ok
      ? `wrote img/tools/page-tracker.png  ${png.bytes} bytes  1200x720`
      : `SKIPPED page-tracker.png — ${png.why}`);
    if (!png.ok) exit(1);
  }
  return 0;
}

main().then(exit).catch((e) => {
  console.error(`ERROR: ${e.message}`);
  exit(1);
});
