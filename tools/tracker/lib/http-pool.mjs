/**
 * http-pool.mjs — bounded concurrency, a request-rate ceiling, and the ONE retry rule
 * every admin.hlx.page caller in this pipeline uses.
 *
 * Node-only (`.mjs`; never importable from a browser entry — see
 * tools/tracker/check-browser-modules.mjs).
 *
 * ─── Why a rate limiter and not just a concurrency cap ──────────────────────
 *
 * `admin.hlx.page` is rate-limited at roughly 10 requests/second. A concurrency cap
 * alone does not bound the RATE: six lanes against a fast endpoint (the status API
 * answers in ~80 ms) is well over 60 req/s, and the 429s that come back arrive in a
 * burst across every lane at once. So the two limits are separate knobs and both are
 * needed — lanes bound how many are in flight, the limiter bounds how often one may
 * start.
 *
 * The limiter spaces requests EVENLY (one every 1/perSecond) rather than allowing a
 * burst up to the ceiling and then stalling. A smooth stream is what the ceiling
 * actually means, and a bursty one measured over any window shorter than a second
 * trips the limit while satisfying it on average.
 *
 * ─── The retry rule ────────────────────────────────────────────────────────
 *
 * Retry ONLY on 429 and 5xx (and on a transport error, which arrives as status 0).
 * A 4xx is a real answer: a 404 on a locale page means the page is not there, and
 * retrying it just doubles the load on an endpoint that is already telling us to slow
 * down. This is the same rule the tool this was ported from used, and the reason is the
 * same — the one time it retried 4xx it turned a batch of missing pages into a
 * self-inflicted rate limit.
 */

/** Sleep, as a promise. */
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * A request-rate gate. `await limiter()` returns when it is this caller's turn.
 *
 * `perSecond <= 0` disables the gate entirely, which is what a caller wants for a
 * localhost endpoint; it is not a silent no-op because the caller passed it.
 */
export function createLimiter({ perSecond = 10 } = {}) {
  if (!(perSecond > 0)) return async () => {};
  const interval = 1000 / perSecond;
  let next = 0;
  return async () => {
    const now = Date.now();
    const slot = Math.max(now, next);
    next = slot + interval;
    if (slot > now) await wait(slot - now);
  };
}

/**
 * Run `worker` over `items` with a bounded number in flight.
 *
 * A shift-queue rather than a chunked `Promise.all`: chunking waits for the slowest
 * item in every chunk before starting the next, so one slow page stalls five lanes.
 * Results come back in COMPLETION order, so a caller that needs the input order keys
 * the result itself rather than relying on position.
 */
export async function pool(items, limit, worker) {
  const queue = [...items];
  const out = [];
  const lanes = Math.max(1, Math.min(limit, queue.length));
  const lane = async () => {
    while (queue.length) {
      out.push(await worker(queue.shift()));
    }
  };
  await Promise.all(Array.from({ length: lanes }, lane));
  return out;
}

/**
 * One HTTP request, rate-gated, retried only when retrying can help.
 *
 * Returns `{ ok, status, res, attempts, detail }` and never throws: every caller here
 * treats an unreachable host as a reportable observation rather than an exception,
 * because the alternative is a batch that dies on page 40 of 190.
 *
 * `status: 0` is a transport failure (DNS, reset, timeout). It is retried like a 5xx
 * and reported distinctly from a real HTTP status, because "the server said no" and
 * "we never reached the server" must not be recorded as the same observation — the
 * second one means we did not look, and nothing may be written from it.
 */
export async function request(url, init = {}, {
  limiter = null, attempts = 3, backoffMs = 1200, timeoutMs = 30000,
} = {}) {
  let last = { ok: false, status: 0, detail: 'not attempted' };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (limiter) await limiter();
    const control = AbortSignal.timeout(timeoutMs);
    const res = await fetch(url, { ...init, signal: control })
      .catch((e) => ({ ok: false, status: 0, statusText: e.message }));
    if (res.ok) {
      return {
        ok: true, status: res.status, res, attempts: attempt, detail: null,
      };
    }
    last = {
      ok: false,
      status: res.status,
      res: res.status ? res : null,
      attempts: attempt,
      detail: res.statusText || `HTTP ${res.status}`,
    };
    // A 4xx is an answer, not a hiccup. Retrying it doubles the load for nothing.
    if (res.status !== 429 && res.status < 500 && res.status !== 0) return last;
    if (attempt < attempts) await wait(backoffMs * attempt);
  }
  return last;
}
