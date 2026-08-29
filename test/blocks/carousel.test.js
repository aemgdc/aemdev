import { expect } from '@esm-bundle/chai';
import decorate from '../../blocks/carousel/carousel.js';

/* A 1x1 gif, so an <img> resolves without the network. Layout reads the attributes. */
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** One block row: `| image | caption |`, with the intrinsic size EDS really emits. */
function row({ w = 1600, h = 900, caption = '' } = {}) {
  const size = w && h ? ` width="${w}" height="${h}"` : '';
  return `<div>
    <div><picture><img src="${PIXEL}"${size}></picture></div>
    <div>${caption ? `<p>${caption}</p>` : ''}</div>
  </div>`;
}

/*
 * 1000px wide so the packer has a real width to divide. Without it the block is
 * zero-width and the collage waits for the ResizeObserver, exactly as it does on a page
 * where the section is still display:none.
 */
function block(className, rows) {
  const el = document.createElement('div');
  el.className = className;
  el.style.width = '1000px';
  el.innerHTML = rows.join('');
  document.body.append(el);
  return el;
}

const prop = (el, name) => Number(el.style.getPropertyValue(name));
const lightbox = () => document.querySelector('dialog.carousel-lightbox');

/* Landscape, landscape, portrait — enough shape variety to exercise the packer. */
const MIXED = [
  row({ w: 2048, h: 1152, caption: 'Wide one' }),
  row({ w: 1600, h: 1200, caption: 'Four by three' }),
  row({ w: 1121, h: 1495, caption: 'Tall one' }),
  row({ w: 1819, h: 1364, caption: 'Another landscape' }),
  row({ w: 1536, h: 1843, caption: 'Another portrait' }),
  row({ w: 4032, h: 3024, caption: 'Last one' }),
];

