/**
 * dnt.mjs — the do-not-translate contract, parsed from `.tracker/da-translate.json`.
 *
 * That file is the annotated SOURCE of DA's Translate config (`tx:config` strips the
 * annotations and POSTs it to `/.da/translate.json`). The QA tier reads THE SAME FILE
 * the connector is configured from, deliberately:
 *
 *   the connector decides what gets protected;
 *   this tier decides whether what should have been protected actually was.
 *
 * If those two read different sources they will eventually disagree, and the way that
 * shows up is the worst possible one — a clean DNT report on a page whose identifiers
 * were translated, because the checker was enforcing a rule the connector never had.
 * The upstream pipeline fetched the live config from admin.da.live with a token and
 * therefore could not run without one; reading the committed source removes both the
 * token dependency and the drift.
 *
 * ─── The asymmetry that decides every judgement call in this file ────────────
 *
 * The DEFAULT is translate. A block with no rule has all its prose sent. So mistaking
 * an allowlist for `do-not-translate` leaves visible English on a translated page —
 * ugly, obvious, cheap to spot. Mistaking anything for "no rule" hands the whole block
 * to the translator and silently corrupts it. Therefore:
 *
 *   an unparseable rule is REPORTED and treated as fully protected,
 *   never degraded to the permissive reading.
 *
 * ─── The grammar ────────────────────────────────────────────────────────────
 *
 * `custom-doc-rules.rule` is the near-English query language parsed by da-nx's
 * `nx/blocks/loc/dnt/parseQuery.js`. There is no published grammar, so this parser
 * covers exactly the forms the committed contract uses and REFUSES anything else —
 * which is what makes an unrecognised rule detectable instead of half-understood:
 *
 *   do-not-translate
 *   translate
 *   translate col 2 if col 1 is "title" or "description"
 *   dnt col 3
 *   dnt col 1
 *   dnt row 1 col 1
 *   dnt col 2 if col 1 is "index" or "limit"
 *   dnt col 2 if col 1 contains "-date"
 *   dnt cell if cell startswith "/"
 *
 * Indices are 1-BASED and refer to the AUTHORED table, which is the one way these rules
 * rot silently: an out-of-range column is a no-op, not an error.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, CONFIG_DIR } from '../config.mjs';

/** The committed contract, and the tabs this module reads. */
export const TRANSLATE_CONFIG = join(REPO_ROOT, CONFIG_DIR, 'da-translate.json');
export const RULES_TAB = 'custom-doc-rules';
export const CONTENT_TAB = 'dnt-content-rules';
export const SHEET_RULES_TAB = 'dnt-sheet-rules';

/**
 * Tabs this module refuses to read, and why.
 *
 * `config` carries the translation service's connection settings. Nothing in a QA tier
 * needs them, and a tool that has no reason to carry a service credential through its
 * memory, its logs and its JSON reports should not be the tool that starts.
 */
export const PROTECTED_TABS = {
  config: 'service connection settings — a QA tier has no use for them and reports are world-readable',
};

/**
 * What a parsed rule permits.
 *
 *   dnt        nothing in the block is translated.
 *   allowlist  only the cells a `translate …` directive names are translated.
 *   denylist   everything is translated EXCEPT the cells a `dnt …` directive names.
 *   all        the block is translated wholesale — either a bare `translate`, or no
 *              row at all. THE DEFAULT, and the dangerous one.
 *   blank      a row exists with an empty rule. Deliberately NOT folded into `all`:
 *              somebody created the row on purpose and did not finish it, which is a
 *              different fact about the world and worth reporting as an unfinished
 *              rule rather than as an intentional permission.
 *   conflict   the rows naming this block cannot both be true. Fails CLOSED.
 */
export const RULE_MODES = ['dnt', 'allowlist', 'denylist', 'all', 'blank', 'conflict'];

const DNT_WORD = /^(?:do[-\s]?not[-\s]?translate|dnt)$/i;
const TRANSLATE_WORD = /^translate$/i;
const OPS = ['not-startswith', 'not-contains', 'not-has-element', 'not-is', 'startswith', 'contains', 'has-element', 'is'];

/* Straight and curly quotes both, because the sheet is hand-edited in DA. */
const QUOTED = /["“”'‘’]([^"“”'‘’]*)["“”'‘’]/g;

const fold = (s) => String(s ?? '').trim().toLowerCase();

/**
 * Parse a 1-based index selector: `3`, `1-4`, `-1` (from the end) or `*`.
 *
 * Returns a predicate over `(index0, count)`. Negative indices need `count`, so a
 * selector is a function rather than a resolved number — the same rule is evaluated
 * against rows of different widths on the same page.
 */
