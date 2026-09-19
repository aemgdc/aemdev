/* --------------------------------------------------------------------------
 * Splitforms picker — the catalog.
 *
 * THIS IS THE FILE YOU EDIT TO ADD A FORM TYPE. Nothing in splitforms-picker.js
 * knows any form by name: it renders whatever this file declares, and every
 * option below turns into one `key | value` row of the block table.
 *
 * To add a form: append an entry whose `name` matches the form's key in
 * blocks/splitforms/splitforms.js, list the fields it renders so authors can see
 * what they are placing, and give it whatever options make sense. The picker
 * cross-checks these names against the block at load time and says so when the
 * two drift apart, so a form added to the block but not here is visible rather
 * than silently missing.
 * ------------------------------------------------------------------------ */

/**
 * Options every form gets. Kept separate so a new form picks them up for free
 * rather than restating them and drifting.
 */
const COMMON = [
  {
    key: 'reply-email',
    type: 'text',
    label: 'Reply-to address',
    placeholder: 'hello@aemdev.org',
    hint: 'Where replies go. Sets the notification Reply-To.',
  },
  {
    key: 'redirect-url',
    type: 'text',
    label: 'Redirect URL',
    placeholder: '/en/thank-you',
    hint: 'Sent here after a successful submit. Leave blank to show an inline confirmation instead.',
  },
  {
    key: 'submit-label',
    type: 'text',
    label: 'Button text',
    placeholder: 'Leave blank for the form default',
  },
];

/**
 * Option types the picker knows how to render:
 *
 *   text    single-line input           -> emits the row when non-empty
 *   number  numeric input               -> emits the row when non-empty
 *   choice  segmented button group      -> emits the row unless it equals `default`
 *   switch  checkbox                    -> emits `key | yes|no` when it differs from `default`
 *
 * An option only emits a row when it says something the block does not already
 * assume, which keeps the generated table as short as an author would write it.
 */
export const FORMS = [
  {
    name: 'event-signup',
    label: 'Event sign-up',
    blurb: 'Registration for one meetup. Stamps every submission with the event id so entries can be told apart.',
    fields: ['Name', 'Email', 'Organisation', 'First event?'],
    options: [
      {
        key: 'event-id',
        type: 'text',
        label: 'Event ID',
        placeholder: 'london-2026-10',
        hint: 'Recorded on every submission. Use one id per event.',
      },
      {
        key: 'ticket-type',
        type: 'choice',
        label: 'Ticket type',
        choices: ['In-person', 'Virtual', 'Both'],
        default: 'In-person',
        hint: 'Both adds a chooser to the form; the other two record the type silently.',
      },
      {
        key: 'dietary',
        type: 'switch',
        label: 'Dietary / access requirements field',
        default: true,
      },
      {
        key: 'max-attendees',
        type: 'switch',
        label: 'Number of places field',
        default: false,
        hint: 'Lets one person book for a group.',
      },
      ...COMMON,
    ],
  },
  {
    name: 'contact',
    label: 'Contact',
    blurb: 'Name, email, message. The stock enquiry form for a contact page.',
    fields: ['Name', 'Email', 'Message'],
    options: [...COMMON],
  },
  {
    name: 'subscribe',
    label: 'Subscribe',
    blurb: 'Lowest-friction signup there is — an email address and an optional name.',
    fields: ['Email', 'Name (optional)'],
    options: [...COMMON],
  },
  {
    name: 'join-the-collective',
    label: 'Join the collective',
    blurb: 'Membership signup. Asks where someone is based and how they want to be involved.',
    fields: ['Name', 'Email', 'City', 'Organisation', 'Role', 'Involvement', 'About'],
    options: [...COMMON],
  },
  {
    name: 'buy-me-a-coffee',
    label: 'Buy a coffee',
    blurb: 'Records an intention to chip in. Takes no payment — someone follows up by email.',
    fields: ['Name', 'Email', 'Amount', 'Note'],
    options: [...COMMON],
  },
  {
    name: 'suggest-location',
    label: 'Suggest a location',
    blurb: 'Collects a city, a reason, and whether the sender can help make it happen.',
    fields: ['Name', 'Email', 'City', 'Country', 'Venue', 'Can help?', 'Why there?'],
    options: [...COMMON],
  },
];

export const byName = (name) => FORMS.find((f) => f.name === name);

/** The value an option carries before the author touches anything. */
export function defaultValue(option) {
  if (option.type === 'switch') return option.default === true;
  if (option.type === 'choice') return option.default ?? option.choices[0];
  return '';
}

/**
 * Does this option say anything the block does not already assume? Only those
 * become rows, so the table an author gets back is the one they would have
 * typed by hand.
 */
export function isMeaningful(option, value) {
  if (option.type === 'switch') return value !== (option.default === true);
  if (option.type === 'choice') return value !== (option.default ?? option.choices[0]);
  return String(value ?? '').trim() !== '';
}

/** The cell value written into the block table for an option. */
export function cellValue(option, value) {
  if (option.type === 'switch') return value ? 'yes' : 'no';
  return String(value).trim();
}
