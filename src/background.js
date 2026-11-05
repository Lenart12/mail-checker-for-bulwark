// Runs in Firefox's background page, or as Chromium's service worker, which can restart at any time.
const api = globalThis.browser ?? chrome;
const action = api.action ?? api.browserAction;
const RULE_ID = 1;
const MAX_SEPARATE_NOTIFICATIONS = 3;
const CUE_GAP_MS = 3000; // Each account alerts on its own, so at startup they arrive together.
const BADGE_COLOR = '#d93025';
const BADGE_PARTIAL_COLOR = '#b45309';
const BADGE_CONNECTING_COLOR = '#6b7280';
const DEFAULT_OPTIONS = {
  notificationContent: 'full',
  overlaySize: 'compact',
  iconClick: 'overlay',
  wiggle: true,
  volume: 30,
};
const ICON_SIZE = 64;
const ICON_STORED_SIZE = 128;
const ICON_RECHECK_MS = 24 * 60 * 60 * 1000;
const ICON_RETRY_MS = 60 * 60 * 1000;

async function getOptions() {
  return { ...DEFAULT_OPTIONS, ...(await api.storage.local.get('options')).options };
}

// Firefox's match patterns can't carry a port, so all of a host's ports match. The scripts check the saved address.
function matchPattern(base, path) {
  const url = new URL(base);
  return `${url.protocol}//${url.hostname}${url.pathname.replace(/\/$/, '')}${path}`;
}

// Only frames this extension opens lose these headers; normal tabs keep them. It matches on initiator, so frames
// Bulwark opens inside the overlay keep theirs, which is why plugin frames fail there. The hidden frame needs this
// too: Bulwark's API routes send X-Frame-Options: DENY.
function allowFraming(base) {
  return api.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_ID],
    addRules: [{
      id: RULE_ID,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          { header: 'content-security-policy', operation: 'remove' },
          { header: 'x-frame-options', operation: 'remove' },
        ],
      },
      condition: {
        initiatorDomains: [new URL(api.runtime.getURL('')).host],
        requestDomains: [new URL(base).hostname],
        resourceTypes: ['sub_frame'],
      },
    }],
  });
}

async function registerScripts(base) {
  const scripts = [
    { id: 'bridge', matches: [matchPattern(base, '/api/version*')], file: 'bridge.js' },
    { id: 'theme-probe', matches: [matchPattern(base, '/mail*'), matchPattern(base, '/*/mail*')], file: 'theme-probe.js' },
  ];
  const ids = scripts.map((script) => script.id);
  const current = await api.scripting.getRegisteredContentScripts({ ids });
  const upToDate = scripts.every(({ id, matches }) => current.find((script) => script.id === id)?.matches.includes(matches[0]));
  if (upToDate) return;
  await api.scripting.unregisterContentScripts({ ids: current.map((script) => script.id) });
  await api.scripting.registerContentScripts(scripts.map(({ id, matches, file }) => ({
    id,
    matches,
    js: [file],
    allFrames: true,
    runAt: 'document_idle',
  })));
}

async function startWatcher(base) {
  if (globalThis.loadWatcher) {
    loadWatcher(base);
    return;
  }
  if (await api.offscreen.hasDocument()) return;
  await api.offscreen.createDocument({
    url: `host.html?base=${encodeURIComponent(base)}`,
    reasons: ['IFRAME_SCRIPTING', 'AUDIO_PLAYBACK'],
    justification: 'Keeps the new mail connection open and plays the alert sound.',
  }).catch(async (error) => {
    // Another wake-up of this worker getting there first is fine.
    if (!(await api.offscreen.hasDocument())) throw error;
  });
}

// With no popup set, a click goes to action.onClicked instead.
async function applyClickAction() {
  const { base } = await api.storage.local.get('base');
  const { iconClick } = await getOptions();
  await action.setPopup({ popup: base && iconClick === 'overlay' ? 'popup.html' : '' });
}

