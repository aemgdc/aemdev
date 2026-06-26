#!/usr/bin/env node

/**
 * Push converted articles to DA.live
 *
 * Usage:
 *   DA_TOKEN=xxx node tools/push-articles-to-da.mjs --all
 *   node tools/push-articles-to-da.mjs <token> --slug slug1,slug2,...
 *   node tools/push-articles-to-da.mjs <token> --all
 */

import fs from 'fs';
import path from 'path';

const ORG = 'treeves';
const SITE = 'opsinventor-eds';
const API_BASE = 'https://admin.da.live/source';

const args = process.argv.slice(2);
const token = process.env.DA_TOKEN || args.find(a => !a.startsWith('--'));

if (!token) {
  console.error('Usage: node tools/push-articles-to-da.mjs <bearer-token> [--slug slug1,slug2] [--all]');
  process.exit(1);
}

let slugs = [];

if (args.includes('--all')) {
  const enDir = path.resolve('en');
  if (fs.existsSync(enDir)) {
    const entries = fs.readdirSync(enDir, { withFileTypes: true });
    slugs = entries
      .filter(e => e.isDirectory())
      .filter(e => fs.existsSync(path.join(enDir, e.name, 'index.plain.html')))
      .map(e => e.name);
  }
} else {
  const slugIdx = args.indexOf('--slug');
  if (slugIdx >= 0 && args[slugIdx + 1]) {
    slugs = args[slugIdx + 1].split(',');
  } else {
    console.error('Specify --slug slug1,slug2 or --all');
    process.exit(1);
  }
}

// Skip already-live articles that were manually created
const SKIP_SLUGS = new Set([
  'tailing-and-viewing-adobe-cloud-manager-build-logs',
  'testing-geo-seo-with-adobe-llm-optimizer',
  'aem-infrastructure-and-personnel-strategy-a-talk-with-tom-johnson-of-hirobe',
]);

slugs = slugs.filter(s => !SKIP_SLUGS.has(s));

if (slugs.length === 0) {
  console.error('No articles found to push.');
  process.exit(1);
}

async function uploadArticle(slug) {
  const localPath = path.resolve('en', slug, 'index.plain.html');
  if (!fs.existsSync(localPath)) {
    return { slug, success: false, error: 'file not found' };
  }

  const html = fs.readFileSync(localPath, 'utf-8');
  const url = `${API_BASE}/${ORG}/${SITE}/en/${slug}.html`;

  try {
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'text/html',
      },
      body: html,
    });

    if (response.ok || response.status === 201) {
      return { slug, success: true, status: response.status };
    } else {
      const text = await response.text();
      return { slug, success: false, status: response.status, error: text };
    }
  } catch (err) {
    return { slug, success: false, error: err.message };
  }
}

async function main() {
  console.log(`\n=== Pushing ${slugs.length} articles to DA ===\n`);

  let success = 0;
  let failed = 0;

  // Process in batches of 5
  const batchSize = 5;
  for (let i = 0; i < slugs.length; i += batchSize) {
    const batch = slugs.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(uploadArticle));

    for (const r of results) {
      if (r.success) {
        console.log(`  ✓ ${r.slug}`);
        success++;
      } else {
        console.log(`  ✗ ${r.slug} (${r.error || r.status})`);
        failed++;
      }
    }

    if (i + batchSize < slugs.length) {
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }

  console.log(`\n=== Done: ${success} pushed, ${failed} failed ===`);
  if (success > 0) {
    console.log(`\nPreview: https://main--opsinventor-eds--treeves.aem.page/en/<slug>`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
