/**
 * Splitforms block — a split panel: author content on one side, a working form
 * on the other. Submissions go to splitforms.com; no server code involved.
 *
 *   | splitforms   |                       |
 *   | ------------ | --------------------- |
 *   | ## Join us in London                 |  <- single-cell row: left-pane content
 *   | Doors at 18:00, talks from 18:30.    |
 *   | form         | event-signup          |  <- two-cell row: configuration
 *   | reply-email  | hello@aemdev.org      |
 *   | redirect-url | /en/drafts/thank-you  |
 *   | event-id     | london-2026-10        |
 *
 * The rule authors need to remember: rows with TWO cells configure the form,
 * rows with ONE cell are the content beside it. Content is optional — with no
 * single-cell rows the form runs full width.
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
 * Read the block table into { config, content }.
 * Two-cell rows are configuration; one-cell rows are left-pane content.
 */
function parseBlock(block) {
  const config = {};
  const content = [];

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
      content.push(cells[0]);
    }
  });

  return { config, content };
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

let instanceCount = 0;

export default function decorate(block) {
  const { config, content } = parseBlock(block);

  const requested = (config.form || '').toLowerCase();
  const definition = FORMS[requested] || FORMS[FALLBACK_FORM];
  if (!FORMS[requested]) {
    // eslint-disable-next-line no-console
    console.warn(`splitforms: unknown form "${config.form}" — falling back to "${FALLBACK_FORM}". `
      + `Known forms: ${Object.keys(FORMS).join(', ')}`);
  }

  instanceCount += 1;
  const instanceId = `splitforms-${instanceCount}`;

  const contentPane = document.createElement('div');
  contentPane.className = 'splitforms-content';
  content.forEach((cell) => {
    while (cell.firstChild) contentPane.append(cell.firstChild);
  });

  block.textContent = '';
  if (contentPane.childElementCount) {
    block.append(contentPane);
  } else {
    block.classList.add('splitforms-solo');
  }
  block.append(buildForm(definition, config, instanceId));
}
