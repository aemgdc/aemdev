#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * check-browser-modules.mjs — every module a browser loads must be servable.
 *
 * DA serves a DA app from `<branch>--<site>--<org>.preview.da.live`, and that host does
 * NOT serve `.mjs`. An existing `.mjs` answers 401 there — the signature of an extension
 * that is not on the static allowlist falling through to the authenticated content path —
 * while `.js` answers 200 and a genuinely missing file answers 404. So the failure reads
 * as an auth problem, not a missing file, and you go looking in the wrong place.
 *
 * A static import that fails takes the whole module graph with it, so one `.mjs` in the
 * graph means the app does not boot AT ALL. Worse, it does not fail for everyone: DA
 * picks the host per session, so an authenticated user gets `preview.da.live` while
 * anyone else falls back to `aem.live`, where the same file answers 200. **Opening the
 * app yourself proves nothing about the session a colleague gets.**
 *
 * Nothing else catches it. Lint is happy, the tests are happy, there is no build step,
 * and a browser harness serving from disk serves `.mjs` quite cheerfully. That is why
 * this check lands FIRST in the build order rather than at the end.
 *
 * Three invariants, walked over the real import graph:
 *
 *   1. no browser-reachable module has a `.mjs` extension;
 *   2. every relative or root-absolute import resolves to a file that exists;
 *   3. nothing in `scripts/tracker/` imports anything outside `scripts/tracker/` — no
 *      `node:*`, no bare package name, no reaching up the tree. That directory is the
 *      shared model, loaded by both the browser and the Node pipeline (see its
 *      README.md), and a single `node:fs` in it breaks every browser consumer at once.
 *
 * (2) is not incidental. Renaming a set of shared modules once missed four
 * intra-directory imports written as `./x.mjs` rather than by their new name, and a
 * resolver check was the only thing that found them — eslint does not resolve relative
 * paths to disk here.
 *
 * Browser entry points are DISCOVERED, not listed, so a new app or block is covered the
 * day it is written: everything under `blocks/`, every `.html` with a module script
 * (`tools/page-tracker.html` and its siblings), plus any script importing the DA SDK.
 *
 *   node tools/tracker/check-browser-modules.mjs
 *
 * Exit: 0 clean, 1 violations found.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import {
  join, resolve, dirname, relative,
} from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { argv, exit } from 'node:process';

const REPO = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

/*
 * Directories the browser never loads from, or that are not this project's code.
 * `deps/` is vendored and already globally ignored by eslint; `test/` is served only by
 * web-test-runner, which resolves differently on purpose.
 */
const SKIP = new Set(['node_modules', 'coverage', '.git', '.agents', 'test', 'deps', '.tracker']);

/** The shared model directory, whose import rule is stricter than everything else's. */
const SHARED_MODEL = 'scripts/tracker';

/*
 * Matched as a real import statement or script src, not a bare substring: this file
 * names the SDK URL in a constant, and a substring test made the checker its own entry
 * point and then scanned its own regex literals as if they were import specifiers.
 */
const DA_SDK = 'https://da.live/nx/utils/sdk.js';
const DA_SDK_IMPORT = new RegExp(`from\\s+['"]${DA_SDK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`);

const rel = (f) => relative(REPO, f);
const isCode = (name) => /\.(js|mjs)$/.test(name);

/** Every .js/.mjs/.html file in the tree, skipping vendored and non-shipped directories. */
function allSources(dir = REPO, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!SKIP.has(e.name)) {
      const f = join(dir, e.name);
      if (e.isDirectory()) allSources(f, out);
      else if (isCode(e.name) || e.name.endsWith('.html')) out.push(f);
    }
  }
  return out;
}

