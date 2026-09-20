/**
 * Splitforms block — a working form panel that floats right inside its section.
 * Submissions go to splitforms.com; no server code involved.
 *
 *   ## Our most embarrassing AEM mistakes         <- section copy, NOT the block
 *   Come hear the stories that only come out in person.
 *
 *   | splitforms   |                       |
 *   | ------------ | --------------------- |
 *   | form         | event-signup          |
 *   | reply-email  | hello@aemdev.org      |
 *   | redirect-url | /en/drafts/thank-you  |
 *   | event-id     | london-2026-10        |
 *
 * Every row is configuration — `key | value`. There is no content cell: the
 * teaser copy is whatever the section already says. That is the point of the
 * block's shape. An author drops a form into paragraphs they have already
 * written, and the panel floats right while the copy flows beside it, rather
 * than having to move that copy into a table cell to get the two-column look.
 *
 * Placement is normalised: wherever the cursor was, the block is hoisted to the
 * top of its section. A float only shortens the line boxes that come AFTER it,
 * so a block left at the end of a section would right-align against nothing.
 *
 * Config keys
 *   form           one of the form names below — required
 *   reply-email    address replies go to; sets the notification Reply-To
 *   redirect-url   where to send the visitor after a successful submit. Applied
 *                  client-side: the API deliberately ignores a submitted
 *                  `redirect` field so it cannot be used as an open-redirect hop
 *   event-id       stamped onto every submission as `event_id`
 *   access-key     override the destination splitforms account
 *   submit-label   override the button text
 *   success        override the inline confirmation message
 *
 * Form names: contact · event-signup · join-the-collective · buy-me-a-coffee ·
 * subscribe · suggest-location. An unrecognised name falls back to `contact`
 * and warns in the console.
 */

const SUBMIT_ENDPOINT = 'https://splitforms.com/api/submit';

/*
 * Public, client-side access key for the AEM GDC splitforms account. This is
 * designed to be visible in page source — it identifies the destination inbox,
 * it does not authorise anything. Lock submissions down with allowed-domains in
 * the splitforms dashboard rather than by hiding the key. Override per-block
 * with an `access-key` row.
 */
const DEFAULT_ACCESS_KEY = '0b964a01a7bb49fd9b1f174d6870f479';

/** Field-type shorthand used by the form definitions below. */
const text = (name, label, required = false, extra = {}) => ({
  name, label, type: 'text', required, ...extra,
});
const email = (name, label, required = true, extra = {}) => ({
  name, label, type: 'email', required, ...extra,
});
const area = (name, label, required = false, extra = {}) => ({
  name, label, type: 'textarea', required, ...extra,
});
const choice = (name, label, options, required = false) => ({
  name, label, type: 'select', options, required,
});
const number = (name, label, required = false, extra = {}) => ({
  name, label, type: 'number', required, ...extra,
});

/**
 * Read an on/off config cell. Authors write yes/no, and the picker emits the
 * same, but true/false and on/off are accepted so a hand-typed table behaves.
 * Anything unrecognised — including an empty cell — leaves the default alone.
 */
function flag(raw, fallback) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (['yes', 'true', 'on', '1'].includes(value)) return true;
  if (['no', 'false', 'off', '0'].includes(value)) return false;
  return fallback;
}

/**
 * The pre-selected forms. `subject` becomes the notification email subject,
 * so authors get a readable inbox without configuring anything.
 *
 * Note: `subject`, `from_name`, `replyto`, `redirect`, `botcheck` and
 * `form_loaded_at` are reserved by the splitforms API — no visible field may
 * use those names or it would change delivery behaviour instead of being saved.
 */
