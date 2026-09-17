/**
 * Bios — this page's roster of bios, as bricks.
 *
 * The unambiguous name for the brick roster. Authoring is nothing:
 *
 *   | Bios |          →  the page's `speakers` metadata, one brick each
 *
 * or an explicit list, when the page has no `speakers` metadata or wants a
 * different set from it:
 *
 *   | Bios                     |
 *   | ------------------------ |
 *   | tad-reeves               |
 *   | greg-dimeris             |
 *   | shashi-mulugu            |
 *
 * A bare slug resolves to `/en/fragments/bios/<slug>`; a token starting with `/`
 * is used verbatim, which is how another locale's bios get referenced. A slug
 * with no document renders a visible "no bio yet" brick rather than vanishing.
 *
 * Everything it renders is `blocks/bio`: `renderBricks` there builds the grid and
 * bio.css styles it, so a bio in a brick and a bio on its own page are the same
 * component. This file is the block name, the stylesheet it needs, and nothing
 * else — deliberately, because the moment it grows its own renderer the two
 * start to drift.
 *
 * Related: `blocks/speakers` renders the same roster as full-width rows on a
 * carbon panel (and as bricks with the `bricks` variant); an empty `blocks/bio`
 * falls back to this same grid, which is what makes an already-authored empty
 * `bio` block under a "Speakers" heading render the roster.
 */

import { getConfig, loadStyle } from '../../scripts/ak.js';
import { renderBricks } from '../bio/bio.js';

export default async function decorate(block) {
  const { codeBase } = getConfig();
  // The bricks are styled by bio.css, not by bios.css — loadBlock only fetches
  // the stylesheet named after the block, so this one has to be asked for.
  const styles = loadStyle(`${codeBase}/blocks/bio/bio.css`);

  const grid = await renderBricks(block);
  if (!grid) {
    block.remove();
    return;
  }

  await styles;
  block.replaceChildren(grid);
  block.classList.add('bios-decorated');
}
