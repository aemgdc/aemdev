import { loadArea, setConfig } from './ak.js';
import decorateLinkTargets from './utils/link-target.js';

const hostnames = ['authorkit.dev'];

const locales = {
  '': { lang: 'en' },
  '/de': { lang: 'de' },
  '/es': { lang: 'es' },
  '/fr': { lang: 'fr' },
  '/hi': { lang: 'hi' },
  '/ja': { lang: 'ja' },
  '/zh': { lang: 'zh' },
};

const linkBlocks = [
  { fragment: '/fragments/' },
  { schedule: '/schedules/' },
  { youtube: 'https://www.youtube' },
  { youtube: 'https://youtu.be' },
  { spotify: 'https://open.spotify.com' },
];

// Blocks with self-managed styles
const components = ['fragment', 'schedule'];

// Section folders whose child pages get the long-form "blog" template applied
// automatically, so their body content area matches the article reading layout
// (constrained readable column + full-bleed special sections). Locale-agnostic:
// matches the folder as a path segment in any locale (e.g. /en/articles/foo).
const templatedSections = ['articles', 'meetup-recaps', 'meeting-recaps'];

// If the current page is a child of a templated section and has no explicit
// template metadata, inject template=blog before the area (and template) load.
function applyTemplateByPath() {
  if (document.head.querySelector('meta[name="template"]')) return;
  const segments = window.location.pathname.split('/').filter(Boolean);
  const idx = segments.findIndex((seg) => templatedSections.includes(seg));
  const isChildPage = idx > -1 && idx < segments.length - 1;
  if (!isChildPage) return;
  const meta = document.createElement('meta');
  meta.setAttribute('name', 'template');
  meta.setAttribute('content', 'blog');
  document.head.append(meta);
}

// How to decorate an area before loading it
const decorateArea = ({ area = document }) => {
  const eagerLoad = (parent, selector) => {
    const img = parent.querySelector(selector);
    if (!img) return;
    img.removeAttribute('loading');
    img.fetchPriority = 'high';
  };

  eagerLoad(area, 'img');
  // Same window for everything but a PDF, plus the `#_blank`/`#_self`/`#_parent`/`#_top`
  // authoring language. Must stay HERE rather than in ak.js's decorateLink: loadArea runs
  // decorateArea over the whole area before decorateSections walks it, so this is the one
  // hook that also reaches fragments (header, footer, nav) and any anchor outside `main`.
  decorateLinkTargets(area);
};

export async function loadPage() {
  setConfig({ hostnames, locales, linkBlocks, components, decorateArea });
  applyTemplateByPath();
  await loadArea();
}
await loadPage();

(function da() {
  const { searchParams } = new URL(window.location.href);
  const hasPreview = searchParams.has('dapreview');
  if (hasPreview) import('../tools/da/da.js').then((mod) => mod.default(loadPage));
  const hasQE = searchParams.has('quick-edit');
  if (hasQE) import('../tools/quick-edit/quick-edit.js').then((mod) => mod.default());
}());
