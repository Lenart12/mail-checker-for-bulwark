const api = globalThis.browser ?? chrome;

// Bulwark is one-pane below 768px, or below 600px in newer versions, and browsers cap popups at 800px.
const POPUP_WIDTHS = { compact: '599px', wide: '800px' };
const SLOW_LOAD_MS = 5000;
const RETRY_SECONDS = 15;
const REQUEST_REPORT_MS = 200;
const CANCELLED_ERRORS = ['net::ERR_ABORTED', 'NS_BINDING_ABORTED'];

api.storage.local.get(['base', 'background', 'icon', 'popupUrl', 'options']).then(({ base, background, icon, popupUrl, options }) => {
  document.documentElement.style.setProperty('--width', POPUP_WIDTHS[options?.overlaySize] ?? POPUP_WIDTHS.compact);
  // Before the first open there's no remembered colour yet, so follow the system.
  const systemBackground = matchMedia('(prefers-color-scheme: dark)').matches ? '#0a0a0a' : '#ffffff';
  document.documentElement.style.setProperty('--background', background ?? systemBackground);

  const loading = document.getElementById('loading');
  loading.src = icon ?? 'icon.png';
  loading.style.visibility = 'visible';

  const trouble = document.getElementById('trouble');
  const retry = document.getElementById('retry');
  const frame = document.getElementById('mail');
  const frameUrl = popupUrl ?? `${base}/mail`;
  let report = null; // What this load's request said: 'ok', 'failed' or 'worker'.
  let reloadedForWorker = false;
  let slowTimer;
  let countdown = null;

  const showTrouble = () => {
    trouble.textContent = `Having trouble connecting to ${new URL(base).host}`;
  };
  const stopCountdown = () => {
    clearInterval(countdown);
    countdown = null;
    retry.textContent = '';
  };
  const startCountdown = () => {
    showTrouble();
    if (countdown) return;
    let seconds = RETRY_SECONDS;
    retry.textContent = `Retrying in ${seconds}s`;
    countdown = setInterval(() => {
      seconds -= 1;
      if (seconds > 0) {
        retry.textContent = `Retrying in ${seconds}s`;
        return;
      }
      stopCountdown();
      retry.textContent = 'Retrying now';
      startLoad();
    }, 1000);
  };
  function startLoad() {
    report = null;
    // Once the server has answered, a slow page only gets the message: another try would cut it off.
    slowTimer = setTimeout(() => (report ? showTrouble() : startCountdown()), SLOW_LOAD_MS);
    frame.src = frameUrl;
  }
  const fail = () => {
    report = 'failed';
    clearTimeout(slowTimer);
    frame.classList.remove('loaded');
    startCountdown();
  };

  // A frame fires load for an error page too, and can't say which it got, so watch its request. Bulwark's service
  // worker can take the load over, which reports it as the worker's own request for the same address instead, and
  // browsers disagree on who started that. Pages Bulwark opens itself don't count, and neither does the hidden frame.
  const isOverlayLoad = (details) => (details.type === 'sub_frame'
    ? (details.originUrl ?? details.initiator)?.startsWith(location.origin) && !details.url.startsWith(`${base}/api/version`)
    : details.url === frameUrl);
  const requests = { urls: [`*://${new URL(base).hostname}/*`], types: ['sub_frame', 'xmlhttprequest'] };
  api.webRequest.onResponseStarted.addListener((details) => {
    if (!isOverlayLoad(details)) return;
    if (details.statusCode >= 400) {
      fail();
      return;
    }
    if (report) return; // A late answer can't undo a failure, but the next try can.
    report = details.type !== 'sub_frame' && !reloadedForWorker ? 'worker' : 'ok';
    stopCountdown();
  }, requests);
  api.webRequest.onErrorOccurred.addListener((details) => {
    if (isOverlayLoad(details) && !CANCELLED_ERRORS.includes(details.error)) fail();
  }, requests);

  // Hidden until loaded, so its blank white page never shows. The report can arrive just after load, so give it a moment.
  frame.addEventListener('load', async () => {
    if (!report) await new Promise((resolve) => setTimeout(resolve, REQUEST_REPORT_MS));
    if (report === 'failed') return;
    clearTimeout(slowTimer);
    if (report === 'worker') {
      // A worker that just started answers for the page, and framing rules can't touch that answer, so the browser
      // refuses to show it. Now it's awake, it leaves the next load alone.
      reloadedForWorker = true;
      startLoad();
      return;
    }
    report = 'ok';
    stopCountdown();
    trouble.textContent = '';
    frame.classList.add('loaded');
  });
  startLoad();
  // Used once: this makes that account the active one, so later opens stay on it.
  if (popupUrl) api.storage.local.set({ popupUrl: null, tabsBehind: true });
});
