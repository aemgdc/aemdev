/**
 * An in-memory DA, good enough to drive the Bio Manager with no network and no
 * login. Loaded by fixtures/preview.html as a classic script BEFORE the app's
 * module, so window.fetch is already replaced by the time the app calls it.
 *
 * Covers the roster sheet, bio documents, folder creation, media upload, and
 * the admin.hlx.page preview/publish calls. Anything else falls through to the
 * real fetch, so fonts and images still load.
 */

/* eslint-disable no-console */
(() => {
  const SOURCE = 'https://admin.da.live/source/aemgdc/aemdev';
  const AEM = 'https://admin.hlx.page';
  const PHOTO = '/tools/bio-manager/fixtures/headshot.svg';

  const FIXTURES = [
    {
      slug: 'eric-van-geem',
      name: 'Eric Van Geem',
      title: 'Director, Technology',
      company: 'Huge',
      linkedin: 'https://www.linkedin.com/in/ericvangeem/',
      image: PHOTO,
      status: 'placeholder',
      body: 'Eric leads technology delivery at Huge and has spent more than a decade '
        + 'architecting CMS platforms on Adobe.',
    },
    {
      slug: 'laurel-timko',
      name: 'Laurel Timko',
      title: 'Senior Software Engineer',
      company: 'JMP',
      linkedin: 'https://www.linkedin.com/in/laureltimko/',
      image: PHOTO,
      status: 'approved',
      body: 'Laurel builds the tooling behind one of the larger Edge Delivery and '
        + 'Document Authoring implementations running in the wild.',
    },
    {
      slug: 'rick-reich',
      name: 'Rick Reich',
      title: 'To be confirmed',
      company: 'Better Digital',
      linkedin: 'https://www.linkedin.com/in/rickreich/',
      image: '',
      status: 'placeholder',
      body: 'Lined up to speak at the Miami meetup. Title, topic and headshot are '
        + 'still outstanding.',
    },
  ];

  const doc = (b) => `<body>
  <header></header>
  <main>
    <div>
      <div class="bio">
        ${b.image ? `<div><div>Photo</div><div><picture><img src="${b.image}" alt="${b.name}" /></picture></div></div>` : ''}
        <div><div>Name</div><div>${b.name}</div></div>
        <div><div>Title</div><div>${b.title}</div></div>
        <div><div>Company</div><div>${b.company}</div></div>
        <div><div>LinkedIn</div><div><a href="${b.linkedin}">${b.linkedin}</a></div></div>
        <div><div>Bio</div><div><p>${b.body}</p></div></div>
      </div>
      <div class="metadata">
        <div><div>bio-name</div><div>${b.name}</div></div>
        <div><div>bio-title</div><div>${b.title}</div></div>
        <div><div>bio-company</div><div>${b.company}</div></div>
        <div><div>bio-linkedin</div><div>${b.linkedin}</div></div>
        <div><div>bio-image</div><div>${b.image}</div></div>
        <div><div>bio-status</div><div>${b.status}</div></div>
      </div>
    </div>
  </main>
  <footer></footer>
</body>`;

  const row = (b) => ({
    Slug: b.slug,
    Name: b.name,
    Title: b.title,
    Company: b.company,
    LinkedIn: b.linkedin,
    Image: b.image,
    Path: `/en/fragments/bios/${b.slug}`,
    Status: b.status,
    Updated: '2026-08-23',
  });

  const store = new Map(FIXTURES.map((b) => [`/en/fragments/bios/${b.slug}.html`, doc(b)]));
  const data = FIXTURES.map(row);
  let sheet = {
    total: data.length, limit: data.length, offset: 0, data, ':type': 'sheet',
  };

  const ok = (body, type = 'application/json') => new Response(body, {
    status: 200,
    headers: { 'content-type': type },
  });

  const realFetch = window.fetch.bind(window);

  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method || 'GET').toUpperCase();

    if (url.startsWith(AEM)) {
      console.log(`[mock] ${method} ${url}`);
      return ok(JSON.stringify({ status: 200 }));
    }
    if (!url.startsWith(SOURCE)) return realFetch(input, init);

    const rel = url.slice(SOURCE.length);
    console.log(`[mock] ${method} ${rel}`);

    // Folder create: no extension, no body.
    if (method === 'POST' && !rel.includes('.')) return ok('{}');

    if (rel === '/bios.json') {
      if (method === 'GET') return ok(JSON.stringify(sheet));
      sheet = JSON.parse(await init.body.get('data').text());
      return ok('{}');
    }

    // Media upload — hand back a URL the browser can actually render.
    if (/\.(jpe?g|png|gif|svg)$/.test(rel)) {
      return ok(JSON.stringify({ source: { contentUrl: PHOTO } }));
    }

    if (method === 'GET') {
      if (!store.has(rel)) return new Response('', { status: 404 });
      return ok(store.get(rel), 'text/html');
    }
    if (method === 'POST') {
      store.set(rel, await init.body.get('data').text());
      return ok('{}');
    }
    if (method === 'DELETE') {
      store.delete(rel);
      return new Response('', { status: 204 });
    }
    return new Response('', { status: 405 });
  };

  console.log('[mock] DA fixtures loaded — no network, no login.');
})();
