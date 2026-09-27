// Load modules from a local checkout of adobe/da-nx (DA's own loc app code: the
// custom-doc-rules engine and removeDnt). It is deliberately NOT vendored into this repo.
//   DA_NX=/path/to/da-nx   the checkout root (a relative value resolves against the cwd)
//   default               ../../../da-nx relative to this folder, i.e. a sibling of the repo
// Get it with: git clone --depth 1 https://github.com/adobe/da-nx
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const DA_NX = resolve(process.env.DA_NX || resolve(here, '../../../da-nx'));

/** Import `rel` (e.g. 'nx/blocks/loc/dnt/parseQuery.js') from the da-nx checkout. */
export async function importDaNx(rel) {
  const file = resolve(DA_NX, rel);
  if (!existsSync(file)) {
    throw new Error(`da-nx module not found: ${file} (set DA_NX to a clone of https://github.com/adobe/da-nx)`);
  }
  return import(pathToFileURL(file).href);
}
