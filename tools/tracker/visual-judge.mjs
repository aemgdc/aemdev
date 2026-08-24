#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * visual-judge.mjs — ask the vision model whether the layout is DAMAGED.
 *
 * CLI SURFACE
 *   node tools/tracker/visual-judge.mjs (--from=<manifest.json|dir>
 *        | --compare=<png> | --a=<png> --b=<png>)
 *        [--label-a=<text>] [--label-b=<text>] [--section=<name>]
 *        [--brief=<path>] [--tile-height=<px>] [--tile-width=<px>]
 *        [--max-tiles=<n>] [--out=<json>] [--endpoint=<url>]
 *        [--json] [--quiet] [--dry-run] [--help]
 *
 *   npm run visual:judge -- --from=visual-compare-out/<page>/manifest.json
 *   npm run visual:judge -- --a=…/a-0-main.png --b=…/b-0-main.png --label-b=live
 *   npm run visual:judge -- --compare=…/side-0-main.png --section="hero"
 *
 * ─── THE BAR IS SEMANTIC LAYOUT DRIFT, NOT PIXELS ───────────────────────────
 *
 * FAIL: a block MISSING, REORDERED, CLIPPED, OVERFLOWING, colliding with another
 *       element, or a row of things that lined up no longer lining up.
 * PASS: a reskin, different colours, different spacing, different fonts, different
 *       antialiasing — and DIFFERENT TEXT.
 *
 * This is not a stylistic preference, it is the only bar that can be applied to a
 * translated page. A pixel-diff gate on a translated page fails every page, because
 * the text is different by design: a German page that renders perfectly differs from
 * its English original in essentially every glyph, so the report is a wall of
 * differences with the one that matters invisible inside it. That is the entire reason
 * this tier is a vision model and not a pixel diff, and the reason the prompt below
 * spends its first paragraph forbidding the model to report wording.
 *
 * ─── The source's exit codes were fiction ───────────────────────────────────
 *
 * The file this replaces documented "Exit: 0 pass, 1 fail, 2 escalate, 3 error" and
 * then printed the model's prose and returned — so `main()` resolved and node exited 0
 * on every successful model call, whatever the model had said. Any gate shelling out
 * to it passed unconditionally, which is worse than having no gate: it reads as
 * evidence. The rewrite asks for JSON against a schema (`VERDICT_SCHEMA`, forced by
 * lib/llm.mjs) and derives the exit code from the parsed verdict.
 *
 * ─── Why a bad answer is exit 2 and not exit 3 ──────────────────────────────
 *
 * data-contract.md §5 defines exit 3 as "usage or configuration error. Nothing ran."
 * A model that ran and returned unparseable output does not fit that: something ran,
 * and the page must hold its status while the batch continues. §5 says so directly —
 * "a bad model answer maps to 1 or an escalation" — so unparseable output and a hedged
 * verdict both land on 2, alongside `LlmUnavailable`. Exit 3 is reserved for a missing
 * image, a bad flag, or a misconfigured tier.
 *
 * EXIT CODES  0 pass — the model saw no layout damage ·
 *             1 fail — damage found (an `error` finding, or `damaged: true`) ·
 *             2 no verdict — service down, unparseable answer, or the model hedged
 *               (warnings only). The page holds its status. ·
 *             3 usage/config error — nothing was judged.
 */
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  existsSync, mkdirSync, readFileSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig } from './config.mjs';
import { LlmUnavailable, callVision, probe } from './lib/llm.mjs';
import { verdictExit } from './lib/exit.mjs';
import { tileImage, tilePair } from './lib/shots.mjs';

/**
 * The verdict shape the model is forced into.
 *
 * Deliberately small. This runs against a 7B VL model on CPU: every extra required
 * field is another chance for it to spend its token budget on bookkeeping instead of
 * looking at the picture, and a schema it cannot satisfy is a run that produces
 * nothing. `kind` is an enum rather than free text so findings from different pages can
 * be counted together.
 */
export const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    damaged: { type: 'boolean' },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['error', 'warning', 'note'] },
          kind: {
            type: 'string',
            enum: ['missing', 'reordered', 'clipped', 'overflow', 'collision', 'misaligned', 'other'],
          },
          detail: { type: 'string' },
          side: { type: 'string', enum: ['left', 'right', 'both'] },
        },
        required: ['severity', 'kind', 'detail', 'side'],
        additionalProperties: false,
      },
    },
  },
  required: ['damaged', 'summary', 'findings'],
  additionalProperties: false,
};