const FORMS = {
  contact: {
    title: 'Send us a message',
    subject: 'Contact form — aemdev.org',
    submitLabel: 'Send message',
    success: 'Thanks — your message is in. We usually reply within a couple of days.',
    fields: [
      text('name', 'Your name', true),
      email('email', 'Email', true),
      area('message', 'Message', true, { rows: 5 }),
    ],
  },

  'event-signup': {
    title: 'Register for this event',
    subject: 'Event signup — aemdev.org',
    submitLabel: 'Register',
    success: 'You are registered. Look out for a confirmation email with the details.',
    fields: [
      text('name', 'Your name', true),
      email('email', 'Email', true),
      text('organisation', 'Organisation'),
      text('access_needs', 'Dietary or access requirements'),
      choice('first_event', 'First AEM GDC event?', ['Yes', 'No']),
    ],

    /*
     * Event sign-up is the one form whose shape an author changes per event, so
     * it reads three extra config rows. Everything here is additive: with none
     * of them set the form is exactly what `fields` above declares.
     */
    refine(definition, config) {
      let fields = [...definition.fields];
      const hiddenValues = {};

      // Dietary/access needs is on unless turned off — most events cater.
      if (!flag(config.dietary, true)) {
        fields = fields.filter((f) => f.name !== 'access_needs');
      }

      // A group booking field, off unless asked for.
      if (flag(config['max-attendees'], false)) {
        fields.push(number('places', 'How many places?', false, { min: 1 }));
      }

      /*
       * A single-mode event records its type without asking — the attendee has
       * no choice to make. Only a `Both` event needs the question put to them.
       */
      const ticket = (config['ticket-type'] || '').trim();
      if (ticket && /^both$/i.test(ticket)) {
        fields.push(choice('ticket_type', 'Attending', ['In-person', 'Virtual'], true));
      } else if (ticket) {
        hiddenValues.ticket_type = ticket;
      }

      return { ...definition, fields, hidden: hiddenValues };
    },
  },

  'join-the-collective': {
    title: 'Join the collective',
    subject: 'New collective member — aemdev.org',
    submitLabel: 'Count me in',
    success: 'Welcome aboard. We will be in touch about what is happening near you.',
    fields: [
      text('name', 'Your name', true),
      email('email', 'Email', true),
      text('city', 'Where are you based?', true),
      text('organisation', 'Organisation'),
      text('role', 'What do you do?'),
      choice('involvement', 'How would you like to get involved?', [
        'Just keep me posted',
        'I would like to speak at an event',
        'I can help organise',
        'I can offer a venue',
      ]),
      area('about', 'Anything you would like us to know?', false, { rows: 3 }),
    ],
  },

  'buy-me-a-coffee': {
    title: 'Buy the organisers a coffee',
    subject: 'Coffee pledge — aemdev.org',
    submitLabel: 'Pledge a coffee',
    /*
     * This form takes no payment — splitforms is a form backend, not a payment
     * processor. It records an intent to contribute and someone follows up.
     */
    note: 'This does not take payment — we will email you a link to settle up.',
    success: 'Much appreciated. We will email you a payment link shortly.',
    fields: [
      text('name', 'Your name', true),
      email('email', 'Email', true),
      choice('amount', 'How much?', [
        'A flat white (£3)',
        'Coffee and a pastry (£5)',
        'A round for the organisers (£10)',
        'Something else — I will say in the note',
      ], true),
      area('note', 'Leave a note', false, { rows: 3 }),
    ],
  },

  subscribe: {
    title: 'Get the newsletter',
    subject: 'Newsletter signup — aemdev.org',
    submitLabel: 'Subscribe',
    note: 'Occasional emails about events and what the collective is building. Unsubscribe any time.',
    success: 'You are on the list. Check your inbox to confirm.',
    fields: [
      email('email', 'Email', true),
      text('name', 'Your name (optional)'),
    ],
  },

  'suggest-location': {
    title: 'Suggest a location',
    subject: 'Location suggestion — aemdev.org',
    submitLabel: 'Send suggestion',
    success: 'Suggestion received — thank you. We read every one of these.',
    fields: [
      text('name', 'Your name', true),
      email('email', 'Email', true),
      text('city', 'Which city?', true),
      text('country', 'Country', true),
      text('venue', 'A venue in mind? (optional)'),
      choice('can_help', 'Could you help make it happen?', [
        'Yes, I can help organise',
        'Maybe — tell me more',
        'No, just suggesting',
      ]),
      area('why', 'Why there?', false, { rows: 3 }),
    ],
  },
};

const FALLBACK_FORM = 'contact';

/**
 * The form names this block answers to, for tooling that offers them to authors.
 *
 * Exported so tools/splitforms-picker can check its own catalog against the block
 * instead of keeping a second hand-maintained list: a form added here but not
 * there shows up as a warning in the picker rather than quietly going missing.
 */
export const FORM_NAMES = Object.keys(FORMS);

/**
 * Read the block table into { config, legacy }.
 *
 * Two-cell rows are configuration, which is the whole of the current content
 * model. One-cell rows are LEGACY: before this block floated, the first row
 * carried the teaser copy for a left-hand pane. Pages written that way are
 * live, so rather than dropping that copy — or leaving it to render inside the
 * form panel — it is handed back and lifted out into the section, where copy
 * now belongs. Deleting the row on the page produces exactly the same result.
 */
