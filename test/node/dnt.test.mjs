import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadDntContract, parseRule, indexRules, ruleFor, permitsTranslation, logicalKeys,
  isIdentifier, identifierPrefixes, protectedLiterals,
} from '../../tools/tracker/lib/dnt.mjs';

/*
 * These run against the COMMITTED contract, not a fixture. That is the point: the whole
 * reason this module reads `.tracker/da-translate.json` instead of fetching the live
 * config is so the checker and the connector cannot disagree, and a fixture would let the
 * real file rot while the tests stayed green.
 */
const contract = loadDntContract();

const cell = (cells, colIndex, rowIndex = 0, rowCount = 1) => ({
  rowIndex, colIndex, rowLength: cells.length, rowCount, cells,
});
const permits = (block, cells, col, row = 0, rows = 1) => permitsTranslation(
  ruleFor(contract.rules, block),
  cell(cells, col, row, rows),
);

test('every committed custom-doc-rules row parses', () => {
  assert.deepEqual(contract.errors, []);
  assert.ok(contract.rules.size >= 39, `only ${contract.rules.size} blocks indexed`);
});

test('a block named by two rows accumulates BOTH directives', () => {
  // article-feed carries `dnt col 2 if col 1 is "index"…` AND `dnt col 2 if col 1
  // contains "-date"`. Last-write-wins would silently enforce only the second — a rule
  // visible in the sheet that nothing applies.
  const rule = ruleFor(contract.rules, 'article-feed');
  assert.equal(rule.mode, 'denylist');
  assert.equal(rule.directives.length, 2);
  assert.equal(permits('article-feed', ['index', '/en/articles/query-index.json'], 1), false);
  assert.equal(permits('article-feed', ['card-1-date', '2 Oct 2026'], 1), false);
  assert.equal(permits('article-feed', ['badge', 'Latest'], 1), true);
});

test('the code block is fully protected — a translated identifier is a defect', () => {
  assert.equal(ruleFor(contract.rules, 'code').mode, 'dnt');
  assert.equal(permits('code', ['shell', 'mvn clean install'], 1), false);
  assert.equal(permits('code', ['shell', 'mvn clean install'], 0), false);
});

test('metadata is an allowlist: only the prose keys translate', () => {
  assert.equal(permits('metadata', ['title', 'Munich Meetup'], 1), true);
  assert.equal(permits('metadata', ['description', 'A meetup'], 1), true);
  // Translating `upcoming` to `bevorstehend` breaks the lifecycle model and the index.
  assert.equal(permits('metadata', ['status', 'upcoming'], 1), false);
  assert.equal(permits('metadata', ['event-date', '2026-10-02'], 1), false);
  // An allowlist protects col 1 implicitly — its whole shape presupposes a stable key.
  assert.equal(permits('metadata', ['title', 'Munich'], 0), false);
});

test('a block variant resolves against its base rule', () => {
  // A variant is a CSS class on the same block, decorated by the same JS file, so it must
  // not read as unruled: one implementation, one rule.
  assert.equal(ruleFor(contract.rules, 'code shell').mode, 'dnt');
  assert.equal(ruleFor(contract.rules, 'article-feed rapid-drop').mode, 'denylist');
});

test('an unruled block permits everything — the default, and the dangerous one', () => {
  assert.equal(ruleFor(contract.rules, 'no-such-block').mode, 'all');
  assert.equal(permits('no-such-block', ['a', 'b'], 1), true);
});

test('row and cell selectors, including 1-based indexing', () => {
  // `dnt row 1 col 1` — the headshot in author-rows. Row 2 col 1 is a name and translates
  // by this rule (dnt-content-rules protects the name itself).
  assert.equal(permits('author-rows', ['img', 'Tad Reeves'], 0, 0, 2), false);
  assert.equal(permits('author-rows', ['img', 'Tad Reeves'], 0, 1, 2), true);
  // `dnt col 3` — speaking's youtube URL. Col 2, the talk title, translates.
  assert.equal(permits('speaking', ['adaptTo 2026', 'My talk', 'https://y'], 2), false);
  assert.equal(permits('speaking', ['adaptTo 2026', 'My talk', 'https://y'], 1), true);
  // `dnt cell if cell startswith "/"` — a value predicate, not a position.
  assert.equal(permits('results-panel', ['/en/articles'], 0), false);
  assert.equal(permits('results-panel', ['Results'], 0), true);
});

