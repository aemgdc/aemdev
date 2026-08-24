/*
 * page-tracker.js — the Page Tracker DA app: boot, state, routing, filters.
 * https://da.live/app/aemgdc/aemdev/tools/page-tracker
 *
 * The one WRITING surface on this tracker. The `/tracker/**` boards answer "how far
 * along is the rollout?" for everybody; this answers "what is true about THIS page,
 * in all ten languages, and what may I record about it?" for the two or three people
 * who record anything.
 *
 * Three things make it a different app rather than a board with buttons:
 *
 *  1. **It reads DA source, not the published feeds.** The published copy lags a
 *     write until the doc is previewed, so an app that both reads and writes would
 *     show its own edits as stale.
 *  2. **The unit is a PAGE across ten locales**, which is the view no board can give:
 *     a board picks a locale. See drawer.js.
 *  3. **It writes exactly three columns** and refuses the rest by allow-list. See the
 *     block comment in da-source.js — the three it must never write each have a
 *     different reason, and one of them ("the next scan reverts it") makes a hand edit
 *     look like it landed and then quietly undoes it.
 *
 * ─── Design for ZERO first ──────────────────────────────────────────────────
 *
 * Nothing is translated. Every locale tree is empty, no group sheet has been
 * scaffolded, and `/tracker/data/**` all 404. So the empty and error states are the
 * PRIMARY states of this app, not its edge cases — a panel that renders a blank area
 * when its source 404s is broken. Every one of them says what it wanted, where it
 * looked, and what to run.
 */

import DA_SDK from 'https://da.live/nx/utils/sdk.js';
import {
  DEFAULT_BRANCH, FEEDS, TRACKER_GROUPS, daSheetUrl, pageTrackerUrl,
} from '../../scripts/tracker/paths.js';
import { TARGET_LOCALES, locale as localeFor } from '../../scripts/tracker/locales.js';
import { PAGE_STAGES, QUEUES } from '../../scripts/tracker/stages.js';
import { dom, fmtInt } from '../../scripts/tracker/block-utils.js';
import {
  initDaSource, listGroups, readGroupSheet, readTxReport,
  setEnStatus, setReviewStatus, toggleContentEscalation,
} from './da-source.js';
import {
  BLOCKED, activeFilters, applyFilters, buildRows, localeStates,
  queueOptions, stageOptions, subGroupOptions,
} from './rows.js';
import { renderTable } from './table.js';
import { renderDrawer } from './drawer.js';

/* --------------------------------------------------------------------- config */

/*
 * Every site-specific path this app touches, in one place — and every one of them is
 * IMPORTED, not spelled out. `paths.js` already owns the tracker's URL vocabulary and
 * has already moved this tree once; a second copy of a feed path here is an app that
 * 404s in silence while the boards work.
 *
 * The only genuinely app-level names are the query parameters, and they are the ones
 * `pageTrackerUrl()` writes — so a deep link a board builds and the link this app
 * parses cannot drift apart. `pageTrackerUrl` is the definition; this is the reader.
 */
const CONFIG = {
  appUrl: pageTrackerUrl(),
  groupsFolder: TRACKER_GROUPS,
  sheetPathFor: FEEDS.group,
  params: {
    group: 'group',
    locale: 'locale',
    subGroup: 'sub-group',
    filter: 'filter',
    branch: 'branch',
    readonly: 'readonly',
  },
};

/** The `en` pseudo-mode: the `data` tab, with no locale picked. */
const EN_MODE = 'en';

const state = {
  actor: 'unknown',
  readonly: false,
  branch: DEFAULT_BRANCH,
  groups: [],
  groupsError: null,
  group: null,
  mode: EN_MODE,
  sheet: null,
  pages: [],
  filters: {
    stage: '', queue: '', subGroup: '', text: '',
  },
  table: null,
  openPath: null,
  rerenderDrawer: null,
  reports: new Map(),
};

/* -------------------------------------------------------------------- helpers */

const root = () => document.querySelector('#pt-root');
const { el } = dom(document.body);
const bodyEl = () => document.querySelector('.pt-body');
const localeCode = () => (state.mode === EN_MODE ? null : state.mode);

/**
 * Who is recording this. The IMS token is a JWT whose payload carries the user's
 * email; decoded only to attribute a write. Falls back to a placeholder rather than
 * failing a save — attribution is worth having and is not worth blocking a verdict for.
 */