/**
 * Drop comment-only lines and HTML comments before looking for imports.
 *
 * Line-level rather than a real tokenizer, deliberately: blanking comments properly
 * means tracking strings, template literals and regex literals, and getting THAT wrong
 * corrupts real code — this file's own `/\ssrc=["']…/` would derail a naive scanner.
 * Comment-only lines are where prose lives, and dropping them is unambiguous.
 *
 * It is not cosmetic. `stages.js` carries the comment `"a value we know but did not
 * expect here" from "a value nobody defined"`, and a specifier pattern that crosses
 * newlines read that as an import of a file called `a value nobody`. The scan reported
 * a violation in a file that has none, which is the worst kind of gate.
 */
function codeOf(file, src) {
  const noHtmlComments = file.endsWith('.html') ? src.replace(/<!--[\s\S]*?-->/g, '') : src;
  return noHtmlComments
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
    .join('\n');
}

/**
 * Import specifiers in one file.
 *
 * The specifier may contain neither whitespace nor a newline — a real one never does,
 * and that is what stops prose from being read as an import (see `codeOf`).
 *
 * For HTML that means `<script type="module" src="...">` plus any static or dynamic
 * import inside an inline module script — a DA app's entry point is an HTML file, so
 * skipping HTML would skip the first hop of every app graph.
 */
