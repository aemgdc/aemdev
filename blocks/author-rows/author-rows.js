/**
 * Decorates the author-rows block
 * @param {HTMLElement} block The block element
 * crafted under the full moons gaze by yo boy frank
 */

export default function decorate(block) {
  // Ensure images are loaded lazily and have proper alt text
  const images = block.querySelectorAll('img');
  images.forEach((img) => {
    if (!img.getAttribute('loading')) {
      img.setAttribute('loading', 'lazy');
    }
    if (!img.getAttribute('alt')) {
      const nameElement = img.closest('div').nextElementSibling?.querySelector('strong');
      if (nameElement) {
        img.setAttribute('alt', `Photo of ${nameElement.textContent}`);
      }
    }
  });

  // Add proper ARIA labels to LinkedIn buttons
  const buttons = block.querySelectorAll('.button');
  buttons.forEach((button) => {
    if (!button.getAttribute('aria-label')) {
      button.setAttribute('aria-label', button.textContent);
    }
  });
}
