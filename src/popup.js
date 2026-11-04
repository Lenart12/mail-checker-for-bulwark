const api = globalThis.browser ?? chrome;

// Bulwark is one-pane below 768px, or below 600px in newer versions, and browsers cap popups at 800px.
const POPUP_WIDTHS = { compact: '599px', wide: '800px' };

api.storage.local.get(['base', 'background', 'icon', 'popupUrl', 'options']).then(({ base, background, icon, popupUrl, options }) => {
  document.documentElement.style.setProperty('--width', POPUP_WIDTHS[options?.overlaySize] ?? POPUP_WIDTHS.compact);
  // Before the first open there's no remembered colour yet, so follow the system.
  const systemBackground = matchMedia('(prefers-color-scheme: dark)').matches ? '#0a0a0a' : '#ffffff';
  document.documentElement.style.setProperty('--background', background ?? systemBackground);

  const loading = document.getElementById('loading');
  loading.src = icon ?? 'icon.png';
  loading.style.visibility = 'visible';

  const frame = document.getElementById('mail');
  // Hidden until loaded, so its blank white page never shows.
  frame.addEventListener('load', () => frame.classList.add('loaded'), { once: true });
  frame.src = popupUrl ?? `${base}/mail`;
  // Used once: this makes that account the active one, so later opens stay on it.
  if (popupUrl) api.storage.local.set({ popupUrl: null, tabsBehind: true });
});
