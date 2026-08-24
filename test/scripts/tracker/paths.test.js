import { expect } from '@esm-bundle/chai';
import {
  DEFAULT_BRANCH,
  FEEDS,
  ORG,
  PROD_HOST,
  SITE,
  TRACKER_TX,
  branchFromUrl,
  daEditUrl,
  daSourceUrl,
  liveOrigin,
  liveUrl,
  pageTrackerUrl,
  plainPath,
  plainUrl,
  prodUrl,
  previewApiUrl,
  previewOrigin,
  previewUrl,
  publishApiUrl,
  qaDocPath,
  slugOf,
  statusApiUrl,
  txDocPath,
  links,
} from '../../../scripts/tracker/paths.js';
import { TARGET_LOCALES } from '../../../scripts/tracker/locales.js';

/*
 * Every URL the tracker points at is built here, so the failures this file guards
 * against are all of the same kind: a URL that looks right, resolves to nothing, and
 * is reported as a missing page rather than as a broken link.
 */

/** Every builder that takes a branch, reduced to one argument so they can be swept. */
const BRANCH_BUILDERS = [
  ['previewOrigin', (branch) => previewOrigin(branch)],
  ['liveOrigin', (branch) => liveOrigin(branch)],
  ['previewUrl', (branch) => previewUrl('/en/meetups/berlin', branch)],
  ['liveUrl', (branch) => liveUrl('/en/meetups/berlin', branch)],
  ['plainUrl', (branch) => plainUrl('/en/meetups/berlin', branch)],
  ['statusApiUrl', (branch) => statusApiUrl('/en/meetups/berlin', branch)],
  ['previewApiUrl', (branch) => previewApiUrl('/en/meetups/berlin', branch)],
  ['publishApiUrl', (branch) => publishApiUrl('/en/meetups/berlin', branch)],
];