function actorFrom(token, context) {
  try {
    const claims = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(claims));
    return payload.email || payload.user_id || payload.sub || 'unknown';
  } catch (e) {
    return context?.user?.email || 'unknown';
  }
}

/** Rebuild every view row from the sheet currently in state. */
function rebuild() {
  state.pages = state.sheet?.exists
    ? buildRows({
      rows: state.sheet.rows,
      localeIndex: state.sheet.localeIndex,
      code: localeCode(),
      branch: state.branch,
    })
    : [];
}

const visiblePages = () => applyFilters(state.pages, state.filters);
const pageFor = (path) => state.pages.find((p) => p.path === path) || null;

/* ---------------------------------------------------------------- paint: counts */

/**
 * The counts line, and the two honest notes that belong beside it.
 *
 * `expected but never sent` is its own figure and not folded into anything: at zero
 * that number IS the whole rollout status, and a board that showed only "0 online"
 * would be reporting the same thing as a board whose feed failed to load.
 */
function paintCounts() {
  const line = document.querySelector('.pt-counts');
  const note = document.querySelector('.pt-note-line');
  if (!line) return;

  const shown = visiblePages().length;
  const total = state.pages.length;
  const parts = [`${fmtInt(shown)} of ${fmtInt(total)} page${total === 1 ? '' : 's'}`];

  if (localeCode()) {
    const unsent = state.pages.filter((p) => p.missingLocaleRow).length;
    parts.push(`${fmtInt(unsent)} never sent to ${localeFor(state.mode)?.name || state.mode}`);
  }
  const flagged = state.pages.filter((p) => p.contentEscalation).length;
  if (flagged) parts.push(`${fmtInt(flagged)} with a content escalation`);
  const warned = state.pages.filter((p) => p.warnings.length).length;
  if (warned) parts.push(`${fmtInt(warned)} with a model warning`);
  line.textContent = parts.join(' · ');

  if (!note) return;
  note.textContent = '';
  const unknown = state.sheet?.unknownTabs || [];
  if (unknown.length) {
    note.textContent = `This sheet has tab(s) no locale is registered for: ${unknown.join(', ')}. `
      + 'A misspelled locale tab reads as ten blank rows — that whole locale looks '
      + 'untranslated. Fix the tab name in the sheet.';
  }
}

/* --------------------------------------------------------------- paint: filters */

function filterButton(kind, id, label, count, hint) {
  const b = el('button', 'pt-filter', label);
  b.type = 'button';
  b.dataset.kind = kind;
  b.dataset.id = id;
  b.title = hint || '';
  b.append(el('span', 'pt-filter-count', fmtInt(count)));
  b.setAttribute('aria-pressed', String(state.filters[kind] === id));
  if (!count) b.classList.add('pt-filter-empty');
  b.addEventListener('click', () => {
    // A second click on the active filter clears it, so a chip is never a trap.
    state.filters[kind] = state.filters[kind] === id ? '' : id;
    /*
     * `paintList` renders the table, whose handlers open the drawer, whose write
     * handlers repaint the filter bar this button belongs to. The panels genuinely
     * refresh each other, so the cycle is real and the reference is forward onto a
     * hoisted declaration. Disabled here by name rather than for the whole file.
     */
    // eslint-disable-next-line no-use-before-define
    paintList();
  });
  return b;
}

function paintFilters() {
  const stages = document.querySelector('.pt-filters-stage');
  const queues = document.querySelector('.pt-filters-queue');
  if (!stages || !queues) return;

  stages.textContent = '';
  stages.append(el('span', 'pt-filter-legend', 'Stage'));
  for (const s of stageOptions(state.pages)) {
    stages.append(filterButton('stage', s.id, s.label, s.count, s.hint));
  }

  queues.textContent = '';
  queues.append(el('span', 'pt-filter-legend', 'Queue'));
  for (const q of queueOptions(state.pages)) {
    queues.append(filterButton(
      'queue',
      q.id,
      q.label,
      q.count,
      `${q.hint} Cleared by: ${q.owner}.`,
    ));
  }
}

function paintSubGroups() {
  const wrap = document.querySelector('.pt-subgroup');
  if (!wrap) return;
  const options = subGroupOptions(state.pages);
  wrap.hidden = options.length === 0;
  if (!options.length) return;
  const select = wrap.querySelector('select');
  select.textContent = '';
  const all = el('option', null, `All subgroups (${fmtInt(state.pages.length)})`);
  all.value = '';
  select.append(all);
  for (const o of options) {
    const opt = el('option', null, `${o.label} (${o.count})`);
    opt.value = o.id;
    if (o.id === state.filters.subGroup) opt.selected = true;
    select.append(opt);
  }
}

