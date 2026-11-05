const api = globalThis.browser ?? chrome;

// Bulwark is one-pane below 768px, or below 600px in newer versions, and browsers cap popups at 800px.
const POPUP_WIDTHS = { compact: '599px', wide: '800px' };
const SLOW_LOAD_MS = 5000;
const RETRY_SECONDS = 15;
const REQUEST_REPORT_MS = 200;
const CANCELLED_ERRORS = ['net::ERR_ABORTED', 'NS_BINDING_ABORTED'];

function watchLoad(base, frameUrl) {
  const loading = document.getElementById('loading');
  const trouble = document.getElementById('trouble');
  const retry = document.getElementById('retry');
  const openTab = document.getElementById('open-tab');
  const frame = document.getElementById('mail');
  openTab.href = frameUrl;
  let report = null; // What this load's request said: 'ok', 'failed', 'worker' or 'offline'.
  let workerAwake = false;
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
  const startLoad = () => {
    report = null;
    // Once the server has answered, a slow page only gets the message: another try would cut it off.
    slowTimer = setTimeout(() => (report ? showTrouble() : startCountdown()), SLOW_LOAD_MS);
    frame.src = frameUrl;
  };
  const startCountdown = () => {
    showTrouble();
    openTab.hidden = false;
    if (countdown) return;
    let seconds = RETRY_SECONDS;
    const tick = () => {
      if (seconds > 0) {
        retry.textContent = `Retrying in ${seconds}s`;
        seconds -= 1;
        return;
      }
      stopCountdown();
      retry.textContent = 'Retrying now';
      workerAwake = false;
      startLoad();
    };
    tick();
    countdown = setInterval(tick, 1000);
  };
  // Offline mode has the worker answer every load, so the browser will always refuse to show the page here.
  // A tab can show it, and the saved copy too if the server is down.
  const showOfflineNotice = () => {
    report = 'offline';
    clearTimeout(slowTimer);
    stopCountdown();
    frame.classList.remove('loaded');
    loading.style.animation = 'none';
    trouble.textContent = 'Bulwark\'s Offline mode keeps mail out of this overlay';
    openTab.hidden = false;
  };
  const fail = () => {
    report = 'failed';
    clearTimeout(slowTimer);
    frame.classList.remove('loaded');
    startCountdown();
  };

  // A frame fires load for error pages too, so watch its request. Bulwark's service worker can take the load over,
  // which shows up as the worker's own request for the same address, and browsers disagree on who started it.
  // Pages Bulwark opens itself and the hidden frame don't count.
  const isOverlayLoad = (details) => (details.type === 'sub_frame'
    ? (details.originUrl ?? details.initiator)?.startsWith(location.origin) && !details.url.startsWith(`${base}/api/version`)
    : details.url === frameUrl);
  const requestFilter = { urls: [`*://${new URL(base).hostname}/*`], types: ['sub_frame', 'xmlhttprequest'] };
  api.webRequest.onResponseStarted.addListener((details) => {
    if (!isOverlayLoad(details) || report === 'offline') return;
    if (details.statusCode >= 400) {
      fail();
      return;
    }
    if (report) return; // A late answer can't undo a failure, but the next try can.
    if (details.type !== 'sub_frame' && workerAwake) {
      showOfflineNotice();
      return;
    }
    report = details.type === 'sub_frame' ? 'ok' : 'worker';
    stopCountdown();
  }, requestFilter);
  api.webRequest.onErrorOccurred.addListener((details) => {
    if (isOverlayLoad(details) && report !== 'offline' && !CANCELLED_ERRORS.includes(details.error)) fail();
  }, requestFilter);

  // Hidden until loaded, so its blank white page never shows. The report can arrive just after load, so give it a moment.
  frame.addEventListener('load', async () => {
    if (!report) await new Promise((resolve) => setTimeout(resolve, REQUEST_REPORT_MS));
    if (report === 'failed' || report === 'offline') return;
    clearTimeout(slowTimer);
    if (report === 'worker') {
      // A worker that just started answers for the page, and framing rules can't touch that answer, so the browser
      // refuses to show it. Now it's awake, it leaves the next load alone, unless Offline mode is on.
      workerAwake = true;
      startLoad();
      return;
    }
    report = 'ok';
    openTab.hidden = true;
    trouble.textContent = '';
    stopCountdown();
    frame.classList.add('loaded');
  });
  startLoad();
}

api.storage.local.get(['base', 'background', 'icon', 'popupUrl', 'options']).then(({ base, background, icon, popupUrl, options }) => {
  document.documentElement.style.setProperty('--width', POPUP_WIDTHS[options?.overlaySize] ?? POPUP_WIDTHS.compact);
  // Before the first open there's no remembered colour yet, so follow the system.
  const systemBackground = matchMedia('(prefers-color-scheme: dark)').matches ? '#0a0a0a' : '#ffffff';
  document.documentElement.style.setProperty('--background', background ?? systemBackground);

  const loading = document.getElementById('loading');
  loading.src = icon ?? 'icon.png';
  loading.style.visibility = 'visible';

  watchLoad(base, popupUrl ?? `${base}/mail`);
  // Used once: this makes that account the active one, so later opens stay on it.
  if (popupUrl) api.storage.local.set({ popupUrl: null, tabsBehind: true });
});
