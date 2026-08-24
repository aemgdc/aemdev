import { expect } from '@esm-bundle/chai';
import {
  ALL_LOCALES,
  LOCALES,
  SOURCE_LOCALE,
  TARGET_LOCALES,
  basePath,
  isLocale,
  isTargetLocale,
  locale,
  localeForPath,
  normalizePath,
  pathForLocale,
  siteLocalesConfig,
  sourcePathFor,
} from '../../../scripts/tracker/locales.js';

/*
 * The registry is not ours to invent — it mirrors the site's own translation config —
 * so these tests are mostly about the two things the registry exists to prevent: a
 * path spelled two ways becoming two rows, and a locale code spelled two ways
 * reaching the translation connector.
 */

describe('locales.js', () => {
  describe('the registry', () => {
    it('has exactly ten target locales, in tab-creation order', () => {
      expect(TARGET_LOCALES).to.deep.equal([
        'de', 'fr', 'es', 'it', 'pt', 'pl', 'ja', 'ko', 'zh-cn', 'zh-tw',
      ]);
      expect(TARGET_LOCALES).to.have.length(10);
    });

    it('carries en as the source, and only en', () => {
      expect(SOURCE_LOCALE).to.equal('en');
      expect(LOCALES.filter((l) => l.source).map((l) => l.code)).to.deep.equal(['en']);
      expect(ALL_LOCALES).to.deep.equal(['en', ...TARGET_LOCALES]);
      expect(TARGET_LOCALES).to.not.include('en');
    });

    it('gives every locale a location of /<code>', () => {
      // Spelled out in the table rather than derived, so a future region tree can
      // diverge — but until it does, the two must agree.
      for (const l of LOCALES) expect(l.location, l.code).to.equal(`/${l.code}`);
    });

    it('gives every locale a name, a native name, a script and an expansion factor', () => {
      for (const l of LOCALES) {
        expect(l.name, l.code).to.be.a('string').and.not.empty;
        expect(l.native, l.code).to.be.a('string').and.not.empty;
        expect(l.script, l.code).to.be.a('string').and.not.empty;
        expect(l.expansion, l.code).to.be.a('number').and.greaterThan(0);
      }
    });

    it('looks a locale up case- and whitespace-insensitively, and returns null for a miss', () => {
      // A blank is "no locale", not a bug: callers routinely pass a sheet cell that
      // may legitimately be empty.
      expect(locale('DE').code).to.equal('de');
      expect(locale(' zh-cn ').code).to.equal('zh-cn');
      expect(locale('')).to.be.null;
      expect(locale(null)).to.be.null;
      expect(locale('xx')).to.be.null;
      expect(isLocale('de')).to.be.true;
      expect(isLocale('xx')).to.be.false;
      expect(isTargetLocale('de')).to.be.true;
      expect(isTargetLocale('en')).to.be.false;
      expect(isTargetLocale('xx')).to.be.false;
    });
  });

  describe('serviceCode', () => {
    it('differs from `code` for exactly zh-cn and zh-tw', () => {
      /*
       * DA's translate config and a sitemap `hreflang` want the lowercase form; the
       * translation connector wants BCP-47 casing. They are near-misses, so a typo is
       * a silent no-op rather than an error — the connector accepts an unknown code
       * and hands back the source text untranslated. One place in the codebase knows
       * the difference, and this is the test that keeps it to one.
       */
      const differs = LOCALES.filter((l) => l.serviceCode !== l.code).map((l) => l.code);
      expect(differs).to.deep.equal(['zh-cn', 'zh-tw']);
      expect(locale('zh-cn').serviceCode).to.equal('zh-CN');
      expect(locale('zh-tw').serviceCode).to.equal('zh-TW');
      // Every other code, including pt, is its own service code.
      expect(locale('pt').serviceCode).to.equal('pt');
    });
  });

  describe('normalizePath', () => {
    it('strips a trailing slash but leaves the bare root alone', () => {
      // Not cosmetic: trailing slashes 404 on this site's article paths, so
      // `/en/articles/foo/` and `/en/articles/foo` are a live 404 and a live 200.
      // Normalizing here is what stops a group sync recording a 404 as a tracked page,
      // and what stops two spellings becoming two rows for one page.
      expect(normalizePath('/en/articles/foo/')).to.equal('/en/articles/foo');
      expect(normalizePath('/en/articles/foo')).to.equal('/en/articles/foo');
      expect(normalizePath('/en/articles/foo//')).to.equal('/en/articles/foo');
      expect(normalizePath('/')).to.equal('/');
    });

    it('trims surrounding whitespace, because the input is a spreadsheet cell', () => {
      expect(normalizePath('  /en/articles/foo/  ')).to.equal('/en/articles/foo');
    });

    it('returns an empty string for nothing at all', () => {
      expect(normalizePath('')).to.equal('');
      expect(normalizePath(null)).to.equal('');
      expect(normalizePath(undefined)).to.equal('');
    });
  });

  describe('localeForPath', () => {
    it('reads a locale off a path, at the locale home page too', () => {
      expect(localeForPath('/en/meetups/berlin')).to.equal('en');
      expect(localeForPath('/de/meetups/berlin/')).to.equal('de');
      expect(localeForPath('/ja')).to.equal('ja');
    });

    it('lets the longest prefix win, so /zh-cn/x is zh-cn and never zh', () => {
      // The registry sorts candidates by location length for this reason: were a `/zh`
      // tree ever added, `/zh-cn/...` would otherwise resolve to it and every
      // Simplified Chinese row would join against the wrong locale tab.
      expect(localeForPath('/zh-cn/meetups/berlin')).to.equal('zh-cn');
      expect(localeForPath('/zh-tw/meetups/berlin')).to.equal('zh-tw');
      // There is no `/zh` tree today, and a bare `/zh` must not be invented.
      expect(localeForPath('/zh')).to.be.null;
      expect(localeForPath('/zh/meetups')).to.be.null;
    });

    it('matches whole segments only', () => {
      expect(localeForPath('/zh-cnx/x')).to.be.null;
      expect(localeForPath('/english/x')).to.be.null;
      expect(localeForPath('/den/x')).to.be.null;
    });

    it('returns null for the root home page, which is in no locale tree', () => {
      // `/` is the real case, and the `indexes` group carries it as a manual row.
      expect(localeForPath('/')).to.be.null;
    });

    it('returns null for a path outside every locale tree', () => {
      expect(localeForPath('/tracker/data/rollup.json')).to.be.null;
      expect(localeForPath('')).to.be.null;
    });
  });

  describe('basePath / pathForLocale', () => {
    it('strips the locale to the part every locale shares', () => {
      expect(basePath('/en/meetups/berlin')).to.equal('/meetups/berlin');
      expect(basePath('/zh-cn/meetups/berlin')).to.equal('/meetups/berlin');
      expect(basePath('/de/meetups/berlin/')).to.equal('/meetups/berlin');
      // A locale home page's base is the root.
      expect(basePath('/de')).to.equal('/');
    });

    it('leaves a path outside the locale trees alone', () => {
      expect(basePath('/tracker/data/rollup.json')).to.equal('/tracker/data/rollup.json');
    });

    it('round-trips from any locale to any other', () => {
      for (const from of ALL_LOCALES) {
        const start = pathForLocale('/en/meetups/berlin', from);
        expect(start, from).to.equal(`/${from}/meetups/berlin`);
        expect(basePath(start), from).to.equal('/meetups/berlin');
        for (const to of ALL_LOCALES) {
          expect(pathForLocale(start, to), `${from} -> ${to}`).to.equal(`/${to}/meetups/berlin`);
        }
      }
    });

    it('round-trips the locale home pages', () => {
      for (const code of ALL_LOCALES) {
        expect(pathForLocale('/', code), code).to.equal(`/${code}`);
        expect(pathForLocale(`/${code}`, 'en'), code).to.equal('/en');
        expect(sourcePathFor(`/${code}/meetups/berlin`), code).to.equal('/en/meetups/berlin');
      }
    });

    it('returns null for an unknown target locale rather than guessing', () => {
      expect(pathForLocale('/en/meetups/berlin', 'xx')).to.be.null;
      expect(pathForLocale('/en/meetups/berlin', '')).to.be.null;
    });
  });

  describe('siteLocalesConfig', () => {
    it('keys on the path prefix and carries the lang, as setConfig expects', () => {
      // Exported from the registry so the site's link localization and the tracker
      // cannot disagree about what locales exist.
      const config = siteLocalesConfig();
      for (const code of ALL_LOCALES) {
        expect(config[`/${code}`], code).to.deep.equal({ lang: code });
      }
      expect(config['/zh-cn']).to.deep.equal({ lang: 'zh-cn' });
    });

    it('has an entry for every locale, asserted as a floor and not a ceiling', () => {
      /*
       * Deliberately NOT an exact key set — the `''` fallback below is a legitimate
       * extra key, and pinning the set exactly would make adding one a test failure.
       */
      const config = siteLocalesConfig();
      expect(Object.keys(config)).to.include.members(ALL_LOCALES.map((c) => `/${c}`));
    });

    it('carries the `\'\'` fallback ak.js dereferences without a guard', () => {
      /*
       * THE REGRESSION GUARD. `ak.js`'s `getLocale()` matches a prefix with
       * `pathname.startsWith(`${key}/`)`, whose trailing slash misses on `/`, on the
       * locale HOME pages (`/en`, `/de`) and on everything under `/tracker/`. All of
       * those fall through to `prefix = ''` and it then reads `locales[prefix].lang`
       * with no guard, so a map without this key threw inside `setConfig` and killed
       * `loadPage` before `loadArea` — a blank page on every tracker page. It took out
       * `test/scripts/scripts.test.js` and `test/scripts/dapreview.test.js` at import.
       */
      const config = siteLocalesConfig();
      expect(config).to.have.property('');
      // No `lang`: an empty object is the shape ak.js's own default parameter uses, so
      // the document keeps whatever lang its markup declares. Asserting `en` here would
      // claim /tracker/** is English content rather than a QA surface.
      expect(config['']).to.deep.equal({});
    });

    it('does not let the fallback shadow a real locale prefix', () => {
      /*
       * `''` matches every path (`startsWith('/')`), so it is only safe because
       * getLocale sorts candidates longest-first. Reproduced here rather than trusted:
       * if the sort or the key ever changed, every locale page would resolve to the
       * fallback and no link localization would happen — the exact bug the `/en` key
       * was added to fix.
       */
      const config = siteLocalesConfig();
      const resolve = (pathname) => Object.keys(config)
        .filter((key) => pathname.startsWith(`${key}/`))
        .sort((a, b) => b.length - a.length)[0] || '';
      expect(resolve('/en/meetups/berlin')).to.equal('/en');
      expect(resolve('/zh-cn/meetups/berlin')).to.equal('/zh-cn');
      expect(resolve('/de/')).to.equal('/de');
      // The cases that legitimately reach the fallback.
      expect(resolve('/')).to.equal('');
      expect(resolve('/en')).to.equal('');
      expect(resolve('/tracker/qa/en/meetups/berlin')).to.equal('');
      // What ak.js does next, and what used to throw.
      for (const pathname of ['/', '/en', '/de', '/tracker/qa/en/a', '/en/meetups/berlin']) {
        expect(() => config[resolve(pathname)].lang, pathname).to.not.throw();
      }
    });
  });

  describe('isTargetLocale', () => {
    it('never treats the source locale as a translation target, however it is typed', () => {
      /*
       * It compared the RAW argument to SOURCE_LOCALE while `isLocale` folded case, so
       * `isTargetLocale('EN')` answered true — English as a translation target, which
       * queues the source page to be translated into itself. Sheet cells are typed by
       * hand, so both spellings are reachable.
       */
      for (const raw of ['en', 'EN', 'En', ' en ', ' EN\t']) {
        expect(isTargetLocale(raw), JSON.stringify(raw)).to.equal(false);
      }
    });

    it('still accepts every real target, folded the same way', () => {
      for (const code of TARGET_LOCALES) {
        expect(isTargetLocale(code), code).to.equal(true);
        expect(isTargetLocale(code.toUpperCase()), code).to.equal(true);
        expect(isTargetLocale(` ${code} `), code).to.equal(true);
      }
      expect(isTargetLocale('xx')).to.equal(false);
      expect(isTargetLocale('')).to.equal(false);
    });
  });
});