function parseBlock(block) {
  const config = {};
  const legacy = [];

  [...block.children].forEach((row) => {
    const cells = [...row.children];

    if (cells.length >= 2) {
      const key = cells[0].textContent.trim().toLowerCase();
      const valueCell = cells[1];
      let value = valueCell.textContent.trim();
      // EDS auto-links emails and paths; fall back to the href if the cell
      // renders empty, and drop the mailto: scheme so `replyto` gets a bare
      // address.
      if (!value) {
        const anchor = valueCell.querySelector('a');
        if (anchor) value = anchor.getAttribute('href') || '';
      }
      if (key) config[key] = value.replace(/^mailto:/i, '');
    } else if (cells.length === 1) {
      legacy.push(cells[0]);
    }
  });

  return { config, legacy };
}

/**
 * Only same-origin paths and http(s) URLs may be redirect targets — an author
 * typo should not turn into a `javascript:` navigation.
 */
function safeRedirect(raw) {
  if (!raw) return null;
  try {
    const url = new URL(raw, window.location.origin);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/** Build one labelled control. */
function buildField(field, idPrefix) {
  const id = `${idPrefix}-${field.name}`;
  const wrapper = document.createElement('div');
  wrapper.className = 'splitforms-field';

  const label = document.createElement('label');
  label.setAttribute('for', id);
  label.textContent = field.label;
  if (field.required) {
    const mark = document.createElement('span');
    mark.className = 'splitforms-required';
    mark.textContent = '*';
    mark.setAttribute('aria-hidden', 'true');
    label.append(mark);
  }

  let control;
  if (field.type === 'textarea') {
    control = document.createElement('textarea');
    control.rows = field.rows || 4;
  } else if (field.type === 'select') {
    control = document.createElement('select');
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Choose one…';
    control.append(placeholder);
    (field.options || []).forEach((option) => {
      const el = document.createElement('option');
      el.value = option;
      el.textContent = option;
      control.append(el);
    });
  } else {
    control = document.createElement('input');
    control.type = field.type;
  }

  control.id = id;
  control.name = field.name;
  if (field.required) control.required = true;
  if (field.placeholder) control.placeholder = field.placeholder;

  wrapper.append(label, control);
  return wrapper;
}

/** Hidden input helper. */
function hidden(name, value) {
  const el = document.createElement('input');
  el.type = 'hidden';
  el.name = name;
  el.value = value;
  return el;
}

/**
 * The honeypot pair: a field bots fill, and a timestamp that catches instant posts.
 *
 * `form_loaded_at` MUST be epoch milliseconds. This was verified against the live
 * API, and getting it wrong fails in the worst possible way: an ISO 8601 string is
 * accepted with HTTP 200 and `{"success": true}` — but with no `message` property —
 * and the submission is then silently binned as bot traffic. The visitor sees the
 * success state and the entry never reaches the inbox. Do not "tidy" this into
 * `toISOString()`.
 */
function buildTrap() {
  const trap = document.createElement('div');
  trap.className = 'splitforms-trap';
  trap.setAttribute('aria-hidden', 'true');

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.name = 'botcheck';
  check.tabIndex = -1;
  check.autocomplete = 'off';

  trap.append(check, hidden('form_loaded_at', String(Date.now())));
  return trap;
}

/** Wire up submission: POST as JSON, then redirect or show an inline result. */
function attachSubmit(form, { definition, redirectUrl, status, panel }) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const button = form.querySelector('button[type="submit"]');
    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = 'Sending…';
    status.textContent = '';
    status.className = 'splitforms-status';

    try {
      const response = await fetch(SUBMIT_ENDPOINT, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: new FormData(form),
      });
      const result = await response.json().catch(() => ({}));

      if (response.ok && result.success) {
        /*
         * A genuine acceptance echoes a `message`. A 200 with `success: true` and
         * no message means the API took the submission and binned it as spam —
         * the visitor is deliberately not told, but a developer should be.
         */
        if (!result.message) {
          // eslint-disable-next-line no-console
          console.warn('splitforms: submission accepted but silently filtered as spam. '
            + 'Check the honeypot and form_loaded_at values.');
        }
        if (redirectUrl) {
          window.location.assign(redirectUrl);
          return;
        }
        const done = document.createElement('p');
        done.className = 'splitforms-success';
        done.setAttribute('role', 'status');
        done.textContent = definition.success;
        form.replaceWith(done);
        panel.querySelector('.splitforms-note')?.remove();
        return;
      }

      status.textContent = result.message
        || 'That did not go through. Please try again in a moment.';
      status.classList.add('splitforms-status-error');
    } catch {
      status.textContent = 'We could not reach the form service. Check your connection and try again.';
      status.classList.add('splitforms-status-error');
    }

    button.disabled = false;
    button.textContent = originalLabel;
  });
}

