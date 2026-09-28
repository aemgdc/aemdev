import { expect } from '@esm-bundle/chai';
import decorateEmbedCode, { stravaEmbedHref } from '../../scripts/utils/embed-code.js';

const TOKEN = 'jeSKtHky7WEtJNbfbbw7QPIBd3SbdTxBxB8hKs2Fc3c';
// Strava's Share → Embed code, verbatim.
const SNIPPET = `<div class="strava-embed-placeholder" data-embed-type="activity" data-embed-id="20356929370" data-style="standard" data-from-embed="false" data-token="${TOKEN}"></div><script src="https://strava-embeds.com/embed.js"></script>`;
const HREF = `https://strava-embeds.com/activity/20356929370?style=standard&fromEmbed=false&token=${TOKEN}`;

/** A section holding the given lines, each as DA delivers pasted code: escaped text. */
function area(...lines) {
  const div = document.createElement('div');
  lines.forEach((text) => {
    const p = document.createElement('p');
    p.textContent = text;
    div.append(p);
  });
  return div;
}

describe('embed-code.js', () => {
  describe('stravaEmbedHref', () => {
    it("reads Strava's embed code into its iframe URL", () => {
      expect(stravaEmbedHref(SNIPPET)).to.equal(HREF);
    });

    it('carries the style and any other data attribute along', () => {
      const href = stravaEmbedHref(SNIPPET.replace('"standard"', '"map"'));
      expect(new URL(href).searchParams.get('style')).to.equal('map');
    });

    it('tolerates curled quotes and surrounding whitespace', () => {
      const curled = SNIPPET.replace(/="([^"]*)"/g, '=“$1”');
      expect(stravaEmbedHref(`  ${curled}\n`)).to.equal(HREF);
    });

    it('accepts the placeholder without its script tag', () => {
      expect(stravaEmbedHref(SNIPPET.replace(/<script.*$/, ''))).to.equal(HREF);
    });

    it('builds a route URL and keeps its map hash in the fragment', () => {
      const route = `<div class="strava-embed-placeholder" data-embed-type="route" data-embed-id="3312345678901234567" data-full-width="true" data-map-hash="11.5/52.52/13.4" data-token="${TOKEN}"></div>`;
      const url = new URL(stravaEmbedHref(route));
      expect(url.pathname).to.equal('/route/3312345678901234567');
      expect(url.searchParams.get('fullWidth')).to.equal('true');
      expect(url.searchParams.has('mapHash')).to.be.false;
      expect(new URLSearchParams(url.hash.slice(1)).get('mapHash')).to.equal('11.5/52.52/13.4');
    });

    [
      ['code with no token', SNIPPET.replace(/ data-token="[^"]*"/, '')],
      ['code with no embed type', SNIPPET.replace(/ data-embed-type="[^"]*"/, '')],
      ['a non-numeric id', SNIPPET.replace('20356929370', '../../etc')],
      ['a div that is not the placeholder', SNIPPET.replace('strava-embed-placeholder', 'other')],
      ['code quoted inside a sentence', `Paste ${SNIPPET} on its own line.`],
      ['code followed by another script', SNIPPET.replace('strava-embeds.com/embed.js', 'example.com/x.js')],
      ['plain text', 'Rode 15 miles.'],
    ].forEach(([label, text]) => {
      it(`returns null for ${label}`, () => {
        expect(stravaEmbedHref(text)).to.be.null;
      });
    });
  });

  describe('decorateEmbedCode', () => {
    it('turns a line of embed code into a link to the iframe URL', () => {
      const el = area(SNIPPET);
      decorateEmbedCode(el);
      const a = el.querySelector('p > a');
      expect(a.getAttribute('href')).to.equal(HREF);
      expect(el.querySelector('p').childNodes.length).to.equal(1);
    });

    it('reads through a script URL the pipeline auto-linked', () => {
      const el = document.createElement('div');
      el.innerHTML = `<p>${SNIPPET.replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace('https://strava-embeds.com/embed.js', '<a href="https://strava-embeds.com/embed.js">https://strava-embeds.com/embed.js</a>')}</p>`;
      decorateEmbedCode(el);
      const links = el.querySelectorAll('a');
      expect(links.length).to.equal(1);
      expect(links[0].getAttribute('href')).to.equal(HREF);
    });

    it('drops the script tag when a paste left it on the next line', () => {
      const [div, script] = SNIPPET.split(/(?=<script)/);
      const el = area(div, script, 'After.');
      decorateEmbedCode(el);
      expect([...el.children].map((p) => p.textContent)).to.deep.equal([HREF, 'After.']);
    });

    it('works in a list item', () => {
      const el = document.createElement('ul');
      el.innerHTML = '<li></li>';
      el.firstChild.textContent = SNIPPET;
      decorateEmbedCode(el);
      expect(el.querySelector('li > a')).to.exist;
    });

    it('leaves code quoted in a sentence, and every other line, as it was', () => {
      const lines = [`Paste ${SNIPPET} on its own line.`, 'Rode 15 miles.'];
      const el = area(...lines);
      decorateEmbedCode(el);
      expect(el.querySelector('a')).to.not.exist;
      expect([...el.children].map((p) => p.textContent)).to.deep.equal(lines);
    });
  });
});