/**
 * The instruction, and every sentence in it is load-bearing.
 *
 * The four "do not report" lines are not politeness. Without them a VL model asked to
 * compare two screenshots returns a list of colour and wording differences and never
 * mentions the truncated button, because listing differences is an easier task than
 * judging damage and the model will take the easier task every time. The source's
 * prompt asked "list every visual difference you can see", which on a translated pair
 * is a question whose correct answer is "all of the words".
 *
 * `left`/`right` rather than two separate images: measured against this exact tier, the
 * 7B VL model conflates two images in one message — asked for the word in each of two
 * near-identical crops it answered with the first one twice (see lib/llm.mjs). One
 * composited image described as left/right is the reliable form.
 */
export function buildPrompt({
  labelA, labelB, section, brief, tile, translated,
}) {
  return [
    'You are checking a web page for LAYOUT DAMAGE in a side-by-side screenshot.',
    `LEFT = ${labelA}. RIGHT = ${labelB}.`,
    section ? `Section: ${section}` : null,
    tile ? `This image is ${tile}. Findings must be about what is visible in THIS band.` : null,
    '',
    'DO NOT REPORT any of the following. They are expected and are not damage:',
    '  - different words, different language, different spelling, different text length',
    translated
      ? '  - the right side being longer or shorter than the left: translated text legitimately expands or contracts'
      : '  - minor text or content differences',
    '  - different colours, fonts, font weights, spacing, borders, shadows or antialiasing',
    '  - different images or photographs, as long as an image is present in both',
    '',
    'REPORT ONLY structural damage on the RIGHT side that is not present on the left:',
    '  missing    — a block, heading, image, button or section present on the left is absent on the right',
    '  reordered  — blocks appear in a different order',
    '  clipped    — text or an image is cut off mid-word or mid-shape by its container',
    '  overflow   — content spills outside its box, card, button or coloured background,',
    '               or past the edge of the page',
    '  collision  — text overlapping other text, or text running underneath an image',
    '  misaligned — items that line up in a row on the left (cards, columns, icons and',
    '               their labels) no longer line up on the right',
    '',
    brief ? `\nApproved changes for this page — do NOT flag these:\n${brief}\n` : null,
    'If the right side is intact — everything present, in order, inside its box — set',
    'damaged to false, return an EMPTY findings array, and say so in one sentence.',
    'Use severity "error" only for damage you can actually see in this image. Use',
    '"warning" when you suspect it but cannot be sure, and "note" for an observation',
    'that is not damage.',
  ].filter((l) => l !== null).join('\n');
}

/**
 * The approved-changes rows of a requirements brief.
 *
 * Only `✓` and `~` rows are shown. The parser is brittle by inheritance — it matches a
 * cell that is EXACTLY one of those glyphs, so `✓ (see note)` will not match — and that
 * brittleness is documented in data-contract.md §6 rather than papered over here,
 * because a brief author needs to know the rule, not have it silently widened.
 */
export function loadBrief(briefPath) {
  if (!briefPath) return null;
  if (!existsSync(briefPath)) throw new Error(`brief not found: ${briefPath}`);
  const rows = readFileSync(briefPath, 'utf8').split('\n').filter((l) => {
    if (!l.startsWith('|')) return false;
    return l.split('|').map((c) => c.trim()).some((c) => c === '✓' || c === '~');
  });
  return rows.length ? rows.join('\n') : null;
}

