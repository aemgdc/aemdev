// Minimal DA + admin helpers for aemgdc/aemdev l10n operations. Never prints the token.
// jsdom is a devDependency on purpose: nothing a visitor loads reaches this file.
// eslint-disable-next-line import/no-extraneous-dependencies
import { JSDOM } from 'jsdom';
import { resolveToken } from '../tracker/lib/status-sheet.mjs';

export const ORG = 'aemgdc';
export const SITE = 'aemdev';
export const ADMIN = 'https://admin.da.live';
const TOKEN = resolveToken();
const auth = () => ({ Authorization: `Bearer ${TOKEN}` });

export async function daFetch(url, opts = {}) {
  for (let a = 0; a < 4; a += 1) {
    const r = await fetch(url, { ...opts, headers: { ...auth(), ...(opts.headers || {}) } });
    if (r.status !== 429 && r.status < 500) return r;
    await new Promise((res) => { setTimeout(res, 1000 * (a + 1)); });
  }
  return fetch(url, { ...opts, headers: { ...auth(), ...(opts.headers || {}) } });
}
export async function getSource(path) {
  const r = await daFetch(`${ADMIN}/source/${ORG}/${SITE}${path}?nocache=${Date.now()}`);
  return { status: r.status, etag: r.headers.get('etag'), text: r.ok ? await r.text() : '' };
}
export async function getJson(path) {
  const r = await getSource(path);
  return { ...r, json: r.text ? JSON.parse(r.text) : null };
}
export async function putSource(path, body, type) {
  const fd = new FormData();
  fd.append('data', new Blob([body], { type }));
  return (await daFetch(`${ADMIN}/source/${ORG}/${SITE}${path}`, { method: 'POST', body: fd })).status;
}
export async function version(path, label) {
  const url = `${ADMIN}/versionsource/${ORG}/${SITE}${path}`;
  return (await daFetch(url, { method: 'POST', body: JSON.stringify({ label }) })).status;
}
export async function list(path) {
  const r = await daFetch(`${ADMIN}/list/${ORG}/${SITE}${path}`);
  return r.ok ? r.json() : null;
}
export async function walk(folder) {
  const out = [];
  for (const it of (await list(folder)) || []) {
    const p = `${folder}/${it.name}`;
    if (!it.ext) out.push(...await walk(p));
    else if (it.ext === 'html') out.push(p);
  }
  return out;
}
export const parse = (html) => new JSDOM(html).window.document;
export const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
export const blocks = (doc) => [...doc.querySelectorAll('main > div > div[class]')];

/** Version a JSON source, mutate it, and write it back only if nobody wrote in between. */
export async function versionedJsonEdit(path, label, mutate) {
  const before = await getJson(path);
  if (!before.json) return { error: `read ${before.status}` };
  const v = await version(path, label);
  if (v !== 201) return { error: `version ${v}` };
  const again = await getSource(path);
  if (again.etag !== before.etag) return { error: 'changed while versioning' };
  const changed = mutate(before.json);
  if (!changed) return { unchanged: true };
  const status = await putSource(path, JSON.stringify(before.json), 'application/json');
  const after = await getJson(path);
  return { status, after: after.json };
}

// ---- admin.hlx.page preview / publish / status (same headers the tracker uses) ----
const adminHeaders = () => ({ Authorization: `Bearer ${TOKEN}`, 'x-content-source-authorization': `Bearer ${TOKEN}` });
async function adminOp(op, path) {
  for (let a = 0; a < 5; a += 1) {
    const r = await fetch(`https://admin.hlx.page/${op}/${ORG}/${SITE}/main${path}`, { method: 'POST', headers: adminHeaders() });
    if (r.status !== 429 && r.status < 500) return { status: r.status, error: r.headers.get('x-error') };
    await new Promise((res) => { setTimeout(res, 1500 * (a + 1)); });
  }
  return { status: 599 };
}
/** `path` is the web path without extension, e.g. /de/meetups/x or /de/ for a folder index. */
export const preview = (p) => adminOp('preview', p);
export const publish = (p) => adminOp('live', p);
export async function adminStatus(path) {
  const resp = await fetch(`https://admin.hlx.page/status/${ORG}/${SITE}/main${path}`, { headers: adminHeaders() });
  return resp.ok ? resp.json() : { status: resp.status };
}
