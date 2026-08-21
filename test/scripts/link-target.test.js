import { expect } from '@esm-bundle/chai';
import decorateLinkTargets from '../../scripts/utils/link-target.js';

/** Decorate a throwaway area built from an href list, and read the links back. */
function decorate(...hrefs) {
  const area = document.createElement('div');
  area.innerHTML = hrefs.map((href) => `<a href="${href}">link</a>`).join('');
  decorateLinkTargets(area);
  return [...area.querySelectorAll('a')];
}

describe('link-target.js', () => {
  describe('default policy', () => {
    it('leaves an internal link in the same window', () => {
      const [a] = decorate('/en/meetups');
      expect(a.hasAttribute('target')).to.be.false;
    });

    it('leaves an external link in the same window', () => {
      const [a] = decorate('https://www.aem.live/docs/');
      expect(a.hasAttribute('target')).to.be.false;
    });

    it('opens a PDF in a new window', () => {
      const [a] = decorate('/en/docs/whitepaper.pdf');
      expect(a.target).to.equal('_blank');
      expect(a.rel).to.equal('noopener');
    });

    it('opens an external PDF in a new window', () => {
      const [a] = decorate('https://www.aem.live/handbook/report.PDF');
      expect(a.target).to.equal('_blank');
    });

    it('reads the pathname, so a query string does not hide the extension', () => {
      const [a] = decorate('/en/docs/report.pdf?v=2#page=4');
      expect(a.target).to.equal('_blank');
    });

    it('does not treat a .pdf in the query or a pdf-ish path as a PDF', () => {
      const [query, path] = decorate('/en/search?file=report.pdf', '/en/pdf-tools');
      expect(query.hasAttribute('target')).to.be.false;
      expect(path.hasAttribute('target')).to.be.false;
    });

    it('leaves mailto and tel links alone', () => {
      const [mail, tel] = decorate('mailto:hello@example.com', 'tel:+19195552000');
      expect(mail.hasAttribute('target')).to.be.false;
      expect(tel.hasAttribute('target')).to.be.false;
    });
  });

  describe('target hashes', () => {
    it('supports all four reserved keywords', () => {
      const links = decorate(
        '/en/a#_blank',
        '/en/b#_self',
        '/en/c#_parent',
        '/en/d#_top',
      );
      expect(links.map((a) => a.target)).to.deep.equal(['_blank', '_self', '_parent', '_top']);
    });

    it('consumes the hash so it never becomes a fragment id', () => {
      const [a] = decorate('/en/a#_blank');
      expect(a.getAttribute('href')).to.equal('/en/a');
    });

    it('keeps a real fragment id alongside the target, in either order', () => {
      const [after, before] = decorate('/en/a#section-2#_blank', '/en/a#_blank#section-2');
      expect(after.getAttribute('href')).to.equal('/en/a#section-2');
      expect(after.target).to.equal('_blank');
      expect(before.getAttribute('href')).to.equal('/en/a#section-2');
      expect(before.target).to.equal('_blank');
    });

    it('adds rel=noopener only for _blank', () => {
      const [blank, top] = decorate('/en/a#_blank', '/en/b#_top');
      expect(blank.rel).to.equal('noopener');
      expect(top.rel).to.equal('');
    });

    it('lets an author force a PDF back into the same window', () => {
      const [a] = decorate('/en/docs/whitepaper.pdf#_self');
      expect(a.target).to.equal('_self');
      expect(a.getAttribute('href')).to.equal('/en/docs/whitepaper.pdf');
    });

    it('degrades a bare target hash to a same-page link', () => {
      const [a] = decorate('#_blank');
      expect(a.getAttribute('href')).to.equal('#');
      expect(a.target).to.equal('_blank');
    });

    it('ignores a hash that merely starts with a keyword', () => {
      const [topic, dnt] = decorate('/en/a#_topic', '/en/b#_dnt');
      expect(topic.hasAttribute('target')).to.be.false;
      expect(topic.getAttribute('href')).to.equal('/en/a#_topic');
      // ak.js's own hashes pass through untouched
      expect(dnt.getAttribute('href')).to.equal('/en/b#_dnt');
    });
  });

  describe('precedence', () => {
    it('an authored hash beats a target already on the anchor', () => {
      const area = document.createElement('div');
      area.innerHTML = '<a href="/en/a#_self" target="_blank">link</a>';
      decorateLinkTargets(area);
      expect(area.querySelector('a').target).to.equal('_self');
    });

    it('a target already on the anchor beats the PDF default', () => {
      const area = document.createElement('div');
      area.innerHTML = '<a href="/en/a.pdf" target="_self">link</a>';
      decorateLinkTargets(area);
      expect(area.querySelector('a').target).to.equal('_self');
    });

    it('does not overwrite an authored rel', () => {
      const area = document.createElement('div');
      area.innerHTML = '<a href="/en/a.pdf" rel="nofollow">link</a>';
      decorateLinkTargets(area);
      expect(area.querySelector('a').rel).to.equal('nofollow');
    });
  });
});