/** Fold per-tile verdicts into one. */
export function mergeVerdicts(tiles) {
  const findings = tiles.flatMap((t) => (t.verdict?.findings || []).map((f) => ({
    ...f, tile: t.label, image: t.file,
  })));
  const unresolved = tiles.filter((t) => !t.verdict);
  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warning');
  const damaged = tiles.some((t) => t.verdict?.damaged) || errors.length > 0;

  let verdict = 'pass';
  let why = 'no layout damage reported in any tile';
  if (damaged) {
    verdict = 'fail';
    why = `${errors.length || 'unspecified'} layout defect(s) reported`;
  } else if (unresolved.length) {
    verdict = 'escalate';
    why = `${unresolved.length} of ${tiles.length} tile(s) produced no usable verdict`;
  } else if (warnings.length) {
    /*
     * Warnings are an escalation, not a pass. The model hedges when the picture is
     * ambiguous, and recording a hedge as a pass is how a real defect ends up marked
     * "checked". Exit 2 holds the page's status and puts it in front of a human.
     */
    verdict = 'escalate';
    why = `${warnings.length} finding(s) the model was not sure about`;
  }
  return {
    verdict,
    why,
    damaged,
    findings,
    unresolved: unresolved.map((t) => ({ tile: t.label, reason: t.error })),
    summaries: tiles.map((t) => ({ tile: t.label, summary: t.verdict?.summary || null })),
  };
}

const HELP = `visual-judge — does the vision model see LAYOUT DAMAGE?

  --from=<path>       a visual-compare manifest.json (or its directory): judge every
                      side-by-side it produced, one verdict per width
  --a=<png> --b=<png> a raw pair; tiled per side and composited per tile
  --compare=<png>     an already-composited side-by-side; tiled vertically
  --label-a=<text>    left-hand label used in the prompt (default: English)
  --label-b=<text>    right-hand label (default: the manifest's B label, or "candidate")
  --section=<name>    what part of the page this is, for the prompt
  --brief=<path>      a requirements brief; its ✓ and ~ rows become approved changes
  --tile-height=<px>  band height before scaling (default 1200)
  --tile-width=<px>   width of the composited tile handed to the model (default 1600)
  --max-tiles=<n>     cap on tiles per pair (default 4)
  --endpoint=<url>    override the vision tier endpoint
  --out=<json>        write the verdict JSON here as well as printing it
  --dry-run           build and print the tiles and the prompt, call no model
  --json              print only the verdict JSON
  --quiet             suppress the human-readable summary
  --help              this text

exit 0 pass · 1 layout damage · 2 no verdict (service down / unparseable / hedged) · 3 usage`;

function parseArgs(args) {
  const o = {
    from: null,
    a: null,
    b: null,
    compare: null,
    labelA: null,
    labelB: null,
    section: null,
    brief: null,
    tileHeight: 1200,
    tileWidth: 1600,
    maxTiles: 4,
    endpoint: null,
    out: null,
    dryRun: false,
    json: false,
    quiet: false,
    help: false,
  };
  for (const x of args) {
    if (x === '--help' || x === '-h') o.help = true;
    else if (x === '--dry-run') o.dryRun = true;
    else if (x === '--json') o.json = true;
    else if (x === '--quiet') o.quiet = true;
    else if (x.startsWith('--from=')) o.from = x.slice(7);
    else if (x.startsWith('--a=')) o.a = x.slice(4);
    else if (x.startsWith('--b=')) o.b = x.slice(4);
    else if (x.startsWith('--compare=')) o.compare = x.slice(10);
    else if (x.startsWith('--label-a=')) o.labelA = x.slice(10);
    else if (x.startsWith('--label-b=')) o.labelB = x.slice(10);
    else if (x.startsWith('--section=')) o.section = x.slice(10);
    else if (x.startsWith('--brief=')) o.brief = x.slice(8);
    else if (x.startsWith('--tile-height=')) o.tileHeight = Number(x.slice(14));
    else if (x.startsWith('--tile-width=')) o.tileWidth = Number(x.slice(13));
    else if (x.startsWith('--max-tiles=')) o.maxTiles = Number(x.slice(12));
    else if (x.startsWith('--endpoint=')) o.endpoint = x.slice(11);
    else if (x.startsWith('--out=')) o.out = x.slice(6);
    else throw new Error(`unknown arg: ${x}`);
  }
  if (o.help) return o;
  const modes = [o.from, o.compare, o.a && o.b].filter(Boolean).length;
  if (modes !== 1) {
    throw new Error('pass exactly one of --from=<manifest>, --compare=<png>, or --a=<png> --b=<png>');
  }
  return o;
}