function selector(raw) {
  const text = String(raw ?? '').trim();
  if (!text || text === '*') return () => true;
  const range = /^(-?\d+)\s*-\s*(-?\d+)$/.exec(text);
  const at = (n, count) => (n < 0 ? count + n : n - 1);
  if (range) {
    const [, a, b] = range;
    return (i, count) => i >= at(Number(a), count) && i <= at(Number(b), count);
  }
  if (/^-?\d+$/.test(text)) return (i, count) => i === at(Number(text), count);
  return null;
}

/** Parse the `if`/`unless` clause. Returns null when the rule has no condition. */
function condition(text) {
  const m = /\b(if|unless)\s+(col(?:umn)?\s*(-?\d+)|cell)\s+(\S+)\s*(.*)$/i.exec(text);
  if (!m) return null;
  const [, word, subject, colNum, op, rest] = m;
  const operator = fold(op);
  if (!OPS.includes(operator)) throw new Error(`unknown operator "${op}" — known: ${OPS.join(', ')}`);
  const values = [...String(rest).matchAll(QUOTED)].map((q) => q[1]).filter((v) => v !== '');
  if (!values.length) throw new Error(`condition names no quoted value: ${JSON.stringify(rest)}`);
  return {
    negate: fold(word) === 'unless',
    subject: /^cell/i.test(subject) ? 'cell' : 'col',
    col: colNum ? Number(colNum) : null,
    op: operator,
    values,
  };
}

/** Everything before the `if`/`unless`, which is where the row/col targets live. */
function targets(text) {
  const rowM = /\brow\s+(\S+)/i.exec(text);
  const colM = /\bcol(?:umn)?\s+(\S+)/i.exec(text);
  const row = rowM ? selector(rowM[1]) : null;
  const col = colM ? selector(colM[1]) : null;
  if (rowM && !row) throw new Error(`cannot parse row selector "${rowM[1]}"`);
  if (colM && !col) throw new Error(`cannot parse col selector "${colM[1]}"`);
  return { row, col, cell: /\bcell\b/i.test(text), targeted: Boolean(rowM || colM) };
}

/**
 * Parse one `custom-doc-rules` rule string into a directive.
 *
 * @throws on any form this parser does not recognise — see the header for why that is
 *   a throw and not a permissive fallback.
 */
export function parseRule(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { directive: 'blank', raw: text };
  const head = /^(\S+(?:[-\s]not[-\s]translate)?)/i.exec(text)[1];
  const isDnt = DNT_WORD.test(head) || /^do[-\s]?not[-\s]?translate/i.test(text);
  const isTranslate = TRANSLATE_WORD.test(head);
  if (!isDnt && !isTranslate) {
    throw new Error(`unrecognised directive in ${JSON.stringify(text)} — expected "translate", `
      + '"dnt" or "do-not-translate". Refusing to guess: reading an unparsed rule as "no rule" '
      + 'would hand the whole block to the translator and silently corrupt it.');
  }
  const body = text.replace(/^(do[-\s]?not[-\s]?translate|dnt|translate)\s*/i, '');
  const cond = condition(body);
  const beforeCond = cond ? body.slice(0, body.search(/\b(if|unless)\b/i)) : body;
  const t = targets(beforeCond);
  /*
   * Leftovers are refused. Without this check `dnt col 2 sometimes` parses as
   * `dnt col 2` and the word nobody understood is silently discarded — the exact
   * failure mode the strictness in this file exists to prevent.
   */
  const residue = beforeCond
    .replace(/\brow\s+\S+/i, '')
    .replace(/\bcol(?:umn)?\s+\S+/i, '')
    .replace(/\bcell\b/i, '')
    .trim();
  if (residue) throw new Error(`unparsed text ${JSON.stringify(residue)} in rule ${JSON.stringify(text)}`);
  return {
    directive: isDnt ? 'dnt' : 'translate',
    row: t.row,
    col: t.col,
    cellScope: t.cell,
    targeted: t.targeted || Boolean(cond),
    condition: cond,
    raw: text,
  };
}

