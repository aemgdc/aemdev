/*
 * status-primer — /tracker/how-to-use-this. The status model, explained from the model.
 *
 * NO FETCH. Every table below is generated from the exports of
 * `scripts/tracker/stages.js`, so this is the one board that renders completely before
 * any feed exists — which is why it is built first. It also means it cannot fall
 * behind: add a stage, a queue or a status value to the model and it appears here with
 * its own label and hint, and a reworded hint reaches this page in the same commit.
 *
 * That is not a nicety. The tracker this is ported from also kept a hand-written
 * `docs/status-model.md`, and it fell behind the code twice in one week. A primer that
 * business readers are told to trust is exactly the document that must not be allowed
 * to drift, so it does not get the chance.
 *
 * Nothing here is authored prose about a status. The only authored prose is about the
 * MODEL — the two rules in `rulesSection()`, which no enum can state — and it lives
 * next to the tables it explains rather than in a doc nobody opens.
 *
 * Authored config (optional key/value rows):
 *   sections   comma-separated subset of:
 *              rules, funnel, bands, queues, english, translation, review, flag
 */
import {
  PAGE_STAGES, QUEUES, PROGRESS_BUCKETS, EN_STATUSES, TRANSLATION_STATUSES,
  REVIEW_STATUSES, CONTENT_ESCALATION_COLUMN, bucketForStage, queueMeta, docMarkerFor,
  statusClass,
} from '../../scripts/tracker/stages.js';
import { TARGET_LOCALES } from '../../scripts/tracker/locales.js';
import { dom, readConfig } from '../../scripts/tracker/block-utils.js';

/*
 * Who writes each stored column, in one place.
 *
 * `TRANSLATION_STATUSES` carries a per-value `actor` because two different automated
 * things write it (a mechanical scan and an LLM judge) and a reader needs to know
 * which; `en-status` and `review-status` are single-owner columns, so the ownership is
 * a property of the COLUMN and belongs here rather than repeated on every row. The
 * pairing of column, owner and the surface it is edited through is the answer to
 * "where do I go to change this?", which is the question this page exists for.
 */
const COLUMN_OWNERS = {
  'en-status': {
    owner: 'human',
    where: 'the group sheet’s `data` tab, or `npm run en-status`',
    note: 'Human-owned. A crawl never writes it — the send gate has to be a decision '
      + 'somebody made, because sending is the one step that costs money and cannot be '
      + 'taken back.',
  },
  'translation-status': {
    owner: 'pipeline',
    where: 'the locale tab, written by `tx:scan`, `tx:send` and the QA tiers',
    note: 'Pipeline-written. Never type into this column: the next scan overwrites it, '
      + 'and the value it writes is derived from what actually answered on the hosts.',
  },
  'review-status': {
    owner: 'human',
    where: 'the review document in DA (a `TRANSLATION STATUS:` line), synced to the sheet',
    note: 'The ONLY stored human judgement in the model, and the one that outranks '
      + 'every pipeline verdict. A reviewer edits a document, not a spreadsheet, so two '
      + 'reviewers can work at once without overwriting each other.',
  },
};

const ACTOR_LABEL = {
  automated: 'Pipeline',
  judge: 'Pipeline (LLM judge)',
  human: 'Human',
};

const OWNER_LABEL = {
  human: 'Human',
  pipeline: 'Pipeline',
  developer: 'Developer',
};

/** `actor`/`owner` → the two-tone chip class. Anything not human is machine-written. */
const actorKind = (actor) => (actor === 'human' ? 'human' : 'auto');

const SECTION_ORDER = ['rules', 'funnel', 'bands', 'queues', 'english', 'translation', 'review', 'flag'];

/**
 * The section builders, and the whole rendering vocabulary, bound to one Document.
 *
 * Built inside a factory rather than as module-level functions because `dom()` takes
 * its Document from the block element — this directory forbids DOM globals so the
 * shared model stays importable in Node. Threading `el` through fourteen builders as a
 * parameter was the alternative and it reads worse at every call site.
 */