/** The pairs a run is going to judge, from whichever input mode was given. */
function jobsFrom(o) {
  if (o.from) {
    const file = statSync(o.from).isDirectory() ? join(o.from, 'manifest.json') : o.from;
    const m = JSON.parse(readFileSync(file, 'utf8'));
    const jobs = m.shots.filter((s) => s.a && s.b).map((s) => ({
      name: `w${s.width} ${s.selector}`,
      a: s.a,
      b: s.b,
      dir: dirname(s.a),
      labelA: o.labelA || m.a?.label || 'reference',
      labelB: o.labelB || m.b?.label || 'candidate',
      section: o.section || s.selector,
    }));
    if (!jobs.length) throw new Error(`${file} lists no complete pairs to judge`);
    return { jobs, manifest: m, manifestFile: file };
  }
  if (o.compare) {
    return {
      jobs: [{
        name: 'composite',
        composite: o.compare,
        dir: dirname(o.compare),
        labelA: o.labelA || 'reference',
        labelB: o.labelB || 'candidate',
        section: o.section,
      }],
    };
  }
  return {
    jobs: [{
      name: 'pair',
      a: o.a,
      b: o.b,
      dir: dirname(o.a),
      labelA: o.labelA || 'reference',
      labelB: o.labelB || 'candidate',
      section: o.section,
    }],
  };
}

/**
 * Ask about one tile, retrying once on a malformed answer.
 *
 * `callVision` has no retry of its own — `llmJson` retries once on bad JSON and the
 * vision path does not — and the 7B VL tier does occasionally emit a JSON string with a
 * raw control character in it despite the forced grammar. Measured on this box: an
 * identical prompt parsed cleanly on the next attempt, and the retry is nearly free
 * because the image tokens are already in the server's prompt cache (first sight of a
 * 1600px tile costs minutes, a re-ask costs seconds). One retry, not a loop: a model
 * that cannot answer twice is an escalation, not something to grind on.
 */
async function askTile(tier, tile, prompt) {
  let last = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const text = attempt === 0
        ? prompt
        : `${prompt}\n\nReturn ONLY valid JSON matching the schema. No newlines inside string values.`;
      const verdict = await callVision(tier, tile.file, text, { schema: VERDICT_SCHEMA });
      return { label: tile.caption, file: tile.file, verdict };
    } catch (e) {
      // A down service is not worth a second attempt; a bad answer is.
      if (e instanceof LlmUnavailable) {
        return {
          label: tile.caption,
          file: tile.file,
          verdict: null,
          error: `vision tier unavailable: ${e.message}`,
        };
      }
      last = e;
    }
  }
  // Both outcomes are exit-2 territory; the distinction is kept in the report so "the
  // box was off" and "the model babbled twice" are not one line in a log.
  return {
    label: tile.caption, file: tile.file, verdict: null, error: `${last.message} (2 attempts)`,
  };
}

/**
 * Judge one pair: tile it, ask per tile, report which tile each finding came from.
 *
 * Per tile rather than per page because a finding a reviewer cannot locate is a finding
 * they cannot act on — "something is clipped somewhere on this 9000px page" costs more
 * time than it saves.
 */
async function judgePair(tier, job, o, brief) {
  const tiling = job.composite
    ? await tileImage(job.composite, join(job.dir, 'tiles'), {
      prefix: 'j', tileHeight: o.tileHeight, maxTiles: o.maxTiles, tileWidth: o.tileWidth,
    })
    : await tilePair(job.a, job.b, join(job.dir, 'tiles'), {
      prefix: `j-${job.name.replace(/[^a-z0-9]+/gi, '-')}`,
      tileHeight: o.tileHeight,
      maxTiles: o.maxTiles,
      tileWidth: o.tileWidth,
      labelA: job.labelA,
      labelB: job.labelB,
    });

  const results = [];
  for (const tile of tiling.tiles) {
    const prompt = buildPrompt({
      labelA: job.labelA,
      labelB: job.labelB,
      section: job.section,
      brief,
      tile: tile.caption,
      translated: Boolean(job.translated),
    });
    if (o.dryRun) {
      results.push({ label: tile.caption, file: tile.file, verdict: null, error: 'dry run' });
    } else {
      results.push(await askTile(tier, tile, prompt));
    }
  }
  return { tiling, tiles: results, merged: mergeVerdicts(results) };
}

