/**
 * Speakers — the bio roster for a page.
 *
 * Authoring, in precedence order:
 *
 *   1. Slugs in the block. Either shape works:
 *
 *        | Speakers |                            |
 *        | -------- | -------------------------- |
 *        | bios     | tad-reeves, laurel-timko   |
 *
 *        | Speakers                 |
 *        | ------------------------ |
 *        | tad-reeves               |
 *        | laurel-timko             |
 *
 *   2. Nothing in the block — it reads `<meta name="speakers">` from the page,
 *      which is the contract every `/en/meetups/*` page already follows
 *      (docs/adaptto-2026/content-model.md). So an empty block on a meetup
 *      page needs no authoring at all.
 *
 * Two layouts. The default is full-width rows on a carbon panel. The `bricks`
 * variant — `| Speakers (bricks) |` — is the card grid from `blocks/bio`,
 * recoloured for this panel's dark ground by the `--bio-*` properties bio.css
 * exposes; `blocks/bios` is the same grid on a light page.
 *
 * A bare slug resolves to `/en/fragments/bios/<slug>`; a token starting with
 * `/` is used verbatim, which is how another locale's bios get referenced.
 *
 * A slug with no document renders a visible "no bio yet" row rather than
 * vanishing — the orphan rule from content-model.md. That is deliberate: a
 * silently missing speaker is the failure nobody notices before publish.
 *
 * The slug grammar, the fetch, and the media-URL rewrite live in
 * `blocks/bio/roster.js`, shared with `bios` and `bio`.
 */

import { getConfig, loadStyle } from '../../scripts/ak.js';
import { buildBio, parseBio, renderBricks } from '../bio/bio.js';
import { loadRoster, missingBio, rosterSlugs } from '../bio/roster.js';

export default async function decorate(block) {
  const slugs = rosterSlugs(block);

  if (!slugs.length) {
    block.remove();
    return;
  }

  const { codeBase } = getConfig();
  const styles = loadStyle(`${codeBase}/blocks/bio/bio.css`);

  if (block.classList.contains('bricks')) {
    // Non-null: `renderBricks` returns null only for an empty roster, and the
    // guard above already left on that. Same `rosterSlugs` call, same answer.
    const grid = await renderBricks(block);
    await styles;
    block.replaceChildren(grid);
    block.classList.add('speakers-decorated');
    return;
  }

  const list = document.createElement('div');
  list.className = 'speakers-list';

  (await loadRoster(slugs)).forEach(({ slug, source }) => {
    const bio = source ? parseBio(source) : null;
    if (!bio?.name) {
      list.append(missingBio(slug, 'speakers-missing'));
      return;
    }
    const row = document.createElement('div');
    row.className = 'bio';
    row.append(buildBio(bio));
    list.append(row);
  });

  await styles;
  block.replaceChildren(list);
  block.classList.add('speakers-decorated');
}
