import { expect } from '@esm-bundle/chai';
import init from '../../blocks/spotify/spotify.js';

const EPISODE = 'https://open.spotify.com/episode/4rOoJ6Egrf8K2IrywzwOMk?si=abc123';
const EMBED = 'https://open.spotify.com/embed/episode/4rOoJ6Egrf8K2IrywzwOMk';

/** Build a line of content, auto-block its links the way ak.js does, and init them. */
function autoBlock(html) {
  const line = document.createElement('div');
  line.innerHTML = html;
  const links = [...line.querySelectorAll('a')];
  links.forEach((a) => {
    a.classList.add('spotify', 'auto-block');
    a.dataset.blockName = 'spotify';
  });
  links.forEach((a) => init(a));
  return line;
}

describe('spotify.js', () => {
  describe('auto-blocking', () => {
    it('embeds a link left alone on a line', () => {
      const div = autoBlock(`<p><a href="${EPISODE}">${EPISODE}</a></p>`).querySelector('.spotify-embed');
      expect(div).to.exist;
      expect(div.dataset.src).to.equal(EMBED);
    });

    it('embeds a link alone in a list item', () => {
      const line = autoBlock(`<ul><li><a href="${EPISODE}">listen</a></li></ul>`);
      expect(line.querySelector('li > .spotify-embed')).to.exist;
    });

    it('embeds a link alone on a line even when it is bolded', () => {
      const line = autoBlock(`<p><strong><a href="${EPISODE}">listen</a></strong></p>`);
      expect(line.querySelector('.spotify-embed')).to.exist;
    });

    it('leaves a link that shares its line with text', () => {
      const line = autoBlock(`<p>Hear it on <a href="${EPISODE}">the podcast</a> today.</p>`);
      expect(line.querySelector('.spotify-embed')).to.not.exist;
      expect(line.querySelector('a')).to.exist;
    });

    it('sheds the auto-block markers from a link it does not embed', () => {
      const a = autoBlock(`<p>Hear it on <a href="${EPISODE}">the podcast</a>.</p>`).querySelector('a');
      expect(a.classList.contains('spotify')).to.be.false;
      expect(a.classList.contains('auto-block')).to.be.false;
      expect(a.hasAttribute('class')).to.be.false;
      expect(a.dataset.blockName).to.be.undefined;
    });

    it('sheds the markers from a link with no episode or track id', () => {
      const a = autoBlock('<p><a href="https://open.spotify.com/">Spotify</a></p>').querySelector('a');
      expect(a).to.exist;
      expect(a.hasAttribute('class')).to.be.false;
      expect(a.dataset.blockName).to.be.undefined;
    });
  });

  describe('embed URL', () => {
    it('drops tracking query params', () => {
      const div = autoBlock(`<p><a href="${EPISODE}">listen</a></p>`).querySelector('.spotify-embed');
      expect(div.dataset.src).to.equal(EMBED);
    });

    it('keeps the content type, so the CSS can size the player', () => {
      const div = autoBlock('<p><a href="https://open.spotify.com/track/1301WleyT98MSxVHPZCA6M">t</a></p>').querySelector('.spotify-embed');
      expect(div.dataset.src).to.equal('https://open.spotify.com/embed/track/1301WleyT98MSxVHPZCA6M');
    });
  });
});
