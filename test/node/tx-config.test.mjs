/**
 * tx-config.test.mjs — the annotation strip and the validation gate.
 *
 *   npm run test:node          (node --test "test/node/*.test.mjs")
 *
 * The strip is the whole point of the tool and both halves fail invisibly if it is
 * skipped: a `_comment` top-level key is accepted by admin.da.live and refused at
 * PREVIEW, and a `_why` inside a row becomes a real sheet column handed to the
 * connector as data. The validation exists because da-nx's parser ignores what it does
 * not recognise, so a misspelled sheet or a near-miss locale code deploys cleanly and
 * simply never applies.
 *
 * The real .tracker/da-translate.json is exercised too: it is the file that actually
 * ships, and a test against a fixture only proves the fixture is well formed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripAnnotations, validatePayload, diffPayloads } from '../../tools/tracker/tx-config.mjs';
import { REPO_ROOT } from '../../tools/tracker/config.mjs';
import { TARGET_LOCALES } from '../../scripts/tracker/locales.js';

const real = () => JSON.parse(readFileSync(join(REPO_ROOT, '.tracker', 'da-translate.json'), 'utf8'));

test('the committed source strips clean and validates', () => {
  const { payload, stripped } = stripAnnotations(real());
  assert.ok(stripped.includes('_comment'), 'the top-level annotation is removed');
  assert.ok(stripped.includes('custom-doc-rules[]._why'), 'the per-row annotation is removed');
  assert.deepEqual(validatePayload(payload), []);

  // Nothing that is not `:`-prefixed or a sheet may survive — that is the content bus rule.
  for (const [k, v] of Object.entries(payload)) {
    assert.ok(k.startsWith(':') || Array.isArray(v.data), `${k} is neither metadata nor a sheet`);
  }
  for (const sheet of Object.values(payload)) {
    if (!Array.isArray(sheet.data)) continue; // eslint-disable-line no-continue
    for (const row of sheet.data) {
      for (const col of Object.keys(row)) assert.ok(!col.startsWith('_'), `${col} leaked into a row`);
    }
  }
});

test('the counters are recomputed, not trusted', () => {
  const source = real();
  source.config.total = 99;
  source.config.limit = 1;
  const { payload, counters } = stripAnnotations(source);
  assert.equal(payload.config.total, payload.config.data.length);
  assert.equal(payload.config.limit, payload.config.data.length);
  assert.equal(payload.config.offset, 0);
  assert.equal(counters.length, 1, 'and the correction is reported rather than silent');
  assert.match(counters[0].was, /total 99/);
});

test('an unknown sheet or column is refused, because da-nx would ignore it silently', () => {
  const { payload } = stripAnnotations(real());
  const withSheet = { ...payload, 'dnt-content-rule': { total: 0, limit: 0, offset: 0, data: [] } };
  withSheet[':names'] = [...payload[':names'], 'dnt-content-rule'];
  assert.match(validatePayload(withSheet).join(' | '), /unknown sheet "dnt-content-rule"/);

  const withCol = JSON.parse(JSON.stringify(payload));
  withCol.dnt.data[0].columns = 'Slug';
  assert.match(validatePayload(withCol).join(' | '), /unknown column "columns"/);
});

test('the languages sheet is checked against the locale registry', () => {
  const { payload } = stripAnnotations(real());

  const nearMiss = JSON.parse(JSON.stringify(payload));
  const zh = nearMiss.languages.data.find((r) => r.location === '/zh-cn');
  zh.code = 'zh-cn';
  assert.match(validatePayload(nearMiss).join(' | '), /should be "zh-CN"/);

  const dropped = JSON.parse(JSON.stringify(payload));
  dropped.languages.data = dropped.languages.data.filter((r) => r.code !== 'ko');
  const problems = validatePayload(dropped).join(' | ');
  assert.match(problems, /ko is missing/);
  assert.ok(TARGET_LOCALES.includes('ko'));

  const sourceTranslated = JSON.parse(JSON.stringify(payload));
  sourceTranslated.languages.data.find((r) => r.code === 'en').actions = 'Translate';
  assert.match(validatePayload(sourceTranslated).join(' | '), /en must be "Skip"/);

  const wrongTree = JSON.parse(JSON.stringify(payload));
  wrongTree.languages.data.find((r) => r.code === 'de').location = '/de-de';
  assert.match(validatePayload(wrongTree).join(' | '), /registry says "\/de"/);
});

test('diffPayloads reports absent, identical, changed rows and a reordering', () => {
  const { payload } = stripAnnotations(real());
  assert.ok(diffPayloads(payload, null).length, 'an absent config differs from everything');
  assert.deepEqual(diffPayloads(payload, payload), []);

  const changed = JSON.parse(JSON.stringify(payload));
  changed['dnt-content-rules'].data.push({ content: 'Something New' });
  const added = diffPayloads(changed, payload);
  assert.equal(added.length, 1);
  assert.equal(added[0].sheet, 'dnt-content-rules');
  assert.deepEqual(added[0].onlyLocal, [{ content: 'Something New' }]);
  assert.deepEqual(added[0].onlyDeployed, []);

  const reordered = JSON.parse(JSON.stringify(payload));
  reordered.config.data.reverse();
  const order = diffPayloads(reordered, payload);
  assert.equal(order.length, 1);
  assert.equal(order[0].orderDiffers, true, 'order is semantic in the config sheet');
});

test('the dnt sheet has two rows with the same first column, so the diff is a multiset', () => {
  const { payload } = stripAnnotations(real());
  const stars = payload.dnt.data.filter((r) => r['dnt-sheet'] === '*');
  assert.ok(stars.length > 1, 'a key-based diff would collide on these');
  assert.deepEqual(diffPayloads(payload, payload), [], 'and a multiset diff does not');
});