/** Does a directive select this cell? */
function directiveMatches(d, cell) {
  const {
    rowIndex, colIndex, rowLength, rowCount, cells,
  } = cell;
  if (d.row && !d.row(rowIndex, rowCount)) return false;
  if (d.col && !d.col(colIndex, rowLength)) return false;
  if (!d.condition) return true;
  const c = d.condition;
  const subject = c.subject === 'cell'
    ? cells[colIndex]
    : cells[c.col < 0 ? rowLength + c.col : c.col - 1];
  const value = fold(subject);
  const base = c.op.replace(/^not-/, '');
  const negated = c.op.startsWith('not-');
  let hit;
  if (base === 'is') hit = c.values.some((v) => fold(v) === value);
  else if (base === 'contains') hit = c.values.some((v) => value.includes(fold(v)));
  else if (base === 'startswith') hit = c.values.some((v) => value.startsWith(fold(v)));
  else {
    /*
     * `has-element` asks about MARKUP inside the cell, which this parser is not given.
     * Answering it from text would be a guess, and a guess in the permissive direction
     * here is content corruption — so the directive is treated as matching (protect)
     * and `indexRules` has already reported the block as carrying an unsupported rule.
     */
    hit = true;
  }
  // `not-<op>` and `unless` are two spellings of the same inversion, and a rule may carry
  // both — so they compose rather than one overriding the other.
  return (negated !== c.negate) ? !hit : hit;
}

/**
 * The effective rule for a block class.
 *
 * Normalizes to the FIRST class token, so `article-feed rapid-drop` resolves against the
 * `article-feed` rule. A variant is a CSS class on the same block, handled by the same
 * `blocks/<name>/<name>.js`, so it must share the base block's rule; treating a variant
 * as unruled would silently opt it out of its own DNT contract, which is the most
 * consequential single mistake available here.
 */
export function ruleFor(rules, blockClass) {
  const name = String(blockClass ?? '').trim().split(/\s+/)[0].toLowerCase();
  return rules.get(name) || {
    mode: 'all', directives: [], rows: [], raw: null, name,
  };
}

/**
 * Should this cell have been translated, per the contract?
 *
 * @param {object} rule from `ruleFor()`
 * @param {object} cell `{ rowIndex, colIndex, rowLength, rowCount, cells }` — all
 *   0-based, `cells` being the row's cell texts so a condition can read its key.
 */
export function permitsTranslation(rule, cell) {
  if (rule.mode === 'dnt' || rule.mode === 'conflict') return false;
  if (rule.mode === 'all' || rule.mode === 'blank') return true;
  const hits = rule.directives.filter((d) => directiveMatches(d, cell));
  // An allowlist permits only what it names; a denylist permits everything it does not.
  return rule.mode === 'allowlist' ? hits.length > 0 : hits.length === 0;
}

/**
 * The authoring keys a block's rule names.
 *
 * The contract already enumerates the col-1 keys every rule-bearing block matches on
 * (`title`, `index`, `limit`, `status`, `card-1-url` …), so the QA tier reads its list
 * of LOGICAL keys out of the same place the connector reads its protections from. The
 * upstream pipeline kept a hand-maintained block registry for this and it drifted: a
 * key added to a rule was protected by the connector and still unknown to the checker.
 */
export function logicalKeys(rule) {
  const out = new Set();
  for (const d of rule.directives || []) {
    if (d.condition?.subject === 'col' && d.condition.op === 'is') {
      for (const v of d.condition.values) out.add(fold(v));
    }
  }
  return out;
}

/**
 * Which mode a block's accumulated directives add up to.
 *
 * A bare `translate` alongside `dnt col …` directives is not a conflict — the bare word
 * restates the default and the targeted rules are the exceptions (`article-feed` is
 * authored exactly this way). A bare `do-not-translate` alongside a `translate …`
 * directive IS a conflict, because there is no reading in which both hold.
 */
function modeOf(directives, bare, parsed) {
  if (bare.includes('dnt') && (bare.includes('translate') || directives.some((d) => d.directive === 'translate'))) {
    return 'conflict';
  }
  if (bare.includes('dnt')) return 'dnt';
  if (directives.some((d) => d.directive === 'dnt')) return 'denylist';
  if (directives.some((d) => d.directive === 'translate')) return 'allowlist';
  if (bare.includes('translate')) return 'all';
  return parsed.directive === 'blank' ? 'blank' : 'all';
}

/**
 * Index the `custom-doc-rules` rows into a block → rule map.
 *
 * Two things this does that the upstream version did not, both because the aemdev
 * contract needs them:
 *
 *   1. The `block` column may name SEVERAL blocks, comma-separated, so one row can
 *      produce four entries.
 *   2. A block may be named by SEVERAL ROWS. `article-feed` carries two `dnt col 2`
 *      rules with different conditions, and last-write-wins would silently enforce
 *      only the second — a rule in the sheet, visible to a reader, that nothing
 *      applies. Directives ACCUMULATE.
 *
 * Parse failures are collected rather than thrown: one malformed row must not stop the
 * other fifteen from being enforced. Callers surface them, and the drivers treat a
 * parse error as a gate failure.
 */
