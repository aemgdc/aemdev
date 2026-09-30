import { expect } from '@esm-bundle/chai';
import { setConfig } from '../../scripts/ak.js';
import decorateSignalButtons from '../../scripts/utils/signal-button.js';

/** Decorate a throwaway area built from authored markup, and hand it back. */
function decorate(html) {
  const area = document.createElement('div');
  area.innerHTML = html;
  decorateSignalButtons(area);
  return area;
}

/** The one link in a decorated area. */
const link = (area) => area.querySelector('a');

describe('signal-button.js', () => {
  before(() => {
    setConfig({ linkBlocks: [{ youtube: 'https://www.youtube' }, { fragment: '/fragments/' }] });
  });

  describe('turns [[link]] on its own line into a Signal button', () => {
    it('with the brackets outside the link', () => {
      const area = decorate('<p>[[<a href="/en/meetups">RSVP for the Meetup</a>]]</p>');
      expect(link(area).className).to.equal('btn btn-signal');
      expect(area.innerHTML).to.equal(
        '<p><a href="/en/meetups" class="btn btn-signal"><span class="btn-signal-label">RSVP for the Meetup</span></a></p>',
      );
    });

    it('with the brackets inside the link', () => {
      const area = decorate('<p><a href="/en/meetups">[[RSVP for the Meetup]]</a></p>');
      expect(link(area).classList.contains('btn-signal')).to.be.true;
      expect(link(area).textContent).to.equal('RSVP for the Meetup');
    });

    it('with the brackets split across the edge of the link', () => {
      const area = decorate('<p>[<a href="/en/meetups">[RSVP for the Meetup]</a>]</p>');
      expect(link(area).classList.contains('btn-signal')).to.be.true;
      expect(link(area).textContent).to.equal('RSVP for the Meetup');
    });

    it('removing only the outer pair, so brackets in the label survive', () => {
      const area = decorate('<p>[[<a href="/en/meetups">RSVP [free]</a> ]]</p>');
      expect(link(area).textContent).to.equal('RSVP [free]');
    });

    it('with whitespace around and between the brackets', () => {
      const area = decorate('<p> [[ <a href="/en/meetups"> RSVP </a> ]] </p>');
      expect(link(area).textContent).to.equal('RSVP');
      expect(area.querySelector('p').childNodes).to.have.length(1);
    });

    it('in a list item and in a single-paragraph block cell', () => {
      const area = decorate(`
        <ul><li>[[<a href="/en/a">In a list</a>]]</li></ul>
        <div class="columns"><div><div>[[<a href="/en/b">In a cell</a>]]</div></div></div>`);
      expect(area.querySelectorAll('a.btn-signal')).to.have.length(2);
    });

    it('stripping bold and italic, which would otherwise pick a small button', () => {
      const area = decorate('<p><strong><em>[[<a href="/en/meetups"><u>RSVP</u></a>]]</em></strong></p>');
      expect(area.innerHTML).to.equal(
        '<p><a href="/en/meetups" class="btn btn-signal"><span class="btn-signal-label">RSVP</span></a></p>',
      );
    });

    it('keeping a line break the author typed inside the label', () => {
      const area = decorate('<p>[[<a href="/en/meetups">Watch it<br>adaptTo() unpacked</a>]]</p>');
      expect(area.querySelector('.btn-signal-label').innerHTML).to.equal('Watch it<br>adaptTo() unpacked');
    });
  });

  describe('the arrow', () => {
    it('marks a link that leaves the site as external', () => {
      const area = decorate('<p>[[<a href="https://usergroups.adobe.com/e/mzbaqn/">RSVP</a>]]</p>');
      expect(link(area).classList.contains('btn-signal-external')).to.be.true;
    });

    it('treats relative links, this host and aemdev.org as the site', () => {
      const area = decorate(`
        <p>[[<a href="/en/meetups">Relative</a>]]</p>
        <p>[[<a href="${window.location.origin}/en/meetups">This host</a>]]</p>
        <p>[[<a href="https://www.aemdev.org/en/meetups">aemdev.org</a>]]</p>
        <p>[[<a href="mailto:hello@aemdev.org">Mail</a>]]</p>`);
      const external = area.querySelectorAll('.btn-signal-external');
      expect(area.querySelectorAll('.btn-signal')).to.have.length(4);
      expect(external).to.have.length(0);
    });
  });

  describe('auto blocks', () => {
    it('stops a link that would auto-block from becoming an embed', () => {
      const area = decorate('<p>[[<a href="https://www.youtube.com/@aemdev">Watch on YouTube</a>]]</p>');
      expect(link(area).getAttribute('href')).to.equal('https://www.youtube.com/@aemdev#_dnb');
    });

    it('leaves every other href exactly as authored', () => {
      const area = decorate('<p>[[<a href="/en/meetups#agenda">Agenda</a>]]</p>');
      expect(link(area).getAttribute('href')).to.equal('/en/meetups#agenda');
    });
  });

  describe('leaves everything else as authored', () => {
    const untouched = {
      'a [[link]] inside a sentence': '<p>Bring a laptop and [[<a href="/en/a">RSVP here</a>]] before Friday.</p>',
      'a plain standalone link': '<p><a href="/en/a">Plain</a></p>',
      'single brackets': '<p>[<a href="/en/a">Single</a>]</p>',
      'triple brackets': '<p>[[[<a href="/en/a">Triple</a>]]]</p>',
      'only one side bracketed': '<p>[[<a href="/en/a">Open only</a></p>',
      'two links inside the brackets': '<p>[[<a href="/en/a">Two</a> <a href="/en/b">links</a>]]</p>',
      'brackets around empty link text': '<p>[[<a href="/en/a"> </a>]]</p>',
      'a linked image': '<p>[[<a href="/en/a"><picture><img src="/x.jpg" alt=""></picture></a>]]</p>',
      'an icon beside the link': '<p><span class="icon icon-rsvp"></span>[[<a href="/en/a">RSVP</a>]]</p>',
      'a link in a heading': '<h2>[[<a href="/en/a">Heading</a>]]</h2>',
    };
    Object.entries(untouched).forEach(([name, html]) => {
      it(name, () => {
        expect(decorate(html).innerHTML).to.equal(html);
      });
    });

    it('brackets with no link at all', () => {
      const html = '<p>[[Brackets with no link]]</p>';
      expect(decorate(html).innerHTML).to.equal(html);
    });
  });
});
