import { expect } from '@esm-bundle/chai';
import sinon from 'sinon';
import decorate from '../../blocks/article-feed/article-feed.js';

/*
 * The thumbnail is the only part of this block that reaches outside itself: it
 * takes the query index's `image` — the 1200px og render — and has to come back
 * as a card-sized picture. These cover that, plus the two states a mixed feed
 * puts the card in (with an image, and without).
 */

const article = (over = {}) => ({
  path: '/en/meetups/one',
  title: 'A meetup',
  description: 'What happened.',
  author: 'AEM GDC',
  date: '2026-06-25',
  category: 'aemdev:category/meetup',
  image: '/en/meetups/media_abc.jpg?width=1200&format=pjpg&optimize=medium',
  ...over,
});

function stubIndex(articles) {
  return sinon.stub(window, 'fetch').callsFake(() => Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ data: articles }),
  }));
}

function block(html = '') {
  const el = document.createElement('div');
  el.className = 'article-feed';
  el.innerHTML = html;
  document.body.append(el);
  return el;
}

const row = (key, value) => `<div><div>${key}</div><div>${value}</div></div>`;

describe('blocks/article-feed', () => {
  let fetchStub;

  afterEach(() => {
    fetchStub?.restore();
    fetchStub = null;
    document.querySelectorAll('.article-feed').forEach((el) => el.remove());
  });

  it('gives every indexed article a thumbnail built from its own image', async () => {
    fetchStub = stubIndex([
      article({ path: '/en/meetups/one', image: '/en/meetups/a.jpg?width=1200&format=pjpg&optimize=medium' }),
      article({ path: '/en/meetups/two', image: '/en/meetups/b.jpg?width=1200&format=pjpg&optimize=medium' }),
    ]);
    const el = block(row('index', '/en/query-index.json'));
    await decorate(el);

    const thumbs = el.querySelectorAll('.feed-card-thumb');
    expect(thumbs.length).to.equal(2);
    expect([...thumbs].map((t) => new URL(t.querySelector('img').src).pathname))
      .to.eql(['/en/meetups/a.jpg', '/en/meetups/b.jpg']);
  });

  it('asks for a card-sized render, not the 1200px og image the index carries', async () => {
    fetchStub = stubIndex([article()]);
    const el = block(row('index', '/en/query-index.json'));
    await decorate(el);

    const img = el.querySelector('.feed-card-thumb img');
    expect(new URL(img.src).searchParams.get('width')).to.equal('750');
    // A webp source ahead of the fallback is what makes the smaller render pay off.
    const source = el.querySelector('.feed-card-thumb source[type="image/webp"]');
    expect(source).to.exist;
    expect(new URL(source.srcset).searchParams.get('format')).to.equal('webply');
    expect(img.getAttribute('loading')).to.equal('lazy');
  });

  it('leaves the thumbnail undescribed — the card is one link, already named by its title', async () => {
    fetchStub = stubIndex([article()]);
    const el = block(row('index', '/en/query-index.json'));
    await decorate(el);

    expect(el.querySelector('.feed-card-thumb img').getAttribute('alt')).to.equal('');
  });

  it('keeps the text-only card for an article with no image rather than framing a gap', async () => {
    fetchStub = stubIndex([article({ image: '' })]);
    const el = block(row('index', '/en/query-index.json'));
    await decorate(el);

    const card = el.querySelector('.feed-card-item');
    expect(card.querySelector('.feed-card-thumb')).to.equal(null);
    expect(card.querySelector('.feed-card-title').textContent).to.equal('A meetup');
  });

  it('costs one card its thumbnail, not the whole feed, when an image path is junk', async () => {
    fetchStub = stubIndex([
      article({ path: '/en/meetups/one', image: 'http://' }),
      article({ path: '/en/meetups/two' }),
    ]);
    const el = block(row('index', '/en/query-index.json'));
    await decorate(el);

    const cards = el.querySelectorAll('.feed-card-item');
    expect(cards.length).to.equal(2);
    expect(cards[0].querySelector('.feed-card-thumb')).to.equal(null);
    expect(cards[1].querySelector('.feed-card-thumb')).to.exist;
  });

  it('takes a thumbnail from an authored card row, whether a path or a real image', async () => {
    const el = block([
      row('card-1-title', 'Authored one'),
      row('card-1-url', '<a href="/en/one">one</a>'),
      row('card-1-image', '/en/meetups/authored.jpg'),
      row('card-2-title', 'Authored two'),
      row('card-2-url', '<a href="/en/two">two</a>'),
      row('card-2-image', '<picture><img src="/en/meetups/dropped.jpg"></picture>'),
      row('card-3-title', 'Authored three'),
      row('card-3-url', '<a href="/en/three">three</a>'),
    ].join(''));
    await decorate(el);

    const cards = el.querySelectorAll('.feed-card-item');
    expect(cards.length).to.equal(3);
    expect(new URL(cards[0].querySelector('.feed-card-thumb img').src).pathname)
      .to.equal('/en/meetups/authored.jpg');
    expect(new URL(cards[1].querySelector('.feed-card-thumb img').src).pathname)
      .to.equal('/en/meetups/dropped.jpg');
    expect(cards[2].querySelector('.feed-card-thumb')).to.equal(null);
  });
});