function specifiersOf(file, src) {
  const code = codeOf(file, src);
  const specs = [
    ...code.matchAll(/from\s+(['"])([^'"\s]+)\1/g),
    ...code.matchAll(/import\(\s*(['"])([^'"\s]+)\1\s*\)/g),
  ].map((m) => m[2]);
  if (file.endsWith('.html')) {
    const tags = [...code.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    for (const tag of tags) {
      const srcAttr = /\ssrc=["']([^"']+)["']/.exec(tag);
      if (srcAttr && /type=["']module["']/.test(tag)) specs.push(srcAttr[1]);
    }
  }
  return specs;
}

/**
 * Resolve one specifier to a repo file, or null when it is not a repo file at all.
 *
 * Root-absolute (`/tools/x/y.js`) is how every DA app HTML loads its entry script, and
 * how the EDS page shells load `/scripts/scripts.js`; relative is how modules import
 * each other. An `https:` specifier is the browser's problem, not a repo file.
 */
function resolveSpec(spec, fromFile) {
  if (spec.startsWith('.')) return resolve(dirname(fromFile), spec);
  if (spec.startsWith('/')) return join(REPO, spec);
  return null;
}

/**
 * Files a browser loads directly.
 *
 * `blocks/` is EDS's own contract — every block script is fetched by the browser. An
 * HTML file with a module script is a page or app shell. A DA app also announces itself
 * by importing the SDK, which is the one thing every app must do and no Node tool ever
 * does, so it beats maintaining a list of app directories by hand.
 */
function entryPoints(sources) {
  return sources.filter((f) => {
    const r = rel(f);
    if (r.startsWith('blocks/') && isCode(f)) return true;
    const code = codeOf(f, readFileSync(f, 'utf8'));
    if (f.endsWith('.html')) return /<script\b[^>]*type=["']module["']/.test(code);
    return DA_SDK_IMPORT.test(code);
  });
}

/**
 * Check the shared model's import rule over the directory itself, not over the graph.
 *
 * Deliberately not limited to browser-reachable files: the rule is a property of
 * `scripts/tracker/` as a whole, and a module that is not imported yet is exactly the
 * one that acquires a `node:fs` unnoticed and breaks the browser the day someone wires
 * it up.
 */
function sharedModelViolations(sources) {
  const dir = join(REPO, SHARED_MODEL);
  const out = [];
  for (const f of sources.filter((s) => isCode(s) && s.startsWith(`${dir}/`))) {
    for (const spec of specifiersOf(f, readFileSync(f, 'utf8'))) {
      const target = resolveSpec(spec, f);
      const outside = target ? !target.startsWith(`${dir}/`) : true;
      if (outside) out.push(`${rel(f)} → ${spec}`);
    }
  }
  return out;
}

/**
 * Walk the browser's real import graph.
 *
 * Exported because two checks need the same answer and must not drift: this file's
 * static extension rule, and check-deployed-modules.mjs, which fetches every module in
 * the graph from the live delivery hosts. A hand-maintained second list would go stale
 * the first time someone added an import.
 *
 * @returns {{ modules, entries, badExt, unresolved, sharedModel }}
 *   `modules` are repo-relative and web-servable (leading slash added by the caller);
 *   `badExt` and `unresolved` carry the full import chain from the entry point, because
 *   "b.mjs is bad" is not actionable until you know which app pulls it in.
 */
export function browserGraph() {
  const sources = allSources();
  const seen = new Set();
  const via = new Map();
  const badExt = [];
  const unresolved = [];

  /** entry → … → file, as one printable line. */
  const chainOf = (file) => {
    const parts = [];
    for (let cur = file; cur; cur = via.get(cur)) parts.unshift(rel(cur));
    return parts.join(' → ');
  };

  /** Follow every repo-resolvable import from `file`, depth-first. */
  function visit(file) {
    if (!seen.has(file)) {
      seen.add(file);
      let src;
      try {
        src = readFileSync(file, 'utf8');
      } catch {
        return;
      }
      for (const spec of specifiersOf(file, src)) {
        const target = resolveSpec(spec, file);
        if (target && !via.has(target)) via.set(target, file);
        if (target && !existsSync(target)) {
          unresolved.push(`${chainOf(file)} → ${spec}   (no such file)`);
        } else if (target) {
          if (target.endsWith('.mjs')) badExt.push(chainOf(target));
          visit(target);
        }
      }
    }
  }

  const entries = entryPoints(sources);
  for (const e of entries) visit(e);
  return {
    modules: [...seen].filter(isCode).map(rel),
    entries: entries.map(rel),
    badExt: [...new Set(badExt)],
    unresolved: [...new Set(unresolved)],
    sharedModel: sharedModelViolations(sources),
  };
}

/*
 * Only run the check when invoked directly.
 *
 * check-deployed-modules.mjs imports browserGraph(), and without this guard that import
 * would run this whole check as a side effect — printing twice and, worse, calling
 * exit(1) on a violation before the importer had done anything. A module that exits on
 * import is not importable.
 */
const invokedDirectly = argv[1] && import.meta.url === pathToFileURL(argv[1]).href;
if (invokedDirectly) {
  const {
    modules, entries, badExt, unresolved, sharedModel,
  } = browserGraph();
  console.log(`Walked ${modules.length} module(s) from ${entries.length} browser entry point(s).`);

  if (unresolved.length) {
    console.error(`\n✗ ${unresolved.length} import(s) do not resolve to a file:`);
    for (const u of unresolved) console.error(`    ${u}`);
  }
  if (badExt.length) {
    console.error(`\n✗ ${badExt.length} browser-reachable module(s) use .mjs, which preview.da.live will not serve:`);
    for (const b of badExt) console.error(`    ${b}`);
    console.error('\n  Rename the module to .js and update its importers. `"type": "module"` in');
    console.error('  package.json means .js is still ESM under Node, so CLI tools keep working.');
  }
  if (sharedModel.length) {
    console.error(`\n✗ ${sharedModel.length} import(s) in ${SHARED_MODEL}/ reach outside it:`);
    for (const s of sharedModel) console.error(`    ${s}`);
    console.error(`\n  ${SHARED_MODEL}/ runs in the browser AND in Node: zero dependencies, no node:*,`);
    console.error('  no bare packages, no DOM globals. A function that needs a Document takes one');
    console.error(`  from its caller. See ${SHARED_MODEL}/README.md.`);
  }
  if (unresolved.length || badExt.length || sharedModel.length) exit(1);
  console.log(`✓ every browser-reachable module is .js, every import resolves, and ${SHARED_MODEL}/ is self-contained.`);
}