/* --------------------------------------------------------------- write handlers */

/**
 * Absorb a write's result.
 *
 * A successful write hands back the sheet it read BACK, after confirming the value
 * landed — so the app re-derives everything from that rather than patching the row it
 * thinks it changed. Cheap here (one small sheet) and it is the only version of this
 * that cannot drift: a write that moved a page's stage repaints the stage, the counts
 * and the filter tallies from the same read that proved the write worked.
 */
function absorb(result) {
  if (!result.ok) return result;
  if (result.sheet) {
    state.sheet = result.sheet;
    rebuild();
    paintFilters();
    paintSubGroups();
  }
  const page = state.openPath ? pageFor(state.openPath) : null;
  if (page) state.table?.updateRow(page);
  paintCounts();
  /*
   * DEFERRED, and it has to be. The control that triggered this write lives INSIDE the
   * drawer, and its own handler writes "✓ saved" beside itself the moment this returns.
   * Re-rendering synchronously replaces that node first, so the confirmation lands on a
   * detached element and a write that SUCCEEDED appears to have done nothing — which is
   * the one reading of a successful write that must never happen. Let the message
   * paint, then refresh the panel from the sheet the write read back.
   */
  setTimeout(() => state.rerenderDrawer?.(), 700);
  return result;
}

const guard = () => (state.readonly ? { ok: false, reason: 'read-only mode' } : null);

async function writeEnStatus(path, value) {
  return guard() || absorb(await setEnStatus(state.group, path, value));
}

async function writeReviewStatus(path, code, value) {
  return guard() || absorb(await setReviewStatus(state.group, path, code, value));
}

async function writeEscalation(path, on) {
  return guard() || absorb(await toggleContentEscalation(state.group, path, on));
}

/* ---------------------------------------------------------------------- drawer */

function closeDrawer() {
  state.openPath = null;
  state.rerenderDrawer = null;
  document.querySelector('.pt-drawer')?.remove();
  document.querySelector('.pt-layout')?.classList.remove('pt-layout-open');
  state.table?.setSelected(null);
}

function openDrawer(page) {
  const layout = document.querySelector('.pt-layout');
  if (!layout) return;
  state.openPath = page.path;
  state.table?.setSelected(page.path);
  layout.classList.add('pt-layout-open');

  const render = () => {
    document.querySelector('.pt-drawer')?.remove();
    const current = pageFor(state.openPath) || page;
    const code = current.locale;
    // NUL separator, matching `indexLocaleRows()` in stages.js: a path may contain
    // anything a slug allows, and a delimiter that can appear inside a key is a
    // silent collision.
    const key = code ? `${code}\0${current.path}` : null;
    const drawer = renderDrawer(current, {
      mount: layout,
      readonly: state.readonly,
      locales: localeStates(current.row, state.sheet.localeIndex, state.branch),
      report: key ? state.reports.get(key) : null,
      onClose: closeDrawer,
      onEnStatus: (value) => writeEnStatus(current.path, value),
      onReviewStatus: (c, value) => writeReviewStatus(current.path, c, value),
      onEscalation: (on) => writeEscalation(current.path, on),
    });
    layout.append(drawer);
  };

  state.rerenderDrawer = render;
  render();

  /*
   * The tier report is fetched lazily, per (locale, page), and cached for the session.
   * A 404 is cached too: today every one of them 404s, and re-requesting on every
   * drawer open would be a stampede for an answer that is not going to change until
   * somebody runs the pipeline.
   */
  const code = page.locale;
  if (!code) return;
  const key = `${code}\0${page.path}`;
  if (state.reports.has(key)) return;
  readTxReport(code, page.path).then((report) => {
    state.reports.set(key, report);
    if (state.openPath === page.path) render();
  });
}

/* ---------------------------------------------------------- the primary states */

/**
 * No sheet for this group.
 *
 * The state this app is in today, for all four groups. It names the exact document it
 * asked for, the endpoint it asked, and the two commands that create and populate it —
 * because "no data" with no address in it sends the reader to the wrong place, and the
 * wrong place here is usually "the app is broken".
 */
