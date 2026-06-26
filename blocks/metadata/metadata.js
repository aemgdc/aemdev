export default function init(el) {
  const rows = el.querySelectorAll(':scope > div');
  rows.forEach((row) => {
    if (row.children.length < 2) return;
    const key = row.children[0].textContent.trim();
    const val = row.children[1].textContent.trim();
    if (!key) return;
    const attr = key.includes(':') ? 'property' : 'name';
    let meta = document.head.querySelector(`meta[${attr}="${key}"]`);
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute(attr, key);
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', val);
  });
  const section = el.closest('.section');
  el.remove();
  if (section && !section.textContent.trim()) section.remove();
}
