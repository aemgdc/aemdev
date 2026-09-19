#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * register-picker.mjs — add or update the Splitforms Form Picker's row in the
 * DA site config.
 *
 * The picker is opened from INSIDE the editor to drop a block into a document,
 * so it belongs in the config's `library` sheet alongside "AEM Tags" and the
 * Icon Picker — not `apps` (full-screen, from da.live/apps) or `prepare`.
 *
 *   `experience: 'dialog'` opens it as a modal rather than in the narrow side
 *   rail, which is what a two-pane layout needs. The picker still lays out in
 *   one column below 720px, so the rail degrades rather than breaks.
 *
 * ORDER MATTERS. `path` is fetched from the LIVE origin, so applying this before
 * the branch carrying tools/splitforms-picker/ is deployed registers a palette
 * entry that 404s for every author. The dry run reports that state rather than
 * guessing; --check reports it afterwards.
 *
 * CLI
 *   node tools/splitforms-picker/register-picker.mjs            dry run
 *   node tools/splitforms-picker/register-picker.mjs --apply    write, then verify
 *   node tools/splitforms-picker/register-picker.mjs --check    registered, and live?
 *   node tools/splitforms-picker/register-picker.mjs --remove   take the row out (with --apply)
 *
 * EXIT  0 as asked · 1 write or verify failed · 2 could not reach DA · 3 usage/no token
 */
import { argv, exit } from 'node:process';
import { registerRow, parseArgs } from '../lib/register-library-row.mjs';

const SHEET = 'library';

const ROW = {
  title: 'Form Picker',
  path: '/tools/splitforms-picker/splitforms-picker.html',
  format: '',
  icon: '',
  experience: 'dialog',
  ref: '',
};

const HELP = `register-picker — add or update the Form Picker row in the DA \`${SHEET}\` sheet.

  (no flags)   dry run: show the live sheet and the row that would change
  --apply      write, then read back and verify
  --check      report whether the row is registered AND its path resolves
  --remove     remove the row (with --apply)
  --help       this text`;

const opts = parseArgs(argv.slice(2), 'register-picker');
if (!opts) exit(3);
if (opts.help) {
  console.log(HELP);
  exit(0);
}

exit(await registerRow({ sheet: SHEET, row: ROW, opts }));