function noSheetState() {
  const box = el('div', 'pt-empty');
  const path = CONFIG.sheetPathFor(state.group);
  box.append(el('p', 'pt-empty-head', state.sheet?.error
    ? `Could not read the ${state.group} sheet.`
    : `No sheet for the ${state.group} group yet.`));
  const what = el('p', 'pt-note');
  what.append(el('span', null, 'Wanted '));
  const link = el('a', 'pt-mini', path);
  link.href = daSheetUrl(path);
  link.target = '_blank';
  link.rel = 'noopener';
  what.append(link);
  what.append(el('span', null, ` · asked ${state.sheet?.where || 'admin.da.live/source'}`));
  box.append(what);
  if (state.sheet?.error) box.append(el('p', 'pt-error-line', state.sheet.error));
  box.append(el('p', 'pt-hint', 'Create it and fill it from the live index:'));
  const pre = el('pre', 'pt-cmd');
  pre.textContent = `npm run group:scaffold -- --group=${state.group} --apply\n`
    + `npm run group:sync -- --group=${state.group} --apply\n`
    + 'npm run tx:scan -- --apply        # observes both hosts, writes the crawl columns';
  box.append(pre);
  box.append(el('p', 'pt-hint', 'Every writing tool defaults to --dry-run and prints a plan '
    + 'rather than a count. Read the plan before adding --apply.'));
  return box;
}

/** No group sheets at all — nothing to pick, so say where we looked. */
function noGroupsState() {
  const box = el('div', 'pt-empty');
  box.append(el('p', 'pt-empty-head', 'No group sheets in DA yet.'));
  const what = el('p', 'pt-note');
  what.append(el('span', null, `Listed ${CONFIG.groupsFolder} — nothing there.`));
  box.append(what);
  if (state.groupsError) box.append(el('p', 'pt-error-line', state.groupsError));
  box.append(el('p', 'pt-hint', 'The four groups are created by the pipeline, not by this app:'));
  const pre = el('pre', 'pt-cmd');
  pre.textContent = 'npm run group:scaffold -- --all --apply\nnpm run group:sync -- --apply';
  box.append(pre);
  return box;
}

/* ------------------------------------------------------------------ paint: list */

function paintList() {
  const body = bodyEl();
  if (!body) return;
  const wasOpen = state.openPath;
  body.textContent = '';

  if (!state.sheet?.exists) {
    body.append(noSheetState());
    paintCounts();
    paintFilters();
    return;
  }

  const layout = el('div', 'pt-layout');
  const list = el('div', 'pt-list');
  layout.append(list);
  body.append(layout);

  state.table = renderTable(list, visiblePages(), {
    readonly: state.readonly,
    onOpen: openDrawer,
    active: activeFilters(state.filters),
    onClear: (key) => {
      if (key) state.filters[key] = '';
      else {
        state.filters = {
          stage: '', queue: '', subGroup: '', text: '',
        };
      }
      const search = document.querySelector('.pt-search');
      if (search && (!key || key === 'text')) search.value = state.filters.text;
      paintSubGroups();
      paintList();
    },
  });

  paintCounts();
  paintFilters();
  const reopen = wasOpen ? pageFor(wasOpen) : null;
  if (reopen) openDrawer(reopen);
}

/* ----------------------------------------------------------------------- shell */

function localeNav(onChange) {
  const nav = el('nav', 'pt-locales');
  nav.setAttribute('aria-label', 'Locale');
  const add = (code, label, hint) => {
    const b = el('button', 'pt-locale');
    b.type = 'button';
    b.dataset.locale = code;
    b.title = hint;
    b.append(el('span', 'pt-locale-native', label));
    b.append(el('span', 'pt-locale-code', code));
    b.setAttribute('aria-pressed', String(state.mode === code));
    b.addEventListener('click', () => onChange({ mode: code }));
    nav.append(b);
  };
  /*
   * English first and separate: it is not one of the ten, it is the `data` tab — the
   * SOURCE and the send gate. Grouping it with the targets would suggest a page can be
   * "translated into English", which is exactly the mis-send `isTargetLocale()` folds
   * case to prevent.
   */
  add(EN_MODE, 'English', 'The data tab — the English source and the send gate. Not a '
    + 'translation target.');
  for (const code of TARGET_LOCALES) {
    const loc = localeFor(code);
    // The NATIVE name, because the person reading this row of buttons for their own
    // locale is a native speaker of it.
    add(code, loc.native, `${loc.name} — the ${code} tab`);
  }
  return nav;
}

