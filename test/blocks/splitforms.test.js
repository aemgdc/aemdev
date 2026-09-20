import { expect } from '@esm-bundle/chai';
import sinon from 'sinon';
import decorate from '../../blocks/splitforms/splitforms.js';

/*
 * Two things here are worth more than the rest.
 *
 * `form_loaded_at` must be epoch milliseconds. An ISO 8601 string is accepted by
 * the API with HTTP 200 and `success: true`, and the submission is then silently
 * binned as bot traffic — the visitor sees the success state and the entry never
 * arrives. That failure is invisible from the browser, so it is pinned here.
 *
 * And `redirect-url` is author-supplied but applied by us via
 * `window.location.assign`, so a `javascript:` value has to be rejected before it
 * gets there.
 */

const row = (key, value) => `<div><div>${key}</div><div>${value}</div></div>`;
const legacyRow = (html) => `<div><div>${html}</div></div>`;

/**
 * A block in the shape AuthorKit leaves it: a section holding a
 * `.default-content` group of copy and a `.block-content` group of blocks.
 * The block reads and rearranges that structure, so the tests have to build it.
 */
function block(html, { copy = '', siblingBlock = false } = {}) {
  const section = document.createElement('div');
  section.className = 'section';
  if (copy) section.innerHTML = `<div class="default-content">${copy}</div>`;

  const group = document.createElement('div');
  group.className = 'block-content';

  const el = document.createElement('div');
  el.className = 'splitforms';
  el.innerHTML = html;
  group.append(el);
  if (siblingBlock) group.append(document.createElement('div'));

  section.append(group);
  document.body.append(section);
  return el;
}

const hiddenValue = (el, name) => el.querySelector(`input[type="hidden"][name="${name}"]`)?.value;

function stubSubmit(body = { success: true, message: 'Submission received' }, ok = true) {
  return sinon.stub(window, 'fetch').resolves({
    ok,
    status: ok ? 200 : 400,
    json: () => Promise.resolve(body),
  });
}

/** Submit and wait for the block's async handler to settle. */
async function submit(el) {
  el.querySelector('form').requestSubmit();
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  await new Promise((resolve) => { setTimeout(resolve, 0); });
}

