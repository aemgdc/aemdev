/* A link is "on its own line" when nothing else shares its paragraph or list
   item, so inline mentions of a video or a post stay links. Compare text rather
   than child count: a formatting wrapper (a bolded link, say) adds an element but
   no text of its own, and shouldn't stop the line counting as the link's alone.

   Shared by every auto-blocking embed, because the authoring rule is the same for
   all of them: a URL left alone on a line becomes the thing it points at.
   @param {HTMLAnchorElement} a the auto-blocked link
   @returns {boolean} true when the link is the only content of its line */
export default function isOwnLine(a) {
  const line = a.closest('p, li');
  return !!line && line.textContent.trim() === a.textContent.trim();
}
