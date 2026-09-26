/*
 * Locale-aware paths for content that is authored once, in English, and served in
 * every locale.
 *
 * Blocks carry English paths — an `index` cell of `/en/query-index.json`, a `path` of
 * `/en/meetups/`, the bios folder `/en/fragments/bios` — and the translation config
 * marks those cells do-not-translate, so a German page keeps them verbatim. Rewriting
 * them here, at render time, is what makes a /de/ page read /de/ data.
 *
 * Every fetch falls back to the English resource when the locale's copy is missing
 * (not yet translated, not yet published, or its query index not yet configured), so
 * a locale page degrades to English content instead of an empty block.
 */
import { getConfig } from '../ak.js';

export const SOURCE_PREFIX = '/en';

/** The current page's locale prefix, e.g. `/de`; `''` off the locale tree. */
export function currentLocalePrefix() {
  try {
    return getConfig()?.locale?.prefix || '';
  } catch {
    return '';
  }
}

/**
 * Map an English path into `prefix`'s tree. Paths outside `/en` are returned as-is,
 * as are all paths when the page is English or not on the locale tree.
 */
export function localizePath(path, prefix = currentLocalePrefix()) {
  if (!path || !prefix || prefix === SOURCE_PREFIX) return path;
  if (path === SOURCE_PREFIX || path.startsWith(`${SOURCE_PREFIX}/`)) {
    return `${prefix}${path.slice(SOURCE_PREFIX.length)}`;
  }
  return path;
}

/**
 * fetch() the locale's copy of an English resource, falling back to the English one.
 * Resolves to `{ resp, localized }`; `localized` says which copy answered, so callers
 * can keep path filters consistent with the data they actually got.
 */
export async function fetchLocalized(path, opts, prefix = currentLocalePrefix()) {
  const target = localizePath(path, prefix);
  if (target !== path) {
    try {
      const resp = await fetch(target, opts);
      if (resp.ok) return { resp, localized: true, path: target };
    } catch {
      // fall through to the English resource
    }
  }
  return { resp: await fetch(path, opts), localized: false, path };
}

/**
 * Load a query index for the current locale. A locale index that exists but has no
 * rows yet (configured, nothing published) also falls back to English.
 * Resolves to `{ rows, localized }`; throws when even the English index fails.
 */
export async function fetchLocalizedIndex(indexPath, prefix = currentLocalePrefix()) {
  const first = await fetchLocalized(indexPath, undefined, prefix);
  if (first.localized) {
    try {
      const json = await first.resp.json();
      if (Array.isArray(json.data) && json.data.length) return { rows: json.data, localized: true };
    } catch {
      // unreadable locale index: fall back
    }
    const resp = await fetch(indexPath);
    if (!resp.ok) throw new Error(`Failed to fetch ${indexPath} (${resp.status})`);
    return { rows: (await resp.json()).data || [], localized: false };
  }
  if (!first.resp.ok) throw new Error(`Failed to fetch ${indexPath} (${first.resp.status})`);
  return { rows: (await first.resp.json()).data || [], localized: false };
}

/** The document's language for Intl formatting, e.g. `de`; `en-US` when unset. */
export function pageLang() {
  return document.documentElement.lang || 'en-US';
}
