/**
 * da-ims.mjs — mint the DA/AEM token from an OAuth Server-to-Server credential.
 *
 * ─── What this replaces ──────────────────────────────────────────────────────
 *
 * Every pipeline write used a DA **user** token: a human logged into da.live, copied it
 * into `~/today-da-token.txt`, and it expired exactly 24 hours later. Its claims say so
 * plainly — `client_id: darkalley`, `user_id` present, `expires_in: 86400000`.
 *
 * The failure mode was not that it expired; it is that nothing noticed. A cron ran the
 * translation scan dozens of times a day against a dead token, and the tool printed
 * "Published … 10 locale index file(s)" underneath ten lines of `POST 401`. The
 * dashboard simply stopped getting newer, for a day at a time.
 *
 * ─── One credential, two APIs ────────────────────────────────────────────────
 *
 * Proven against the live services:
 *
 *     IMS mint (client_credentials)   granted aem.frontend.all,openid,AdobeID,read_organizations
 *     admin.da.live  GET              200
 *     admin.da.live  POST  (write)    201
 *     admin.hlx.page preview          200   ← needs BOTH Authorization headers
 *
 * Two things had to be right and each failed loudly first, which is worth recording
 * because neither is guessable:
 *
 *   1. The **Edge Delivery Services card** must be attached to the Developer Console
 *      project. Without it IMS silently drops the AEM scope — a mint that "succeeds" with
 *      only `openid,AdobeID` and 401s everywhere. Asking for `aem.frontend.all` alone
 *      returns the real diagnosis: "None of the requested scopes are both on the client
 *      and the binding."
 *   2. DA authorises on the identity **inside the token**, which is the technical account
 *      ID (`6530C10C…@techacct.adobe.com`) — NOT the technical account email the console
 *      shows most prominently (`fa7fcb52-…@techacct.adobe.com`). With only the email in
 *      DA's permission sheet the call authenticates and then 403s. 401 → 403 is the tell:
 *      it means the identity is recognised and the ACL simply has no row for it.
 *
 * ─── Why a cache file rather than minting in-process ─────────────────────────
 *
 * `resolveToken()` (lib/status-sheet.mjs) is synchronous and called from every write
 * path; making it async would touch every one. So minting happens in one place — a
 * token CLI calling `ensureDaToken()` — which writes a short-lived token to
 * `~/.aemdev-tracker/da-token.json`, and `resolveToken()` gains a sync read of that
 * file. Nothing else changes.
 *
 * The cache is mode 0600 and holds a token, not the secret. It is refreshed when it is
 * inside `SKEW_MS` of expiry, so a long batch cannot have it die underneath.
 */
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { SITE } from '../../../scripts/tracker/paths.js';

const CRED_DIR = process.env.AEMDEV_TRACKER_CRED_DIR || join(homedir(), '.aemdev-tracker');
export const DA_TOKEN_CACHE = process.env.DA_TOKEN_CACHE || join(CRED_DIR, 'da-token.json');
const CRED_PATH = process.env.AEMDEV_TRACKER_CREDENTIALS || join(CRED_DIR, 'credentials.json');
const IMS_TOKEN_URL = 'https://ims-na1.adobelogin.com/ims/token/v3';

/**
 * The site key a credential is stored under, matching the DA site this tracker runs on.
 *
 * Taken from `paths.js` rather than spelled again. It is the same identity `daSourceUrl`
 * builds every request against, and a credential filed under a key that no longer
 * matches the site fails as "no credential for this site" — which reads like a missing
 * card in the Developer Console, sending you to fix the wrong thing entirely.
 */
export const DEFAULT_SITE_KEY = SITE;

/**
 * The scope set that actually works.
 *
 * `aem.frontend.all` is the one that matters and the one that is dropped when the EDS card
 * is missing. The other three come along with any Adobe credential; asking for them keeps
 * the granted set identical to what the DA web client carries, so DA sees a familiar shape.
 */
export const DA_SCOPES = 'openid,AdobeID,read_organizations,aem.frontend.all';

/** Refresh this far before expiry, so a batch cannot outlive its own token. */
const SKEW_MS = 10 * 60 * 1000;