test('an unparseable rule FAILS CLOSED and is reported', () => {
  const { rules, errors } = indexRules([{ block: 'mystery', rule: 'sometimes translate maybe' }]);
  assert.equal(errors.length, 1);
  assert.match(errors[0].detail, /unrecognised directive/);
  // Treated as fully protected. Degrading to the permissive reading would hand the whole
  // block to the translator and silently corrupt it.
  assert.equal(rules.get('mystery').mode, 'conflict');
  assert.equal(permitsTranslation(rules.get('mystery'), cell(['a', 'b'], 1)), false);
});

test('leftover text in a rule is refused rather than silently discarded', () => {
  assert.throws(() => parseRule('dnt col 2 sometimes'), /unparsed text/);
});

test('a bare do-not-translate alongside a translate directive is a conflict', () => {
  const { rules } = indexRules([
    { block: 'x', rule: 'do-not-translate' },
    { block: 'x', rule: 'translate col 2 if col 1 is "title"' },
  ]);
  assert.equal(rules.get('x').mode, 'conflict');
  assert.equal(permitsTranslation(rules.get('x'), cell(['title', 'y'], 1)), false);
});

test('a bare translate alongside dnt directives is a denylist, not a conflict', () => {
  // The bare word restates the default; the targeted rules are the exceptions. This is
  // how article-feed and the prose-block row are actually authored.
  const { rules } = indexRules([
    { block: 'x', rule: 'translate' },
    { block: 'x', rule: 'dnt col 1' },
  ]);
  assert.equal(rules.get('x').mode, 'denylist');
  assert.equal(permitsTranslation(rules.get('x'), cell(['a', 'b'], 0)), false);
  assert.equal(permitsTranslation(rules.get('x'), cell(['a', 'b'], 1)), true);
});

test('a blank rule is not folded into "no rule"', () => {
  const { rules } = indexRules([{ block: 'x', rule: '   ' }]);
  assert.equal(rules.get('x').mode, 'blank');
});

test('logicalKeys comes from the contract, so the checker cannot lag the connector', () => {
  const keys = logicalKeys(ruleFor(contract.rules, 'metadata'));
  assert.ok(keys.has('title'));
  assert.ok(keys.has('og:title'));
  assert.equal(keys.has('status'), false, 'status is protected, not an allowlisted key');
  assert.ok(logicalKeys(ruleFor(contract.rules, 'insights')).has('category'));
});

test('identifier prefixes come from dnt-sheet-rules, not from a regex in code', () => {
  assert.deepEqual(contract.identifiers, ['http://', 'https://', '/', 'aemdev:', '#']);
  assert.equal(isIdentifier(contract.identifiers, 'aemdev:topic/edge-delivery'), true);
  assert.equal(isIdentifier(contract.identifiers, '#_blank'), true);
  assert.equal(isIdentifier(contract.identifiers, '/en/meetups'), true);
  assert.equal(isIdentifier(contract.identifiers, 'Edge Delivery Services'), false);
  assert.equal(isIdentifier(contract.identifiers, ''), false);
});

test('only dnt-actioned sheet rules become protected prefixes', () => {
  const doc = {
    'dnt-sheet-rules': {
      data: [
        { pattern: 'beginsWith(https://)', action: 'dnt' },
        { pattern: 'beginsWith(mailto:)', action: 'translate' },
      ],
    },
  };
  assert.deepEqual(identifierPrefixes(doc), ['https://']);
});

test('the protected literals are the connector\'s own never-translate list', () => {
  assert.ok(contract.literals.includes('Edge Delivery Services'));
  assert.ok(contract.literals.includes('adaptTo()'));
  assert.ok(contract.literals.includes('Tad Reeves'), 'person names are load-bearing content');
  assert.equal(protectedLiterals({}).length, 0);
});
