#!/usr/bin/env node

/**
 * Convert WordPress articles to new block format and push to DA.
 *
 * Usage:
 *   node tools/convert-and-push.mjs <bearer-token> --slug slug1,slug2
 *   node tools/convert-and-push.mjs <bearer-token> --all
 *   node tools/convert-and-push.mjs <bearer-token> --batch 5  (first N unconverted)
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const token = args.find(a => !a.startsWith('--'));

if (!token) {
  console.error('Usage: node tools/convert-and-push.mjs <bearer-token> [--slug s1,s2] [--all] [--batch N]');
  process.exit(1);
}

// Already-live articles to skip
const SKIP_SLUGS = new Set([
  'tailing-and-viewing-adobe-cloud-manager-build-logs',
  'testing-geo-seo-with-adobe-llm-optimizer',
  'aem-infrastructure-and-personnel-strategy-a-talk-with-tom-johnson-of-hirobe',
]);

// Determine which files to convert
const contentDir = path.resolve('content/en');
const allSourceFiles = fs.readdirSync(contentDir)
  .filter(f => f.endsWith('.plain.html'))
  .map(f => f.replace('.plain.html', ''));

let targetSlugs = [];

if (args.includes('--all')) {
  targetSlugs = allSourceFiles.filter(s => !SKIP_SLUGS.has(s));
} else if (args.includes('--slug')) {
  const idx = args.indexOf('--slug');
  targetSlugs = args[idx + 1].split(',');
} else if (args.includes('--batch')) {
  const idx = args.indexOf('--batch');
  const count = parseInt(args[idx + 1] || '5', 10);
  targetSlugs = allSourceFiles.filter(s => !SKIP_SLUGS.has(s)).slice(0, count);
} else {
  // Default: first 5
  targetSlugs = allSourceFiles.filter(s => !SKIP_SLUGS.has(s)).slice(0, 5);
}

console.log(`\n=== Converting ${targetSlugs.length} articles ===\n`);

// Step 1: Convert
const sourceFiles = targetSlugs.map(s => `content/en/${s}.plain.html`).filter(f => fs.existsSync(f));

if (sourceFiles.length === 0) {
  console.error('No source files found.');
  process.exit(1);
}

try {
  const result = execSync(`node tools/convert-to-new-blocks.mjs --batch ${sourceFiles.join(' ')}`, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe']
  });
  console.log(result);
} catch (err) {
  console.error('Conversion failed:', err.stderr || err.message);
  process.exit(1);
}

// Step 2: Push
console.log(`\n=== Pushing to DA ===\n`);

try {
  const slugList = targetSlugs.join(',');
  execSync(`node tools/push-articles-to-da.mjs ${token} --slug ${slugList}`, {
    encoding: 'utf-8',
    stdio: 'inherit'
  });
} catch (err) {
  console.error('Push failed.');
  process.exit(1);
}
