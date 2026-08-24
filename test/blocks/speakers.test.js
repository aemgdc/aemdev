import { expect } from '@esm-bundle/chai';
import sinon from 'sinon';
import decorate from '../../blocks/speakers/speakers.js';

const bioDoc = (name, title) => `
  <div>
    <div class="bio">
      <div><div>Photo</div><div><picture><img src="/media/bios/x.jpg"></picture></div></div>
      <div><div>Name</div><div>${name}</div></div>
      <div><div>Title</div><div>${title}</div></div>
      <div><div>Bio</div><div><p>Bio copy for ${name}.</p></div></div>
    </div>
  </div>`;

/** Fake content bus: known paths return a bio doc, everything else 404s. */
function stubBios(map) {
  return sinon.stub(window, 'fetch').callsFake((url) => {
    const path = String(url);
    const body = Object.keys(map).find((k) => path.endsWith(`${k}.plain.html`));
    if (!body) return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') });
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(map[body]) });
  });
}

function block(html = '') {
  const el = document.createElement('div');
  el.className = 'speakers';
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

describe('blocks/speakers', () => {
  let fetchStub;

  afterEach(() => {
    fetchStub?.restore();
    fetchStub = null;
    setSpeakersMeta(null);
    document.querySelectorAll('.speakers').forEach((el) => el.remove());
  });

  it('renders one row per slug from the page metadata', async () => {
    fetchStub = stubBios({
      '/en/fragments/bios/tad-reeves': bioDoc('Tad Reeves', 'Principal Architect'),
      '/en/fragments/bios/laurel-timko': bioDoc('Laurel Timko', 'Senior Software Engineer'),
    });
    setSpeakersMeta('tad-reeves, laurel-timko');
    const el = block();
    await decorate(el);

    const names = [...el.querySelectorAll('.bio-name')].map((n) => n.textContent);
    expect(names).to.deep.equal(['Tad Reeves', 'Laurel Timko']);
    expect(el.classList.contains('speakers-decorated')).to.be.true;
  });

  it('keeps the authored order, not the order the fetches resolve in', async () => {
    fetchStub = stubBios({
      '/en/fragments/bios/a-one': bioDoc('A One', 'X'),
      '/en/fragments/bios/b-two': bioDoc('B Two', 'Y'),
      '/en/fragments/bios/c-three': bioDoc('C Three', 'Z'),
    });
    setSpeakersMeta('c-three, a-one, b-two');
    const el = block();
    await decorate(el);
    const names = [...el.querySelectorAll('.bio-name')].map((n) => n.textContent);
    expect(names).to.deep.equal(['C Three', 'A One', 'B Two']);
  });

  it('prefers slugs authored in the block over the page metadata', async () => {
    fetchStub = stubBios({
      '/en/fragments/bios/from-block': bioDoc('From Block', 'X'),
      '/en/fragments/bios/from-meta': bioDoc('From Meta', 'Y'),
    });
    setSpeakersMeta('from-meta');
    const el = block('<div><div>bios</div><div>from-block</div></div>');
    await decorate(el);
    const names = [...el.querySelectorAll('.bio-name')].map((n) => n.textContent);
    expect(names).to.deep.equal(['From Block']);
  });

  it('reads a one-slug-per-row single-column block', async () => {
    fetchStub = stubBios({
      '/en/fragments/bios/one': bioDoc('One', 'X'),
      '/en/fragments/bios/two': bioDoc('Two', 'Y'),
    });
    const el = block('<div><div>one</div></div><div><div>two</div></div>');
    await decorate(el);
    expect(el.querySelectorAll('.bio').length).to.equal(2);
  });

  it('skips a label-only cell so "Speakers" is not treated as a slug', async () => {
    fetchStub = stubBios({ '/en/fragments/bios/real-one': bioDoc('Real One', 'X') });
    const el = block('<div><div>Speakers</div></div><div><div>real-one</div></div>');
    await decorate(el);
    const names = [...el.querySelectorAll('.bio-name')].map((n) => n.textContent);
    expect(names).to.deep.equal(['Real One']);
  });

  it('shows a visible placeholder for a slug with no document', async () => {
    fetchStub = stubBios({ '/en/fragments/bios/exists': bioDoc('Exists', 'X') });
    setSpeakersMeta('exists, wilson-faure');
    const el = block();
    await decorate(el);

    const missing = el.querySelector('.speakers-missing');
    expect(missing).to.not.be.null;
    expect(missing.querySelector('.bio-name').textContent).to.equal('wilson-faure');
    expect(missing.querySelector('.bio-role').textContent).to.equal('No bio yet');
    expect(el.querySelectorAll('.bio').length).to.equal(2);
  });

  it('shows a placeholder when the document exists but has no name', async () => {
    fetchStub = stubBios({
      '/en/fragments/bios/blank': '<div><div class="bio"><div><div>Title</div><div>X</div></div></div></div>',
    });
    setSpeakersMeta('blank');
    const el = block();
    await decorate(el);
    expect(el.querySelector('.speakers-missing')).to.not.be.null;
  });

  it('survives a network error on one bio', async () => {
    fetchStub = sinon.stub(window, 'fetch').callsFake((url) => (
      String(url).includes('good')
        ? Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(bioDoc('Good', 'X')) })
        : Promise.reject(new Error('offline'))
    ));
    setSpeakersMeta('good, bad');
    const el = block();
    await decorate(el);
    expect(el.querySelectorAll('.bio').length).to.equal(2);
    expect(el.querySelector('.speakers-missing .bio-name').textContent).to.equal('bad');
  });

  it('removes itself when there is nothing to show', async () => {
    fetchStub = stubBios({});
    const el = block();
    await decorate(el);
    expect(el.isConnected).to.be.false;
  });

  it('ignores tokens that are not slug-shaped', async () => {
    fetchStub = stubBios({});
    setSpeakersMeta('TBD, Not A Slug');
    const el = block();
    await decorate(el);
    expect(el.isConnected).to.be.false;
  });

  it('uses an absolute token verbatim, for other locales', async () => {
    fetchStub = stubBios({ '/de/fragments/bios/andreas-haller': bioDoc('Andreas Haller', 'X') });
    setSpeakersMeta('/de/fragments/bios/andreas-haller');
    const el = block();
    await decorate(el);
    expect(el.querySelector('.bio-name').textContent).to.equal('Andreas Haller');
  });
});