/** Build the whole form panel for one block instance. */
function buildForm(definition, config, instanceId) {
  const panel = document.createElement('div');
  panel.className = 'splitforms-panel';

  const heading = document.createElement('h3');
  heading.className = 'splitforms-title';
  heading.textContent = definition.title;
  panel.append(heading);

  if (definition.note) {
    const note = document.createElement('p');
    note.className = 'splitforms-note';
    note.textContent = definition.note;
    panel.append(note);
  }

  const form = document.createElement('form');
  form.className = 'splitforms-form';
  form.noValidate = false;

  form.append(hidden('access_key', config['access-key'] || DEFAULT_ACCESS_KEY));
  form.append(hidden('subject', definition.subject));
  if (config['reply-email']) form.append(hidden('replyto', config['reply-email']));
  if (config['event-id']) form.append(hidden('event_id', config['event-id']));
  Object.entries(definition.hidden || {}).forEach(([name, value]) => {
    form.append(hidden(name, value));
  });

  definition.fields.forEach((field) => form.append(buildField(field, instanceId)));
  form.append(buildTrap());

  const status = document.createElement('p');
  status.className = 'splitforms-status';
  status.setAttribute('role', 'alert');
  status.setAttribute('aria-live', 'polite');

  const button = document.createElement('button');
  button.type = 'submit';
  button.className = 'splitforms-submit';
  button.textContent = config['submit-label'] || definition.submitLabel;

  form.append(status, button);
  panel.append(form);

  attachSubmit(form, {
    definition: { ...definition, success: config.success || definition.success },
    redirectUrl: safeRedirect(config['redirect-url']),
    status,
    panel,
  });

  return panel;
}

/**
 * Wrap copy lifted out of a legacy content row so it reads as section copy.
 *
 * `.default-content` is deliberate rather than a class of our own: it is the
 * group AuthorKit puts prose in, so it already carries the article column's
 * width and typography in every template. Copy that moves out of the block
 * lands looking like copy the author had typed into the section.
 */
function legacyCopy(cells) {
  const group = document.createElement('div');
  group.className = 'default-content splitforms-legacy-copy';
  cells.forEach((cell) => {
    while (cell.firstChild) group.append(cell.firstChild);
  });
  return group;
}

/** Is there prose in this section for the panel to float beside? */
function hasCopy(section) {
  return [...section.querySelectorAll(':scope > .default-content')]
    .some((group) => group.textContent.trim() !== '');
}

/**
 * Put the block where the float can do its work.
 *
 * Two moves, both load-bearing. The block is hoisted to the top of its section
 * because a float only shortens the line boxes that FOLLOW it — dropped at the
 * end of a section it would right-align against nothing, which reads as the
 * block being broken rather than as the author having placed it late. And the
 * section is marked so CSS can make it a block formatting context, or the
 * panel escapes the bottom of the section and lands over the next one.
 */
function placeInSection(block, legacy) {
  const section = block.closest('.section');

  // Fragments, the DA preview and unit tests hand over a bare block. It still
  // renders — it just has no section to float within.
  if (!section) {
    if (legacy.length) block.append(legacyCopy(legacy));
    return;
  }

  const group = block.parentElement;
  section.classList.add('splitforms-section');
  section.prepend(block);
  // AuthorKit groups consecutive DIVs, so the block may have left an empty
  // `.block-content` behind — or a sibling block, which stays where it is.
  if (group !== section && !group.childElementCount) group.remove();

  if (legacy.length) block.after(legacyCopy(legacy));

  // Nothing to flow beside: centre the panel rather than right-align it
  // against empty space.
  if (!hasCopy(section)) block.classList.add('splitforms-solo');
}

let instanceCount = 0;

export default function decorate(block) {
  const { config, legacy } = parseBlock(block);

  const requested = (config.form || '').toLowerCase();
  const definition = FORMS[requested] || FORMS[FALLBACK_FORM];
  if (!FORMS[requested]) {
    // eslint-disable-next-line no-console
    console.warn(`splitforms: unknown form "${config.form}" — falling back to "${FALLBACK_FORM}". `
      + `Known forms: ${Object.keys(FORMS).join(', ')}`);
  }

  // A form may reshape itself from config; those that do not are passed through.
  const resolved = typeof definition.refine === 'function'
    ? definition.refine(definition, config)
    : definition;

  instanceCount += 1;
  const instanceId = `splitforms-${instanceCount}`;

  block.textContent = '';
  block.append(buildForm(resolved, config, instanceId));
  placeInSection(block, legacy);
}