// One at a time: in Firefox, overlapping runs registered the content scripts twice, and every mail alerted twice.
let startQueue = Promise.resolve();
function start() {
  startQueue = startQueue.catch(() => {}).then(applySettings);
  return startQueue;
}

async function applySettings() {
  const { base } = await api.storage.local.get('base');
  await applyClickAction();
  if (!base) {
    await showRestingIcon();
    return;
  }
  await allowFraming(base);
  await registerScripts(base);
  await startWatcher(base);
  await updateIcon(base);
}

function describeProblem({ username, problem, detail }) {
  return problem === 'logged-out' ? `Not logged in: ${username}` : `Can't reach mail: ${username} (${detail})`;
}

async function showStatus({ status, unread, problems = [] }) {
  const shown = {
    ok: { text: unread > 999 ? '999+' : unread ? String(unread) : '', title: unread ? 'Mail Checker for Bulwark' : 'No unread mail' },
    connecting: { text: '…', title: 'Connecting…', color: BADGE_CONNECTING_COLOR },
    'logged-out': { text: '?', title: 'Not logged in. Click to log in to Bulwark.' },
    error: { text: '!', title: 'Can\'t reach your mail. Retrying.' },
  }[status];
  // Some accounts still work: keep their count, and say which ones don't.
  const partial = status === 'ok' && problems.length > 0;
  action.setBadgeBackgroundColor({ color: partial ? BADGE_PARTIAL_COLOR : shown.color ?? BADGE_COLOR });
  action.setBadgeText({ text: shown.text || (partial ? '!' : '') });
  action.setTitle({ title: problems.length ? problems.map(describeProblem).join('\n') : shown.title });

  const idle = status !== 'ok' || !unread;
  if (idle === (await api.storage.local.get('idle')).idle) return;
  await api.storage.local.set({ idle });
  if (!wiggling) await showRestingIcon();
}

async function iconUrl() {
  return (await api.storage.local.get('icon')).icon ?? api.runtime.getURL('icon.png');
}

async function iconCanvas() {
  const image = await createImageBitmap(await (await fetch(await iconUrl())).blob());
  const ctx = new OffscreenCanvas(ICON_SIZE, ICON_SIZE).getContext('2d', { willReadFrequently: true });
  return { image, ctx };
}

// Plain greyscale turns mid-tone icons dark, which vanishes on a dark toolbar.
// This lighter range stays readable on dark and light toolbars, for any icon.
function toIdleGrey(data) {
  for (let i = 0; i < data.length; i += 4) {
    const luminance = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    data[i] = data[i + 1] = data[i + 2] = 110 + luminance * 0.5;
  }
}

function drawIcon({ image, ctx }, angle, idle) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ICON_SIZE, ICON_SIZE);
  ctx.translate(ICON_SIZE / 2, ICON_SIZE / 2);
  ctx.rotate(angle);
  ctx.drawImage(image, -ICON_SIZE / 2, -ICON_SIZE / 2, ICON_SIZE, ICON_SIZE);
  const pixels = ctx.getImageData(0, 0, ICON_SIZE, ICON_SIZE);
  if (idle) toIdleGrey(pixels.data);
  return action.setIcon({ imageData: { [ICON_SIZE]: pixels } });
}

// Grey until connected with unread mail.
async function showRestingIcon() {
  const { idle = true } = await api.storage.local.get('idle');
  await drawIcon(await iconCanvas(), 0, idle);
}