describe('blocks/speakers media URLs', () => {
  let fetchStub;

  const pipelineDoc = (name) => `
    <div>
      <div class="bio">
        <div><div>Photo</div><div><picture>
          <source type="image/webp" srcset="./media_abc123.jpg?width=2000&amp;format=webply" media="(min-width: 600px)">
          <source type="image/jpeg" srcset="./media_abc123.jpg?width=750&amp;format=jpg">
          <img loading="lazy" alt="" src="./media_abc123.jpg?width=750&amp;format=jpg" width="200" height="200">
        </picture></div></div>
        <div><div>Name</div><div>${name}</div></div>
      </div>
    </div>`;

  afterEach(() => {
    fetchStub?.restore();
    fetchStub = null;
    document.head.querySelectorAll('meta[name="speakers"]').forEach((m) => m.remove());
    document.querySelectorAll('.speakers').forEach((el) => el.remove());
  });

  /**
   * The pipeline emits `./media_<hash>` relative to the bio document. Moving
   * that markup onto a host page in another folder must not leave it relative,
   * or every headshot 404s.
   */
  it('resolves ./media_ URLs against the bio document, not the host page', async () => {
    fetchStub = sinon.stub(window, 'fetch').callsFake(() => Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(pipelineDoc('Eric Van Geem')),
    }));
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'speakers');
    meta.setAttribute('content', 'eric-van-geem');
    document.head.append(meta);

    const el = document.createElement('div');
    el.className = 'speakers';
    document.body.append(el);
    await decorate(el);

    const img = el.querySelector('.bio-photo img');
    expect(img.getAttribute('src')).to.equal('/en/fragments/bios/media_abc123.jpg?width=750&format=jpg');
    expect(img.getAttribute('src')).to.not.contain('./');

    const sources = [...el.querySelectorAll('.bio-photo source')];
    expect(sources.length).to.equal(2);
    sources.forEach((s) => {
      expect(s.getAttribute('srcset')).to.match(/^\/en\/fragments\/bios\/media_abc123\.jpg\?/);
    });
  });

  it('leaves an already-absolute image URL alone', async () => {
    fetchStub = sinon.stub(window, 'fetch').callsFake(() => Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(`
        <div><div class="bio">
          <div><div>Photo</div><div><picture><img src="/media/bios/eric.jpg"></picture></div></div>
          <div><div>Name</div><div>Eric</div></div>
        </div></div>`),
    }));
    const el = document.createElement('div');
    el.className = 'speakers';
    el.innerHTML = '<div><div>eric-van-geem</div></div>';
    document.body.append(el);
    await decorate(el);
    expect(el.querySelector('.bio-photo img').getAttribute('src')).to.equal('/media/bios/eric.jpg');
  });

  it('resolves against an absolute token path too', async () => {
    fetchStub = sinon.stub(window, 'fetch').callsFake(() => Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(pipelineDoc('Andreas Haller')),
    }));
    const el = document.createElement('div');
    el.className = 'speakers';
    el.innerHTML = '<div><div>/de/fragments/bios/andreas-haller</div></div>';
    document.body.append(el);
    await decorate(el);
    expect(el.querySelector('.bio-photo img').getAttribute('src'))
      .to.equal('/de/fragments/bios/media_abc123.jpg?width=750&format=jpg');
  });
});
