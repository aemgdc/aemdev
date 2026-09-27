/* eslint-disable no-console, no-continue */
// Finish a stalled Translate-app rollout for one locale from Node: download the translated
// files from the (completed) Smartling job and save them into DA exactly as the app would,
// using DA's own removeDnt (da-nx) under jsdom. Only docs missing in DA are written unless --all.
// Needs a da-nx checkout: see da-nx.mjs (env DA_NX). Dry run unless --apply.
// Usage: node finish-rollout.mjs <projectEpoch> <smartlingLocale e.g. zh-TW> [--apply] [--all]
// jsdom is a devDependency on purpose: nothing a visitor loads reaches this file.
// eslint-disable-next-line import/no-extraneous-dependencies
import { JSDOM } from 'jsdom';
import { getJson, getSource, putSource, version } from './da.mjs';
import { smartlingSession } from './smartling.mjs';
import { importDaNx } from './da-nx.mjs';

globalThis.DOMParser = new JSDOM('').window.DOMParser;
const { removeDnt } = await importDaNx('nx/blocks/loc/dnt/dnt.js');

const [epoch, locale, ...flags] = process.argv.slice(2);
const apply = flags.includes('--apply');
const all = flags.includes('--all');
const p = (await getJson(`/.da/translation/active/${epoch}.json`)).json;
const svc = p.options.service;
const lang = p.langs.find((l) => l.code === locale);
if (!lang) throw new Error(`no lang ${locale}`);
const { get, getText } = await smartlingSession(svc.env || 'prod');
const filesResp = await get(`/jobs-api/v3/projects/${svc.projectId}/jobs/${svc.jobUid.value}/files?limit=500`);
const uris = (filesResp.json?.response?.data?.items || []).map((f) => f.uri || f.fileUri);
console.log(`job files: ${uris.length} (e.g. ${uris[0]})`);

let written = 0;
let skipped = 0;
const errors = [];
for (const uri of uris) {
  const rel = uri.replace(/\.html$/, '');
  const dest = `${lang.location}${rel}.html`;
  if (!all && (await getSource(dest)).status === 200) {
    skipped += 1;
    continue;
  }
  const text = await getText(`/files-api/v2/projects/${svc.projectId}/locales/${locale}/file?fileUri=${encodeURIComponent(uri)}`);
  if (!text) {
    errors.push(`${uri}: download failed`);
    continue;
  }
  const html = await removeDnt({ org: 'aemgdc', site: 'aemdev', html: text, ext: 'html' });
  if (!apply) {
    console.log(`would write ${dest} (${html.length} bytes)`);
    written += 1;
    continue;
  }
  const status = await putSource(dest, html, 'text/html');
  if (status === 200 || status === 201) {
    written += 1;
    await version(dest, `${p.title} - Rolled Out`);
  } else errors.push(`${dest}: write ${status}`);
}
console.log(`${apply ? 'written' : 'would write'} ${written}, skipped (present) ${skipped}, errors ${errors.length}`);
errors.forEach((e) => console.log(`  ! ${e}`));
