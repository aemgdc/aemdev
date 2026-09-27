/* eslint-disable no-console */
// Build (and with --apply write) a DA Translate project for a list of EN paths, using the
// tracker's own reverse-engineered shape. The connector is NOT run: a person clicks through.
// Usage: node make-project.mjs <title> [--apply] /en/meetups/x /en/fragments/bios/y ...
// createdBy follows the tracker's rule (a pipeline says so rather than borrow a person's
// address): `aemdev-l10n@<hostname>`, or L10N_CREATED_BY when set.
import { hostname } from 'node:os';
import { buildProject, assertProject, writeProject } from '../tracker/lib/tx-project.mjs';
import { TARGET_LOCALES } from '../../scripts/tracker/locales.js';
import { resolveToken } from '../tracker/lib/status-sheet.mjs';

const [title, ...rest] = process.argv.slice(2);
const apply = rest.includes('--apply');
const paths = rest.filter((p) => p.startsWith('/'));
const createdBy = process.env.L10N_CREATED_BY || `aemdev-l10n@${hostname()}`;
const { doc, path, epochMs } = buildProject({
  title, paths, codes: TARGET_LOCALES, createdBy, view: 'basics',
});
const problems = assertProject(doc);
console.log(`project ${epochMs} "${title}": ${doc.urls.length} urls × ${doc.langs.length} langs [${doc.langs.map((l) => l.code).join(' ')}]`, problems?.length ? `PROBLEMS ${problems}` : 'valid');
if (apply && !(problems?.length)) {
  const r = await writeProject(resolveToken(), path, doc);
  console.log('write', typeof r === 'object' ? JSON.stringify(r).slice(0, 120) : r, `→ https://da.live/apps/loc#/basics/aemgdc/aemdev/.da/translation/active/${epochMs}`);
}
