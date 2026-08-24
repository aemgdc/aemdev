/**
 * config.mjs — orchestrator configuration with layered resolution:
 *   built-in defaults
 *     ← .tracker/orchestrator.json      (project-wide, one per repo)
 *     ← .tracker/hosts/<hostname>.json  (per-machine profile)
 *     ← environment variables           (per-run)
 *
 * The host layer exists because more than one machine can run this pipeline and they
 * are NOT interchangeable. The machine whose judge is GPU-resident is the designated
 * writer of shared state; a workstation running the same models on CPU is several times
 * slower per page and is a read-only validator, so a one-off check there can never
 * clobber a batch running on the writer. Both profiles are committed side by side, so
 * either machine gets its own settings from a plain `git pull` with nothing to
 * configure locally.
 *
 * Which profile loads is decided by `os.hostname()`, overridable with AEMDEV_QA_HOST
 * (handy for testing another machine's profile, or when a host is renamed).
 *
 * IMPORTANT — what a host profile may and may not change: it may tune *transport*
 * (endpoints, models, timeouts, token caps) and *role* (`host.role`). It must NOT
 * tune anything that changes the evidence the judge sees — notably `qa.maxTextWords`
 * and `qa.wordRatio`. Those decide verdicts, and a verdict that depends on which
 * laptop ran it is worthless. Keep them in orchestrator.json for every host.
 *
 * Env overrides (highest precedence, useful while the appliance moves around):
 *   AEMDEV_QA_HOST             force a host profile name, e.g. fw13-ubuntu
 *   AEMDEV_QA_JUDGE_ENDPOINT   e.g. http://127.0.0.1:8080
 *   AEMDEV_QA_JUDGE_MODEL      e.g. qwen2.5-14b-instruct
 *   AEMDEV_QA_TRIAGE_ENDPOINT / AEMDEV_QA_TRIAGE_MODEL
 *   AEMDEV_QA_VISION_ENDPOINT / AEMDEV_QA_VISION_MODEL
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import { TARGET_LOCALES } from '../../scripts/tracker/locales.js';
import {
  ORG, SITE, DEFAULT_BRANCH, TRACKER_QA, TRACKER_TX,
} from '../../scripts/tracker/paths.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Config lives here, parallel to the pipeline's state and reports. */
const CONFIG_DIR = '.tracker';

