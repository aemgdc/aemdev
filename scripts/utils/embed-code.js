/*
 * Pasted embed code — a provider's "copy embed code" snippet, left alone on a line,
 * becomes the link that provider's auto-block already understands.
 *
 * Most embeds here start from a plain link (see linkBlocks in scripts/scripts.js). Strava
 * can't: its iframe answers 403 unless the URL carries a per-activity `token`, and that
 * token appears only in the snippet Strava's Share → Embed dialog hands out — never in the
 * activity URL or on the activity page. So for Strava the snippet itself is what an author
 * pastes, exactly as copied:
 *
 *   <div class="strava-embed-placeholder" data-embed-type="activity" data-embed-id="…"
 *     data-style="standard" data-from-embed="false" data-token="…"></div>
 *   <script src="https://strava-embeds.com/embed.js"></script>
 *
 * DA keeps that as escaped TEXT in a paragraph, so it is inert as delivered. This pass
 * reads the attributes out of the text — it never parses or injects the snippet's markup,
 * and Strava's embed.js is never loaded — and swaps the line for a link to the iframe URL
 * embed.js would have built, which the `strava` block then embeds:
 *
 *   https://strava-embeds.com/activity/<id>?style=standard&fromEmbed=false&token=<token>
 *
 * Same own-line rule as every embed: the snippet has to be the whole of its paragraph or
 * list item. One quoted mid-sentence, or one missing its token, stays text.
 */

// Straight quotes only past this point; DA or a word processor may have curled them.
const unCurl = (text) => text.replace(/[“”″]/g, '"').replace(/[‘’]/g, "'");

const SCRIPT = String.raw`<script\b[^>]*strava-embeds\.com/embed\.js[^>]*>\s*</script>`;
const SNIPPET = new RegExp(String.raw`^<div\b([^>]*)>\s*</div>\s*(?:${SCRIPT})?$`, 'i');
const SCRIPT_LINE = new RegExp(`^${SCRIPT}$`, 'i');
const PLACEHOLDER = /\bclass\s*=\s*(["'])[^"']*\bstrava-embed-placeholder\b[^"']*\1/i;
const DATA_ATTR = /\bdata-([a-z][a-z-]*)\s*=\s*(["'])(.*?)\2/gi;

const camel = (name) => name.toLowerCase().replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/**
 * Read a pasted Strava embed snippet into the iframe URL it stands for.
 * Mirrors strava-embeds.com/embed.js: every data-* attribute other than the type, id and
 * map hash rides along as a query param under its dataset (camelCase) name.
 * @param {string} text the text of one line
 * @returns {string|null} the strava-embeds.com URL, or null if the line isn't a snippet
 */
export function stravaEmbedHref(text) {
  const match = unCurl(text).trim().match(SNIPPET);
  if (!match || !PLACEHOLDER.test(match[1])) return null;

  const data = Object.fromEntries(
    [...match[1].matchAll(DATA_ATTR)].map(([, name, , value]) => [camel(name), value]),
  );
  const { embedType, embedId, mapHash, ...params } = data;
  // Type and id become path segments, so hold them to the shapes Strava issues.
  const valid = /^[a-z]+$/.test(embedType ?? '') && /^\d+$/.test(embedId ?? '');
  if (!valid || !params.token) return null;

  const url = new URL(`https://strava-embeds.com/${embedType}/${embedId}`);
  url.search = new URLSearchParams(params).toString();
  if (mapHash) url.hash = new URLSearchParams({ mapHash }).toString();
  return url.href;
}

/**
 * The link a line of pasted embed code stands for.
 * @param {string} text the text of one line
 * @returns {HTMLAnchorElement|null} a link to the iframe URL, or null if not embed code
 */
export function embedCodeLink(text) {
  const href = stravaEmbedHref(text);
  if (!href) return null;
  const a = document.createElement('a');
  a.href = href;
  a.textContent = href;
  return a;
}

/**
 * Turn every line that is nothing but a Strava embed snippet into a link to its iframe
 * URL, so ak.js's link decoration auto-blocks it like any other embed. Runs from
 * decorateArea, which loadArea calls ahead of decorateSections.
 * @param {Element|Document} area the area being decorated
 */
export default function decorateEmbedCode(area) {
  area.querySelectorAll('p, li').forEach((line) => {
    if (!line.textContent.includes('strava-embed-placeholder')) return;
    const a = embedCodeLink(line.textContent);
    if (!a) return;
    line.replaceChildren(a);
    // A multi-line paste can leave the <script> tag on a line of its own right after.
    const next = line.nextElementSibling;
    if (next?.tagName === line.tagName && SCRIPT_LINE.test(unCurl(next.textContent).trim())) {
      next.remove();
    }
  });
}
