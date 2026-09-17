import { expect } from '@esm-bundle/chai';
import init, { embedSrc } from '../../blocks/linkedin/linkedin.js';

const POST = 'https://www.linkedin.com/posts/dianne-eveler_adobeexperiencemanager-edgedeliveryservices-ugcPost-7498946243193257984-NbEe/';
const EMBED = 'https://www.linkedin.com/embed/feed/update/urn:li:ugcPost:7498946243193257984';

/** Build a line of content, auto-block its links the way ak.js does, and init them. */
function autoBlock(html) {
  const line = document.createElement('div');
  line.innerHTML = html;
  const links = [...line.querySelectorAll('a')];
  links.forEach((a) => {
    a.classList.add('linkedin', 'auto-block');
    a.dataset.blockName = 'linkedin';
  });
  links.forEach((a) => init(a));
  return line;
}

describe('linkedin.js', () => {
  describe('embedSrc', () => {
    it('reads the URN out of a post permalink slug', () => {
      expect(embedSrc(POST)).to.equal(EMBED);
    });

    it('ignores tracking query params', () => {
      expect(embedSrc(`${POST}?utm_source=share&utm_medium=member_desktop`)).to.equal(EMBED);
    });

    it('reads a URN spelled out in a feed permalink', () => {
      expect(embedSrc('https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678/'))
        .to.equal('https://www.linkedin.com/embed/feed/update/urn:li:activity:7123456789012345678');
    });

    it('decodes a percent-encoded URN', () => {
      expect(embedSrc('https://www.linkedin.com/feed/update/urn%3Ali%3AugcPost%3A7123456789012345678/'))
        .to.equal('https://www.linkedin.com/embed/feed/update/urn:li:ugcPost:7123456789012345678');
    });

    it('passes an embed URL through unchanged', () => {
      const embed = 'https://www.linkedin.com/embed/feed/update/urn:li:share:7123456789012345678';
      expect(embedSrc(embed)).to.equal(embed);
    });

    it('takes the trailing URN when the post text also looks like one', () => {
      expect(embedSrc('https://www.linkedin.com/posts/jane_my-share-2024-recap-activity-7123456789012345678-abcd/'))
        .to.equal('https://www.linkedin.com/embed/feed/update/urn:li:activity:7123456789012345678');
    });

    ['https://www.linkedin.com/in/jane-doe/',
      'https://www.linkedin.com/company/adobe/',
      'https://www.linkedin.com/pulse/an-article-jane-doe/',
      'https://example.com/posts/x-share-7123456789012345678',
      'not a url',
    ].forEach((href) => {
      it(`returns null for ${href}`, () => {
        expect(embedSrc(href)).to.be.null;
      });
    });
  });

  describe('auto-blocking', () => {
    it('embeds a link left alone on a line', () => {
      const div = autoBlock(`<p><a href="${POST}">${POST}</a></p>`).querySelector('.linkedin-embed');
      expect(div).to.exist;
      expect(div.dataset.src).to.equal(EMBED);
    });

    it('embeds a link alone in a list item', () => {
      const line = autoBlock(`<ul><li><a href="${POST}">post</a></li></ul>`);
      expect(line.querySelector('li > .linkedin-embed')).to.exist;
    });

    it('embeds a link alone on a line even when it is bolded', () => {
      const line = autoBlock(`<p><strong><a href="${POST}">post</a></strong></p>`);
      expect(line.querySelector('.linkedin-embed')).to.exist;
    });

    it('leaves a link that shares its line with text', () => {
      const line = autoBlock(`<p>See <a href="${POST}">this post</a> for more.</p>`);
      expect(line.querySelector('.linkedin-embed')).to.not.exist;
      expect(line.querySelector('a')).to.exist;
    });

    it('sheds the auto-block markers from a link it does not embed', () => {
      const a = autoBlock(`<p>See <a href="${POST}">this post</a>.</p>`).querySelector('a');
      expect(a.classList.contains('linkedin')).to.be.false;
      expect(a.classList.contains('auto-block')).to.be.false;
      expect(a.hasAttribute('class')).to.be.false;
      expect(a.dataset.blockName).to.be.undefined;
    });

    it('leaves a non-post LinkedIn link alone on a line', () => {
      const line = autoBlock('<p><a href="https://www.linkedin.com/in/jane-doe/">Jane</a></p>');
      expect(line.querySelector('.linkedin-embed')).to.not.exist;
      expect(line.querySelector('a')).to.exist;
    });
  });

  describe('#_height authoring hash', () => {
    it('sizes the frame and consumes the hash', () => {
      const div = autoBlock(`<p><a href="${POST}#_height=1450">post</a></p>`).querySelector('.linkedin-embed');
      expect(div.style.getPropertyValue('--linkedin-embed-height')).to.equal('1450px');
      expect(div.dataset.src).to.equal(EMBED);
    });

    it('leaves the default height when no hash is authored', () => {
      const div = autoBlock(`<p><a href="${POST}">post</a></p>`).querySelector('.linkedin-embed');
      expect(div.style.getPropertyValue('--linkedin-embed-height')).to.equal('');
    });

    it('ignores a hash that only looks like a height', () => {
      const div = autoBlock(`<p><a href="${POST}#_heights">post</a></p>`).querySelector('.linkedin-embed');
      expect(div.style.getPropertyValue('--linkedin-embed-height')).to.equal('');
    });
  });
});
