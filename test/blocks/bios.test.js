/*
 * The brick roster: `bios`, the `speakers (bricks)` variant, and the empty-`bio`
 * fallback that makes an already-authored page render one.
 *
 * The fallback is the reason this file exists. `/en/meetups/20260827-aem-meetup-
 * washington-dc` carries an EMPTY `bio` block under its "Meetup Speakers" heading
 * and three slugs in `<meta name="speakers">`. Every assertion about that shape is
 * an assertion about a published page, so the cases here are the real one plus the
 * two an author can reach by accident: a bio mid-edit, and a slug with no document.
 */

import { expect } from '@esm-bundle/chai';
import sinon from 'sinon';
import bios from '../../blocks/bios/bios.js';
import speakers from '../../blocks/speakers/speakers.js';
import bio from '../../blocks/bio/bio.js';

const bioDoc = (name, title, company = '') => `
  <div>
    <div class="bio">
      <div><div>Photo</div><div><picture><img src="/media/bios/x.jpg"></picture></div></div>
      <div><div>Name</div><div>${name}</div></div>
      <div><div>Title</div><div>${title}</div></div>
      ${company ? `<div><div>Company</div><div>${company}</div></div>` : ''}
      <div><div>LinkedIn</div><div><a href="https://www.linkedin.com/in/x/">x</a></div></div>
      <div><div>Bio</div><div><p>Bio copy for ${name}.</p></div></div>
    </div>
  </div>`;

/** The three speakers the DC meetup page really names, in the order it names them. */
const DC = {
  '/en/fragments/bios/tad-reeves': bioDoc('Tad Reeves', 'Principal Architect', 'Arbory Digital'),
  '/en/fragments/bios/greg-dimeris': bioDoc('Greg Dimeris', 'Sr. Technical Product Manager'),
  '/en/fragments/bios/shashi-mulugu': bioDoc('Shashi Mulugu', 'Lead Business Transformation Architect', 'Deloitte Digital'),
};
const DC_META = 'tad-reeves, greg-dimeris, shashi-mulugu';

function stubBios(map) {
  return sinon.stub(window, 'fetch').callsFake((url) => {
    const path = String(url);
    const key = Object.keys(map).find((k) => path.endsWith(`${k}.plain.html`));
    if (!key) return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') });
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(map[key]) });
  });
}

function block(name, html = '') {
  const el = document.createElement('div');
  el.className = name;
  el.innerHTML = html;
  document.body.append(el);
  return el;
}

function setSpeakersMeta(value) {
  document.head.querySelectorAll('meta[name="speakers"]').forEach((m) => m.remove());
  if (value === null) return;
  const meta = document.createElement('meta');
  meta.setAttribute('name', 'speakers');
  meta.setAttribute('content', value);
  document.head.append(meta);
}

const names = (el) => [...el.querySelectorAll('.bio-name')].map((n) => n.textContent);

