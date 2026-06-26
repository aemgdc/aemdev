#!/usr/bin/env node
/* eslint-disable no-console */

import fs from 'fs/promises';
import { createSign } from 'crypto';

const OAUTH_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GA4_API_BASE = 'https://analyticsdata.googleapis.com/v1beta';

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function toBase64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function signJwt(assertion, privateKey) {
  const signer = createSign('RSA-SHA256');
  signer.update(assertion);
  signer.end();
  return signer.sign(privateKey, 'base64url');
}

async function getAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claimSet = {
    iss: serviceAccount.client_email,
    scope: OAUTH_SCOPE,
    aud: OAUTH_TOKEN_URL,
    exp: now + 3600,
    iat: now,
  };

  const unsignedToken = `${toBase64Url(JSON.stringify(header))}.${toBase64Url(JSON.stringify(claimSet))}`;
  const signature = signJwt(unsignedToken, serviceAccount.private_key);
  const assertion = `${unsignedToken}.${signature}`;

  const response = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OAuth token request failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  return data.access_token;
}

function normalizePath(pathname) {
  if (!pathname) return '';
  const withoutQuery = pathname.split('?')[0].split('#')[0].trim();
  if (!withoutQuery) return '';
  if (withoutQuery.length > 1 && withoutQuery.endsWith('/')) {
    return withoutQuery.slice(0, -1);
  }
  return withoutQuery;
}

function buildDateRange(lookbackDays) {
  if (lookbackDays === 1) {
    return { startDate: 'yesterday', endDate: 'yesterday' };
  }
  return { startDate: `${lookbackDays}daysAgo`, endDate: 'yesterday' };
}

function compileRegex(raw, fallback) {
  if (!raw) return fallback;
  return new RegExp(raw, 'i');
}

function buildPlainHtml(items, generatedAt, lookbackDays) {
  const isoDate = generatedAt.slice(0, 10);
  const lines = [];
  lines.push('<h2>Most Popular Articles</h2>');
  lines.push(`<p>Updated ${isoDate} (last ${lookbackDays} day${lookbackDays === 1 ? '' : 's'}).</p>`);
  lines.push('<ul>');

  items.forEach((item) => {
    const safeTitle = item.title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    lines.push(`  <li><a href="${item.path}">${safeTitle}</a></li>`);
  });

  lines.push('</ul>');
  return `${lines.join('\n')}\n`;
}

async function run() {
  const propertyId = requireEnv('GA4_PROPERTY_ID');
  const serviceAccountRaw = requireEnv('GA4_SERVICE_ACCOUNT_JSON');
  const serviceAccount = JSON.parse(serviceAccountRaw);

  const lookbackDays = Math.max(1, parseInt(process.env.POPULAR_LOOKBACK_DAYS || '1', 10));
  const limit = Math.max(1, parseInt(process.env.POPULAR_LIMIT || '10', 10));
  const outputJsonPath = process.env.POPULAR_OUTPUT_JSON || 'data/popular-articles.json';
  const outputPlainPath = process.env.POPULAR_OUTPUT_PLAIN || 'fragments/brands/popular-articles.plain.html';

  const includeRegex = compileRegex(process.env.POPULAR_INCLUDE_REGEX, /^\/en\//i);
  const excludeRegex = compileRegex(
    process.env.POPULAR_EXCLUDE_REGEX,
    /\/fragments\/|\/drafts\/|\/404$|\/robots\.txt$|\/query-index\.json$|^\/$|\/index$/i,
  );

  const accessToken = await getAccessToken(serviceAccount);

  const response = await fetch(`${GA4_API_BASE}/properties/${propertyId}:runReport`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      dimensions: [{ name: 'pagePath' }, { name: 'pageTitle' }],
      metrics: [{ name: 'screenPageViews' }],
      dateRanges: [buildDateRange(lookbackDays)],
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      keepEmptyRows: false,
      limit: '200',
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GA4 runReport failed (${response.status}): ${body}`);
  }

  const report = await response.json();
  const rows = report.rows || [];

  const byPath = new Map();

  rows.forEach((row) => {
    const rawPath = row.dimensionValues?.[0]?.value || '';
    const rawTitle = row.dimensionValues?.[1]?.value || '';
    const views = parseInt(row.metricValues?.[0]?.value || '0', 10);
    const path = normalizePath(rawPath);

    if (!path || Number.isNaN(views) || views <= 0) return;
    if (excludeRegex.test(path)) return;
    if (!includeRegex.test(path)) return;

    const current = byPath.get(path);
    if (!current) {
      byPath.set(path, {
        path,
        title: rawTitle || path,
        views,
      });
      return;
    }

    current.views += views;
    if (current.title === current.path && rawTitle) current.title = rawTitle;
  });

  const ranked = [...byPath.values()]
    .sort((a, b) => b.views - a.views)
    .slice(0, limit)
    .map((item, index) => ({
      rank: index + 1,
      path: item.path,
      title: item.title,
      views: item.views,
    }));

  const generatedAt = new Date().toISOString();
  const jsonPayload = {
    generatedAt,
    propertyId,
    lookbackDays,
    metric: 'screenPageViews',
    totalCandidates: byPath.size,
    data: ranked,
  };

  await fs.mkdir(outputJsonPath.split('/').slice(0, -1).join('/') || '.', { recursive: true });
  await fs.mkdir(outputPlainPath.split('/').slice(0, -1).join('/') || '.', { recursive: true });

  await fs.writeFile(outputJsonPath, `${JSON.stringify(jsonPayload, null, 2)}\n`, 'utf8');
  await fs.writeFile(outputPlainPath, buildPlainHtml(ranked, generatedAt, lookbackDays), 'utf8');

  console.log(`Generated ${ranked.length} popular article rows.`);
  console.log(`JSON: ${outputJsonPath}`);
  console.log(`Fragment: ${outputPlainPath}`);
}

run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