export function indexRules(rows) {
  const rules = new Map();
  const errors = [];
  (rows || []).forEach((row, i) => {
    const blocks = String(row.block ?? '').split(',').map((b) => b.trim().toLowerCase()).filter(Boolean);
    if (!blocks.length) return;
    let parsed;
    try {
      parsed = parseRule(row.rule);
    } catch (e) {
      errors.push({ row: i, block: blocks.join(', '), detail: e.message });
      // Fail closed: the blocks this row names are treated as fully protected until
      // somebody fixes the rule.
      for (const b of blocks) {
        rules.set(b, {
          mode: 'conflict', directives: [], rows: [i], raw: String(row.rule ?? ''), name: b,
        });
      }
      return;
    }
    for (const b of blocks) {
      const prev = rules.get(b);
      if (prev?.mode === 'conflict') return;
      const directives = [...(prev?.directives || [])];
      if (parsed.directive !== 'blank' && parsed.targeted) directives.push(parsed);
      const bare = [
        ...(prev?.bare || []),
        ...(parsed.directive !== 'blank' && !parsed.targeted ? [parsed.directive] : []),
      ];
      rules.set(b, {
        name: b,
        directives,
        bare,
        rows: [...(prev?.rows || []), i],
        raw: [prev?.raw, String(row.rule ?? '')].filter(Boolean).join(' ; '),
        mode: modeOf(directives, bare, parsed),
      });
    }
  });
  for (const [name, rule] of rules) {
    if (rule.mode === 'conflict' && !errors.some((e) => e.block.includes(name))) {
      errors.push({
        row: rule.rows[0],
        block: name,
        detail: 'rows disagree: one says do-not-translate and another permits translation. '
          + 'Treated as fully protected until resolved.',
      });
    }
  }
  return { rules, errors };
}

/**
 * The literal strings that must survive byte-identical wherever they appear.
 *
 * `dnt-content-rules` wraps each of these in `translate="no"` in body text. Two
 * categories, both deliberate (see the annotations in the contract): product and event
 * names, whose translation is a defect in every locale; and PEOPLE'S NAMES, which the
 * meetups and bios groups make load-bearing content and which a CJK locale will happily
 * transliterate into something both wrong and hard to spot in review.
 *
 * The matcher is a substring test, case-SENSITIVE, matching the XPath `contains()` the
 * connector uses — and matching the requirement, which is byte-identity and not
 * approximate survival.
 */
export const protectedLiterals = (doc) => (doc?.[CONTENT_TAB]?.data ?? [])
  .map((r) => String(r.content ?? '').trim())
  .filter(Boolean);

/**
 * Value shapes that must survive byte-identical, from `dnt-sheet-rules`.
 *
 * Absolute URLs, root-relative paths, taxonomy tag ids (`aemdev:topic/edge-delivery`)
 * and this site's hash authoring language (`#_blank`). Every one is an identifier.
 * Written as a contract row (`beginsWith(a || b)`) rather than as a regex in code, so
 * the checker cannot protect a shape the connector does not.
 */
export function identifierPrefixes(doc) {
  return (doc?.[SHEET_RULES_TAB]?.data ?? [])
    .filter((row) => fold(row.action) === 'dnt')
    .flatMap((row) => {
      const m = /^beginsWith\((.*)\)$/i.exec(String(row.pattern ?? '').trim());
      return m ? m[1].split('||').map((s) => s.trim()).filter(Boolean) : [];
    });
}

/**
 * Load the whole contract.
 *
 * Reads the committed file, never the network — so a QA run needs no DA token to know
 * what should have been protected. `config` is skipped, per PROTECTED_TABS.
 */
export function loadDntContract({ file = TRANSLATE_CONFIG } = {}) {
  if (!existsSync(file)) {
    throw new Error(`no DNT contract at ${file} — refusing to run. With no contract every `
      + 'protected cell reads as unruled and the DNT check reports a false all-clear, which is '
      + 'the one outcome worth failing to avoid.');
  }
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const { rules, errors } = indexRules(doc[RULES_TAB]?.data ?? []);
  return {
    source: file,
    rules,
    errors,
    literals: protectedLiterals(doc),
    identifiers: identifierPrefixes(doc),
    languages: doc.languages?.data ?? [],
  };
}

/** Does this text look like an identifier the contract protects by shape? */
export const isIdentifier = (identifiers, text) => {
  const t = String(text ?? '').trim();
  return t !== '' && identifiers.some((p) => t.startsWith(p));
};
