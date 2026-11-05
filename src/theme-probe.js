// Runs in the overlay's mail frame. Remembers the page's real background for the next overlay's loading screen.
(() => {
  if (window.parent === window) return;

  const api = globalThis.browser ?? chrome;
  let last;
  const remember = () => {
    const background = getComputedStyle(document.documentElement).getPropertyValue('--color-background').trim();
    // Only a colour: anything else, such as url(), would load from elsewhere in the overlay.
    if (!background || background === last || !CSS.supports('color', background)) return;
    last = background;
    api.storage.local.set({ background });
  };

  // Scripts match every port of the host, because match patterns can't name one. Only the saved address counts.
  api.storage.local.get('base').then(({ base }) => {
    if (!location.href.startsWith(`${base}/`)) return;
    // Switching to an account with another theme changes these after load.
    const observer = new MutationObserver(remember);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
    observer.observe(document.head, { childList: true });
    remember();
  });
})();
