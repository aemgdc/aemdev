import { expect } from '@esm-bundle/chai';
import decorate, { buildBio, parseBio } from '../../blocks/bio/bio.js';

/** Build a `.bio` block from key/value rows, the way DA authors one. */
function block(rows) {
  const el = document.createElement('div');
  el.className = 'bio';
  el.innerHTML = rows.map(([k, v]) => `<div><div>${k}</div><div>${v}</div></div>`).join('');
  return el;
}

const FULL = [
  ['Photo', '<picture><img src="/media/bios/eric.jpg"></picture>'],
  ['Name', 'Eric Van Geem'],
  ['Title', 'Director, Technology'],
  ['Company', 'Huge'],
  ['LinkedIn', '<a href="https://www.linkedin.com/in/ericvangeem/">linkedin.com</a>'],
  ['Bio', '<p>Builds EDS at scale.</p><p>Second paragraph.</p>'],
];

describe('blocks/bio', () => {
  describe('parseBio', () => {
    it('reads every field out of a key/value block', () => {
      const bio = parseBio(block(FULL));
      expect(bio.name).to.equal('Eric Van Geem');
      expect(bio.title).to.equal('Director, Technology');
      expect(bio.company).to.equal('Huge');
      expect(bio.link).to.equal('https://www.linkedin.com/in/ericvangeem/');
      expect(bio.picture).to.not.be.null;
      expect(bio.body.textContent).to.contain('Builds EDS at scale.');
    });

    it('does not care about row order', () => {
      const bio = parseBio(block([...FULL].reverse()));
      expect(bio.name).to.equal('Eric Van Geem');
      expect(bio.company).to.equal('Huge');
    });

    it('ignores an unknown key instead of rendering it', () => {
      const bio = parseBio(block([...FULL, ['Fee', 'Nine million dollars']]));
      expect(bio.name).to.equal('Eric Van Geem');
      expect(JSON.stringify(bio)).to.not.contain('million');
    });

    it('accepts a bare URL in the LinkedIn cell', () => {
      const bio = parseBio(block([['Name', 'A'], ['LinkedIn', 'https://example.com/a']]));
      expect(bio.link).to.equal('https://example.com/a');
    });

    it('rejects a LinkedIn cell that is not a URL', () => {
      const bio = parseBio(block([['Name', 'A'], ['LinkedIn', 'ask me']]));
      expect(bio.link).to.equal('');
    });

    it('takes Role as a synonym for Title', () => {
      const bio = parseBio(block([['Name', 'A'], ['Role', 'Architect']]));
      expect(bio.title).to.equal('Architect');
    });
  });

  describe('buildBio', () => {
    it('joins title and company with a middot', () => {
      const el = document.createElement('div');
      el.append(buildBio(parseBio(block(FULL))));
      expect(el.querySelector('.bio-role').textContent).to.equal('Director, Technology · Huge');
    });

    it('omits the role line when there is no title or company', () => {
      const el = document.createElement('div');
      el.append(buildBio(parseBio(block([['Name', 'A']]))));
      expect(el.querySelector('.bio-role')).to.be.null;
    });

    it('falls back to initials when there is no photo', () => {
      const el = document.createElement('div');
      el.append(buildBio(parseBio(block([['Name', 'Eric Van Geem']]))));
      const photo = el.querySelector('.bio-photo');
      expect(photo.classList.contains('bio-photo-initials')).to.be.true;
      expect(photo.textContent).to.equal('EG');
    });

    it('uses two letters of a single-word name', () => {
      const el = document.createElement('div');
      el.append(buildBio(parseBio(block([['Name', 'Prince']]))));
      expect(el.querySelector('.bio-photo').textContent).to.equal('PR');
    });

    it('gives the photo an alt of the name and lazy loading', () => {
      const el = document.createElement('div');
      el.append(buildBio(parseBio(block(FULL))));
      const img = el.querySelector('.bio-photo img');
      expect(img.getAttribute('alt')).to.equal('Eric Van Geem');
      expect(img.getAttribute('loading')).to.equal('lazy');
    });

    it('rebuilds the link so authored button classes do not leak through', () => {
      const rows = [['Name', 'A'], ['LinkedIn', '<a class="btn btn-primary" href="https://x.co/a">x</a>']];
      const el = document.createElement('div');
      el.append(buildBio(parseBio(block(rows))));
      const link = el.querySelector('.bio-link');
      expect(link.className).to.equal('bio-link');
      expect(link.href).to.equal('https://x.co/a');
      expect(link.rel).to.equal('noopener');
    });

    it('drops an empty bio body rather than rendering a blank div', () => {
      const el = document.createElement('div');
      el.append(buildBio(parseBio(block([['Name', 'A'], ['Bio', '<p>  </p>']]))));
      expect(el.querySelector('.bio-body')).to.be.null;
    });
  });

  describe('decorate', () => {
    it('replaces the authored table with the rendered bio', () => {
      const el = block(FULL);
      decorate(el);
      expect(el.classList.contains('bio-decorated')).to.be.true;
      expect(el.querySelector('.bio-name').textContent).to.equal('Eric Van Geem');
      expect(el.querySelectorAll(':scope > div').length).to.equal(2);
    });

    it('leaves a nameless block untouched instead of rendering an empty card', () => {
      const el = block([['Title', 'Architect']]);
      const before = el.innerHTML;
      decorate(el);
      expect(el.innerHTML).to.equal(before);
      expect(el.classList.contains('bio-decorated')).to.be.false;
    });
  });
});