/** The S2S credential, from env first so CI and one-off shells need touch no disk. */
export function loadDaCredential(site = DEFAULT_SITE_KEY) {
  if (process.env.DA_CLIENT_ID && process.env.DA_CLIENT_SECRET) {
    return {
      clientId: process.env.DA_CLIENT_ID,
      clientSecret: process.env.DA_CLIENT_SECRET,
      source: 'env DA_CLIENT_ID/DA_CLIENT_SECRET',
    };
  }
  if (!existsSync(CRED_PATH)) return null;
  let doc;
  try {
    doc = JSON.parse(readFileSync(CRED_PATH, 'utf8'));
  } catch {
    throw new Error(`${CRED_PATH} is not valid JSON — move it aside first`);
  }
  const cfg = doc.sites?.[site] || null;
  if (!cfg?.clientId || !cfg?.clientSecret) return null;
  return { ...cfg, source: `${CRED_PATH} (sites.${site})` };
}

/** Claims are informational only; a token that will not parse is still a token. */
function claims(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString());
  } catch {
    return {};
  }
}
const tokenScope = (token) => claims(token).scope || '';

/** Exchange the client pair for an access token. Never logs the secret or the token. */
export async function mintDaToken(cred, scopes = DA_SCOPES) {
  const res = await fetch(IMS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: cred.clientId,
      client_secret: cred.clientSecret,
      scope: scopes,
    }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j.error_description || j.error || '';
    } catch { /* the body can echo the request; status is enough */ }
    throw new Error(`IMS token exchange failed (${res.status}) for client `
      + `${cred.clientId.slice(0, 6)}…${detail ? `: ${detail}` : ''}`);
  }
  const json = await res.json();
  if (!json.access_token) throw new Error('IMS returned no access_token');
  const granted = tokenScope(json.access_token);
  /*
   * A mint that drops the AEM scope is the "EDS card not attached" case, and it is worse
   * than an outright failure: the token is valid, so every call 401s and nothing points at
   * the credential. Fail here instead.
   */
  if (!/aem\./.test(granted)) {
    throw new Error('IMS granted no AEM scope — attach the Edge Delivery Services card to '
      + `the Developer Console project. Granted: ${granted || '(none)'}`);
  }
  return {
    token: json.access_token,
    expiresAt: Date.now() + (Number(json.expires_in || 3600) * 1000),
    granted,
  };
}

/** The cached token, or null when absent, unparseable or too close to expiry. */
export function cachedDaToken() {
  if (!existsSync(DA_TOKEN_CACHE)) return null;
  try {
    const c = JSON.parse(readFileSync(DA_TOKEN_CACHE, 'utf8'));
    if (!c.token || !c.expiresAt) return null;
    if (c.expiresAt - SKEW_MS < Date.now()) return null;
    return c;
  } catch {
    return null;
  }
}

function writeCache(entry) {
  mkdirSync(dirname(DA_TOKEN_CACHE), { recursive: true, mode: 0o700 });
  writeFileSync(DA_TOKEN_CACHE, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
  chmodSync(DA_TOKEN_CACHE, 0o600);
}

/**
 * A usable token, minting only when the cache cannot serve one.
 *
 * Returns `{ token, expiresAt, minted, identity }`. `identity` is what DA authorises on,
 * so it is worth printing: a 403 almost always means this string is missing from DA's
 * permission sheet.
 */
export async function ensureDaToken({ force = false, site = DEFAULT_SITE_KEY } = {}) {
  if (!force) {
    const hit = cachedDaToken();
    if (hit) {
      return {
        ...hit, minted: false, identity: claims(hit.token).user_id || '(unknown)',
      };
    }
  }
  const cred = loadDaCredential(site);
  if (!cred) {
    throw new Error('no S2S credential — set DA_CLIENT_ID/DA_CLIENT_SECRET, or write '
      + `${CRED_PATH} (mode 0600) as {"sites":{"${site}":{"clientId":"…","clientSecret":"…"}}}`);
  }
  const minted = await mintDaToken(cred);
  writeCache({ token: minted.token, expiresAt: minted.expiresAt, granted: minted.granted });
  return {
    ...minted, minted: true, identity: claims(minted.token).user_id || '(unknown)',
  };
}