function builders(block) {
  const { el } = dom(block);

  /** A monospaced stored value. `''` shows as `(blank)`, which is a real value here. */
  const code = (v) => el('code', 'sp-code', v === '' ? '(blank)' : String(v));

  /** A two-tone chip: `human` reads warm, everything machine-written reads cool. */
  const chip = (text, kind) => {
    const c = el('span', `sp-chip sp-chip-${kind}`, text);
    return c;
  };

  /** A stage or status chip whose colour hook comes from the model, never from here. */
  const statusPill = (value, label) => {
    const pill = el('span', 'sp-pill', label);
    pill.dataset.status = statusClass(value);
    return pill;
  };

  const section = (id, title, lede) => {
    const s = el('section', `sp-section sp-section-${id}`);
    s.id = `sp-${id}`;
    s.append(el('h2', 'sp-h', title));
    if (lede) s.append(el('p', 'sp-lede', lede));
    return s;
  };

  const note = (text) => el('p', 'sp-note', text);

  /**
   * A table from `headers` and `rows`.
   *
   * A cell is a string, a Node, or an array of either — never an HTML string. Every
   * label and hint on this page is a model constant today, but the primer sits in the
   * same directory as boards that render sheet cells a human typed, and one `innerHTML`
   * helper here is the one that gets copied into those.
   */
  const table = (headers, rows, cls) => {
    const t = el('table', `sp-table${cls ? ` ${cls}` : ''}`);
    const htr = el('tr');
    for (const [label, hcls] of headers) htr.append(el('th', hcls || null, label));
    const thead = el('thead');
    thead.append(htr);
    const tbody = el('tbody');
    for (const row of rows) {
      const tr = el('tr', row.cls || null);
      for (const cell of row.cells) {
        const td = el('td');
        for (const part of [cell].flat()) {
          td.append(typeof part === 'string' ? block.ownerDocument.createTextNode(part) : part);
        }
        tr.append(td);
      }
      tbody.append(tr);
    }
    t.append(thead, tbody);
    return t;
  };

  /** The ownership strip under a vocabulary table. Reads off COLUMN_OWNERS, one copy. */
  const ownership = (column) => {
    const o = COLUMN_OWNERS[column];
    const p = el('p', 'sp-owner');
    p.append(
      chip(OWNER_LABEL[o.owner], actorKind(o.owner)),
      el('span', 'sp-owner-col', column),
      el('span', 'sp-owner-where', `edited in ${o.where}`),
    );
    const wrap = el('div', 'sp-owner-wrap');
    wrap.append(p, note(o.note));
    return wrap;
  };

  /* ---------------------------------------------------------------- the two rules */

  /*
   * The two rules a reader gets wrong, in prose, at the top.
   *
   * They are prose because no enum can hold them: they are properties of HOW the
   * enums are combined, and each one produces a board that looks broken to somebody
   * who does not know it. Rule 1 is the ticket that gets filed as "the tracker went
   * backwards"; rule 2 is the argument about whose verdict counts. Both are answered
   * before the first table rather than in a footnote after eight of them.
   */
  const rulesSection = () => {
    const s = section(
      'rules',
      'Two rules that surprise people',
      'Everything below is generated from the model. These two are the parts of the '
      + 'model that are not a list of values, and they are the two that get read as '
      + 'bugs. Read them first.',
    );
    const rules = [
      [
        'A stage is DERIVED, never stored — so a page can move backwards',
        'No column anywhere holds "Previewed" or "Auto QA passed". A stage is computed '
        + 'every time it is asked, from the stored columns PLUS two facts observed by '
        + 'crawling: does this page answer on the preview host, and on the live host? '
        + 'So if a translated page is withdrawn from preview, the next scan moves it '
        + 'back to "Sent for translation" — even though the sheet still records that a '
        + 'QA tier passed it. That is the model working. Nothing in this system ever '
        + 'clears a status column, so a stage that trusted the columns alone would '
        + 'report a page as QA-passed forever after it stopped existing. A number that '
        + 'can only go up is not a measurement.',
      ],
      [
        'A human review-status outranks any pipeline verdict — in BOTH directions',
        'The tiers are advisory. A native speaker who marks a page "Needs '
        + 'retranslation" takes it out of the funnel however clean the automated '
        + 'verdicts were; a native speaker who marks a page "Translation OK" signs it '
        + 'off even if a tier failed it. Both directions matter, and the second is the '
        + 'one people do not expect: an automated failure a human has looked at and '
        + 'accepted is closed, not outstanding. If you disagree with a page’s '
        + 'position, look at review-status first — it is the only stored human '
        + 'judgement in the model and it wins.',
      ],
    ];
    const list = el('ol', 'sp-rules');
    for (const [head, body] of rules) {
      const li = el('li');
      li.append(el('strong', 'sp-rule-head', head), el('p', 'sp-rule-body', body));
      list.append(li);
    }
    s.append(list);
    return s;
  };

  /* ------------------------------------------------------------------- the funnel */

  const funnelSection = () => {
    const s = section(
      'funnel',
      'The funnel: nine positions',
      'The unit is a (page, locale) PAIR, not a page. One English page tracked into '
      + `${TARGET_LOCALES.length} locales is ${TARGET_LOCALES.length} pairs, each at `
      + 'exactly one of these positions. The first two are the English-side gate — they '
      + 'are the same for every locale, because they are facts about the source page.',
    );
    const rows = PAGE_STAGES.map((stage, i) => {
      const bucket = PROGRESS_BUCKETS.find((b) => b.id === bucketForStage(stage.id));
      return {
        cls: i < 2 ? 'sp-row-english' : null,
        cells: [
          String(i + 1),
          [statusPill(stage.id, stage.label), el('span', 'sp-short', stage.short)],
          stage.hint,
          bucket ? bucket.label : '—',
        ],
      };
    });
    s.append(table([
      ['#', 'sp-num'],
      ['Position', 'sp-col-stage'],
      ['What it means'],
      ['Progress band', 'sp-col-band'],
    ], rows, 'sp-funnel'));
    s.append(note(
      'The `short` column on the right of each chip (CAT, EN, PREV…) is the same label '
      + 'the Page Tracker app uses in its tight table columns. Same value, less room.',
    ));
    s.append(note(
      'A pair in a work queue has NO position: it has stepped out of the funnel and is '
      + 'counted as blocked until somebody clears it. See the queues below.',
    ));
    return s;
  };

  /* -------------------------------------------------------------- progress bands */

  const bandsSection = () => {
    const s = section(
      'bands',
      'How the nine positions collapse into eight bands',
      'The progress bars on the boards are coarser than the funnel on purpose: from '
      + 'outside the pipeline "automated QA is running" is one fact, not three. These '
      + 'bands are what a bar is divided into, left to right.',
    );
    const rows = PROGRESS_BUCKETS.map((bucket, i) => {
      const folded = PAGE_STAGES.filter((st) => bucketForStage(st.id) === bucket.id);
      const pills = folded.flatMap((st, n) => (
        n ? [' + ', statusPill(st.id, st.label)] : [statusPill(st.id, st.label)]
      ));
      return {
        cls: folded.length > 1 ? 'sp-row-folded' : null,
        cells: [String(i + 1), el('strong', null, bucket.label), pills],
      };
    });
    s.append(table([
      ['#', 'sp-num'],
      ['Band', 'sp-col-band'],
      ['Funnel positions folded into it'],
    ], rows, 'sp-bands'));
    s.append(note(
      'Two bands fold two positions each, and they are the only ones that do: the two '
      + 'automated QA tiers read as one band, and so do the two review positions. '
      + 'Everything else is one-to-one, which is why a bar and a funnel table of the '
      + 'same data are never off by more than that fold.',
    ));
    s.append(note(
      'A blocked pair is in NO band. The bands sum to the pairs on the line, not to the '
      + 'total — so a bar that does not fill the width is telling you something.',
    ));
    return s;
  };

  /* -------------------------------------------------------------------- queues */

  const queuesSection = () => {
    const s = section(
      'queues',
      `Work queues: ${QUEUES.length} ways out of the funnel`,
      'A failure, a rejection or a missing page takes a pair out of the forward path '
      + 'and puts it in a queue that has an OWNER. A pair in a queue is not lost — it '
      + 'is waiting for one named party to do one specific thing.',
    );
    const rows = QUEUES.map((q) => ({
      cells: [
        el('strong', null, q.label),
        chip(OWNER_LABEL[q.owner] || q.owner, actorKind(q.owner)),
        q.hint,
        code(q.id),
      ],
    }));
    s.append(table([
      ['Queue', 'sp-col-queue'],
      ['Owned by', 'sp-col-owner'],
      ['What it is waiting for'],
      ['Feed id', 'sp-col-id'],
    ], rows, 'sp-queues'));
    s.append(note(
      'The owner is in the MODEL, not in this page’s markup, so the boards, the '
      + 'Page Tracker app and the escalation feed cannot disagree about who is being '
      + 'asked.',
    ));
    s.append(note(
      'One of these coexists with a funnel position instead of replacing it: '
      + '"Content escalations" — see the flag at the bottom of this page. Every other '
      + 'queue means the pair has left the funnel until someone acts.',
    ));
    return s;
  };

  /* -------------------------------------------------------- the stored vocabularies */

  const englishSection = () => {
    const s = section(
      'english',
      'Stored column 1 of 3: en-status — the English gate',
      'Deliberately tiny. The English page already exists, so the only question this '
      + 'column answers is whether it is published enough to translate FROM. Blank is '
      + 'normal, not missing.',
    );
    const rows = EN_STATUSES.map((v) => ({
      cls: v.value === 'en-published' ? 'sp-row-gate' : null,
      cells: [
        code(v.value),
        el('strong', null, v.label),
        v.value === 'en-published'
          ? 'THE SEND GATE. Only this value lets a pair be handed to the translation service.'
          : 'Not sendable.',
      ],
    }));
    s.append(table([['Stored value', 'sp-col-value'], ['Means', 'sp-col-means'], ['Effect']], rows));
    s.append(ownership('en-status'));
    s.append(note(
      'The gate wants this value EXPLICITLY. A page that merely looks published — the '
      + 'crawl saw a 200 once — is not sent on that basis. Case is folded, so '
      + '`EN-Published` counts: a shift key is not allowed to be a semantic difference '
      + 'in a spreadsheet a human edits.',
    ));
    return s;
  };

  const translationSection = () => {
    const s = section(
      'translation',
      'Stored column 2 of 3: translation-status — what the pipeline recorded',
      'One value per (page, locale) pair, written by the scan and the QA tiers. The '
      + 'values with a queue on the right are BLOCKING: they pull the pair out of the '
      + 'funnel rather than advancing it.',
    );
    const rows = TRANSLATION_STATUSES.map((v) => ({
      cls: v.queue ? 'sp-row-blocking' : null,
      cells: [
        code(v.value),
        el('strong', null, v.label),
        chip(ACTOR_LABEL[v.actor] || v.actor, actorKind(v.actor)),
        v.queue ? chip((queueMeta(v.queue) || {}).label || v.queue, 'queue') : '—',
      ],
    }));
    s.append(table([
      ['Stored value', 'sp-col-value'],
      ['Means', 'sp-col-means'],
      ['Written by', 'sp-col-owner'],
      ['Sends it to', 'sp-col-queue'],
    ], rows, 'sp-tx'));
    s.append(ownership('translation-status'));
    s.append(note(
      '`sent` is the one value here that nothing can re-observe. Every other state can '
      + 'be recovered by crawling two hosts or re-running a tier; "we handed this to the '
      + 'translation service" exists only because we recorded it. That is why it carries '
      + 'a `sent-at` timestamp and why a preview that never arrives becomes '
      + '`preview-missing` rather than being quietly forgotten.',
    ));
    s.append(note(
      'A value here is only believed when the English page passed the gate above. A '
      + 'status on an ungated pair is treated as a mis-send or a stale row, not as '
      + 'progress — reporting it as forward motion would inflate the only number '
      + 'anybody reads.',
    ));
    return s;
  };

  const reviewSection = () => {
    const s = section(
      'review',
      'Stored column 3 of 3: review-status — the human verdict',
      'A native speaker’s answer, and the only stored human judgement in the '
      + 'model. It is written by editing a review DOCUMENT in DA — one per (page, '
      + 'locale) — and the marker line in that document is what syncs back to the '
      + 'sheet. Rule 2 at the top of this page is about this column.',
    );
    const rows = REVIEW_STATUSES.map((v) => ({
      cls: v.queue ? 'sp-row-blocking' : null,
      cells: [
        code(v.value),
        el('strong', null, v.label),
        code(`TRANSLATION STATUS: ${docMarkerFor(v.value)}`),
        v.queue ? chip((queueMeta(v.queue) || {}).label || v.queue, 'queue') : '—',
      ],
    }));
    s.append(table([
      ['Stored value', 'sp-col-value'],
      ['Means', 'sp-col-means'],
      ['Line to write in the review doc', 'sp-col-marker'],
      ['Sends it to', 'sp-col-queue'],
    ], rows, 'sp-review'));
    s.append(ownership('review-status'));
    s.append(note(
      'A verdict is single-valued: recording one replaces the last. A mistyped marker '
      + 'matches nothing and is reported as an unknown marker rather than being read as '
      + 'the nearest one — `TRANSLATION STATUS: OKAY` is not a sign-off. Prose after the '
      + 'marker is fine: `OK — check the date` reads as OK.',
    ));
    return s;
  };

  /* ---------------------------------------------------------------------- the flag */

  const flagSection = () => {
    const s = section(
      'flag',
      `The one flag: ${CONTENT_ESCALATION_COLUMN}`,
      'Every column above is single-valued — setting one replaces the last. A problem '
      + 'in the ENGLISH source does not work that way, so it is not a status at all.',
    );
    const why = '"The recap video is a dead link" is true at the same time as "the '
      + 'German translation is ready for review", and it stays true across '
      + 're-translations and re-judges until a content owner decides something. Folding '
      + 'it into a status would force a choice between recording the content problem and '
      + 'recording the translation state, and losing one of them.';
    const how = `So \`${CONTENT_ESCALATION_COLUMN}\` is an independent column that `
      + 'COEXISTS with any position: a flagged pair is still counted wherever it sits in '
      + 'the funnel, and the flag rides alongside. It is also the only signal here that '
      + 'belongs to the PAGE rather than the pair — a dead link in English is dead in '
      + `all ${TARGET_LOCALES.length} locales — which is why it lives on the \`data\` tab.`;
    s.append(el('p', 'sp-body', why), el('p', 'sp-body', how));
    s.append(note(
      'On a board, that means the escalation count does not partition with the funnel '
      + 'columns and must never be added to them. It is an annotation on a row, not '
      + 'another step in it.',
    ));
    return s;
  };

  return {
    rules: rulesSection,
    funnel: funnelSection,
    bands: bandsSection,
    queues: queuesSection,
    english: englishSection,
    translation: translationSection,
    review: reviewSection,
    flag: flagSection,
  };
}