function buildShell(onChange) {
  const mount = root();
  mount.textContent = '';

  const header = el('header', 'pt-header');
  const titles = el('div', 'pt-titles');
  titles.append(el('h1', null, 'Page Tracker'));
  titles.append(el('p', 'pt-sub', 'One page, ten languages. The stage in every row is '
    + 'derived from the stored columns and the two crawl observations — nothing here '
    + 'reads a stored stage.'));
  header.append(titles);

  const controls = el('div', 'pt-controls');

  const groupField = el('label', 'pt-field');
  groupField.append(el('span', null, 'Group'));
  const groupSelect = el('select', 'pt-select pt-group');
  for (const g of state.groups) {
    const opt = el('option', null, g);
    opt.value = g;
    if (g === state.group) opt.selected = true;
    groupSelect.append(opt);
  }
  groupSelect.addEventListener('change', () => onChange({ group: groupSelect.value }));
  groupField.append(groupSelect);
  controls.append(groupField);

  const subWrap = el('div', 'pt-field pt-subgroup');
  subWrap.append(el('span', null, 'Subgroup'));
  const subSelect = el('select', 'pt-select');
  subSelect.addEventListener('change', () => onChange({ subGroup: subSelect.value }));
  subWrap.append(subSelect);
  subWrap.hidden = true;
  controls.append(subWrap);

  const branchField = el('label', 'pt-field');
  branchField.append(el('span', null, 'Link ref'));
  const branchInput = el('input', 'pt-input pt-branch');
  branchInput.type = 'text';
  branchInput.size = 10;
  branchInput.value = state.branch;
  /*
   * The ref changes the LINKS and never the data. Every read and write here goes to
   * the same live DA source whatever this says, which is what makes `?readonly=1` on a
   * branch build a safe thing to hand somebody: they see the same numbers you do.
   */
  branchInput.title = 'The ref the page links point at. It changes the links only — every '
    + 'read and write goes to the same live sheets.';
  branchInput.addEventListener('change', () => onChange({ branch: branchInput.value.trim() }));
  branchField.append(branchInput);
  controls.append(branchField);

  const findField = el('label', 'pt-field');
  findField.append(el('span', null, 'Find'));
  const search = el('input', 'pt-input pt-search');
  search.type = 'search';
  search.placeholder = 'path, title or subgroup';
  search.value = state.filters.text;
  search.addEventListener('input', () => onChange({ text: search.value }));
  findField.append(search);
  controls.append(findField);

  header.append(controls);
  header.append(localeNav(onChange));
  header.append(el('nav', 'pt-filters pt-filters-stage'));
  header.append(el('nav', 'pt-filters pt-filters-queue'));
  header.append(el('p', 'pt-counts'));
  header.append(el('p', 'pt-note-line'));

  if (state.readonly) {
    header.append(el('p', 'pt-readonly', 'Read-only — ?readonly=1 is set. Every write '
      + 'control is disabled; everything else works normally.'));
  }

  mount.append(header);
  mount.append(el('div', 'pt-body'));
}

function paintLocaleNav() {
  for (const b of document.querySelectorAll('.pt-locale')) {
    b.setAttribute('aria-pressed', String(b.dataset.locale === state.mode));
  }
}

/* ------------------------------------------------------------------- load a group */

async function loadGroup(group) {
  state.group = group;
  closeDrawer();
  const body = bodyEl();
  if (body) {
    body.textContent = '';
    body.append(el('p', 'pt-boot', `Reading ${CONFIG.sheetPathFor(group)}…`));
  }
  state.sheet = await readGroupSheet(group);
  rebuild();
  paintSubGroups();
  paintLocaleNav();
  paintList();
}

/* ---------------------------------------------------------------------- routing */

/**
 * Read the deep-link parameters, using the names `pageTrackerUrl()` writes.
 *
 * Every value is VALIDATED against the model rather than assigned blind. An unknown
 * locale or an unrecognised stage assigned straight into state would leave the board
 * matching nothing, and an empty board reads as "this group is done" rather than "that
 * link was wrong" — which is the same failure the tolerant `filter` handling below
 * avoids by degrading to a text search instead of to silence.
 */
