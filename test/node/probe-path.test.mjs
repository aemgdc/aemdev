/**
 * probe-path.test.mjs — the one path shape that differs, pinned.
 *
 *   npm run test:node          (node --test "test/node/*.test.mjs")
 *
 * `normalizePath` strips trailing slashes because the slashed form 404s on this site's
 * article paths. The locale HOME page is the exception in the other direction: it is a
 * directory index, so only the SLASHED form resolves. Measured on
 * `main--aemdev--aemgdc.aem.live`:
 *
 *     /en            404        /en/            200
 *     /en/articles   200        /en/articles/   404
 *
 * That is ten of the tracker's pages — every locale home — and getting it wrong makes
 * `tx:scan` report `previewed=''` on them forever, whatever is published. These
 * assertions exist so a future tidy-up of `normalizePath` cannot quietly undo it.
 *
 * The rest of `paths.js` is covered by test/scripts/tracker/paths.test.js, which runs
 * in a browser under web-test-runner. This lives in the node suite because the fact it
 * pins was established with a live HTTP probe, and it is worth being able to re-check
 * it without a browser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_LOCALES } from '../../scripts/tracker/locales.js';
import {
  probePath, sourceDocPath, statusApiUrl, previewUrl, liveUrl, previewApiUrl, publishApiUrl,
} from '../../scripts/tracker/paths.js';

test('every locale home keeps its trailing slash, in both spellings', () => {
  for (const code of ALL_LOCALES) {
    assert.equal(probePath(`/${code}`), `/${code}/`);
    assert.equal(probePath(`/${code}/`), `/${code}/`);
    assert.equal(sourceDocPath(`/${code}`), `/${code}/index`);
  }
});

test('nothing else is touched — a slashed article path is still stripped', () => {
  assert.equal(probePath('/en/articles'), '/en/articles');
  assert.equal(probePath('/en/articles/'), '/en/articles');
  assert.equal(probePath('/en/meetups/miami'), '/en/meetups/miami');
  assert.equal(probePath('/zh-cn/meetups/miami/'), '/zh-cn/meetups/miami');
  // A feed under a locale tree is not a locale home.
  assert.equal(probePath('/en/query-index.json'), '/en/query-index.json');
});

test('the site root is left alone: it exists and answers 301 to /en/', () => {
  assert.equal(probePath('/'), '/');
  assert.equal(sourceDocPath('/'), '/index');
});

test('every host and admin builder carries the correction', () => {
  for (const build of [statusApiUrl, previewApiUrl, publishApiUrl]) {
    assert.ok(build('/de', 'main').endsWith('/de/'), `${build.name} dropped the slash`);
  }
  assert.equal(previewUrl('/de'), 'https://main--aemdev--aemgdc.aem.page/de/');
  assert.equal(liveUrl('/de'), 'https://main--aemdev--aemgdc.aem.live/de/');
  assert.equal(liveUrl('/en/contact'), 'https://main--aemdev--aemgdc.aem.live/en/contact');
});
