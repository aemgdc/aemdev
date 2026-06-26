import fs from 'node:fs/promises';

const allowedSites = new Set(['aemdev']);

export default async function sendGetRequest(authToken, orgName, siteName) {
  const url = `https://admin.hlx.page/config/${orgName}/sites/${siteName}.json`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `token ${authToken}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      }
    });

    if (!response.ok) {
      throw new Error(`Config sync request failed for ${orgName}/${siteName}: ${response.status} ${response.statusText}`);
    }

    const responseText = await response.text();
    console.log(`Config sync response for ${orgName}/${siteName}: ${response.status} ${response.statusText} (${responseText.length} bytes)`);
    if (!responseText.trim()) {
      throw new Error(`Config sync returned an empty response for ${orgName}/${siteName}`);
    }

    const config = JSON.parse(responseText);
    if (config === null || Array.isArray(config) || typeof config !== 'object') {
      throw new Error(`Config sync returned an invalid site payload for ${orgName}/${siteName}`);
    }

    return config;
  } catch (error) {
    console.error('sync request: ', { error });
    throw error;
  }
}

const authToken = process.env.AUTH_TOKEN;
const orgName = process.env.CONFIG_ORG || 'aemgdc';
const siteName = process.env.SITE_NAME;

if (!siteName || !allowedSites.has(siteName)) {
  throw new Error(`SITE_NAME must be one of: ${Array.from(allowedSites).join(', ')}`);
}

const outputPath = process.env.OUTPUT_PATH || `config/sites/${siteName}/site.json`;

const result = await sendGetRequest(authToken, orgName, siteName);
await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
