const GA_IDS = ['G-8HTDEY6V7P', 'G-Q8BQNWZ0YL'];

const script = document.createElement('script');
script.async = true;
script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_IDS[0]}`;
document.head.appendChild(script);

window.dataLayer = window.dataLayer || [];
function gtag() { window.dataLayer.push(arguments); }
window.gtag = gtag;
gtag('js', new Date());
GA_IDS.forEach((id) => gtag('config', id));