const DEFAULTS = {
  llm: {
    // 14B judge: content-fidelity verdicts on structural QA evidence.
    judge: {
      api: 'openai', // 'openai' (llama.cpp server) or 'ollama'
      endpoint: 'http://127.0.0.1:8080',
      model: 'qwen2.5-14b-instruct',
      maxTokens: 900,
      /*
       * Generous on purpose. A 240s ceiling sat AT the measured p90 of judge
       * duration on the source pipeline and therefore timed out a fixed fraction
       * of pages by construction, each after several wasted attempts. The bound
       * exists only so a wedged server cannot hang a batch forever.
       */
      timeoutMs: 900000,
    },
    // small fast model: high-volume triage/classification.
    triage: {
      api: 'openai',
      endpoint: 'http://127.0.0.1:8081',
      model: 'qwen3-4b-instruct',
      maxTokens: 400,
      timeoutMs: 120000,
    },
    // VL model: screenshot-pair drift verdicts (visual-judge.mjs).
    vision: {
      api: 'openai',
      endpoint: 'http://127.0.0.1:8082',
      model: 'qwen2.5-vl-7b-instruct',
      // 1024 truncated verdicts mid-item on the source pipeline.
      maxTokens: 2048,
      // A 1280x900 crop pair measures minutes on CPU, so a tight bound here would
      // newly fail slow-but-healthy runs. 15 min is a wedged-server backstop.
      timeoutMs: 900000,
    },
  },
  /*
   * Which machine this is, and what it is allowed to do. Overridden per machine in
   * .tracker/hosts/<hostname>.json.
   *   role: 'writer'    — may write the shared ledger, DA sheets, tracker docs, rollup
   *         'validator' — one-off checks only; the drivers default to --validate-only
   */
  host: {
    label: null,
    role: 'writer',
    notes: null,
  },
  qa: {
    // words of visible text (each side) embedded in the report for the judge
    maxTextWords: 2500,
    // cap on image reachability probes per page
    imageCheckLimit: 40,
    /*
     * Visible-word ratio of the page under review against its reference page:
     * outside [warnMin,warnMax] → warning, below failMin → error (content dropped).
     *
     * On the EN side the reference is the previously blessed revision; on the
     * translation side it is the English source, and a locale's normal text
     * expansion is NOT accounted for here — `expansion` in scripts/tracker/locales.js
     * is per locale and belongs to the caller that compares across locales.
     *
     * These numbers are inherited from the source pipeline and have NOT been
     * recalibrated on aemdev pages. Per-group overrides live in
     * .tracker/qa-baselines/<group>.json, which is where a calibration belongs —
     * a group's tolerance is a property of its template, not of the machine.
     */
    wordRatio: { failMin: 0.6, warnMin: 0.85, warnMax: 1.25 },
    fetchTimeoutMs: 30000,
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) aemdev-tracker-qa',
  },
  /*
   * Where pages are previewed, and the ONE branch every surface agrees on: `main`.
   *
   * This value decides the aem.page host the drivers judge against AND the "Preview"
   * link written into every QA-notes doc, so a feature branch here sends reviewers to
   * a host that only exists until someone deletes the branch. Code lands on main via a
   * PR before the content that needs it is handed over, so main is the correct default;
   * a branch is an explicit `--branch=`.
   *
   * `site`, not `repo`: there is one DA site (`aemgdc/aemdev`) and it holds both the
   * content and the tracker. Defaulted from scripts/tracker/paths.js so the pipeline
   * and the browser cannot disagree about which site this is.
   */
  publish: {
    org: ORG,
    site: SITE,
    branch: DEFAULT_BRANCH,
  },
  /*
   * The locale list, imported rather than restated.
   *
   * `deepMerge` replaces an array wholesale, so an override in orchestrator.json or a
   * host profile silently desynchronises the pipeline from the registry the browser
   * reads — and the failure mode of a near-miss locale code is a silent no-op, not an
   * error. Add or remove a locale in scripts/tracker/locales.js, never here.
   */
  locales: [...TARGET_LOCALES],
  /*
   * The group registry — one entry per tracked page group, keyed BY GROUP NAME.
   *
   * Shape: { org, repo, path, sheet, branch, qaNotesPath, txNotesPath }
   *   path         DA path of the group's multi-sheet tracking doc (with `.json`)
   *   sheet        the master tab name ('data'); locale tabs are named by locale code
   *   branch       what gets previewed after a write
   *   qaNotesPath  base DA path for per-page EN QA docs
   *   txNotesPath  base DA path for per-(page, locale) review docs
   *
   * The registry itself lives in .tracker/orchestrator.json, not here, so adding a
   * group is a committed config change rather than a code change. Empty by default so
   * a tool run against a repo with no orchestrator.json fails loudly on a missing group
   * instead of writing to a made-up sheet path.
   *
   * The key MUST equal the sheet basename — see `assertGroupRegistry`.
   */
  groups: {},
  escalation: {
    /*
     * Attempt ceiling for a page that keeps failing. NOT YET WIRED: as of this file
     * the drivers do not exist, so nothing compares `attempts` against it. The source
     * pipeline had the same value and the same gap, and the consequence there was real
     * — a page could be re-judged forever. Whoever writes qa-driver.mjs / tx-driver.mjs
     * either reads this on the skip rule or deletes the key; do not leave it decorative.
     */
    maxAttempts: 3,
  },
  state: {
    ledger: join(REPO_ROOT, CONFIG_DIR, 'state', 'qa-ledger.json'),
    txLedger: join(REPO_ROOT, CONFIG_DIR, 'state', 'tx-ledger.json'),
    escalations: join(REPO_ROOT, CONFIG_DIR, 'state', 'qa-escalations.jsonl'),
    txEscalations: join(REPO_ROOT, CONFIG_DIR, 'state', 'tx-escalations.jsonl'),
    reportsDir: join(REPO_ROOT, CONFIG_DIR, 'reports', 'qa'),
    txReportsDir: join(REPO_ROOT, CONFIG_DIR, 'reports', 'tx'),
    /*
     * Where a --validate-only run drops its reports. Deliberately NOT the shared
     * reportsDir: a validation is one machine's opinion, not batch state, and it must
     * not show up as a committed report or race the writer's run. Gitignored.
     */
    localReportsDir: join(REPO_ROOT, CONFIG_DIR, 'reports', 'qa-local'),
  },
};

/*
 * Merge `over` onto `base`, one layer at a time.
 *
 * Two deliberate semantics, both of which a naive recursive merge gets wrong:
 *
 *   arrays REPLACE. Element-wise merging a locale list or a rule table produces a
 *   value nobody wrote — a nine-element override onto a ten-element default leaves the
 *   tenth element in place. An override of a list means "this list", entirely.
 *
 *   null FALLS BACK. `host.label: null` in DEFAULTS is "unset", and a layer that
 *   carries an explicit null (a hand-edited profile, a JSON round trip) means the same
 *   thing rather than "erase the default". `?? base` is what makes those identical.
 */
function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

/** The host profile name in effect: AEMDEV_QA_HOST, else this machine's hostname. */
export function hostProfileName() {
  return process.env.AEMDEV_QA_HOST || hostname();
}

/** Path of the host profile for `name`, whether or not it exists. */
export function hostProfilePath(name = hostProfileName()) {
  return join(REPO_ROOT, CONFIG_DIR, 'hosts', `${name}.json`);
}

/** Path of the committed project config. */
export const orchestratorPath = () => join(REPO_ROOT, CONFIG_DIR, 'orchestrator.json');