describe('blocks/bios', () => {
  let fetchStub;

  afterEach(() => {
    fetchStub?.restore();
    fetchStub = null;
    setSpeakersMeta(null);
    document.querySelectorAll('.bios, .speakers, .bio').forEach((el) => el.remove());
  });

  it('renders one brick per slug from the page metadata, in authored order', async () => {
    fetchStub = stubBios(DC);
    setSpeakersMeta(DC_META);
    const el = block('bios');
    await bios(el);

    expect(el.querySelectorAll('.bio-bricks').length).to.equal(1);
    expect(el.querySelectorAll('.bio-bricks > .bio-brick').length).to.equal(3);
    expect(names(el)).to.deep.equal(['Tad Reeves', 'Greg Dimeris', 'Shashi Mulugu']);
    expect(el.classList.contains('bios-decorated')).to.be.true;
  });

  it('renders every field the fragment carries, not just the name', async () => {
    fetchStub = stubBios(DC);
    setSpeakersMeta('tad-reeves');
    const el = block('bios');
    await bios(el);

    const brick = el.querySelector('.bio-brick');
    expect(brick.querySelector('.bio-photo img')).to.not.be.null;
    expect(brick.querySelector('.bio-name').textContent).to.equal('Tad Reeves');
    expect(brick.querySelector('.bio-role').textContent).to.equal('Principal Architect · Arbory Digital');
    expect(brick.querySelector('.bio-body').textContent).to.contain('Bio copy for Tad Reeves.');
    expect(brick.querySelector('.bio-link').getAttribute('href')).to.equal('https://www.linkedin.com/in/x/');
  });

  it('names whose profile each LinkedIn link is, so a row of them is not one link three times', async () => {
    fetchStub = stubBios(DC);
    setSpeakersMeta(DC_META);
    const el = block('bios');
    await bios(el);

    const labels = [...el.querySelectorAll('.bio-link')].map((a) => a.getAttribute('aria-label'));
    expect(labels).to.deep.equal([
      'Tad Reeves on LinkedIn',
      'Greg Dimeris on LinkedIn',
      'Shashi Mulugu on LinkedIn',
    ]);
  });

  it('prefers slugs authored in the block over the page metadata', async () => {
    fetchStub = stubBios({ ...DC, '/en/fragments/bios/from-block': bioDoc('From Block', 'X') });
    setSpeakersMeta(DC_META);
    const el = block('bios', '<div><div>from-block</div></div>');
    await bios(el);
    expect(names(el)).to.deep.equal(['From Block']);
  });

  it('shows a visible placeholder brick for a slug with no document', async () => {
    fetchStub = stubBios({ '/en/fragments/bios/tad-reeves': DC['/en/fragments/bios/tad-reeves'] });
    setSpeakersMeta('tad-reeves, wilson-faure');
    const el = block('bios');
    await bios(el);

    const missing = el.querySelector('.bio-brick.bio-missing');
    expect(missing).to.not.be.null;
    expect(missing.querySelector('.bio-name').textContent).to.equal('wilson-faure');
    expect(missing.querySelector('.bio-role').textContent).to.equal('No bio yet');
    expect(el.querySelectorAll('.bio-brick').length).to.equal(2);
  });

  it('removes itself when there is nothing to show', async () => {
    fetchStub = stubBios({});
    const el = block('bios');
    await bios(el);
    expect(el.isConnected).to.be.false;
  });

  /*
   * Semantics, not decoration. A roster of people rendered as divs full of
   * paragraphs is unreachable by the two things a screen-reader user navigates
   * with — headings and lists — so these are behaviour, and they were a review
   * finding rather than an original guess.
   */
  it('renders the roster as a list of people, each name a heading', async () => {
    fetchStub = stubBios(DC);
    setSpeakersMeta(DC_META);
    const el = block('bios');
    await bios(el);

    const grid = el.querySelector('.bio-bricks');
    expect(grid.tagName).to.equal('UL');
    // `list-style: none` is enough for Safari to drop the list role.
    expect(grid.getAttribute('role')).to.equal('list');
    expect([...grid.children].map((c) => c.tagName)).to.deep.equal(['LI', 'LI', 'LI']);
    expect([...el.querySelectorAll('.bio-name')].map((n) => n.tagName))
      .to.deep.equal(['H3', 'H3', 'H3']);
  });

  it('gives the orphan placeholder the same list-item and heading shape', async () => {
    fetchStub = stubBios({});
    setSpeakersMeta('nobody-here-yet');
    const el = block('bios');
    await bios(el);

    const missing = el.querySelector('.bio-brick.bio-missing');
    expect(missing.tagName).to.equal('LI');
    expect(missing.querySelector('.bio-name').tagName).to.equal('H3');
  });

  /*
   * bios.js loads blocks/bio/bio.css by hand — loadBlock only fetches the
   * stylesheet named after the block — so deleting that one line would ship an
   * unstyled roster with every other test still green. This asserts the
   * stylesheet arrived AND that the rule the overflow fix turns on is in it.
   */
  it('loads bio.css, and its copy column breaks a word that would escape a brick', async () => {
    fetchStub = stubBios(DC);
    setSpeakersMeta('tad-reeves');
    const el = block('bios');
    await bios(el);

    expect(document.querySelector('head > link[href$="/blocks/bio/bio.css"]')).to.not.be.null;
    const copy = el.querySelector('.bio-brick .bio-copy');
    expect(window.getComputedStyle(copy).overflowWrap).to.equal('break-word');
  });

  it('uses an absolute token verbatim, for another locale\'s bios', async () => {
    fetchStub = stubBios({ '/de/fragments/bios/andreas-haller': bioDoc('Andreas Haller', 'X') });
    setSpeakersMeta('/de/fragments/bios/andreas-haller');
    const el = block('bios');
    await bios(el);
    expect(names(el)).to.deep.equal(['Andreas Haller']);
  });

  it('resolves ./media_ URLs against the bio document, not the host page', async () => {
    fetchStub = sinon.stub(window, 'fetch').callsFake(() => Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(`
        <div><div class="bio">
          <div><div>Photo</div><div><picture>
            <source type="image/webp" srcset="./media_abc123.jpg?width=2000&amp;format=webply" media="(min-width: 600px)">
            <img loading="lazy" alt="" src="./media_abc123.jpg?width=750&amp;format=jpg" width="200" height="200">
          </picture></div></div>
          <div><div>Name</div><div>Tad Reeves</div></div>
        </div></div>`),
    }));
    setSpeakersMeta('tad-reeves');
    const el = block('bios');
    await bios(el);

    const img = el.querySelector('.bio-brick .bio-photo img');
    expect(img.getAttribute('src')).to.equal('/en/fragments/bios/media_abc123.jpg?width=750&format=jpg');
    expect(el.querySelector('.bio-brick source').getAttribute('srcset'))
      .to.match(/^\/en\/fragments\/bios\/media_abc123\.jpg\?/);
  });
});

