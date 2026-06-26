#!/usr/bin/env node
/**
 * Downloads ALL images from a post and uploads them to DA.
 * Images are stored in the DA convention: /en/.{pagename}/{filename}
 * Updates the .da.html with DA content URLs and <picture> elements.
 *
 * Usage: node upload-images-to-da.js <da-html-file> <da-token>
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const daHtmlFile = process.argv[2];
const daToken = process.argv[3];

const ORG = 'treeves';
const SITE = 'opsinventor-eds';
const DA_CONTENT_BASE = `https://content.da.live/${ORG}/${SITE}`;

if (!daHtmlFile || !daToken) {
  console.error('Usage: node upload-images-to-da.js <da-html-file> <da-token>');
  process.exit(1);
}

function downloadImage(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadImage(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const contentType = res.headers['content-type'] || 'image/png';
        resolve({ buffer: Buffer.concat(chunks), contentType });
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function uploadToDA(daPath, buffer, contentType) {
  const url = `https://admin.da.live/source/${ORG}/${SITE}${daPath}`;
  const boundary = `----FormBoundary${crypto.randomBytes(8).toString('hex')}`;
  const filename = path.basename(daPath);

  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="data"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, buffer, footer]);

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${daToken}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`DA upload failed (${response.status}): ${text}`);
  }
  return response.json();
}

function getExtFromContentType(contentType) {
  const map = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg',
    'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg',
  };
  return map[contentType] || '.png';
}

async function main() {
  let html = fs.readFileSync(daHtmlFile, 'utf8');

  // Determine the DA document path and .{pagename} folder
  // e.g. content/en/my-post.da.html -> pagename = my-post, folder = /en/.my-post
  const relPath = daHtmlFile.replace(/^content/, '').replace(/\.da\.html$/, '').replace(/\.plain\.html$/, '');
  const pageName = path.basename(relPath);
  const dirPath = path.dirname(relPath);
  const imageFolder = `${dirPath}/.${pageName}`;

  console.log(`Page: ${relPath}`);
  console.log(`Image folder: ${imageFolder}`);

  // Find ALL image URLs in the HTML (src attributes and srcset)
  const imgSrcRegex = /(?:src|srcset)="(https?:\/\/[^"]+)"/g;
  const allUrls = new Set();
  let m;
  while ((m = imgSrcRegex.exec(html)) !== null) {
    const url = m[1].replace(/&amp;/g, '&');
    // Skip non-image URLs, tracking pixels, and gravatar
    if (url.includes('pixel.wp.com') || url.includes('g.gif') || url.includes('gravatar.com')) continue;
    // Only process WordPress image URLs
    if (url.includes('wp.com') || url.includes('opsinventor.com/wp-content')) {
      allUrls.add(url);
    }
  }

  // Also check metadata table image cell
  const metaImgMatch = html.match(/<tr><td>image<\/td><td>([^<]+)<\/td><\/tr>/);
  if (metaImgMatch) {
    const metaUrl = metaImgMatch[1].replace(/&amp;/g, '&');
    if (metaUrl.startsWith('http')) allUrls.add(metaUrl);
  }

  console.log(`Found ${allUrls.size} unique image URLs to process`);

  // Download and upload each image, build URL mapping
  const urlMap = {};
  let idx = 0;
  for (const originalUrl of allUrls) {
    idx++;
    try {
      console.log(`[${idx}/${allUrls.size}] Downloading: ${originalUrl.substring(0, 80)}...`);
      const { buffer, contentType } = await downloadImage(originalUrl);
      const ext = getExtFromContentType(contentType);
      const hash = crypto.createHash('md5').update(buffer).digest('hex').substring(0, 12);
      const filename = `img${hash}${ext}`;
      const daPath = `${imageFolder}/${filename}`;
      const daContentUrl = `${DA_CONTENT_BASE}${daPath}`;

      await uploadToDA(daPath, buffer, contentType);
      urlMap[originalUrl] = daContentUrl;
      console.log(`  ✓ -> ${daPath}`);
    } catch (err) {
      console.error(`  ✗ Failed: ${err.message}`);
    }
  }

  // Replace all image URLs in HTML with DA URLs
  // Handle both src="url" and srcset="url" and &amp; encoded versions
  for (const [origUrl, daUrl] of Object.entries(urlMap)) {
    const escaped = origUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const ampEscaped = origUrl.replace(/&/g, '&amp;').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    html = html.replace(new RegExp(escaped, 'g'), daUrl);
    html = html.replace(new RegExp(ampEscaped, 'g'), daUrl);
  }

  // For the metadata image: replace the plain text URL in the table cell
  // with a <picture> element (DA convention)
  html = html.replace(
    /<tr><td>image<\/td><td>(https:\/\/content\.da\.live[^<]+)<\/td><\/tr>/,
    (match, daUrl) => {
      const picture = `<picture><source srcset="${daUrl}"><source srcset="${daUrl}" media="(min-width: 600px)"><img src="${daUrl}" alt="" loading="lazy"></picture>`;
      return `<tr><td>image</td><td>${picture}</td></tr>`;
    }
  );

  // Write updated HTML
  fs.writeFileSync(daHtmlFile, html);
  console.log(`\nUpdated ${daHtmlFile} with ${Object.keys(urlMap).length} DA image refs`);

  // Upload the final HTML to DA
  console.log('Uploading final HTML to DA...');
  const htmlBuffer = Buffer.from(html, 'utf8');
  await uploadToDA(`${relPath}.html`, htmlBuffer, 'text/html');
  console.log('✓ Done!');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