// The web app manifest points at the instance's branded icon, always as a PNG.
async function fetchInstanceIcon(base) {
  const manifest = await (await fetch(`${base}/manifest.webmanifest`, { credentials: 'omit' })).json();
  const { src } = manifest.icons.find((icon) => icon.purpose === 'any');
  const res = await fetch(new URL(src, base), { credentials: 'omit' });
  const image = await createImageBitmap(await res.blob());
  const canvas = new OffscreenCanvas(ICON_STORED_SIZE, ICON_STORED_SIZE);
  canvas.getContext('2d').drawImage(image, 0, 0, ICON_STORED_SIZE, ICON_STORED_SIZE);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function updateIcon(base) {
  const { iconBase, iconCheckedAt = 0 } = await api.storage.local.get(['iconBase', 'iconCheckedAt']);
  if (iconBase !== base || Date.now() - iconCheckedAt > ICON_RECHECK_MS) {
    const icon = await fetchInstanceIcon(base).catch(() => null);
    // A failure is remembered too, or Chromium would fetch again every minute. A new address drops the old icon.
    await api.storage.local.set({
      iconBase: base,
      iconCheckedAt: Date.now() - (icon ? 0 : ICON_RECHECK_MS - ICON_RETRY_MS),
      ...(icon ? { icon } : {}),
    });
    if (!icon && iconBase !== base) await api.storage.local.remove('icon');
  }
  if (!wiggling) await showRestingIcon();
}

let wiggling = false;
async function wiggle() {
  if (wiggling) return;
  wiggling = true;
  const frames = 24;
  try {
    const canvas = await iconCanvas();
    for (let i = 0; i <= frames; i++) {
      const progress = i / frames;
      await drawIcon(canvas, Math.sin(progress * Math.PI * 6) * 0.3 * (1 - progress), false);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  } finally {
    wiggling = false;
  }
  await showRestingIcon();
}

// Only set with more than one account. It goes in the message because Firefox notifications have just a title and a message.
function recipient(mail) {
  return mail.username ? `To: ${mail.username}\n` : '';
}

// Newest first, each sender once: "From Ana, Bob and 2 others".
function senders(mail) {
  const names = [...new Set(mail.map((m) => m.from).reverse())];
  if (names.length <= 2) return `From ${names.join(' and ')}`;
  const rest = names.length - 2;
  return `From ${names[0]}, ${names[1]} and ${rest} other${rest === 1 ? '' : 's'}`;
}

function notifications(mail, inboxUrl, content) {
  if (content === 'off') return [];
  if (mail.length > MAX_SEPARATE_NOTIFICATIONS) {
    const title = `${mail.length} new messages`;
    if (content === 'minimal') return [{ url: inboxUrl, title, message: '' }];
    return [{ url: inboxUrl, title, message: `${recipient(mail[0])}${senders(mail)}` }];
  }
  return mail.map((m) => {
    if (content === 'minimal') return { url: m.url, title: 'New mail', message: '' };
    const preview = content === 'full' ? `\n${m.preview}` : '';
    return { url: m.url, title: m.from, message: `${recipient(m)}${m.subject}${preview}` };
  });
}

async function tabCanAlert(tab) {
  try {
    const [{ result }] = await api.scripting.executeScript({ target: { tabId: tab.id }, files: ['tab-can-alert.js'] });
    return result === true;
  } catch {
    return false; // An unloaded tab can't play anything either.
  }
}

// An open tab plays its own sound only for the account it shows. Tabs don't follow an account
// switch made in the overlay until they reload, so after one the saved active account can't say
// which that is: a sound played twice is better than a missed one.
async function tabPlaysSound(base, tabMayAlert) {
  const tabs = await api.tabs.query({ url: matchPattern(base, '/*') });
  const { tabsBehind } = await api.storage.local.get('tabsBehind');
  if (!tabs.length && tabsBehind) await api.storage.local.remove('tabsBehind');
  if (!tabMayAlert || tabsBehind) return false;
  return (await Promise.all(tabs.map(tabCanAlert))).includes(true);
}

let lastWiggle = 0;
let lastSound = 0;
async function alertMail({ mail, base, sound, isActiveAccount, tabMayAlert, inboxUrl, reducedMotion }) {
  const options = await getOptions();
  // The next overlay or tab opens the account this mail is for.
  await api.storage.local.set({ popupUrl: isActiveAccount ? null : inboxUrl });
  const icon = await iconUrl();
  for (const { url, title, message } of notifications(mail, inboxUrl, options.notificationContent)) {
    // The id carries the link, so a click still works after this worker restarts.
    api.notifications.create(url, { type: 'basic', iconUrl: icon, title, message });
  }
  if (options.wiggle && !reducedMotion && Date.now() - lastWiggle >= CUE_GAP_MS) {
    lastWiggle = Date.now();
    wiggle();
  }
  if (sound && options.volume > 0 && !(await tabPlaysSound(base, tabMayAlert)) && Date.now() - lastSound >= CUE_GAP_MS) {
    lastSound = Date.now();
    const url = `${base}/notification/${sound}`;
    const volume = options.volume / 100;
    if (globalThis.playSound) playSound(url, volume);
    else api.runtime.sendMessage({ play: url, volume }).catch(() => {});
  }
}

// The settings page lists these; only the bridge can read Bulwark's accounts.
async function rememberAccounts(accounts) {
  const { accounts: known } = await api.storage.local.get('accounts');
  if (JSON.stringify(known) !== JSON.stringify(accounts)) await api.storage.local.set({ accounts });
}

function handleMessage(msg) {
  if (msg.status) showStatus(msg);
  if (msg.mail) alertMail(msg);
  if (msg.accounts) rememberAccounts(msg.accounts);
}

api.runtime.onMessage.addListener(handleMessage);

function openSettings() {
  return api.tabs.create({ url: api.runtime.getURL('options.html?tab') });
}

api.runtime.onInstalled.addListener(async () => {
  if (!(await api.storage.local.get('base')).base) openSettings();
});

// Only fires when no popup is set: not connected yet, or the option to open a tab.
action.onClicked.addListener(async () => {
  const { base, popupUrl } = await api.storage.local.get(['base', 'popupUrl']);
  if (!base) {
    openSettings();
    return;
  }
  if (popupUrl) await api.storage.local.set({ popupUrl: null, tabsBehind: true });
  const [tab] = await api.tabs.query({ url: matchPattern(base, '/*') });
  if (!tab) {
    api.tabs.create({ url: popupUrl ?? `${base}/mail` });
    return;
  }
  // An open tab keeps what's in it, unless new mail for another account needs it.
  api.tabs.update(tab.id, { active: true, ...(popupUrl ? { url: popupUrl } : {}) });
  api.windows.update(tab.windowId, { focused: true });
});

const MENU_ITEMS = {
  open: 'Open mail',
  compose: 'New message',
  refresh: 'Check for new mail',
  'mark-read': 'Mark Inbox as read',
  settings: 'Settings',
};
for (const [id, title] of Object.entries(MENU_ITEMS)) {
  api.contextMenus.create(
    { id, title, contexts: [api.action ? 'action' : 'browser_action'] },
    () => void api.runtime.lastError, // Chromium keeps the entries across worker restarts, so these report a duplicate id.
  );
}

api.contextMenus.onClicked.addListener(async ({ menuItemId }) => {
  const { base } = await api.storage.local.get('base');
  if (menuItemId === 'settings' || !base) openSettings();
  else if (menuItemId === 'open') api.tabs.create({ url: `${base}/mail` });
  // Bulwark's mailto route: an empty address opens a blank message, and fallback=1 keeps it in this tab.
  else if (menuItemId === 'compose') api.tabs.create({ url: `${base}/protocol/mailto?url=mailto%3A&fallback=1` });
  else if (globalThis.commandWatcher) commandWatcher(menuItemId);
  else api.runtime.sendMessage({ command: menuItemId }).catch(() => {});
});

api.notifications.onClicked.addListener((id) => {
  api.tabs.create({ url: id });
  api.notifications.clear(id);
});

api.storage.onChanged.addListener(async (changes) => {
  if (changes.options) applyClickAction();
  if (!changes.base) return;
  if (api.offscreen && await api.offscreen.hasDocument()) await api.offscreen.closeDocument();
  start();
});

// Chromium only: each wake-up runs start(), which reopens the offscreen document if it closed.
if (api.alarms) {
  api.alarms.create('keep-watcher-running', { periodInMinutes: 1 });
  api.alarms.onAlarm.addListener(start);
}
api.runtime.onStartup.addListener(start);

start();
