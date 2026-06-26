const fs = require('fs').promises;
const path = require('path');
const { parseStringPromise } = require('xml2js');

async function ensureDir(dir) {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (e) {
    // ignore
  }
}

function safeFilename(input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200) || 'post';
}

// Helper to get a string value whether parsed with explicitArray true or false
function getVal(obj, key) {
  if (!obj) return '';
  const v = obj[key];
  if (v == null) return '';
  if (Array.isArray(v)) return v[0];
  return v;
}

// Helper to get an array value regardless of parsing mode
function getArray(obj, key) {
  if (!obj) return [];
  const v = obj[key];
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  return [v];
}

function stripWpComments(html) {
  if (!html) return '';
  // Remove all <!-- wp:* --> and <!-- /wp:* --> comments
  return html.replace(/<!--\s*\/?wp:[^>]*-->/g, '');
}

function makeHtml(post) {
  const title = getVal(post, 'title');
  const link = getVal(post, 'link');
  let rawContent = getVal(post, 'content:encoded');
  const pubDate = getVal(post, 'pubDate');
  const isoDate = pubDate ? new Date(pubDate).toISOString() : '';

  // Strip wp: comments from content
  rawContent = stripWpComments(rawContent);

  const categories = (getArray(post, 'category') || []).map(c => {
    if (typeof c === 'string') return c;
    if (c._) return c._;
    return '';
  }).filter(Boolean);

  // Basic semantic HTML wrapper
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  ${link ? `<link rel="canonical" href="${escapeHtml(link)}">` : ''}
</head>
<body>
  <article>
    <header>
      <h1>${escapeHtml(title)}</h1>
      ${isoDate ? `<time datetime="${isoDate}">${escapeHtml(new Date(isoDate).toLocaleString())}</time>` : ''}
    </header>
    <section class="content">
      ${rawContent}
    </section>
    ${categories.length ? `<footer><p>Categories: ${categories.map(escapeHtml).join(', ')}</p></footer>` : ''}
  </article>
</body>
</html>`;
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function main() {
  const baseDir = path.resolve(__dirname);
  const artifactsDir = path.join(baseDir, 'artifacts');
  const inputFile = path.join(artifactsDir, 'opsinventor.WordPress.2024-09-14.xml');
  const outDir = path.join(artifactsDir, 'posts');

  await ensureDir(outDir);

  let xml;
  try {
    xml = await fs.readFile(inputFile, 'utf8');
  } catch (err) {
    console.error('Could not read input file:', inputFile, err.message);
    process.exit(1);
  }

  let parsed;
  try {
    // Use a simpler parsing mode (no explicit arrays) to get predictable keys
    parsed = await parseStringPromise(xml, { explicitArray: false, mergeAttrs: true });
  } catch (err) {
    console.error('Failed to parse XML:', err.message);
    process.exit(1);
  }

  // Debug: show top-level keys so we can find where the items are
  console.log('Parsed top-level keys:', Object.keys(parsed || {}));

  const channel = parsed && parsed.rss && parsed.rss.channel;
  if (!channel) {
    console.error('No <channel> element found under rss. Parsed structure may differ.');
    try {
      await fs.writeFile(path.join(outDir, 'parsed-debug.json'), JSON.stringify(parsed, null, 2), 'utf8');
    } catch (e) {
      // ignore
    }
    process.exit(1);
  }

  // items might be a single object or an array
  const items = Array.isArray(channel.item) ? channel.item : (channel.item ? [channel.item] : []);
  if (!items.length) {
    console.error('No items found in channel.');
    try {
      await fs.writeFile(path.join(outDir, 'parsed-debug.json'), JSON.stringify(parsed, null, 2), 'utf8');
    } catch (e) {
      // ignore
    }
    process.exit(1);
  }

  console.log(`Found ${items.length} items; processing posts...`);

  let count = 0;
  for (const item of items) {
    const postType = getVal(item, 'wp:post_type');
    const status = getVal(item, 'wp:status');

    // Only handle regular published posts
    if (postType !== 'post' || status !== 'publish') continue;

  const title = getVal(item, 'title');
  const slug = getVal(item, 'wp:post_name') || safeFilename(title);
  const filename = `${safeFilename(slug)}.html`;
  const outPath = path.join(outDir, filename);

    const html = makeHtml(item);
    await fs.writeFile(outPath, html, 'utf8');
    count += 1;
  }

  console.log(`Wrote ${count} post HTML files to ${outDir}`);
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