/**
 * Render the primer.
 *
 * This block has no feed, so it has no empty state — but it does have a config error
 * state, and that is the one worth handling: an authored `sections` row with a typo in
 * it would otherwise silently produce a blank block on the page whose whole job is
 * explaining the model. So an unrecognised name is named back, the valid ones are
 * listed, and the full primer renders anyway. A page that explains itself badly still
 * beats a page that is not there.
 */
export default function init(block) {
  const cfg = readConfig(block);
  const sections = builders(block);
  const { el } = dom(block);

  const asked = (cfg.sections || '').split(',').map((x) => x.trim()).filter(Boolean);
  const unknown = asked.filter((name) => !sections[name]);
  const wanted = asked.filter((name) => sections[name]);

  block.textContent = '';

  if (unknown.length) {
    const warn = el('p', 'sp-config-error');
    warn.append(
      el('strong', null, `Unknown section${unknown.length === 1 ? '' : 's'} in this block: `),
      el('code', 'sp-code', unknown.join(', ')),
      el('span', null, ` — valid names are: ${SECTION_ORDER.join(', ')}. `),
      el('span', null, wanted.length
        ? 'The recognised sections are shown below.'
        : 'Showing the whole primer instead.'),
    );
    block.append(warn);
  }

  // Authored order is ignored, deliberately: the sections build an argument in a fixed
  // order (the two rules, then the funnel they apply to, then the columns behind it),
  // and `sections` exists to leave one out on a page that has already made the point.
  const render = wanted.length ? SECTION_ORDER.filter((n) => wanted.includes(n)) : SECTION_ORDER;
  for (const name of render) block.append(sections[name]());
}
