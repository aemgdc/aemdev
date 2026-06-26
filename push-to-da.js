#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import FormData from 'form-data';

// Configuration
const ORG = 'treeves';
const SITE = 'opsinventor-eds';
const BASE_PATH = '/blog/replacing-an-ssl-certificate-on-aem-6-5';
const API_BASE = 'https://admin.da.live/api/v1/source';

// Get IMS token from environment or command line
const imsToken = process.env.IMS_TOKEN || process.argv[2];

if (!imsToken) {
  console.error('Error: IMS_TOKEN environment variable or command line argument required');
  console.error('Usage: node push-to-da.js <token>');
  process.exit(1);
}

async function uploadFile(filePath, daPath) {
  try {
    const fileContent = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    
    const form = new FormData();
    form.append('data', fileContent, fileName);
    
    const url = `${API_BASE}/${ORG}/${SITE}${daPath}`;
    
    console.log(`Uploading: ${fileName} -> ${daPath}`);
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${imsToken}`,
        ...form.getHeaders()
      },
      body: form
    });
    
    if (response.ok || response.status === 201) {
      console.log(`  ✓ Success (${response.status})`);
      return true;
    } else {
      console.error(`  ✗ Failed (${response.status}): ${response.statusText}`);
      const text = await response.text();
      if (text) console.error(`  Response: ${text}`);
      return false;
    }
  } catch (error) {
    console.error(`  ✗ Error: ${error.message}`);
    return false;
  }
}

async function createFolder(folderPath) {
  try {
    const url = `${API_BASE}/${ORG}/${SITE}${folderPath}`;
    
    console.log(`Creating: folder ${folderPath}`);
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${imsToken}`
      }
    });
    
    if (response.ok || response.status === 201 || response.status === 409) {
      const status = response.status === 409 ? '(already exists)' : '';
      console.log(`  ✓ Complete ${status}`);
      return true;
    } else {
      console.error(`  ✗ Failed (${response.status}): ${response.statusText}`);
      const text = await response.text();
      if (text) console.error(`  Response: ${text}`);
      return false;
    }
  } catch (error) {
    console.error(`  ✗ Error: ${error.message}`);
    return false;
  }
}

async function main() {
  console.log('');
  console.log('=== DA Live Push ===');
  console.log(`Org: ${ORG}`);
  console.log(`Site: ${SITE}`);
  console.log(`Base Path: ${BASE_PATH}`);
  console.log('');
  
  const results = {
    success: 0,
    failed: 0
  };
  
  // Create folder structure
  await createFolder(BASE_PATH);
  await createFolder(`${BASE_PATH}/images`);
  
  // Upload HTML file
  const htmlPath = `./blog/replacing-an-ssl-certificate-on-aem-6-5/index.plain.html`;
  if (fs.existsSync(htmlPath)) {
    const success = await uploadFile(htmlPath, `${BASE_PATH}/index.plain.html`);
    success ? results.success++ : results.failed++;
  } else {
    console.error(`✗ HTML file not found: ${htmlPath}`);
    results.failed++;
  }
  
  // Upload all images
  const imagesDir = `./blog/replacing-an-ssl-certificate-on-aem-6-5/images`;
  if (fs.existsSync(imagesDir)) {
    const files = fs.readdirSync(imagesDir);
    console.log(`\nUploading ${files.length} images...`);
    
    for (const file of files) {
      const filePath = path.join(imagesDir, file);
      if (fs.statSync(filePath).isFile()) {
        const success = await uploadFile(filePath, `${BASE_PATH}/images/${file}`);
        success ? results.success++ : results.failed++;
      }
    }
  }
  
  console.log('');
  console.log('=== Summary ===');
  console.log(`✓ Uploaded: ${results.success}`);
  console.log(`✗ Failed: ${results.failed}`);
  console.log('');
  
  if (results.failed === 0) {
    console.log(`Page available at: https://da.live/#/${ORG}/${SITE}${BASE_PATH}/index.plain.html`);
  }
  
  process.exit(results.failed > 0 ? 1 : 0);
}

main();
