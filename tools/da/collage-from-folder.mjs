#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * collage-from-folder — fill a page's `carousel (collage)` block from its DA dot-folder.
 *
 * Usage:
 *   DA_TOKEN=$(cat ~/today-da-token.txt) \
 *     node tools/da/collage-from-folder.mjs /en/meetups/aem-meetup-washington-dc
 *
 *   --captions <file.json>  captions for the images (see below)
 *   --variant <classes>     block variant, e.g. "collage captions" (default "collage")
 *   --dry-run               print the document that WOULD be written, write nothing
 *   --no-preview            skip the Helix preview call after writing
 *   --publish               also publish to aem.live
 *   --org/--site/--branch   defaults aemgdc / aemdev / main
 *
 * WHY THIS IS A TOOL AND NOT BLOCK CODE
 *   The collage's source of truth is the page's dot-folder — for
 *   /en/meetups/aem-meetup-washington-dc that is /en/meetups/.aem-meetup-washington-dc.
 *   The block cannot read it: admin.da.live/list and content.da.live both answer 401
 *   without a bearer token, and there is no public listing endpoint, so an anonymous
 *   visitor has nothing to fetch. Resolving the folder here instead is also strictly
 *   better for the page — authored rows go through Media Bus at preview, so the
 *   delivered markup carries responsive <picture> sources and intrinsic width/height,
 *   and the collage can lay itself out before any image byte arrives.
 *
 * CAPTIONS FILE
 *   Either an object keyed by file name, in which case the folder listing (sorted by
 *   name) sets the order:
 *     { "img-1.jpg": "Caption one", "img-2.jpg": "Caption two" }
 *   ...or an array, which sets BOTH the order and the subset — collage row-packing is
 *   order-sensitive, so this is how you arrange one deliberately:
 *     [ { "file": "img-2.jpg", "caption": "Caption two" }, { "file": "img-1.jpg" } ]
 *
 * Re-running is safe: an existing collage block is replaced, and any caption already
 * authored in DA is carried over for images the captions file does not mention.
 */
import fs from 'fs';
import path from 'path';
/*
 * jsdom is a devDependency and stays one: this is an authoring tool run by hand, never
 * loaded by the site. Same call the tracker pipeline makes in tools/tracker/lib.
 */
// eslint-disable-next-line import/no-extraneous-dependencies
import { JSDOM } from 'jsdom';

const DA_API = 'https://admin.da.live';
const HLX_API = 'https://admin.hlx.page';
const CONTENT_HOST = 'https://content.da.live';
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif'];
const TOKEN_FILES = ['today-auth-token.txt', 'today-da-token.txt'];

function parseArgs(argv) {
  const opts = {
    org: 'aemgdc',
    site: 'aemdev',
    branch: 'main',
    variant: 'collage',
    captions: null,
    dryRun: false,
    preview: true,
    publish: false,
    page: null,
  };
  const flags = {
    '--org': 'org',
    '--site': 'site',
    '--branch': 'branch',
    '--variant': 'variant',
    '--captions': 'captions',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (flags[arg]) {
      i += 1;
      opts[flags[arg]] = argv[i];
    } else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--no-preview') opts.preview = false;
    else if (arg === '--publish') opts.publish = true;
    else if (arg.startsWith('--')) throw new Error(`unknown flag: ${arg}`);
    else if (!opts.page) opts.page = arg;
    else throw new Error(`unexpected argument: ${arg}`);
  }

  if (!opts.page) throw new Error('a page path is required, e.g. /en/meetups/some-page');
  opts.page = `/${opts.page.replace(/^\/+|\/+$|\.html$/g, '')}`;
  return opts;
}

/*
 * DA_TOKEN wins; otherwise take the first token file that has something in it. Both
 * names are in play on this machine and only one is refreshed on any given day, so
 * trying both beats making the caller remember which.
 */
function resolveToken() {
  if (process.env.DA_TOKEN?.trim()) return process.env.DA_TOKEN.trim();
  const found = TOKEN_FILES
    .map((name) => path.join(process.env.HOME || '', name))
    .filter((file) => fs.existsSync(file))
    .map((file) => fs.readFileSync(file, 'utf8').trim())
    .find(Boolean);
  if (found) return found;
  throw new Error(`no DA token: set DA_TOKEN or write one to ~/${TOKEN_FILES[0]}`);
}

/** /en/meetups/aem-meetup-washington-dc -> /en/meetups/.aem-meetup-washington-dc */
export function dotFolderFor(pagePath) {
  const dir = path.posix.dirname(pagePath);
  const name = path.posix.basename(pagePath);
  return path.posix.join(dir, `.${name}`);
}

