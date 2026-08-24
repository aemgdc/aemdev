#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * da-token.mjs — put a usable DA/AEM token in place, minting one if needed.
 *
 * This is what replaces "a human logs into da.live and pastes a token that dies in 24
 * hours". Run it before anything that writes, and the rest of the pipeline stops
 * caring: `resolveToken()` in lib/status-sheet.mjs reads the cache this writes.
 *
 * The failure this exists to prevent was not expiry. It was that nothing NOTICED
 * expiry — a cron ran dozens of times a day against a dead token and printed success
 * underneath a column of `POST 401`, so the dashboards simply stopped getting newer
 * for a day at a time.
 *
 * CLI SURFACE
 *   node tools/tracker/da-token.mjs                 mint only if the cache cannot serve one
 *   node tools/tracker/da-token.mjs --force         mint regardless
 *   node tools/tracker/da-token.mjs --describe      what is configured, and for how long
 *   node tools/tracker/da-token.mjs --print         the token on stdout, for $(…)
 *   node tools/tracker/da-token.mjs --help
 *
 *   npm run da-token -- --describe
 *
 * `--print` writes ONLY the token to stdout so `export DA_TOKEN=$(npm run --silent
 * da-token -- --print)` captures it cleanly; every other word this tool says goes to
 * stderr. Nothing here ever prints the client secret, and `--describe` prints only
 * the client-id PREFIX — enough to tell two credentials apart, not enough to reuse
 * one.
 *
 * EXIT CODES (docs/tracker/data-contract.md section 5)
 *   0  a token is in place
 *   2  there IS a credential but the exchange could not be completed (IMS down,
 *      network, a scope the console has not granted) — no verdict, try again
 *   3  no credential is configured at all. Nothing ran and nothing will until one is.
 */
import { argv, exit } from 'node:process';
import {
  ensureDaToken, cachedDaToken, loadDaCredential, DA_TOKEN_CACHE,
} from './lib/da-ims.mjs';

const HELP = `da-token — put a usable DA/AEM token in place.

  --force      mint a new token even if the cached one is still good
  --describe   print the configured credential and cache expiry, then exit
  --print      write ONLY the token to stdout (everything else goes to stderr)
  --help       this text

exit 0 a token is in place · 2 exchange failed · 3 no credential configured`;

function parseArgs(args) {
  const o = {
    force: false, describe: false, print: false, help: false,
  };
  for (const a of args) {
    if (a === '--force') o.force = true;
    else if (a === '--describe') o.describe = true;
    else if (a === '--print') o.print = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  return o;
}

const mins = (ms) => Math.round(ms / 60000);

/**
 * Report the configuration without touching IMS.
 *
 * Deliberately read-only and deliberately quiet about specifics. It answers the two
 * questions that come up before every batch — "is a credential installed on this
 * machine" and "will the cached token outlive the run" — and nothing else.
 */
function describe() {
  const cred = loadDaCredential();
  const hit = cachedDaToken();
  console.log(cred
    ? `   credential: client ${cred.clientId.slice(0, 6)}… from ${cred.source}`
    : '   credential: NONE configured');
  console.log(hit
    ? `   cache:      valid for ${mins(hit.expiresAt - Date.now())} more minute(s) — ${DA_TOKEN_CACHE}`
    : `   cache:      empty or expiring — ${DA_TOKEN_CACHE}`);
  return cred ? 0 : 3;
}

async function main() {
  const opts = parseArgs(argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return 0;
  }
  if (opts.describe) return describe();

  /*
   * No credential is a CONFIGURATION error (3), not a failed verdict (2). The
   * difference matters to a batch runner: exit 3 means stop and go install something,
   * exit 2 means the same command may well work in five minutes.
   */
  if (!loadDaCredential()) {
    console.error('ERROR: no S2S credential configured — run with --describe for where it is looked for');
    return 3;
  }

  const t = await ensureDaToken({ force: opts.force });
  if (opts.print) {
    // stdout is the token and nothing else, so `$(…)` captures it cleanly.
    process.stdout.write(t.token);
    console.error(`   ${t.minted ? 'minted' : 'cached'}, ${mins(t.expiresAt - Date.now())} min left`);
    return 0;
  }
  console.log(`   ✓ ${t.minted ? 'minted a new token' : 'cached token still good'} — `
    + `${mins(t.expiresAt - Date.now())} minute(s) left`);
  /*
   * Printing the identity is not decoration. DA authorises on this exact string, and
   * the one failure that cost real time was the technical account EMAIL sitting in
   * DA's permission sheet while the token asserted the technical account ID. A 403
   * with this line visible is a five-second diagnosis instead of an afternoon.
   */
  console.log(`   identity: ${t.identity}`);
  if (t.granted) console.log(`   scopes:   ${t.granted}`);
  return 0;
}

main()
  .then((code) => exit(code))
  .catch((e) => {
    console.error(`ERROR: ${e.message}`);
    /*
     * A usage mistake is 3; anything that got as far as talking to IMS and failed is
     * 2, because the credential exists and the next attempt may succeed.
     */
    exit(/^unknown arg/.test(e.message) ? 3 : 2);
  });
