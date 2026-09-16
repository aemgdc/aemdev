import { expect } from '@esm-bundle/chai';
import init from '../../blocks/youtube/youtube.js';

const WATCH = 'https://www.youtube.com/watch?v=ZAu5PdM_oTw';
const EMBED = 'https://www.youtube-nocookie.com/embed/ZAu5PdM_oTw?rel=0';

/** Build a line of content, auto-block its links the way ak.js does, and init them. */
function autoBlock(html) {
  const line = document.createElement('div');
  line.innerHTML = html;
  const links = [...line.querySelectorAll('a')];
  links.forEach((a) => {
    a.classList.add('youtube', 'auto-block');
    a.dataset.blockName = 'youtube';
  });
  links.forEach((a) => init(a));
  return line;
}

describe('youtube.js', () => {
  describe('auto-blocking', () => {
    it('embeds a link left alone on a line', () => {
      const div = autoBlock(`<p><a href="${WATCH}">${WATCH}</a></p>`).querySelector('.video');
      expect(div).to.exist;
      expect(div.dataset.src).to.equal(EMBED);
    });

    it('embeds a link alone in a list item', () => {
      const line = autoBlock(`<ul><li><a href="${WATCH}">watch</a></li></ul>`);
      expect(line.querySelector('li > .video')).to.exist;
    });

    it('embeds a link alone on a line even when it is bolded', () => {
      const line = autoBlock(`<p><strong><a href="${WATCH}">watch</a></strong></p>`);
      expect(line.querySelector('.video')).to.exist;
    });

    it('leaves a link that shares its line with text', () => {
      const line = autoBlock(`<p>Watch <a href="${WATCH}">the talk</a> for more.</p>`);
      expect(line.querySelector('.video')).to.not.exist;
      expect(line.querySelector('a')).to.exist;
    });

    /* The bug this guard exists for: a chapter list deep-links into one video, and
       every timestamp used to become its own full-width player. */
    it('leaves a chapter list of timestamp links as links', () => {
      const chapters = [['', '0:00 Introduction'], ['&t=91s', '1:31 Meet Tad Reeves'],
        ['&t=148s', '2:28 What is an Agentic CMS?']]
        .map(([param, text]) => {
          const [time, ...words] = text.split(' ');
          return `<li><a href="${WATCH}${param}">${time}</a> ${words.join(' ')}</li>`;
        }).join('');
      const line = autoBlock(`<ul>${chapters}</ul>`);
      expect(line.querySelectorAll('.video').length).to.equal(0);
      expect(line.querySelectorAll('a').length).to.equal(3);
    });

    it('sheds the auto-block markers from a link it does not embed', () => {
      const a = autoBlock(`<p>See <a href="${WATCH}">the talk</a>.</p>`).querySelector('a');
      expect(a.classList.contains('youtube')).to.be.false;
      expect(a.classList.contains('auto-block')).to.be.false;
      expect(a.hasAttribute('class')).to.be.false;
      expect(a.dataset.blockName).to.be.undefined;
    });
  });

  describe('embed URL', () => {
    it('keeps a timestamp and drops the v param', () => {
      const div = autoBlock(`<p><a href="${WATCH}&t=91s">watch</a></p>`).querySelector('.video');
      expect(div.dataset.src).to.equal('https://www.youtube-nocookie.com/embed/ZAu5PdM_oTw?t=91s&rel=0');
    });

    it('reads the id out of a youtu.be short link', () => {
      const div = autoBlock('<p><a href="https://youtu.be/ZAu5PdM_oTw">watch</a></p>').querySelector('.video');
      expect(div.dataset.src).to.equal(EMBED);
    });
  });
});
