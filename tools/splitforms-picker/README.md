# Splitforms Form Picker

A DA editor palette for placing a `splitforms` block: pick a form, set the
options that form offers, see the table you are about to get, insert it.

## Adding a form type

Edit **`form-catalog.js`**. That is the whole job — `splitforms-picker.js` knows
no form by name, only how to render option *types*, so a new entry appears in the
palette with no other change.

```js
{
  name: 'workshop-signup',          // must match the key in blocks/splitforms/splitforms.js
  label: 'Workshop sign-up',
  blurb: 'One line telling an author when to reach for this.',
  fields: ['Name', 'Email'],        // shown as chips, so they can see what they are placing
  options: [
    { key: 'seats', type: 'number', label: 'Seats' },
    ...COMMON,                      // reply-to, redirect, button text
  ],
}
```

Option types the picker renders:

| type | control | emits a row when |
|---|---|---|
| `text` | single-line input | non-empty |
| `number` | numeric input | non-empty |
| `choice` | segmented buttons | it differs from `default` |
| `switch` | checkbox | it differs from `default`, as `yes` / `no` |

An option only becomes a row when it says something the block does not already
assume, so the table an author gets back is the one they would have typed.

### The catalog checks itself against the block

On load the picker imports `FORM_NAMES` from `blocks/splitforms/splitforms.js`
and compares:

- a form **the block has and the catalog does not** → a warning naming it, because
  a form nobody can see is the kind of gap that never gets noticed
- a form **the catalog has and the block does not** → an error, because inserting
  it would silently fall back to the contact form

Keeping both lists correct is therefore a thing the tool tells you about rather
than a thing you have to remember.

## What it inserts — a table, not divs

A block has two shapes and they are not interchangeable:

| | shape |
|---|---|
| on disk, in DA | `<div class="splitforms"><div><div>form</div><div>…</div></div>…` |
| in the editor | `<table><tr><td colspan="2"><p>splitforms</p></td></tr>…` |

The editor converts between them on load and save, but **its paste parser only
recognises the table**. Sending the div form inserts nothing at all — and does it
silently, with the palette closing as though it had worked. That is worth knowing
because the div shape is the one you see if you read a document back through the
Source API, so it is the obvious wrong guess.

```html
<table><tbody>
  <tr><td colspan="2"><p>splitforms</p></td></tr>
  <tr><td colspan="2"><h2>…</h2><p>…</p></td></tr>
  <tr><td><p>form</p></td><td><p>event-signup</p></td></tr>
  <tr><td><p>event-id</p></td><td><p>berlin-2026-11</p></td></tr>
</tbody></table>
```

The name row and any content row span both columns; config rows are two cells;
every cell's text sits in a `<p>`. That is the shape a block already in a document
has, which is where it was read from.

## Event sign-up options are real, not decorative

`ticket-type`, `dietary` and `max-attendees` are read by the block's
`refine()` hook for `event-signup`:

| row | effect |
|---|---|
| `dietary` | `no` drops the dietary / access needs field. On by default. |
| `max-attendees` | `yes` adds a "How many places?" field for group bookings. |
| `ticket-type` | `In-person` or `Virtual` is recorded as a hidden field — the attendee has no choice to make. `Both` puts the question to them instead. |

Flags accept `yes/no`, `true/false`, `on/off`, `1/0`. Anything else, including a
blank cell, leaves the default alone.

## Files

| file | |
|---|---|
| `splitforms-picker.html` | palette entry point |
| `form-catalog.js` | **the file you edit** — form types and their options |
| `splitforms-picker.js` | rendering, preview, insert |
| `splitforms-picker.css` | skinned to DESIGN.md, the way bio-manager is |
| `register-picker.mjs` | add the palette row to the DA site config |

## Setting it up

Order matters. DA loads the palette HTML from the **live origin**, so the code has
to be deployed before the row is registered — otherwise every author gets an entry
that 404s. The dry run checks for this and says so.

```bash
# 1. deploy the branch carrying tools/splitforms-picker/

# 2. register the palette
node tools/splitforms-picker/register-picker.mjs          # dry run; reports if the path is not live
node tools/splitforms-picker/register-picker.mjs --apply

# any time after
node tools/splitforms-picker/register-picker.mjs --check  # is the row there, and does its path resolve?
```

The token comes from the usual chain — `DA_TOKEN`, then the S2S cache, then
`~/today-da-token.txt` (see `tools/tracker/da-token.mjs`).

Registration goes through `tools/lib/register-library-row.mjs`, which GETs the
live config, changes exactly one row of one sheet, PUTs it back, then re-reads and
diffs every sheet it did not mean to touch. A config API has no preview step, so
the read-back is the only evidence the write was stored.

## Developing it without DA

The palette blocks on a `postMessage` handshake from DA's parent frame, so opening
`splitforms-picker.html` directly renders nothing. To work on it locally, serve the
site (`aem up`) and drive the handshake from a scratch page:

```js
const ch = new MessageChannel();
ch.port2.onmessage = (e) => console.log(e.data);   // sendHTML lands here
iframe.contentWindow.postMessage(
  { ready: true, context: { org: 'aemgdc', repo: 'aemdev' } }, '*', [ch.port1],
);
```

That resolves the SDK and captures every action the palette emits, which is how
the inserted markup was verified.
