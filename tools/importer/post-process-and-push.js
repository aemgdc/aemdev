#!/usr/bin/env node
/**
 * Post-processes all imported .plain.html files and pushes to DA:
 * 1. Cleans Jetpack junk from each file
 * 2. Converts to DA table format
 * 3. Uploads all images to DA in .{pagename}/ folder
 * 4. Pushes final HTML to DA
 *
 * Usage: node post-process-and-push.js <da-token> [--dry-run]
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const daToken = process.argv[2];
const dryRun = process.argv.includes('--dry-run');

if (!daToken) {
  console.error('Usage: node post-process-and-push.js <da-token> [--dry-run]');
  process.exit(1);
}

const CONTENT_DIR = 'content/en';

// Get .plain.html files that don't have a corresponding .da.html yet (skip already processed)
const files = fs.readdirSync(CONTENT_DIR)
  .filter((f) => f.endsWith('.plain.html'))
  .filter((f) => !fs.existsSync(path.join(CONTENT_DIR, f.replace('.plain.html', '.da.html'))))
  .sort();

console.log(`Found ${files.length} files remaining to process`);
if (dryRun) console.log('DRY RUN — no DA uploads');

let success = 0;
let failed = 0;

for (let i = 0; i < files.length; i++) {
  const file = files[i];
  const slug = file.replace('.plain.html', '');
  const plainPath = path.join(CONTENT_DIR, file);
  const daPath = path.join(CONTENT_DIR, `${slug}.da.html`);

  console.log(`\n[${i + 1}/${files.length}] ${slug}`);

  try {
    // 1. Clean Jetpack junk
    let html = fs.readFileSync(plainPath, 'utf8');
    html = html.replace(/<p><a href="#"><\/a><a href="#"><\/a><\/p>/g, '');
    html = html.replace(/<p>Loading Comments\.\.\.<\/p>/g, '');
    html = html.replace(/<p><a href="#"><\/a><\/p>/g, '');
    html = html.replace(/<p>%d<\/p>/g, '');
    html = html.replace(/<p><img src="https:\/\/pixel\.wp\.com[^"]*" alt=""><\/p>/g, '');
    html = html.replace(/<p>Like Loading\.\.\.<\/p>/g, '');
    fs.writeFileSync(plainPath, html);

    // 2. Convert to DA format
    execSync(`node tools/importer/plain-to-da.js ${plainPath} ${daPath}`, { stdio: 'pipe' });

    // 3. Upload images and push to DA
    if (!dryRun) {
      const output = execSync(
        `node tools/importer/upload-images-to-da.js ${daPath} "${daToken}"`,
        { stdio: 'pipe', timeout: 120000 },
      ).toString();
      const imgCount = (output.match(/✓/g) || []).length;
      console.log(`  ✓ ${imgCount} images uploaded, pushed to DA`);
    } else {
      console.log('  [dry-run] would upload images and push');
    }

    success++;
  } catch (err) {
    console.error(`  ✗ Failed: ${err.message.substring(0, 100)}`);
    failed++;
  }
}

console.log(`\n${'='.repeat(40)}`);
console.log(`Done. Success: ${success}, Failed: ${failed}`);