describe('blocks/speakers bricks variant', () => {
  let fetchStub;

  afterEach(() => {
    fetchStub?.restore();
    fetchStub = null;
    setSpeakersMeta(null);
    document.querySelectorAll('.speakers').forEach((el) => el.remove());
  });

  it('lays the roster out as bricks instead of rows', async () => {
    fetchStub = stubBios(DC);
    setSpeakersMeta(DC_META);
    const el = block('speakers bricks');
    await speakers(el);

    expect(el.querySelectorAll('.bio-bricks > .bio-brick').length).to.equal(3);
    expect(el.querySelector('.speakers-list')).to.be.null;
    expect(el.classList.contains('speakers-decorated')).to.be.true;
  });

  it('renders the orphan placeholder as a brick, not a row', async () => {
    fetchStub = stubBios({ '/en/fragments/bios/tad-reeves': DC['/en/fragments/bios/tad-reeves'] });
    setSpeakersMeta('tad-reeves, nobody-here-yet');
    const el = block('speakers bricks');
    await speakers(el);

    const missing = el.querySelector('.bio-brick.bio-missing');
    expect(missing).to.not.be.null;
    expect(missing.tagName).to.equal('LI');
    expect(missing.querySelector('.bio-name').textContent).to.equal('nobody-here-yet');
    expect(el.querySelector('.speakers-missing')).to.be.null;
  });

  it('still renders rows without the variant', async () => {
    fetchStub = stubBios(DC);
    setSpeakersMeta(DC_META);
    const el = block('speakers');
    await speakers(el);

    expect(el.querySelector('.speakers-list')).to.not.be.null;
    expect(el.querySelectorAll('.bio-brick').length).to.equal(0);
  });
});

/*
 * The published shape: an EMPTY `bio` block, a heading above it, and the roster in
 * page metadata. This is what the DC meetup page carries today, so if this describe
 * block goes red that page has an empty strip where its speakers should be.
 */
describe('blocks/bio roster fallback', () => {
  let fetchStub;

  afterEach(() => {
    fetchStub?.restore();
    fetchStub = null;
    setSpeakersMeta(null);
    document.querySelectorAll('.bio').forEach((el) => el.remove());
  });

  it('renders the page roster from an empty bio block', async () => {
    fetchStub = stubBios(DC);
    setSpeakersMeta(DC_META);
    // Exactly what the pipeline delivers for a `bio` block with one blank row.
    const el = block('bio', '<div><div></div></div>');
    await bio(el);

    expect(names(el)).to.deep.equal(['Tad Reeves', 'Greg Dimeris', 'Shashi Mulugu']);
    expect(el.classList.contains('bio-roster')).to.be.true;
  });

  it('renders the roster from a bio block with no rows at all', async () => {
    fetchStub = stubBios(DC);
    setSpeakersMeta('tad-reeves');
    const el = block('bio');
    await bio(el);
    expect(names(el)).to.deep.equal(['Tad Reeves']);
  });

  it('takes slugs authored in the block when there are any', async () => {
    fetchStub = stubBios(DC);
    setSpeakersMeta('tad-reeves');
    const el = block('bio', '<div><div>greg-dimeris</div></div><div><div>shashi-mulugu</div></div>');
    await bio(el);
    expect(names(el)).to.deep.equal(['Greg Dimeris', 'Shashi Mulugu']);
  });

  it('leaves a bio that is mid-edit alone rather than replacing it with the roster', async () => {
    fetchStub = stubBios(DC);
    setSpeakersMeta(DC_META);
    const el = block('bio', '<div><div>Title</div><div>Principal Architect</div></div>');
    const before = el.innerHTML;
    await bio(el);

    expect(el.innerHTML).to.equal(before);
    expect(el.classList.contains('bio-roster')).to.be.false;
    expect(fetchStub.called).to.be.false;
  });

  it('still renders a complete bio as one bio, not a one-brick roster', async () => {
    fetchStub = stubBios(DC);
    setSpeakersMeta(DC_META);
    const el = block('bio', '<div><div>Name</div><div>Eric Van Geem</div></div>');
    await bio(el);

    expect(el.classList.contains('bio-decorated')).to.be.true;
    expect(el.querySelector('.bio-bricks')).to.be.null;
    expect(names(el)).to.deep.equal(['Eric Van Geem']);
  });

  it('removes an empty bio block on a page with no roster', async () => {
    fetchStub = stubBios({});
    const el = block('bio', '<div><div></div></div>');
    await bio(el);
    expect(el.isConnected).to.be.false;
  });
});
