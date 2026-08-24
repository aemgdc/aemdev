/**
 * exit.mjs — the one mapping from a tier's verdict to a process exit code.
 *
 * Node-only. Not importable from a browser entry point; exit codes do not exist there.
 *
 * ─── WHY THIS IS A SHARED MODULE AND NOT A LINE IN EACH TOOL ────────────────
 *
 * docs/tracker/data-contract.md §5 makes the codes CONTRACTUAL, because callers — the
 * drivers, `npm run verify`, a CI step, a human's `&&` — branch on them:
 *
 *   0  pass
 *   1  fail — a real defect was found
 *   2  the tool could not reach a verdict (LLM down, network error, missing page).
 *      The page HOLDS its current status and the batch CONTINUES.
 *   3  usage or configuration error. Nothing ran.
 *
 * Exit 2 existing separately from 1 is the whole reason a batch can be interrupted and
 * resumed without corrupting state. That makes the 1-vs-2 split the single most
 * load-bearing decision in the table, and it was previously made three times, in three
 * private `const EXIT = { … }` maps in tx-qa.mjs, tx-judge.mjs and visual-judge.mjs.
 * Three copies of one contract is how a tool comes to report "no defect found" for
 * "could not look" — and nothing would have caught it, because each copy was locally
 * consistent and no test compared them.
 *
 * ─── WHY ONE TABLE COVERS THREE VOCABULARIES ────────────────────────────────
 *
 * The tiers do not share a verdict word for "could not reach a verdict": tier 1 says
 * `review`, the judges say `escalate`, and the visual tier says `escalate` too. Those
 * are the tools' own vocabularies and worth keeping — `review` genuinely means "a human
 * should look", not "the model fell over". So the table accepts every spelling and maps
 * them all onto the one contract, rather than forcing three tools to rename their
 * verdicts to share a number.
 */

/**
 * Verdict word → exit code. Every spelling any tier emits, including the ones that mean
 * the same thing.
 */
export const VERDICT_EXIT = {
  pass: 0,
  ok: 0,
  fail: 1,
  error: 1,
  review: 2,
  escalate: 2,
  unreachable: 2,
  skip: 2,
};

/**
 * The exit code for a verdict.
 *
 * An UNKNOWN verdict is 2, never 0. A tier that produced a word this table has never
 * heard of did not establish that the page is fine — it established that something is
 * wrong with the tier. Defaulting an unrecognised verdict to 0 is how a batch reports a
 * clean run it never performed, so the default is deliberately the conservative code
 * that holds the page's status and lets the batch continue.
 */
export const verdictExit = (verdict) => VERDICT_EXIT[String(verdict ?? '')] ?? 2;
