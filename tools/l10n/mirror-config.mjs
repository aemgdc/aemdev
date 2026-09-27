/* eslint-disable no-console, no-underscore-dangle */
// Rebuild .tracker/da-translate.json (annotated source) from the LIVE DA config,
// dropping credential rows and keeping every existing `_comment` / `_why`.
// Prints only key names and counts; never a credential value.
// Usage: node tools/l10n/mirror-config.mjs .tracker/da-translate.json   (then tx:config --diff)
import { readFileSync, writeFileSync } from 'node:fs';
import { getJson } from './da.mjs';

const REPO_FILE = process.argv[2];
export const SECRET_KEY = /\.(userIdentifier|userId|userSecret|clientId|clientSecret|apiKey|password|username)$/i;

const NEW_WHY = {
  'home-hero, article-feed, rapid-drop, splitforms, bio||dnt col 1': 'Column 1 of these key/value blocks is the parser key (kicker, heading, index, badge, Name, form…). A translated key is silently skipped: the hero loses its copy, article-feed renders nothing without `index`, and `bio` removes itself. Healed 2026-09-26 after the DA engine simulation showed every key translatable.',
  'home-hero||dnt col 2 if col 1 is "slides" or "rapid-fragment" or "rapid-id" or "rapid-bg" or "event-date" or "event-image" or "event-link" or "event-focal" or "event-index" or "event-auto"': 'Functional values: fragment paths, ids, ISO dates, links and switches. `event-auto` is matched against off/false/no/none, so a translated "aus" silently turns auto-fill back on.',
  'article-feed||dnt col 2 if col 1 is "index" or "index path" or "index-path" or "limit" or "path" or "paths" or "status" or "statuses"': 'The aliases the parser accepts for the feed source and filters (the older insights/article-feed rule covers only the canonical names). The /en/ paths stay English; scripts/utils/locale-path.js maps them into the page locale at render time.',
  'article-feed||dnt col 2 if col 1 contains "-url" or "-image" or "-date"': 'Hand-authored card rows (card-N-url/-image/-date) for any N, not only card-1..4.',
  'insights, dam-display, speakers, bios||do-not-translate': 'Pure configuration, no reader-facing text: insights (limit/index/category/tag/template), dam-display (filepath + mode — a translated "images" falls back to pdf mode), speakers/bios (slugs).',
  'rapid-drop||dnt col 2 if col 1 is "id" or "bg"': 'Element id and background value.',
  'splitforms||dnt col 2 if col 1 is "form" or "reply-email" or "redirect-url" or "event-id" or "access-key"': 'An unknown form name falls back to the contact form; the rest are addresses, ids and keys. submit-label and success stay translatable.',
  'bio||dnt col 2 if col 1 is "photo" or "image" or "name" or "company" or "linkedin" or "link"': 'Names, companies and URLs. Title (job title) and Bio stay translatable.',
};

const live = (await getJson('/.da/translate.json')).json;
const repo = JSON.parse(readFileSync(REPO_FILE, 'utf8'));
const out = { _comment: repo._comment };
const report = [];
for (const name of live[':names']) {
  const sheet = live[name];
  let rows = sheet.data;
  if (name === 'config') {
    const dropped = rows.filter((r) => SECRET_KEY.test(r.key)).map((r) => r.key);
    rows = rows.filter((r) => !SECRET_KEY.test(r.key));
    report.push(`config: dropped credential rows [${dropped.join(', ')}]`);
  }
  if (name === 'custom-doc-rules') {
    const whyOf = new Map((repo[name]?.data || []).map((r) => [`${r.block}||${r.rule}`, r._why]));
    rows = rows.map((r) => {
      const key = `${r.block}||${r.rule}`;
      const why = whyOf.get(key) || NEW_WHY[key];
      if (!why) report.push(`custom-doc-rules: no _why for [${key}]`);
      return why ? { ...r, _why: why } : r;
    });
  }
  const outSheet = { total: rows.length, limit: rows.length, offset: 0, data: rows };
  if (repo[name]?._comment) outSheet._comment = repo[name]._comment;
  if (sheet[':colWidths']) outSheet[':colWidths'] = sheet[':colWidths'];
  out[name] = outSheet;
  report.push(`${name}: ${rows.length} rows`);
}
out[':names'] = live[':names'];
out[':version'] = live[':version'] ?? repo[':version'];
out[':type'] = live[':type'];
// Update the stale Google wording in the top comment without rewriting it.
out._comment = out._comment.map((line) => line.replace('the bundled / Google-connector default', 'the bundled Google-connector default'));
writeFileSync(REPO_FILE, `${JSON.stringify(out, null, 2)}\n`);
console.log(report.join('\n'));
