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
  let failed = false;
  let answered = false;
  let slowTimer;
  let countdown = null;
  let requestReported;
  let requestReport;

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
    failed = false;
    answered = false;
    requestReport = new Promise((resolve) => {
      requestReported = resolve;
    });
    // Once the server has answered, a slow page only gets the message: another try would cut it off.
    slowTimer = setTimeout(() => (answered ? showTrouble() : startCountdown()), SLOW_LOAD_MS);
    frame.src = frameUrl;
  }
  const fail = () => {
    failed = true;
    clearTimeout(slowTimer);
    requestReported();
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
  api.webRequest.onCompleted.addListener((details) => {
    if (!isOverlayLoad(details)) return;
    if (details.statusCode >= 400) {
      fail();
      return;
    }
    answered = true;
    stopCountdown();
    requestReported();
  }, requests);
  api.webRequest.onErrorOccurred.addListener((details) => {
    if (isOverlayLoad(details) && !CANCELLED_ERRORS.includes(details.error)) fail();
  }, requests);

  // Hidden until loaded, so its blank white page never shows. The report can arrive just after load, so give it a moment.
  frame.addEventListener('load', async () => {
    await Promise.race([requestReport, new Promise((resolve) => setTimeout(resolve, REQUEST_REPORT_MS))]);
    if (failed) return;
    clearTimeout(slowTimer);
    stopCountdown();
    trouble.textContent = '';
    frame.classList.add('loaded');
  });
  startLoad();
  // Used once: this makes that account the active one, so later opens stay on it.
  if (popupUrl) api.storage.local.set({ popupUrl: null, tabsBehind: true });
});
