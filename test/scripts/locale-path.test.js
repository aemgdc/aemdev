import { expect } from '@esm-bundle/chai';
import sinon from 'sinon';
import {
  localizePath, fetchLocalized, fetchLocalizedIndex,
} from '../../scripts/utils/locale-path.js';

/*
 * A /de/ page keeps its authored English paths (they are do-not-translate) and reads
 * the German copy at render time — but never ends up with less than the English page
 * would show when the German copy is missing.
 */

const answer = (map) => sinon.stub(window, 'fetch').callsFake((url) => {
  const hit = map[url];
  if (!hit) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(hit), text: () => Promise.resolve('') });
});

describe('localizePath', () => {
  it('moves an English path into the locale tree', () => {
    expect(localizePath('/en/query-index.json', '/de')).to.equal('/de/query-index.json');
    expect(localizePath('/en/meetups/', '/zh-tw')).to.equal('/zh-tw/meetups/');
    expect(localizePath('/en', '/ja')).to.equal('/ja');
  });

  it('leaves English pages, root pages and non-/en paths alone', () => {
    expect(localizePath('/en/meetups/', '/en')).to.equal('/en/meetups/');
    expect(localizePath('/en/meetups/', '')).to.equal('/en/meetups/');
    expect(localizePath('/fragments/brands/x', '/de')).to.equal('/fragments/brands/x');
    expect(localizePath('/enterprise/x', '/de')).to.equal('/enterprise/x');
  });
});

describe('fetchLocalized', () => {
  afterEach(() => window.fetch.restore?.());

  it('prefers the locale copy', async () => {
    answer({ '/de/fragments/bios/a.plain.html': {}, '/en/fragments/bios/a.plain.html': {} });
    const { localized, path } = await fetchLocalized('/en/fragments/bios/a.plain.html', undefined, '/de');
    expect(localized).to.be.true;
    expect(path).to.equal('/de/fragments/bios/a.plain.html');
  });

  it('falls back to English when the locale copy is missing', async () => {
    answer({ '/en/fragments/bios/a.plain.html': {} });
    const { resp, localized } = await fetchLocalized('/en/fragments/bios/a.plain.html', undefined, '/de');
    expect(localized).to.be.false;
    expect(resp.ok).to.be.true;
  });
});

describe('fetchLocalizedIndex', () => {
  afterEach(() => window.fetch.restore?.());

  it('reads the locale index when it has rows', async () => {
    answer({ '/de/query-index.json': { data: [{ path: '/de/meetups/x' }] }, '/en/query-index.json': { data: [{ path: '/en/meetups/x' }] } });
    const { rows, localized } = await fetchLocalizedIndex('/en/query-index.json', '/de');
    expect(localized).to.be.true;
    expect(rows[0].path).to.equal('/de/meetups/x');
  });

  it('falls back to English when the locale index is missing or empty', async () => {
    answer({ '/de/query-index.json': { data: [] }, '/en/query-index.json': { data: [{ path: '/en/meetups/x' }] } });
    const empty = await fetchLocalizedIndex('/en/query-index.json', '/de');
    expect(empty.localized).to.be.false;
    expect(empty.rows).to.have.length(1);
    window.fetch.restore();
    answer({ '/en/query-index.json': { data: [{ path: '/en/meetups/x' }] } });
    const missing = await fetchLocalizedIndex('/en/query-index.json', '/ja');
    expect(missing.localized).to.be.false;
  });

  it('throws when even the English index fails', async () => {
    answer({});
    let threw = false;
    try {
      await fetchLocalizedIndex('/en/query-index.json', '/de');
    } catch {
      threw = true;
    }
    expect(threw).to.be.true;
  });
});