/**
 * Fail on a group registry that cannot address its own sheet.
 *
 * Two invariants, both of which produced real breakage in the source pipeline:
 *
 *   1. group name === sheet basename. The source allowed a registry key to differ from
 *      the sheet file it pointed at, and the escalation feed then carried `group`
 *      values no work-queue filter could match — leaving almost every group's
 *      escalations unfilterable in the UI. One name, everywhere.
 *   2. every entry addresses THIS site. `org`/`repo` are spelled out per entry for
 *      readability, but there is exactly one DA site now, and a typo there would send
 *      writes at a site that either does not exist or is not ours.
 */
/*
 * `$`-prefixed keys are inline documentation, not data.
 *
 * The convention is used throughout .tracker/orchestrator.json — a config with nowhere
 * to write down WHY a value is what it is grows a parallel doc that goes stale. Every
 * reader of a map in this config has to skip them, so the test lives in one place.
 */
const isDataKey = (k) => !k.startsWith('$');

function assertGroupRegistry(groups) {
  for (const [name, g] of Object.entries(groups || {}).filter(([k]) => isDataKey(k))) {
    const basename = String(g.path || '').split('/').pop().replace(/\.json$/, '');
    if (basename !== name) {
      throw new Error(`groups.${name}: sheet basename "${basename}" must equal the group name`);
    }
    if (g.org !== ORG || g.repo !== SITE) {
      throw new Error(`groups.${name}: org/repo must be ${ORG}/${SITE}, got ${g.org}/${g.repo}`);
    }
  }
}

export function loadConfig() {
  let cfg = DEFAULTS;
  const file = orchestratorPath();
  if (existsSync(file)) {
    cfg = deepMerge(cfg, JSON.parse(readFileSync(file, 'utf8')));
  }

  // Per-machine layer. A missing profile is not an error — an unregistered host simply
  // gets the project defaults (and, per DEFAULTS.host, the writer role, which is the
  // behaviour for every machine that has not declared itself a validator).
  const profileName = hostProfileName();
  const profile = hostProfilePath(profileName);
  if (existsSync(profile)) {
    cfg = deepMerge(cfg, JSON.parse(readFileSync(profile, 'utf8')));
    cfg.host = { ...cfg.host, profile: profileName, profilePath: profile };
  } else {
    cfg.host = { ...cfg.host, profile: null, profilePath: null };
  }

  const { env } = process;
  if (env.AEMDEV_QA_JUDGE_ENDPOINT) cfg.llm.judge.endpoint = env.AEMDEV_QA_JUDGE_ENDPOINT;
  if (env.AEMDEV_QA_JUDGE_MODEL) cfg.llm.judge.model = env.AEMDEV_QA_JUDGE_MODEL;
  if (env.AEMDEV_QA_TRIAGE_ENDPOINT) cfg.llm.triage.endpoint = env.AEMDEV_QA_TRIAGE_ENDPOINT;
  if (env.AEMDEV_QA_TRIAGE_MODEL) cfg.llm.triage.model = env.AEMDEV_QA_TRIAGE_MODEL;
  if (env.AEMDEV_QA_VISION_ENDPOINT) cfg.llm.vision.endpoint = env.AEMDEV_QA_VISION_ENDPOINT;
  if (env.AEMDEV_QA_VISION_MODEL) cfg.llm.vision.model = env.AEMDEV_QA_VISION_MODEL;

  // A profile may express state paths relative to the repo (nicer to read than an
  // absolute path that only exists on one machine); resolve them here so callers keep
  // getting absolute paths as before.
  for (const [k, v] of Object.entries(cfg.state)) {
    if (typeof v === 'string' && !isAbsolute(v)) cfg.state[k] = join(REPO_ROOT, v);
  }

  assertGroupRegistry(cfg.groups);
  return cfg;
}

/** Registered group names, in registry order. */
export const groupNames = (cfg) => Object.keys(cfg.groups || {}).filter(isDataKey);

/**
 * One group's registry entry, with the per-group defaults filled in.
 *
 * Throws rather than returning null: every caller of this needs a sheet path, and an
 * unregistered group name is a typo on the command line, not a state to handle.
 */
export function groupConfig(cfg, name) {
  const g = isDataKey(String(name)) ? cfg.groups?.[name] : null;
  if (!g) {
    const known = groupNames(cfg).join(', ') || '(none registered)';
    throw new Error(`unknown group "${name}" — registered: ${known}`);
  }
  return {
    name,
    org: g.org || ORG,
    repo: g.repo || SITE,
    path: g.path,
    sheet: g.sheet || 'data',
    branch: g.branch || cfg.publish?.branch || DEFAULT_BRANCH,
    qaNotesPath: g.qaNotesPath || TRACKER_QA,
    txNotesPath: g.txNotesPath || TRACKER_TX,
  };
}

export { REPO_ROOT, CONFIG_DIR };
