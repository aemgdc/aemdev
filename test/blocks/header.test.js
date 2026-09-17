import { expect } from '@esm-bundle/chai';
import sinon from 'sinon';
import { setConfig } from '../../scripts/ak.js';
import init from '../../blocks/header/header.js';
import { ALL_LOCALES, locale as localeByCode } from '../../scripts/tracker/locales.js';

/*
 * `loadArea` decorates every link in the fragment, and `decorateLink` reads
 * `hostnames` and `linkBlocks` off the config with no guard. Without a config the
 * fragment still decorates — the failure is swallowed — but each link logs, which
 * buries a real failure in noise.
 */
setConfig({ hostnames: [], linkBlocks: [] });

/*
 * The header is authored as one fragment, so these tests drive the real entry point
 * with the real DA markup rather than calling the private decorators: the thing most
 * likely to break is the contract between what an author writes and what the block
 * looks for, and only the whole path exercises that.
 */
const NAV_HTML = `<body><header></header><main>
  <div><p><a href="/en/">AEM Global Developer Collective</a></p><p><a href="/tools/widgets/toggle">Toggle menu</a></p></div>
  <div><ul><li><a href="/en/">Articles</a></li></ul></div>
  <div><p><a href="/tools/widgets/language">Language</a></p><p><a href="https://usergroups.adobe.com/x">Join the Collective!</a></p></div>
</main><footer></footer></body>`;

async function buildHeader() {
  const el = document.createElement('header');
  document.body.append(el);
  await init(el);
  return el;
}

/** Run `fn` as if the reader were on `pathname`. */
async function atPath(pathname, fn) {
  const restore = window.location.pathname + window.location.search;
  window.history.pushState({}, '', pathname);
  try {
    await fn();
  } finally {
    window.history.pushState({}, '', restore);
  }
}

describe('header language selector', () => {
  let fetchStub;

  beforeEach(() => {
    fetchStub = sinon.stub(window, 'fetch').callsFake(() => Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(NAV_HTML),
    }));
  });

  afterEach(() => {
    fetchStub.restore();
    document.querySelectorAll('header').forEach((el) => el.remove());
  });

  it('sits in the actions row, immediately before the CTA', async () => {
    const el = await buildHeader();
    const actions = el.querySelector('.actions-section .default-content');
    const [first, second] = actions.children;

    expect(first.classList.contains('action-wrapper')).to.be.true;
    expect(first.classList.contains('globe')).to.be.true;
    expect(second.querySelector('.btn-accent')).to.exist;
  });

  it('draws a globe and the active locale code', async () => {
    await atPath('/de/meetups/berlin', async () => {
      const el = await buildHeader();
      const btn = el.querySelector('.action-wrapper.globe button');

      expect(btn.querySelector('.icon-globe svg circle')).to.exist;
      expect(btn.querySelector('.lang-code').textContent).to.equal('de');
      // The code alone is not a language name, so the accessible name spells it out.
      expect(btn.getAttribute('aria-label')).to.equal('Language: German');
      expect(btn.getAttribute('aria-haspopup')).to.equal('true');
      expect(btn.getAttribute('aria-expanded')).to.equal('false');
    });
  });

  it('offers every registered locale, linking to the same page', async () => {
    await atPath('/en/meetups/berlin', async () => {
      const el = await buildHeader();
      const links = [...el.querySelectorAll('.language-menu a')];

      expect(links.length).to.equal(ALL_LOCALES.length);
      expect(links.map((a) => a.getAttribute('hreflang'))).to.eql(ALL_LOCALES);
      expect(links.map((a) => new URL(a.href).pathname))
        .to.eql(ALL_LOCALES.map((code) => `/${code}/meetups/berlin`));
      expect(links.map((a) => a.textContent))
        .to.eql(ALL_LOCALES.map((code) => `${code}${localeByCode(code).native}`));

      const current = el.querySelectorAll('.language-menu [aria-current]');
      expect(current.length).to.equal(1);
      expect(current[0].getAttribute('hreflang')).to.equal('en');
    });
  });

  /*
   * `/tracker/**` and the site root sit in no locale tree. There is no German twin of
   * `/tracker/queues` to link to, so the picker must offer the locale home instead of
   * inventing `/de/tracker/queues`.
   */
  it('falls back to locale homes off the locale tree', async () => {
    await atPath('/tracker/queues', async () => {
      const el = await buildHeader();
      const links = [...el.querySelectorAll('.language-menu a')];

      expect(links.map((a) => new URL(a.href).pathname))
        .to.eql(ALL_LOCALES.map((code) => `/${code}`));
      expect(el.querySelector('.lang-code').textContent).to.equal('en');
    });
  });

  it('toggles the menu and keeps aria-expanded in step', async () => {
    const el = await buildHeader();
    const wrapper = el.querySelector('.action-wrapper.globe');
    const btn = wrapper.querySelector('button');

    btn.click();
    expect(wrapper.classList.contains('is-open')).to.be.true;
    expect(btn.getAttribute('aria-expanded')).to.equal('true');

    btn.click();
    expect(wrapper.classList.contains('is-open')).to.be.false;
    expect(btn.getAttribute('aria-expanded')).to.equal('false');
  });

  it('closes on a click outside and resets the button', async () => {
    const el = await buildHeader();
    const wrapper = el.querySelector('.action-wrapper.globe');
    const btn = wrapper.querySelector('button');

    btn.click();
    document.body.click();

    expect(wrapper.classList.contains('is-open')).to.be.false;
    expect(btn.getAttribute('aria-expanded')).to.equal('false');
  });

  it('closes on Escape', async () => {
    const el = await buildHeader();
    const wrapper = el.querySelector('.action-wrapper.globe');
    const btn = wrapper.querySelector('button');

    btn.click();
    wrapper.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(wrapper.classList.contains('is-open')).to.be.false;
    expect(btn.getAttribute('aria-expanded')).to.equal('false');
  });
});
