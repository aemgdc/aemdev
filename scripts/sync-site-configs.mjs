import fs from 'node:fs/promises';
import path from 'node:path';

const allowedSites = new Set(['aemdev']);

/*
 * Read-back counterpart to update-configs.mjs.
 *
 * update-configs.mjs POSTs a local file to the config service. Nothing pulled the
 * other way, so drift between the deployed config and the repo copy was invisible —
 * and pushing a stale local file silently deletes whatever the deployed config had
 * that the repo copy lacked. This fetches each config and writes it back into
 * config/sites/<site>/ so drift surfaces as a commit.
 *
 * Mirrors the sync-fastly.mjs pattern: fetch, write, let the workflow commit.
 *
 * The API path is NOT always the local filename — sitemap.yaml lives at
 * content/sitemap.yaml and query.yaml at content/query.yaml. Keep this map in step
 * with the CONFIG_NAME values in .github/workflows/update-*-configuration.yaml.
 */
const CONFIGS = [
  { file: 'query.yaml', apiPath: 'content/query.yaml' },
  { file: 'sitemap.yaml', apiPath: 'content/sitemap.yaml' },
  { file: 'headers.json', apiPath: 'headers.json' },
  { file: 'robots.txt', apiPath: 'robots.txt' },
];

async function fetchConfig(authToken, orgName, siteName, apiPath) {
  const url = `https://admin.hlx.page/config/${orgName}/sites/${siteName}/${apiPath}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `token ${authToken}`, Accept: '*/*' },
  });

  // A config that was never set is not an error — leave the local file alone rather
  // than truncating it to an error page.
  if (response.status === 404) {
    console.log(`  ${apiPath}: 404 not set on the config service, skipping`);
    return null;
  }
  if (!response.ok) {
    throw new Error(`Fetch failed for ${orgName}/${siteName}/${apiPath}: ${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  if (!text.trim()) {
    throw new Error(`Empty response for ${orgName}/${siteName}/${apiPath}; refusing to overwrite the local copy`);
  }
  return text;
}

const authToken = process.env.AUTH_TOKEN;
if (!authToken) {
  throw new Error('AUTH_TOKEN is not set; cannot authenticate to the config API (this surfaces as a 401).');
}

const orgName = process.env.CONFIG_ORG || 'aemgdc';
const siteName = process.env.SITE_NAME;

if (!siteName || !allowedSites.has(siteName)) {
  throw new Error(`SITE_NAME must be one of: ${Array.from(allowedSites).join(', ')}`);
}

const outputDir = process.env.OUTPUT_DIR || `config/sites/${siteName}`;
await fs.mkdir(outputDir, { recursive: true });

let written = 0;
let skipped = 0;

for (const { file, apiPath } of CONFIGS) {
  // Sequential on purpose: a rate-limit or auth failure should stop the run before
  // it half-writes the config directory.
  // eslint-disable-next-line no-await-in-loop
  const text = await fetchConfig(authToken, orgName, siteName, apiPath);
  if (text === null) {
    skipped += 1;
  } else {
    const target = path.join(outputDir, file);
    const body = text.endsWith('\n') ? text : `${text}\n`;
    // eslint-disable-next-line no-await-in-loop
    await fs.writeFile(target, body, 'utf8');
    console.log(`  ${apiPath} -> ${target} (${body.length} bytes)`);
    written += 1;
  }
}

console.log(`Synced ${written} config(s) for ${orgName}/${siteName}${skipped ? `, skipped ${skipped}` : ''}.`);