describe('blocks/splitforms', () => {
  let fetchStub;

  afterEach(() => {
    fetchStub?.restore();
    fetchStub = null;
    document.querySelectorAll('body > .section').forEach((el) => el.remove());
  });

  describe('placement', () => {
    it('hoists the block to the top of its section and marks the section', () => {
      const el = block(row('form', 'contact'), { copy: '<h2>Join us</h2><p>Doors at six.</p>' });
      const section = el.closest('.section');
      decorate(el);

      // A float only shortens the line boxes that follow it, so the block has
      // to lead the section for the copy to flow beside the panel.
      expect(section.firstElementChild).to.equal(el);
      expect(section.classList.contains('splitforms-section')).to.be.true;
      expect(section.querySelector('.default-content').textContent).to.contain('Doors at six.');
    });

    it('clears away the group it was hoisted out of', () => {
      const el = block(row('form', 'contact'), { copy: '<p>Copy.</p>' });
      const section = el.closest('.section');
      decorate(el);

      expect(section.querySelector('.block-content')).to.not.exist;
    });

    it('leaves the group behind when another block is still in it', () => {
      const el = block(row('form', 'contact'), { copy: '<p>Copy.</p>', siblingBlock: true });
      const section = el.closest('.section');
      decorate(el);

      expect(section.querySelector('.block-content')).to.exist;
      expect(section.firstElementChild).to.equal(el);
    });

    it('goes solo when the section has no copy to flow beside the panel', () => {
      const el = block(row('form', 'contact'));
      decorate(el);

      expect(el.classList.contains('splitforms-solo')).to.be.true;
    });

    it('stays floated when the section has copy', () => {
      const el = block(row('form', 'contact'), { copy: '<p>Doors at six.</p>' });
      decorate(el);

      expect(el.classList.contains('splitforms-solo')).to.be.false;
    });

    it('renders without a section — a fragment or a preview still gets a form', () => {
      const el = document.createElement('div');
      el.className = 'splitforms';
      el.innerHTML = row('form', 'contact');
      document.body.append(el);
      decorate(el);

      expect(el.querySelector('.splitforms-panel')).to.exist;
      el.remove();
    });
  });

  describe('content model', () => {
    it('reads every two-cell row as config', () => {
      const el = block(row('form', 'contact'), { copy: '<p>Doors at six.</p>' });
      decorate(el);

      expect(el.querySelector('.splitforms-title').textContent).to.equal('Send us a message');
      expect(el.querySelector('.splitforms-content')).to.not.exist;
    });

    it('lifts a legacy one-cell content row out into the section', () => {
      const el = block(
        legacyRow('<h2>Join us</h2>') + legacyRow('<p>Doors at six.</p>') + row('form', 'contact'),
      );
      const section = el.closest('.section');
      decorate(el);

      // The copy is section copy now, not a pane inside the panel — and it
      // still counts as something for the form to float beside.
      const lifted = section.querySelector('.splitforms-legacy-copy');
      expect(lifted).to.exist;
      expect(lifted.previousElementSibling).to.equal(el);
      expect(lifted.classList.contains('default-content')).to.be.true;
      expect(lifted.querySelector('h2').textContent).to.equal('Join us');
      expect(lifted.querySelector('p').textContent).to.equal('Doors at six.');
      expect(el.contains(lifted)).to.be.false;
      expect(el.classList.contains('splitforms-solo')).to.be.false;
    });

    it('falls back to the contact form when the name is unknown', () => {
      const warn = sinon.stub(console, 'warn');
      const el = block(row('form', 'not-a-form'));
      decorate(el);
      warn.restore();

      expect(el.querySelector('.splitforms-title').textContent).to.equal('Send us a message');
      expect(warn.calledOnce).to.be.true;
    });

    it('builds each named form with its own fields', () => {
      const names = {
        contact: ['name', 'email', 'message'],
        'event-signup': ['name', 'email', 'organisation', 'access_needs', 'first_event'],
        subscribe: ['email', 'name'],
        'suggest-location': ['name', 'email', 'city', 'country', 'venue', 'can_help', 'why'],
      };

      Object.entries(names).forEach(([name, expected]) => {
        const el = block(row('form', name));
        decorate(el);
        const fields = [...el.querySelectorAll('.splitforms-field [name]')].map((f) => f.name);
        expect(fields, name).to.deep.equal(expected);
        el.remove();
      });
    });
  });

  describe('configuration', () => {
    it('maps reply-email to replyto and event-id to event_id', () => {
      const el = block(
        row('form', 'event-signup')
        + row('reply-email', 'hello@aemdev.org')
        + row('event-id', 'london-2026-10'),
      );
      decorate(el);

      expect(hiddenValue(el, 'replyto')).to.equal('hello@aemdev.org');
      expect(hiddenValue(el, 'event_id')).to.equal('london-2026-10');
    });

    it('strips the mailto: scheme the editor adds to an email cell', () => {
      const mailtoRow = '<div><div>reply-email</div><div><a href="mailto:hello@aemdev.org"></a></div></div>';
      const el = block(`${row('form', 'contact')}${mailtoRow}`);
      decorate(el);

      expect(hiddenValue(el, 'replyto')).to.equal('hello@aemdev.org');
    });

    it('honours access-key, submit-label and success overrides', async () => {
      fetchStub = stubSubmit();
      const el = block(
        row('form', 'contact')
        + row('access-key', 'custom-key')
        + row('submit-label', 'Fire away')
        + row('success', 'Got it, thanks.'),
      );
      decorate(el);

      expect(hiddenValue(el, 'access_key')).to.equal('custom-key');
      expect(el.querySelector('button[type="submit"]').textContent).to.equal('Fire away');

      el.querySelector('#splitforms-contact-name, [name="name"]').value = 'A';
      el.querySelector('[name="email"]').value = 'a@example.com';
      el.querySelector('[name="message"]').value = 'Hi';
      await submit(el);

      expect(el.querySelector('.splitforms-success').textContent).to.equal('Got it, thanks.');
    });
  });

  describe('event-signup options', () => {
    const fieldNames = (el) => [...el.querySelectorAll('.splitforms-field [name]')].map((f) => f.name);
    const build = (extra = '') => {
      const el = block(row('form', 'event-signup') + extra);
      decorate(el);
      return el;
    };

    it('keeps the dietary field unless it is turned off', () => {
      expect(fieldNames(build())).to.include('access_needs');
      expect(fieldNames(build(row('dietary', 'no')))).to.not.include('access_needs');
    });

    it('adds a places field only when asked', () => {
      expect(fieldNames(build())).to.not.include('places');
      expect(fieldNames(build(row('max-attendees', 'yes')))).to.include('places');
    });

    it('records a single-mode ticket type without asking the attendee', () => {
      const el = build(row('ticket-type', 'Virtual'));
      expect(fieldNames(el)).to.not.include('ticket_type');
      expect(hiddenValue(el, 'ticket_type')).to.equal('Virtual');
    });

    it('asks the attendee when the event runs both ways', () => {
      const el = build(row('ticket-type', 'Both'));
      expect(fieldNames(el)).to.include('ticket_type');
      expect(hiddenValue(el, 'ticket_type')).to.be.undefined;
    });

    it('accepts true/false and on/off as well as yes/no', () => {
      expect(fieldNames(build(row('max-attendees', 'true')))).to.include('places');
      expect(fieldNames(build(row('max-attendees', 'on')))).to.include('places');
      expect(fieldNames(build(row('dietary', 'false')))).to.not.include('access_needs');
    });

    it('leaves the defaults alone when a flag cell is empty or nonsense', () => {
      expect(fieldNames(build(row('dietary', '')))).to.include('access_needs');
      expect(fieldNames(build(row('dietary', 'perhaps')))).to.include('access_needs');
    });

    it('does not leak options between instances', () => {
      const trimmed = build(row('dietary', 'no'));
      const plain = build();
      expect(fieldNames(trimmed)).to.not.include('access_needs');
      expect(fieldNames(plain)).to.include('access_needs');
    });
  });

  describe('spam traps', () => {
    it('sends form_loaded_at as epoch milliseconds, not an ISO string', () => {
      const before = Date.now();
      const el = block(row('form', 'contact'));
      decorate(el);
      const after = Date.now();

      const value = hiddenValue(el, 'form_loaded_at');
      expect(value).to.match(/^\d+$/, 'must be digits only — an ISO string is silently binned');
      expect(Number(value)).to.be.within(before, after);
    });

    it('ships an empty, unchecked honeypot', () => {
      const el = block(row('form', 'contact'));
      decorate(el);

      const trap = el.querySelector('input[name="botcheck"]');
      expect(trap.checked).to.be.false;
      expect(trap.closest('.splitforms-trap').getAttribute('aria-hidden')).to.equal('true');
    });
  });

  describe('submission', () => {
    const fill = (el) => {
      el.querySelector('[name="name"]').value = 'Ada';
      el.querySelector('[name="email"]').value = 'ada@example.com';
      el.querySelector('[name="message"]').value = 'Hello';
    };

    it('replaces the form with the success message', async () => {
      fetchStub = stubSubmit();
      const el = block(row('form', 'contact'));
      decorate(el);
      fill(el);
      await submit(el);

      expect(el.querySelector('form')).to.not.exist;
      expect(el.querySelector('.splitforms-success')).to.exist;
      expect(fetchStub.firstCall.args[0]).to.equal('https://splitforms.com/api/submit');
      expect(fetchStub.firstCall.args[1].headers.Accept).to.equal('application/json');
    });

    it('keeps the form and shows the API message when the submit is rejected', async () => {
      fetchStub = stubSubmit({ success: false, message: 'Form inactive', code: 'inactive' }, false);
      const el = block(row('form', 'contact'));
      decorate(el);
      fill(el);
      await submit(el);

      expect(el.querySelector('form')).to.exist;
      expect(el.querySelector('.splitforms-status').textContent).to.equal('Form inactive');
      expect(el.querySelector('button[type="submit"]').disabled).to.be.false;
    });

    it('warns when the API accepts a submission but silently filters it', async () => {
      const warn = sinon.stub(console, 'warn');
      fetchStub = stubSubmit({ success: true });
      const el = block(row('form', 'contact'));
      decorate(el);
      fill(el);
      await submit(el);
      warn.restore();

      expect(warn.calledOnce).to.be.true;
      expect(warn.firstCall.args[0]).to.contain('silently filtered');
    });

    it('refuses a javascript: redirect and shows the inline success instead', async () => {
      fetchStub = stubSubmit();
      // eslint-disable-next-line no-script-url
      const el = block(row('form', 'contact') + row('redirect-url', 'javascript:alert(1)'));
      decorate(el);
      fill(el);
      await submit(el);

      expect(el.querySelector('.splitforms-success')).to.exist;
    });
  });
});