async function daFetch(url, token, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${url} -> ${res.status} ${res.statusText}`);
  return res;
}

async function listImages(opts, token) {
  const folder = dotFolderFor(opts.page);
  const url = `${DA_API}/list/${opts.org}/${opts.site}${folder}`;
  const entries = await (await daFetch(url, token)).json();
  return entries
    .filter((entry) => IMAGE_EXTS.includes(String(entry.ext).toLowerCase()))
    .map((entry) => ({
      file: `${entry.name}.${entry.ext}`,
      url: `${CONTENT_HOST}${entry.path}`,
    }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

function loadCaptions(file) {
  if (!file) return { map: new Map(), order: null };
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Array.isArray(parsed)) {
    return {
      map: new Map(parsed.map((row) => [row.file, row.caption || ''])),
      order: parsed.map((row) => row.file),
    };
  }
  return { map: new Map(Object.entries(parsed)), order: null };
}

/** Captions already authored in DA, keyed by the image file each row points at. */
function existingCaptions(main) {
  const map = new Map();
  main.querySelectorAll('div.carousel > div').forEach((row) => {
    const img = row.querySelector('img');
    const cells = [...row.children];
    const captionCell = cells.find((cell) => !cell.querySelector('picture, img'));
    const text = captionCell?.innerHTML.trim();
    if (img && text) map.set(path.posix.basename(new URL(img.src).pathname), text);
  });
  return map;
}

/*
 * The <picture> shape DA itself writes: two <source srcset> and an <img>, all pointing
 * at content.da.live. Preview resolves these into Media Bus variants.
 */
function pictureHTML(doc, image, alt) {
  const picture = doc.createElement('picture');
  ['', '(min-width: 600px)'].forEach((media) => {
    const source = doc.createElement('source');
    source.setAttribute('srcset', image.url);
    if (media) source.setAttribute('media', media);
    picture.append(source);
  });
  const img = doc.createElement('img');
  img.setAttribute('src', image.url);
  img.setAttribute('alt', alt);
  img.setAttribute('loading', 'lazy');
  picture.append(img);
  return picture;
}

function buildBlock(doc, images, captions, variant) {
  const block = doc.createElement('div');
  block.className = ['carousel', ...variant.split(/[\s,]+/).filter(Boolean)].join(' ');

  images.forEach((image) => {
    const caption = captions.get(image.file) || '';
    const row = doc.createElement('div');

    const mediaCell = doc.createElement('div');
    mediaCell.append(pictureHTML(doc, image, caption.replace(/<[^>]*>/g, '').trim()));

    const captionCell = doc.createElement('div');
    // Already-authored captions arrive as markup; a captions file gives plain text.
    if (/<\w/.test(caption)) captionCell.innerHTML = caption;
    else if (caption) {
      const p = doc.createElement('p');
      p.textContent = caption;
      captionCell.append(p);
    }

    row.append(mediaCell, captionCell);
    block.append(row);
  });

  return block;
}

/*
 * Replace the existing collage in place if there is one — that keeps its position in
 * the document. Otherwise add a section for it just before the metadata section, which
 * is where a gallery belongs and where an author would have put it.
 */
function placeBlock(doc, main, block) {
  const existing = main.querySelector('div.carousel');
  if (existing) {
    existing.replaceWith(block);
    return 'replaced';
  }
  const section = doc.createElement('div');
  section.append(block);
  const metaSection = main.querySelector('div.metadata')?.closest('main > div');
  if (metaSection) main.insertBefore(section, metaSection);
  else main.append(section);
  return 'added';
}

async function putSource(opts, token, html) {
  const body = new FormData();
  body.append('data', new Blob([html], { type: 'text/html' }));
  const url = `${DA_API}/source/${opts.org}/${opts.site}${opts.page}.html`;
  await daFetch(url, token, { method: 'PUT', body });
}

async function publish(opts, token, action) {
  const url = `${HLX_API}/${action}/${opts.org}/${opts.site}/${opts.branch}${opts.page}`;
  await daFetch(url, token, { method: 'POST' });
}

async function run() {
  const opts = parseArgs(process.argv.slice(2));
  const token = resolveToken();

  const images = await listImages(opts, token);
  if (!images.length) throw new Error(`no images in ${dotFolderFor(opts.page)}`);
  console.log(`${images.length} image(s) in ${dotFolderFor(opts.page)}`);

  const sourceUrl = `${DA_API}/source/${opts.org}/${opts.site}${opts.page}.html`;
  const source = await (await daFetch(sourceUrl, token)).text();
  const dom = new JSDOM(source);
  const doc = dom.window.document;
  const mainEl = doc.querySelector('main');
  if (!mainEl) throw new Error('page source has no <main>');

  const { map: fileCaptions, order } = loadCaptions(opts.captions);
  const authored = existingCaptions(mainEl);
  const captions = new Map([...authored, ...fileCaptions]);

  const byFile = new Map(images.map((image) => [image.file, image]));
  const ordered = order ? order.map((file) => byFile.get(file)).filter(Boolean) : images;
  if (order && ordered.length !== order.length) {
    const missing = order.filter((file) => !byFile.has(file));
    console.warn(`  ! not in the folder, skipped: ${missing.join(', ')}`);
  }

  const block = buildBlock(doc, ordered, captions, opts.variant);
  const how = placeBlock(doc, mainEl, block);
  const html = doc.body.outerHTML;

  if (opts.dryRun) {
    console.log(`\n--- dry run (${how}) ---\n${block.outerHTML}\n`);
    return;
  }

  await putSource(opts, token, html);
  console.log(`  ${how} carousel (${opts.variant}) with ${ordered.length} image(s)`);

  if (opts.preview) {
    await publish(opts, token, 'preview');
    console.log(`  preview https://${opts.branch}--${opts.site}--${opts.org}.aem.page${opts.page}`);
  }
  if (opts.publish) {
    await publish(opts, token, 'live');
    console.log(`  live    https://${opts.branch}--${opts.site}--${opts.org}.aem.live${opts.page}`);
  }
}

run().catch((error) => {
  console.error(`collage-from-folder: ${error.message}`);
  process.exit(1);
});