function readParams() {
  const p = new URLSearchParams(window.location.search);
  const { params } = CONFIG;

  state.readonly = p.has(params.readonly) && p.get(params.readonly) !== '0';

  const code = (p.get(params.locale) || '').trim().toLowerCase();
  if (code === EN_MODE) state.mode = EN_MODE;
  else if (TARGET_LOCALES.includes(code)) state.mode = code;

  const branch = (p.get(params.branch) || '').trim();
  if (branch) state.branch = branch;

  const sub = (p.get(params.subGroup) || '').trim();
  // Not validated: the valid set is a property of the sheet, which has not been read
  // yet. `applyFilters` matching nothing is caught by the empty state, which names it.
  if (sub) state.filters.subGroup = sub;

  /*
   * One `filter` parameter, three possible meanings, resolved in this order: a stage
   * id, a queue id, then free text. `pageTrackerUrl()` offers exactly one such
   * parameter and the boards that link here have all three kinds of thing to point at
   * — a stage column, a queue row, a search. Falling back to free text rather than
   * refusing is deliberate: a substring match on a value nobody recognises still lands
   * somewhere explicable, and the empty state names it if it lands nowhere.
   */
  const wanted = (p.get(params.filter) || '').trim();
  if (wanted) {
    if (wanted === BLOCKED || PAGE_STAGES.some((s) => s.id === wanted)) {
      state.filters.stage = wanted;
    } else if (QUEUES.some((q) => q.id === wanted)) {
      state.filters.queue = wanted;
    } else {
      state.filters.text = wanted;
    }
  }

  return (p.get(params.group) || '').trim();
}

/* ------------------------------------------------------------------------- boot */

/**
 * Wait for the SDK handshake, but not for ever.
 *
 * `DA_SDK` is a promise that resolves when the parent frame posts the init message
 * carrying the token and the MessagePort. DA posts it within roughly 750ms of the frame
 * opening — and if the app is not running inside DA, or the listener was registered
 * after that message, the promise NEVER resolves and never rejects. Unbounded, that is
 * a permanent "Connecting to Document Authoring…" with nothing in the console: the one
 * failure mode where the app looks like it is still working.
 *
 * Ten seconds is far beyond the handshake and far short of a reader's patience.
 */
const HANDSHAKE_MS = 10000;

function sdkWithTimeout() {
  return Promise.race([
    DA_SDK,
    new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error(`no SDK handshake after ${HANDSHAKE_MS / 1000}s`)),
        HANDSHAKE_MS,
      );
    }),
  ]);
}

(async function init() {
  const mount = root();
  try {
    const { context, token, actions } = await sdkWithTimeout();
    initDaSource(actions, token);
    state.actor = actorFrom(token, context);

    const wantedGroup = readParams();

    const found = await listGroups();
    state.groups = found.groups;
    state.groupsError = found.error;

    const onChange = (change) => {
      if ('group' in change) {
        // The subgroup slug means nothing in the group being switched to, and a stale
        // one would filter the new group to nothing and look like an empty group.
        state.filters.subGroup = '';
        loadGroup(change.group);
        return;
      }
      if ('mode' in change) {
        state.mode = change.mode;
        // The stage and queue vocabularies are shared, so those filters survive a
        // locale switch on purpose: "show me what is blocked in Japanese too" is the
        // question somebody is actually asking when they click the next locale.
        closeDrawer();
        rebuild();
        paintLocaleNav();
        paintSubGroups();
        paintList();
        return;
      }
      if ('branch' in change) {
        state.branch = change.branch || DEFAULT_BRANCH;
        rebuild();
        paintList();
        return;
      }
      if ('subGroup' in change) state.filters.subGroup = change.subGroup;
      if ('text' in change) state.filters.text = change.text;
      paintList();
    };

    buildShell(onChange);
    mount.setAttribute('aria-busy', 'false');

    if (!state.groups.length) {
      bodyEl().textContent = '';
      bodyEl().append(noGroupsState());
      return;
    }

    const group = state.groups.includes(wantedGroup) ? wantedGroup : state.groups[0];
    await loadGroup(group);
  } catch (e) {
    mount.removeAttribute('aria-busy');
    mount.textContent = '';
    mount.append(el('p', 'pt-error-line', `Could not start: ${e.message}`));
    mount.append(el('p', 'pt-hint', 'This app is a DA fullscreen app and must run inside '
      + 'da.live — opening its HTML directly gets no SDK handshake and no token. Open it '
      + `at ${CONFIG.appUrl}`));
    mount.append(el('p', 'pt-hint', 'Add ?readonly=1 to hand somebody a build that cannot '
      + 'write anything.'));
  }
}());
