import fs from 'node:fs/promises';
import path from 'node:path';

const API_BASE = 'https://api.fastly.com';

// Versioned config object collections worth tracking. Each becomes a JSON file
// under objects/. Add more endpoint names here as needed.
const VERSIONED_COLLECTIONS = [
  'domain',
  'backend',
  'healthcheck',
  'condition',
  'header',
  'request_settings',
  'cache_settings',
  'response_object',
  'gzip',
  'snippet',
  'acl',
  'dictionary',
  'rate_limiter',
];

// Volatile fields that change on every deploy/clone and only add diff noise.
const VOLATILE_KEYS = new Set(['version', 'created_at', 'updated_at', 'deleted_at', 'created', 'updated', 'deleted']);

function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'service';
}

function stripVolatile(value) {
  if (Array.isArray(value)) {
    return value.map(stripVolatile);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !VOLATILE_KEYS.has(key))
        .map(([key, val]) => [key, stripVolatile(val)]),
    );
  }
  return value;
}

async function fastly(apiToken, endpoint, { accept = 'application/json' } = {}) {
  const url = `${API_BASE}${endpoint}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Fastly-Key': apiToken,
      Accept: accept,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Fastly request failed for ${endpoint}: ${response.status} ${response.statusText} ${body}`.trim());
  }

  if (accept === 'application/json') {
    return response.json();
  }
  return response.text();
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeText(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const normalized = value.endsWith('\n') ? value : `${value}\n`;
  await fs.writeFile(filePath, normalized, 'utf8');
}

const apiToken = process.env.FASTLY_API_TOKEN;
const serviceId = process.env.FASTLY_SERVICE_ID;
const stripNoise = process.env.FASTLY_KEEP_METADATA !== 'true';

if (!apiToken) {
  throw new Error('FASTLY_API_TOKEN is required');
}
if (!serviceId) {
  throw new Error('FASTLY_SERVICE_ID is required');
}

// 1. Service details + verify the token can read the service.
const service = await fastly(apiToken, `/service/${serviceId}/details`);
const slug = slugify(service.name || serviceId);
const outDir = process.env.OUTPUT_DIR || `config/fastly/${slug}`;

// 2. Resolve the active version (fall back to the highest-numbered version).
const versions = await fastly(apiToken, `/service/${serviceId}/version`);
const active = versions.find((v) => v.active) || versions.find((v) => v.staging);
const latest = versions.reduce((a, b) => (b.number > a.number ? b : a), versions[0]);
const target = active || latest;

if (!target) {
  throw new Error(`No versions found for service ${serviceId}`);
}

const version = target.number;
console.log(`Fastly service "${service.name}" (${serviceId}) — syncing version ${version}${active ? ' (active)' : ' (latest, none active)'}`);

// 3. Service-level summary (stable identity, which version is live).
await writeJson(path.join(outDir, 'service.json'), stripNoise ? stripVolatile({
  id: service.id,
  name: service.name,
  type: service.type,
  customer_id: service.customer_id,
  active_version: active ? version : null,
  synced_version: version,
  comment: service.comment,
}) : service);

// 4. Version metadata + settings.
const versionDetail = await fastly(apiToken, `/service/${serviceId}/version/${version}`);
await writeJson(path.join(outDir, 'version.json'), stripNoise ? stripVolatile(versionDetail) : versionDetail);

const settings = await fastly(apiToken, `/service/${serviceId}/version/${version}/settings`);
await writeJson(path.join(outDir, 'settings.json'), stripNoise ? stripVolatile(settings) : settings);

// 5. Generated (compiled) VCL — the full effective config in one file.
const generatedVcl = await fastly(apiToken, `/service/${serviceId}/version/${version}/generated_vcl`, { accept: 'application/json' });
if (generatedVcl && generatedVcl.content) {
  await writeText(path.join(outDir, 'generated.vcl'), generatedVcl.content);
}

// 6. Custom VCL files (when boilerplate/custom VCL is in use).
const customVcl = await fastly(apiToken, `/service/${serviceId}/version/${version}/vcl`);
for (const vcl of customVcl) {
  await writeText(path.join(outDir, 'vcl', `${slugify(vcl.name)}.vcl`), vcl.content || '');
}
if (customVcl.length === 0) {
  await fs.rm(path.join(outDir, 'vcl'), { recursive: true, force: true });
}

// 7. Each versioned config object collection.
for (const collection of VERSIONED_COLLECTIONS) {
  try {
    const items = await fastly(apiToken, `/service/${serviceId}/version/${version}/${collection}`);
    const sorted = Array.isArray(items)
      ? [...items].sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')))
      : items;
    await writeJson(path.join(outDir, 'objects', `${collection}.json`), stripNoise ? stripVolatile(sorted) : sorted);
  } catch (error) {
    // Not every account/service exposes every collection; record and move on.
    console.warn(`Skipping ${collection}: ${error.message}`);
  }
}

console.log(`Fastly config written to ${outDir}`);
