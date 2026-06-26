/**
 * Date helpers for query-index `date` fields.
 *
 * Page metadata standardises on ISO `yyyy-mm-dd`. We parse those as *local*
 * dates rather than letting `new Date('2026-05-26')` treat them as UTC
 * midnight — that would render the previous day via `toLocaleDateString` in any
 * timezone behind UTC. Legacy/odd values fall back to native Date parsing.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parse a `yyyy-mm-dd` (or legacy) date string.
 * @param {string|number} raw
 * @returns {Date|null} a local-time Date, or null when unparseable/empty
 */
export function parseDate(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  const iso = ISO_DATE.exec(s);
  if (iso) {
    const [, y, m, d] = iso;
    return new Date(Number(y), Number(m) - 1, Number(d));
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Sort key for a date string. Unparseable/empty dates sort oldest.
 * @param {string|number} raw
 * @returns {number} milliseconds since epoch, or 0
 */
export function dateValue(raw) {
  const d = parseDate(raw);
  return d ? d.getTime() : 0;
}

/**
 * Format a date string for display, e.g. "May 26, 2026".
 * Returns the raw value unchanged when it can't be parsed.
 * @param {string|number} raw
 * @param {string} [locale]
 * @returns {string}
 */
export function formatDate(raw, locale = 'en-US') {
  const d = parseDate(raw);
  if (!d) return raw ? String(raw) : '';
  return d.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' });
}
