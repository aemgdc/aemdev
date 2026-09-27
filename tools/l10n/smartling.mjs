/* eslint-disable no-console */
// Read-only Smartling job status for a DA translation project, via the same da-etc
// login + translate.da.live proxy the Translate app uses. Tokens stay in-process.
// Usage: node smartling.mjs <projectEpochMs>
import { daFetch, getJson } from './da.mjs';

export async function smartlingSession(env = 'prod') {
  const resp = await daFetch(`https://da-etc.adobeaem.workers.dev/aemgdc/sites/aemdev/integrations/smartling/login?env=${env}`, { method: 'POST' });
  if (!resp.ok) throw new Error(`da-etc login ${resp.status}`);
  const token = (await resp.json())?.response?.data?.accessToken;
  if (!token) throw new Error('da-etc login returned no token');
  const endpoint = 'https://translate.da.live/translate/smartling/aemgdc/aemdev';
  const get = async (path) => {
    const r = await fetch(`${endpoint}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const getText = async (path) => {
    const r = await fetch(`${endpoint}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    return r.ok ? r.text() : null;
  };
  return { get, getText };
}

export async function jobStatus(projectEpoch) {
  const p = (await getJson(`/.da/translation/active/${projectEpoch}.json`)).json;
  const svc = p.options.service;
  const { get } = await smartlingSession(svc.env || 'prod');
  const job = (await get(`/jobs-api/v3/projects/${svc.projectId}/jobs/${svc.jobUid.value}`)).json?.response?.data || {};
  const prog = (await get(`/jobs-api/v3/projects/${svc.projectId}/jobs/${svc.jobUid.value}/progress`)).json?.response?.data || {};
  return {
    title: p.title,
    jobStatus: job.jobStatus,
    overall: prog.progress,
    perLocale: (prog.contentProgressReport || []).map((c) => `${c.targetLocaleId}:${c.progress === null ? 'none' : `${c.progress?.percentComplete}%`}`),
    langs: p.langs.map((l) => `${l.code}:${l.translation?.status ?? '-'}/saved=${l.translation?.saved ?? 0}`),
  };
}

if (process.argv[2]) {
  const s = await jobStatus(process.argv[2]);
  console.log(`${s.title}: job ${s.jobStatus} · overall ${JSON.stringify(s.overall)}`);
  console.log(`smartling: ${s.perLocale.join(' ')}`);
  console.log(`DA project: ${s.langs.join(' ')}`);
}
