const CLARITY_PROJECT_ID = 'wy8wbyalc4';

if (!window.clarity) {
  window.clarity = function clarity() {
    (window.clarity.q = window.clarity.q || []).push(arguments);
  };
}

if (!document.querySelector(`script[src="https://www.clarity.ms/tag/${CLARITY_PROJECT_ID}"]`)) {
  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.clarity.ms/tag/${CLARITY_PROJECT_ID}`;
  document.head.append(script);
}