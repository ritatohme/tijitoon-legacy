// Runs in <head> BEFORE styles.css loads, so it can't read the --paper CSS
// variable yet. The dark background color is therefore hardcoded here on
// purpose — this is the single source for it; theme.js reads the rest from CSS.
// Its job: apply the saved theme and set theme-color before first paint, so a
// returning dark-mode user never sees a white status-bar flash on load.
// Also self-contained on purpose: no shared.js dependency (it isn't loaded yet).
(() => {
  const DARK_BG = '#242830'; // keep in sync with --paper in styles.css [data-theme="dark"]
  const saved = localStorage.getItem('tijitoon_theme');
  if (saved) document.documentElement.dataset.theme = saved;
  if (saved === 'dark') {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', DARK_BG);
  }
})();
