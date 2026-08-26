import { expect } from '@esm-bundle/chai';
import sinon from 'sinon';
import decorate from '../../blocks/home-hero/home-hero.js';

/** Build a home-hero block from `key | value` rows, the way DA authors it. */
function block(rows) {
  const el = document.createElement('div');
  el.className = 'home-hero';
  el.innerHTML = rows
    .map(([key, value]) => `<div><div>${key}</div><div>${value}</div></div>`)
    .join('');
  document.body.append(el);
  return el;
}

function stubIndex(data) {
  return sinon.stub(window, 'fetch').callsFake(() => Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ data }),
  }));
}

/* The auto lookup deliberately does not block the hero's first paint, so the
   panel lands a few microtasks after decorate() resolves. */
async function settled(el, predicate, tries = 50) {
  for (let i = 0; i < tries; i += 1) {
    if (predicate(el)) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 5); });
  }
  return predicate(el);
}

const HERO_ROWS = [
  ['kicker', '// AEM Global Developer Collective'],
  ['heading', 'Where AEM Practitioners Build Together.'],
];

const row = (over = {}) => ({
  path: '/en/meetups/x',
  title: 'X',
  description: '',
  image: '',
  location: '',
  eventDate: '',
  status: 'upcoming',
  ...over,
});

describe('home-hero next-meetup promo', () => {
  afterEach(() => {
    document.querySelectorAll('.home-hero').forEach((el) => el.remove());
    if (window.fetch.restore) window.fetch.restore();
  });

  it('renders an authored event and never asks the index for one', async () => {
    const fetchStub = stubIndex([]);
    const el = block([
      ...HERO_ROWS,
      ['event-kicker', 'Next AEM Meetup'],
      ['event-title', "Adobe's New AI-Powered Agentic CMS"],
      ['event-dek', 'An Adobe Champions doubleheader.'],
      ['event-date', '2026-08-27'],
      ['event-location', 'McLean, VA'],
      ['event-image', 'https://example.com/poster.jpg'],
      ['event-link', '/en/meetups/aem-meetup-washington-dc'],
      ['event-cta', '<a href="https://usergroups.adobe.com/e/1">Register free →</a>'],
    ]);
    await decorate(el);

    const panel = el.querySelector('.home-hero-event');
    expect(panel).to.exist;
    expect(fetchStub.called).to.be.false;
    expect(el.querySelector('.home-hero-inner').classList.contains('home-hero-inner-split')).to.be.true;
    expect(panel.querySelector('.home-hero-event-kicker').textContent).to.equal('Next AEM Meetup');
    expect(panel.querySelector('.home-hero-event-title').textContent).to.equal("Adobe's New AI-Powered Agentic CMS");
    expect(panel.querySelector('.home-hero-event-dek').textContent).to.equal('An Adobe Champions doubleheader.');
    expect(panel.querySelector('.home-hero-event-main').getAttribute('href')).to.equal('/en/meetups/aem-meetup-washington-dc');
    expect(panel.querySelector('.home-hero-event-media img').getAttribute('src')).to.equal('https://example.com/poster.jpg');

    const meta = [...panel.querySelectorAll('.home-hero-event-meta span')].map((s) => s.textContent);
    expect(meta).to.deep.equal(['Thu, Aug 27, 2026', 'McLean, VA']);

    const cta = panel.querySelector('.home-hero-event-cta');
    expect(cta.textContent).to.equal('Register free →');
    expect(cta.getAttribute('href')).to.equal('https://usergroups.adobe.com/e/1');
    /* An offsite registration link opens away from the site; an internal one
       must not (asserted in the auto case below). */
    expect(cta.getAttribute('target')).to.equal('_blank');
  });

  it('prints a non-ISO date exactly as the author wrote it', async () => {
    const el = block([...HERO_ROWS, ['event-title', 'X'], ['event-date', '27 Aug, 6–9PM ET']]);
    await decorate(el);
    expect(el.querySelector('.home-hero-event-meta span').textContent).to.equal('27 Aug, 6–9PM ET');
  });

  it('falls back to the soonest upcoming event in the index', async () => {
    stubIndex([
      row({ path: '/en/meetups/recap', title: 'Old recap', eventDate: '2099-01-01', status: 'recap' }),
      row({ path: '/en/meetups/munich', title: 'Munich', eventDate: '2099-10-02' }),
      row({
        path: '/en/meetups/dc', title: 'Washington DC', eventDate: '2099-08-27', location: 'Washington, DC',
      }),
      row({ path: '/en/meetups/miami', title: 'Miami', eventDate: '', status: 'announced' }),
      row({ path: '/en/meetups/past', title: 'Last year', eventDate: '2000-01-01' }),
    ]);
    const el = block(HERO_ROWS);
    await decorate(el);
    await settled(el, (e) => !e.querySelector('.home-hero-event-pending'));

    const panel = el.querySelector('.home-hero-event');
    expect(panel.querySelector('.home-hero-event-title').textContent).to.equal('Washington DC');
    expect(panel.querySelector('.home-hero-event-kicker').textContent).to.equal('Next AEM Meetup');
    expect(panel.querySelector('.home-hero-event-main').getAttribute('href')).to.equal('/en/meetups/dc');

    const cta = panel.querySelector('.home-hero-event-cta');
    expect(cta.textContent).to.equal('Event details →');
    expect(cta.getAttribute('target')).to.equal(null);
  });

  it('keeps a dateless announced event behind a dated one', async () => {
    stubIndex([
      row({ path: '/en/meetups/miami', title: 'Miami', eventDate: '', status: 'announced' }),
      row({ path: '/en/meetups/munich', title: 'Munich', eventDate: '2099-10-02' }),
    ]);
    const el = block(HERO_ROWS);
    await decorate(el);
    await settled(el, (e) => !e.querySelector('.home-hero-event-pending'));
    expect(el.querySelector('.home-hero-event-title').textContent).to.equal('Munich');
  });

  it('drops the panel and the split column when nothing is upcoming', async () => {
    stubIndex([row({ title: 'Last year', eventDate: '2000-01-01' })]);
    const el = block(HERO_ROWS);
    await decorate(el);
    await settled(el, (e) => !e.querySelector('.home-hero-event'));

    expect(el.querySelector('.home-hero-event')).to.not.exist;
    expect(el.querySelector('.home-hero-inner').classList.contains('home-hero-inner-split')).to.be.false;
  });

  it('drops the panel when the index cannot be reached', async () => {
    sinon.stub(window, 'fetch').callsFake(() => Promise.reject(new Error('offline')));
    const el = block(HERO_ROWS);
    await decorate(el);
    await settled(el, (e) => !e.querySelector('.home-hero-event'));
    expect(el.querySelector('.home-hero-event')).to.not.exist;
  });

  it('never looks anything up when event-auto is off', async () => {
    const fetchStub = stubIndex([row({ title: 'Munich', eventDate: '2099-10-02' })]);
    const el = block([...HERO_ROWS, ['event-auto', 'off']]);
    await decorate(el);
    await settled(el, () => fetchStub.called, 5);

    expect(fetchStub.called).to.be.false;
    expect(el.querySelector('.home-hero-event')).to.not.exist;
  });

  it('reads the index path the author pointed it at', async () => {
    const fetchStub = stubIndex([row({ title: 'Munich', eventDate: '2099-10-02' })]);
    const el = block([...HERO_ROWS, ['event-index', '/de/query-index.json']]);
    await decorate(el);
    await settled(el, (e) => !e.querySelector('.home-hero-event-pending'));
    expect(fetchStub.firstCall.args[0]).to.equal('/de/query-index.json');
  });

  it('leaves the hero alone when there is no event at all', async () => {
    const el = block([...HERO_ROWS, ['event-auto', 'off']]);
    await decorate(el);
    expect(el.querySelector('.home-hero-h1').textContent).to.equal('Where AEM Practitioners Build Together.');
    expect(el.querySelector('.home-hero-inner')).to.exist;
    expect(el.querySelector('.home-hero-inner').classList.contains('home-hero-inner-split')).to.be.false;
  });
});
