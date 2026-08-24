/**
 * writer-lock.mjs — a shared, expiring writer lease held in DA, so the single-writer
 * rule is ENFORCED rather than remembered.
 *
 * Node-only (`.mjs`; never importable from a browser entry).
 *
 * ─── Why this is not a comment in a README ─────────────────────────────────
 *
 * A group sheet write is always a WHOLE-DOC write — DA has no partial-write API — so
 * two runs writing one sheet lose one side's rows outright. `updateStatusDoc`'s
 * `If-Match` catches that as a 412 and retries once, which is right for a race inside
 * one run and useless for two runs on two machines: they simply take turns clobbering
 * each other, each retry succeeding.
 *
 * The pipeline this was ported from stated the rule in prose ("only one machine may run
 * it at a time") and checked nothing, so it relied on whoever started a run remembering
 * to stop the other machine. This makes it mechanical.
 *
 * The lease lives in DA, not in git: both machines can always see DA, whereas a
 * git-tracked lock is only as fresh as the last pull — the exact failure it would need
 * to prevent.
 *
 * Mutual exclusion uses the compare-and-swap DA already gives us: read with the ETag,
 * write back with `If-Match`; a 412 means somebody moved first. CREATION cannot use
 * `If-Match` (there is no version yet), so it falls back to
 * write-then-read-back-and-verify-our-own-id, which fails CLOSED — if we do not read
 * our own id back, we did not get the lock.
 *
 * Leases EXPIRE (default 60 min). A crashed run therefore cannot wedge the pipeline
 * forever, which is the failure mode a plain boolean flag has.
 */
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { daSourceUrl } from '../../../scripts/tracker/paths.js';
import { loadConfig, hostProfileName } from '../config.mjs';

/*
 * A dot-prefixed path, so it is DA application state rather than site content: it is
 * never previewed and never published, and `.hlxignore` keeps it out of the code bus.
 * A lock file served on a public host would be both noise and an information leak
 * (it carries a hostname and a pid).
 */
const LOCK_PATH = '/.locks/tracker-writer';
const DEFAULT_TTL_MIN = 60;

const lockUrl = () => daSourceUrl(LOCK_PATH, 'json');
const strongEtag = (etag) => (etag ? etag.replace(/^W\//, '') : null);

async function read(token) {
  const res = await fetch(lockUrl(), { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return { lease: null, version: null };
  if (!res.ok) throw new Error(`lock GET ${res.status}`);
  return { lease: await res.json(), version: strongEtag(res.headers.get('ETag')) };
}

async function write(token, lease, version) {
  const form = new FormData();
  form.append('data', new Blob([JSON.stringify(lease, null, 2)], { type: 'application/json' }), 'tracker-writer.json');
  const res = await fetch(lockUrl(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(version ? { 'If-Match': version } : {}),
    },
    body: form,
  });
  if (res.status === 412) {
    const e = new Error('lock changed while acquiring (412)');
    e.conflict = true;
    throw e;
  }
  if (!res.ok) throw new Error(`lock POST ${res.status}`);
}

const expired = (lease) => !lease?.expires || Date.parse(lease.expires) <= Date.now();

/** Who holds a lease and for how long, in one line. */
export function describeLease(lease) {
  if (!lease) return 'none';
  const mins = Math.round((Date.parse(lease.expires) - Date.now()) / 60000);
  const age = expired(lease) ? 'EXPIRED' : `${mins}m left`;
  return `${lease.operation} on ${lease.host} (pid ${lease.pid}, ${age}, acquired ${lease.acquired})`;
}

/**
 * Take the writer lease, or throw naming who holds it.
 *
 * @returns {{ id, lease, release }}
 */
export async function acquireWriterLock(token, operation, opts = {}) {
  const { ttlMinutes = DEFAULT_TTL_MIN, force = false } = opts;
  /*
   * A `role: validator` host (.tracker/hosts/<hostname>.json) is declared one-off-checks
   * only, precisely so a slow machine cannot clobber the designated writer's sheet rows.
   * The role never enforced anything, because there was no lease. There is one now, so
   * the guarantee the role wanted is actually held — proceed, but say so out loud: a
   * validator host writing shared state should never be silent.
   */
  if (loadConfig().host?.role === 'validator') {
    // eslint-disable-next-line no-console
    console.warn(`⚠ ${hostProfileName()} is role=validator — taking a WRITER lease for "${operation}". `
      + 'The lease is what stops this clobbering another machine; the role alone never did.');
  }
  const { lease: current, version } = await read(token);
  if (current && !expired(current) && !force) {
    throw new Error(`writer lock held — ${describeLease(current)}. Wait for it, or re-run with `
      + '--force-lock if you know that run is dead.');
  }
  const id = randomUUID();
  const now = Date.now();
  const lease = {
    id,
    operation,
    host: hostname(),
    pid: process.pid,
    acquired: new Date(now).toISOString(),
    expires: new Date(now + ttlMinutes * 60000).toISOString(),
    tookOver: current ? describeLease(current) : null,
  };
  await write(token, lease, version);

  // Fail closed: we may proceed only if DA agrees we hold it.
  const back = await read(token);
  if (back.lease?.id !== id) {
    throw new Error(`lost the lock race to ${describeLease(back.lease)} — nothing was changed`);
  }

  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    const cur = await read(token).catch(() => ({ lease: null }));
    // Never release somebody else's lease — ours may have expired and been taken over.
    if (cur.lease?.id !== id) return;
    await fetch(lockUrl(), { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  };
  return { id, lease, release };
}

/** Read-only: who holds the lease right now? */
export async function inspectWriterLock(token) {
  const { lease } = await read(token);
  return { lease, held: Boolean(lease && !expired(lease)), description: describeLease(lease) };
}

/**
 * Run `fn` while holding the lease, releasing it on every exit path.
 *
 * The release is best-effort: a failed release leaves a lease that expires on its own,
 * which is strictly better than failing a run whose work already landed.
 */
export async function withWriterLock(token, operation, opts, fn) {
  const lock = await acquireWriterLock(token, operation, opts);
  try {
    return await fn(lock);
  } finally {
    await lock.release().catch(() => {});
  }
}
