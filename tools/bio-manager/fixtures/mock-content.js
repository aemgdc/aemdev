/**
 * Serves fixture bio documents from `/en/fragments/bios/*.plain.html` so
 * blocks/speakers can be rendered without publishing anything. Loaded as a
 * classic script before the page's module, so fetch is already patched.
 *
 * `wilson-faure` is intentionally missing: that is the orphan path.
 *
 * The <picture> here mirrors pipeline output (multiple <source> children), not the
 * hand-authored <picture><img> the Bio Manager writes into DA — because that is
 * what a block actually receives from `.plain.html`.
 */

/* eslint-disable no-console */
(() => {
  const PHOTO = '/tools/bio-manager/fixtures/headshot.svg';

  const BIOS = {
    'eric-van-geem': {
      name: 'Eric Van Geem',
      title: 'Director, Technology',
      company: 'Huge',
      linkedin: 'https://www.linkedin.com/in/ericvangeem/',
      body: 'Eric leads technology delivery at Huge and has spent more than a decade '
        + 'architecting CMS platforms on Adobe, with an AEM Architect Master certification '
        + 'behind it.',
    },
    'laurel-timko': {
      name: 'Laurel Timko',
      title: 'Senior Software Engineer',
      company: 'JMP',
      linkedin: 'https://www.linkedin.com/in/laureltimko/',
      body: 'Laurel builds the tooling behind one of the larger Edge Delivery and Document '
        + 'Authoring implementations running in the wild — tag pickers wired to a live AEM '
        + 'taxonomy, and bulk operations that do not require opening fourteen pages.',
    },
  };

  const plain = (b) => `<body><main>
  <div>
    <div class="bio">
      <div><div>Photo</div><div><picture>
        <source type="image/webp" srcset="${PHOTO}" media="(min-width: 600px)">
        <source type="image/webp" srcset="${PHOTO}">
        <img loading="lazy" alt="${b.name}" src="${PHOTO}" width="200" height="200">
      </picture></div></div>
      <div><div>Name</div><div>${b.name}</div></div>
      <div><div>Title</div><div>${b.title}</div></div>
      <div><div>Company</div><div>${b.company}</div></div>
      <div><div>LinkedIn</div><div><a href="${b.linkedin}">${b.linkedin}</a></div></div>
      <div><div>Bio</div><div><p>${b.body}</p></div></div>
    </div>
  </div>
  <div></div>
</main></body>`;

  const realFetch = window.fetch.bind(window);

  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    const match = url.match(/\/en\/fragments\/bios\/([a-z0-9-]+)\.plain\.html$/);
    if (!match) return realFetch(input, init);
    const bio = BIOS[match[1]];
    console.log(`[mock] bio ${match[1]} -> ${bio ? '200' : '404'}`);
    if (!bio) return new Response('', { status: 404 });
    return new Response(plain(bio), {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  };
})();
