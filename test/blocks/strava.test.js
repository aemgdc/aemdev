import { expect } from '@esm-bundle/chai';
import init, { embedSrc } from '../../blocks/strava/strava.js';

const TOKEN = 'jeSKtHky7WEtJNbfbbw7QPIBd3SbdTxBxB8hKs2Fc3c';
const FRAME = `https://strava-embeds.com/activity/20356929370?style=standard&fromEmbed=false&token=${TOKEN}`;

/** Build a line of content, auto-block its links the way ak.js does, and init them. */
function autoBlock(html) {
  const line = document.createElement('div');
  line.innerHTML = html;
  const links = [...line.querySelectorAll('a')];
  links.forEach((a) => {
    a.classList.add('strava', 'auto-block');
    a.dataset.blockName = 'strava';
  });
  links.forEach((a) => init(a));
  return line;
}

describe('strava.js', () => {
  describe('embedSrc', () => {
    it('passes an activity frame URL through', () => {
      expect(embedSrc(FRAME)).to.equal(FRAME);
    });

    it('passes a route frame URL through, map hash and all', () => {
      const route = `https://strava-embeds.com/route/3312345678901234567?fullWidth=true&token=${TOKEN}#mapHash=11.5%2F52.52%2F13.4`;
      expect(embedSrc(route)).to.equal(route);
    });

    [
      ['a frame URL with no token', FRAME.replace(/&token=.*$/, '')],
      ["Strava's embed.js", 'https://strava-embeds.com/embed.js'],
      ['an activity page', `https://www.strava.com/activities/20356929370?token=${TOKEN}`],
      ['a look-alike host', `https://strava-embeds.com.example.com/activity/1?token=${TOKEN}`],
      ['a non-numeric id', `https://strava-embeds.com/activity/abc?token=${TOKEN}`],
      ['not a URL', 'not a url'],
    ].forEach(([label, href]) => {
      it(`returns null for ${label}`, () => {
        expect(embedSrc(href)).to.be.null;
      });
    });
  });

  describe('auto-blocking', () => {
    it('embeds a link left alone on a line', () => {
      const div = autoBlock(`<p><a href="${FRAME}">${FRAME}</a></p>`).querySelector('.strava-embed');
      expect(div).to.exist;
      expect(div.dataset.src).to.equal(FRAME);
    });

    it('embeds a link alone in a list item', () => {
      const line = autoBlock(`<ul><li><a href="${FRAME}">ride</a></li></ul>`);
      expect(line.querySelector('li > .strava-embed')).to.exist;
    });

    it('leaves a link that shares its line with text', () => {
      const line = autoBlock(`<p>See <a href="${FRAME}">this ride</a> for the route.</p>`);
      expect(line.querySelector('.strava-embed')).to.not.exist;
      expect(line.querySelector('a')).to.exist;
    });

    it('sheds the auto-block markers from a link it does not embed', () => {
      const a = autoBlock('<p><a href="https://strava-embeds.com/embed.js">embed.js</a></p>').querySelector('a');
      expect(a.hasAttribute('class')).to.be.false;
      expect(a.dataset.blockName).to.be.undefined;
    });

    it('leaves a tokenless frame link a link rather than embed a 403', () => {
      const line = autoBlock(`<p><a href="${FRAME.replace(/&token=.*$/, '')}">ride</a></p>`);
      expect(line.querySelector('.strava-embed')).to.not.exist;
      expect(line.querySelector('a')).to.exist;
    });
  });
});