async function main() {
  const o = parseArgs(argv.slice(2));
  if (o.help) {
    console.log(HELP);
    return 0;
  }
  const cfg = loadConfig();
  const tier = { ...cfg.llm.vision, ...(o.endpoint ? { endpoint: o.endpoint } : {}) };
  const brief = loadBrief(o.brief);
  const { jobs, manifestFile } = jobsFrom(o);

  for (const j of [...(jobs)]) {
    for (const f of [j.a, j.b, j.composite].filter(Boolean)) {
      if (!existsSync(f)) throw new Error(`image not found: ${f}`);
    }
  }

  if (!o.dryRun) {
    const p = await probe(tier);
    if (!p.ok) {
      console.error(`✗ vision tier not reachable (${p.detail})`);
      console.error(`  expected an OpenAI-compatible server at ${tier.endpoint} serving ${tier.model}.`);
      console.error('  point elsewhere with --endpoint=, AEMDEV_QA_VISION_ENDPOINT, or a');
      console.error('  .tracker/hosts/<hostname>.json profile.');
      // Exit 2, not 3: the tool is configured correctly and the service is down. The
      // page holds its status and the batch continues.
      return 2;
    }
  }

  const report = {
    tool: 'visual-judge',
    generated: new Date().toISOString(),
    model: tier.model,
    endpoint: tier.endpoint,
    bar: 'semantic layout drift (missing/reordered/clipped/overflow/collision/misaligned) — NOT pixels, colours, fonts or wording',
    brief: o.brief || null,
    source: manifestFile || null,
    pairs: [],
  };

  for (const job of jobs) {
    if (!o.quiet) console.log(`\n── ${job.name}  (${job.labelA} vs ${job.labelB})`);
    const res = await judgePair(tier, job, o, brief);
    if (!o.quiet) {
      for (const t of res.tiling.tiles) console.log(`   tile ${t.file}`);
      if (res.tiling.truncated) {
        console.log(`   ⚠ only the top ${res.tiling.scannedPx}px of ${res.tiling.pagePx}px was examined `
          + `(--max-tiles=${o.maxTiles}); the rest was NOT looked at.`);
      }
      console.log(`   ${res.merged.verdict.toUpperCase()} — ${res.merged.why}`);
      for (const f of res.merged.findings) {
        console.log(`     [${f.severity}] ${f.kind} (${f.side}, ${f.tile}): ${f.detail}`);
      }
      for (const u of res.merged.unresolved) console.log(`     ? ${u.tile}: ${u.reason}`);
    }
    report.pairs.push({
      name: job.name,
      a: job.a || null,
      b: job.b || null,
      composite: job.composite || null,
      labels: { a: job.labelA, b: job.labelB },
      tiles: res.tiling.tiles.map((t) => ({ caption: t.caption, file: t.file })),
      truncated: res.tiling.truncated,
      examinedPx: res.tiling.scannedPx,
      pagePx: res.tiling.pagePx,
      ...res.merged,
    });
  }

  /*
   * The run's verdict is the WORST pair's, ordered fail > escalate > pass. A page that
   * is intact at 1280 and broken at 390 is a broken page — averaging the widths would
   * pass exactly the mobile-only breakage this tool exists to find.
   */
  const order = { fail: 2, escalate: 1, pass: 0 };
  const worst = report.pairs.reduce(
    (acc, p) => (order[p.verdict] > order[acc] ? p.verdict : acc),
    'pass',
  );
  report.verdict = o.dryRun ? 'escalate' : worst;

  if (o.out) {
    mkdirSync(dirname(o.out), { recursive: true });
    writeFileSync(o.out, JSON.stringify(report, null, 2));
    if (!o.quiet) console.log(`\nverdict JSON: ${o.out}`);
  }
  if (o.json || o.quiet) console.log(JSON.stringify(report, null, 2));
  if (o.dryRun) {
    console.error('\nDRY RUN — tiles were built, no model was called; verdict forced to escalate.');
    return verdictExit('escalate');
  }
  if (!o.quiet) console.log(`\nVISUAL: ${report.verdict.toUpperCase()}`);
  return verdictExit(report.verdict);
}

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main()
    .then((code) => exit(code))
    .catch((e) => {
      console.error(`ERROR: ${e.message}`);
      exit(e instanceof LlmUnavailable ? 2 : 3);
    });
}