describe('paths.js', () => {
  describe('site identity', () => {
    it('is one DA site, and the tracker lives inside it', () => {
      expect(ORG).to.equal('aemgdc');
      expect(SITE).to.equal('aemdev');
      expect(DEFAULT_BRANCH).to.equal('main');
      expect(PROD_HOST).to.equal('www.aemdev.org');
      // No underscore anywhere in the tracker tree: Helix excludes `_`-prefixed paths
      // from publishing, and these feeds have to be served.
      for (const path of Object.values(FEEDS).filter((f) => typeof f === 'string')) {
        expect(path, path).to.match(/^\/tracker\//);
        expect(path, path).to.not.contain('/_');
      }
    });
  });

  describe('branch names', () => {
    it('is lower-cased by every host and admin builder', () => {
      /*
       * AEM's hostname scheme is case-sensitive in practice: `EDGE-1--aemdev--aemgdc`
       * does not resolve while `edge-1--aemdev--aemgdc` does. Branch names with
       * capitals are common, so no builder may trust its caller.
       */
      for (const [name, build] of BRANCH_BUILDERS) {
        expect(build('EDGE-1'), name).to.equal(build('edge-1'));
        expect(build('EDGE-1'), name).to.not.contain('EDGE-1');
        expect(build('EDGE-1'), name).to.contain('edge-1');
      }
    });

    it('falls back to main when no branch is given', () => {
      for (const [name, build] of BRANCH_BUILDERS) {
        expect(build(undefined), name).to.contain(DEFAULT_BRANCH);
        expect(build(''), name).to.equal(build(DEFAULT_BRANCH));
      }
    });

    it('builds the two hosts a page is observed on', () => {
      expect(previewOrigin()).to.equal('https://main--aemdev--aemgdc.aem.page');
      expect(liveOrigin()).to.equal('https://main--aemdev--aemgdc.aem.live');
      expect(previewUrl('/en/meetups/berlin/')).to.equal('https://main--aemdev--aemgdc.aem.page/en/meetups/berlin');
      expect(prodUrl('/en/meetups/berlin')).to.equal('https://www.aemdev.org/en/meetups/berlin');
    });
  });

  describe('plainPath', () => {
    it('appends index for a directory path', () => {
      // `.plain.html` is served for a page's body; a directory has no body of its own,
      // so the request has to name the index document explicitly.
      expect(plainPath('/')).to.equal('/index.plain.html');
      expect(plainUrl('/')).to.equal('https://main--aemdev--aemgdc.aem.page/index.plain.html');
    });

    it('appends the suffix to an ordinary page', () => {
      expect(plainPath('/en/meetups/berlin')).to.equal('/en/meetups/berlin.plain.html');
    });

    it('treats a trailing slash as the same page, because the slashed form 404s', () => {
      expect(plainPath('/en/meetups/berlin/')).to.equal('/en/meetups/berlin.plain.html');
    });
  });

  describe('daSourceUrl', () => {
    it('throws without an explicit ext', () => {
      /*
       * DA is asymmetric: a sheet is addressed with `.json`, a document with `.html`,
       * and the path you GET is the path you POST. There is no safe default — guessing
       * wrong reads an empty document and then writes it back over a live sheet.
       */
      expect(() => daSourceUrl('/tracker/data/groups/meetups')).to.throw(/explicit ext/);
      expect(() => daSourceUrl('/tracker/data/groups/meetups', '')).to.throw(/explicit ext/);
    });

    it('addresses a sheet with .json and a document with .html', () => {
      expect(daSourceUrl('/tracker/data/groups/meetups', 'json'))
        .to.equal('https://admin.da.live/source/aemgdc/aemdev/tracker/data/groups/meetups.json');
      expect(daSourceUrl('/tracker/tx/de/meetups/berlin', 'html'))
        .to.equal('https://admin.da.live/source/aemgdc/aemdev/tracker/tx/de/meetups/berlin.html');
    });
  });

  describe('txDocPath', () => {
    it('contains the locale exactly once', () => {
      /*
       * Keyed on the locale path, so the locale appears once. The tracker this is
       * ported from doubled it (`/lang-status/de/de/...`) and three readers then had
       * to special-case the duplicate segment.
       */
      const path = txDocPath('/en/meetups/berlin', 'de');
      expect(path).to.equal(`${TRACKER_TX}/de/meetups/berlin`);
      expect(path.split('/').filter((seg) => seg === 'de')).to.have.length(1);
    });

    it('contains the locale exactly once for every locale, from any input path', () => {
      for (const code of TARGET_LOCALES) {
        for (const from of ['/en/meetups/berlin', `/${code}/meetups/berlin`, '/fr/meetups/berlin']) {
          const path = txDocPath(from, code);
          expect(path, `${from} -> ${code}`).to.equal(`${TRACKER_TX}/${code}/meetups/berlin`);
          expect(path.split('/').filter((seg) => seg === code), `${from} -> ${code}`).to.have.length(1);
        }
      }
    });

    it('throws for an unknown locale rather than writing a doc nobody reads', () => {
      expect(() => txDocPath('/en/meetups/berlin', 'xx')).to.throw(/unknown locale/);
    });

    it('keeps the EN QA doc on the EN path', () => {
      expect(qaDocPath('/en/meetups/berlin')).to.equal('/tracker/qa/en/meetups/berlin');
    });
  });

  describe('branchFromUrl', () => {
    it('round-trips previewUrl and liveUrl', () => {
      // A report can carry a URL without the branch it was produced against, and
      // judging a stale branch produces confident nonsense.
      expect(branchFromUrl(previewUrl('/en/meetups/berlin'))).to.equal('main');
      expect(branchFromUrl(liveUrl('/en/meetups/berlin'))).to.equal('main');
    });

    it('round-trips a hyphenated branch name', () => {
      expect(branchFromUrl(previewUrl('/en/meetups/berlin', 'edge-153'))).to.equal('edge-153');
      expect(branchFromUrl(liveUrl('/en/meetups/berlin', 'edge-153'))).to.equal('edge-153');
      // Lower-cased on the way out, so the recovered branch matches the host that
      // actually answered.
      expect(branchFromUrl(previewUrl('/en/meetups/berlin', 'EDGE-153'))).to.equal('edge-153');
    });

    it('returns null for a URL that is not a branch host', () => {
      expect(branchFromUrl(prodUrl('/en/meetups/berlin'))).to.be.null;
      expect(branchFromUrl('https://da.live/edit#/aemgdc/aemdev/en/meetups/berlin')).to.be.null;
      expect(branchFromUrl('')).to.be.null;
      expect(branchFromUrl(null)).to.be.null;
    });
  });

  describe('slugOf', () => {
    it('flattens a path into a filename a human can read in a directory listing', () => {
      expect(slugOf('/en/meetups/berlin')).to.equal('en--meetups--berlin');
      expect(slugOf('/en/meetups/berlin/')).to.equal('en--meetups--berlin');
      expect(slugOf('/')).to.equal('index');
    });
  });

  describe('links', () => {
    it('returns a coherent set for a page and a locale', () => {
      const set = links('/en/meetups/berlin', 'de');
      expect(set).to.deep.equal({
        enPreview: 'https://main--aemdev--aemgdc.aem.page/en/meetups/berlin',
        enLive: 'https://main--aemdev--aemgdc.aem.live/en/meetups/berlin',
        enEdit: 'https://da.live/edit#/aemgdc/aemdev/en/meetups/berlin',
        localePreview: 'https://main--aemdev--aemgdc.aem.page/de/meetups/berlin',
        localeLive: 'https://main--aemdev--aemgdc.aem.live/de/meetups/berlin',
        localeEdit: 'https://da.live/edit#/aemgdc/aemdev/de/meetups/berlin',
        qaDoc: 'https://da.live/edit#/aemgdc/aemdev/tracker/qa/en/meetups/berlin',
        txDoc: 'https://da.live/edit#/aemgdc/aemdev/tracker/tx/de/meetups/berlin',
      });
    });

    it('normalizes to the EN page whatever locale path it is handed', () => {
      const fromLocale = links('/ja/meetups/berlin', 'de');
      expect(fromLocale).to.deep.equal(links('/en/meetups/berlin', 'de'));
      expect(fromLocale.qaDoc).to.equal(daEditUrl(qaDocPath('/en/meetups/berlin')));
    });

    it('carries the branch into both hosts but never into a DA editor link', () => {
      const set = links('/en/meetups/berlin', 'de', 'EDGE-153');
      expect(set.enPreview).to.contain('edge-153--');
      expect(set.localeLive).to.contain('edge-153--');
      // A branch changes the code, never the data: every ref edits the same doc.
      expect(set.localeEdit).to.equal(links('/en/meetups/berlin', 'de').localeEdit);
      expect(set.txDoc).to.equal(links('/en/meetups/berlin', 'de').txDoc);
    });

    it('nulls the locale half when no locale is asked for', () => {
      const set = links('/en/meetups/berlin');
      expect(set.localePreview).to.be.null;
      expect(set.localeLive).to.be.null;
      expect(set.localeEdit).to.be.null;
      expect(set.txDoc).to.be.null;
      // The EN half still resolves, so a row with no locale selected still links out.
      expect(set.enPreview).to.equal(previewUrl('/en/meetups/berlin'));
      expect(set.qaDoc).to.equal(daEditUrl(qaDocPath('/en/meetups/berlin')));
    });
  });

  describe('pageTrackerUrl', () => {
    it('omits the default branch and every empty parameter', () => {
      expect(pageTrackerUrl()).to.equal('https://da.live/app/aemgdc/aemdev/tools/page-tracker');
      expect(pageTrackerUrl({ branch: DEFAULT_BRANCH })).to.not.contain('branch');
    });

    it('carries a group, a locale, a branch and readonly', () => {
      const url = pageTrackerUrl({
        group: 'meetups',
        locale: 'de',
        branch: 'edge-153',
        readonly: true,
      });
      expect(url).to.contain('group=meetups');
      expect(url).to.contain('locale=de');
      expect(url).to.contain('branch=edge-153');
      expect(url).to.contain('readonly=1');
    });
  });
});