describe('blocks/carousel', () => {
  afterEach(() => {
    document.querySelectorAll('.carousel, dialog.carousel-lightbox').forEach((el) => el.remove());
    document.body.classList.remove('carousel-lightbox-open');
  });

  describe('collage', () => {
    it('packs the images into justified rows', () => {
      const el = block('carousel collage', MIXED);
      decorate(el);

      const rows = [...el.querySelectorAll('.carousel-collage-row')];
      expect(rows.length).to.be.greaterThan(1);
      expect(el.querySelectorAll('.carousel-item')).to.have.lengthOf(MIXED.length);

      // Every row but a short trailing one spends the full container width.
      rows.slice(0, -1).forEach((r) => {
        const used = [...r.children].reduce((sum, item) => sum + prop(item, '--collage-w'), 0);
        expect(used).to.be.closeTo(1, 0.001);
      });
    });

    it('gives each image its true aspect ratio', () => {
      const el = block('carousel collage', MIXED);
      decorate(el);

      const ratios = [...el.querySelectorAll('.carousel-item')]
        .map((item) => prop(item, '--collage-ar'));
      expect(ratios).to.include.members([Number((2048 / 1152).toFixed(6))]);
      expect(ratios).to.include.members([Number((1121 / 1495).toFixed(6))]);
    });

    it('tells each row how many gaps its width math must subtract', () => {
      const el = block('carousel collage', MIXED);
      decorate(el);

      [...el.querySelectorAll('.carousel-collage-row')].forEach((r) => {
        expect(prop(r, '--collage-row-gaps')).to.equal(r.children.length - 1);
      });
    });

    it('does not stretch a lone trailing portrait across the container', () => {
      // Two wide images fill row one; the portrait is left over.
      const el = block('carousel collage', [
        row({ w: 4000, h: 1000 }),
        row({ w: 4000, h: 1000 }),
        row({ w: 1000, h: 2000 }),
      ]);
      decorate(el);

      const rows = [...el.querySelectorAll('.carousel-collage-row')];
      const last = rows[rows.length - 1];
      expect(last.children).to.have.lengthOf(1);
      // Capped at the target row height instead, so it takes a fraction of the width.
      expect(prop(last.children[0], '--collage-w')).to.be.lessThan(0.5);
    });

    it('keeps captions in the DOM but never draws them in the collage', () => {
      const el = block('carousel collage', MIXED);
      decorate(el);

      const captions = [...el.querySelectorAll('.carousel-collage .carousel-caption')];
      expect(captions).to.have.lengthOf(MIXED.length);
      expect(captions[0].textContent).to.contain('Wide one');
      // The picture is a button; the caption is not, so it cannot be clicked or focused.
      expect(el.querySelectorAll('.carousel-collage .carousel-caption button')).to.have.lengthOf(0);
    });

    it('names each image by its caption for assistive tech', () => {
      const el = block('carousel collage', MIXED);
      decorate(el);

      const button = el.querySelector('.carousel-media-button');
      expect(button.getAttribute('aria-label')).to.contain('Wide one');
      expect(button.getAttribute('aria-label')).to.contain('1 of 6');
      expect(button.querySelector('img').alt).to.equal('Wide one');
      // Lazy, not the invalid `loading="auto"` the property getter tempts you into.
      expect(button.querySelector('img').getAttribute('loading')).to.equal('lazy');
    });

    it('lays out images that arrive without an intrinsic size', () => {
      const el = block('carousel collage', [row({ w: 0, h: 0 }), row({ w: 0, h: 0 })]);
      decorate(el);

      const items = [...el.querySelectorAll('.carousel-item')];
      expect(items).to.have.lengthOf(2);
      items.forEach((item) => expect(prop(item, '--collage-ar')).to.be.greaterThan(0));
    });
  });

  describe('lightbox', () => {
    it('opens on click with the clicked image and its caption underneath', () => {
      const el = block('carousel collage', MIXED);
      decorate(el);

      el.querySelectorAll('.carousel-media-button')[2].click();

      const dialog = lightbox();
      expect(dialog.open).to.equal(true);
      expect(document.body.classList.contains('carousel-lightbox-open')).to.equal(true);
      expect(dialog.querySelector('.carousel-lightbox-caption').textContent).to.contain('Tall one');
      expect(dialog.querySelector('.carousel-lightbox-counter').textContent).to.equal('3 / 6');

      // "Underneath" is structural, not just visual: the caption follows the image.
      const figure = dialog.querySelector('.carousel-lightbox-figure');
      const kids = [...figure.children].map((c) => c.className);
      expect(kids.indexOf('carousel-lightbox-caption'))
        .to.be.greaterThan(kids.indexOf('carousel-lightbox-image'));
    });

    it('steps through images with the arrow keys and wraps around', () => {
      const el = block('carousel collage', MIXED);
      decorate(el);
      el.querySelector('.carousel-media-button').click();

      const dialog = lightbox();
      const counter = dialog.querySelector('.carousel-lightbox-counter');

      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      expect(counter.textContent).to.equal('2 / 6');

      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      expect(counter.textContent).to.equal('6 / 6');
    });

    it('hides the navigation and counter for a single image', () => {
      const el = block('carousel collage', [row({ caption: 'Only one' })]);
      decorate(el);
      el.querySelector('.carousel-media-button').click();

      const dialog = lightbox();
      expect(dialog.querySelector('.carousel-lightbox-prev').hidden).to.equal(true);
      expect(dialog.querySelector('.carousel-lightbox-next').hidden).to.equal(true);
      expect(dialog.querySelector('.carousel-lightbox-counter').textContent).to.equal('');
    });

    it('hides the caption slot when an image has no caption', () => {
      const el = block('carousel collage', [row({ caption: 'Has one' }), row()]);
      decorate(el);
      el.querySelectorAll('.carousel-media-button')[1].click();

      expect(lightbox().querySelector('.carousel-lightbox-caption').hidden).to.equal(true);
    });

    it('returns focus to the image that opened it', () => {
      const el = block('carousel collage', MIXED);
      decorate(el);

      const trigger = el.querySelectorAll('.carousel-media-button')[1];
      trigger.click();

      const dialog = lightbox();
      dialog.close();
      expect(dialog.open).to.equal(false);
      /*
       * Fire `close` rather than wait for it. Chrome queues that event as a task and
       * does not run it promptly while the test page is unfocused — which every page is
       * once the suite runs files concurrently. Whether Chrome dispatches the event is
       * Chrome's problem; what this asserts is that OUR listener restores focus.
       */
      dialog.dispatchEvent(new Event('close'));

      expect(document.activeElement).to.equal(trigger);
      expect(document.body.classList.contains('carousel-lightbox-open')).to.equal(false);
    });
  });

  describe('captions variant', () => {
    it('puts the image on one side and the caption on the other', () => {
      const el = block('carousel collage captions', MIXED);
      decorate(el);

      const items = [...el.querySelectorAll('.carousel-caption-list .carousel-item-split')];
      expect(items).to.have.lengthOf(MIXED.length);
      expect(el.querySelector('.carousel-collage')).to.equal(null);

      const [media, caption] = items[0].children;
      expect(media.classList.contains('carousel-media-button')).to.equal(true);
      expect(caption.classList.contains('carousel-caption')).to.equal(true);
      expect(caption.textContent).to.contain('Wide one');
    });

    it('still opens the lightbox from the image', () => {
      const el = block('carousel collage captions', MIXED);
      decorate(el);
      el.querySelectorAll('.carousel-media-button')[1].click();

      expect(lightbox().querySelector('.carousel-lightbox-caption').textContent)
        .to.contain('Four by three');
    });
  });

  describe('rail', () => {
    it('renders one slide and one indicator per image', () => {
      const el = block('carousel', MIXED);
      decorate(el);

      expect(el.querySelectorAll('.carousel-slide')).to.have.lengthOf(MIXED.length);
      expect(el.querySelectorAll('.carousel-indicator')).to.have.lengthOf(MIXED.length);
      expect(el.querySelector('.carousel-collage')).to.equal(null);
      expect(el.querySelector('.carousel-nav-button-prev')).to.exist;
    });

    it('shows captions under the slides', () => {
      const el = block('carousel', MIXED);
      decorate(el);

      expect(el.querySelector('.carousel-slide .carousel-caption').textContent)
        .to.contain('Wide one');
    });
  });

  it('renders nothing when the block holds no images', () => {
    const el = block('carousel collage', ['<div><div><p>Just text</p></div></div>']);
    decorate(el);

    expect(el.children).to.have.lengthOf(0);
    expect(lightbox()).to.equal(null);
  });
});
