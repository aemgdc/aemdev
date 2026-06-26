import fs from 'node:fs/promises';

const allowedSites = new Set(['aemdev']);

export default async function sendPostRequest(authToken, orgName, siteName, configText, configType) {
  const url = `https://admin.hlx.page/config/${orgName}/sites/${siteName}/${configType}`;

  let contentType = 'text/yaml';
  if (configType.indexOf('.txt') > 0) {
    contentType = 'text/plain';
  } else if (configType.indexOf('.json') > 0) {
    contentType = 'application/json';
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `token ${authToken}`,
        'Accept': '*/*',
        'Content-Type': contentType,
      },
      body: configText,
    });

    const responseText = await response.text();
    console.log(`Config update response for ${siteName}/${configType}: ${response.status} ${response.statusText} (${responseText.length} bytes)`);

    if (!response.ok) {
      throw new Error(`Config update request failed for ${orgName}/${siteName}/${configType}: ${response.status} ${response.statusText}`);
    }

    if (response.status === 204) {
      console.log(`Config update for ${orgName}/${siteName}/${configType} completed with 204 No Content; treating as success.`);
      return { status: response.status, statusText: response.statusText };
    }

    if (!responseText.trim()) {
      throw new Error(`Config update returned an empty response for ${orgName}/${siteName}/${configType}`);
    }

    return responseText;
  } catch (error) {
    console.error('update request: ', { error });
    throw error;
  }
}

const authToken = process.env.AUTH_TOKEN;
if (!authToken) {
  throw new Error('AUTH_TOKEN is not set; cannot authenticate to the config API (this surfaces as a 401).');
}
const orgName = process.env.CONFIG_ORG || 'aemgdc';
const siteName = process.env.SITE_NAME;
const configPath = process.env.CONFIG_PATH;
const configName = process.env.CONFIG_NAME;

if (!siteName || !allowedSites.has(siteName)) {
  throw new Error(`SITE_NAME must be one of: ${Array.from(allowedSites).join(', ')}`);
}

const configText = await fs.readFile(configPath, 'utf8');
console.log(configText);

const result = await sendPostRequest(authToken, orgName, siteName, configText, configName);
console.log(result);
