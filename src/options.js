const api = globalThis.browser ?? chrome;
document.documentElement.classList.toggle('in-tab', location.search === '?tab');
const baseInput = document.getElementById('base');
const statusLine = document.getElementById('status');
const PAGE_IN_PATH = /(\/[a-z]{2}(-[A-Za-z]{2,4})?)?(\/(mail|login|calendar|contacts|files|settings)(\/.*)?)?$/;

// Where Bulwark may live, given a URL copied from the address bar or reached by a redirect:
// without the language and page first, then as it stands, for a sub-path that only looks like one.
function possibleBases(address) {
  const url = new URL(address);
  const path = url.pathname.replace(/\/+$/, '');
  return [url.origin + path.replace(PAGE_IN_PATH, ''), url.origin + path];
}

function withScheme(text) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
}

function originPattern(address) {
  return `*://${new URL(address).hostname}/*`;
}

const PLAIN_FETCH = { cache: 'no-store', credentials: 'omit' };

async function isBulwark(base) {
  const res = await fetch(`${base}/api/version`, PLAIN_FETCH);
  return res.ok && 'buildId' in await res.json();
}

async function findBulwark(address) {
  const redirected = await fetch(address, PLAIN_FETCH).then((res) => res.url).catch(() => address);
  for (const base of new Set([...possibleBases(redirected), ...possibleBases(address)])) {
    if (await isBulwark(base).catch(() => false)) return base;
  }
  return null;
}

function showConnected(base) {
  baseInput.value = base;
  document.getElementById('connect').textContent = 'Save';
  document.getElementById('options').hidden = false;
}

function showIcon(icon) {
  document.getElementById('logo').src = icon;
}

async function connect(address) {
  const pattern = originPattern(address);
  // Must run before any await: the prompt needs the click's user gesture.
  const granted = await api.permissions.request({ origins: [pattern] });
  if (!granted) {
    statusLine.textContent = 'Permission is needed to reach your Bulwark server.';
    return;
  }
  statusLine.textContent = 'Checking…';
  const { base: previous } = await api.storage.local.get('base');
  const previousPattern = previous && originPattern(previous);
  const base = await findBulwark(address);
  if (!base) {
    if (previousPattern !== pattern) await api.permissions.remove({ origins: [pattern] });
    statusLine.textContent = 'No Bulwark server found there. Check the address, including any sub-path such as /webmail. Bulwark Lite isn\'t supported.';
    return;
  }
  const foundPattern = originPattern(base);
  if (!(await api.permissions.contains({ origins: [foundPattern] }))) {
    // A redirect to another host: permission needs a fresh click.
    if (previousPattern !== pattern) await api.permissions.remove({ origins: [pattern] });
    baseInput.value = base;
    statusLine.textContent = 'That address redirects to another host. Click Connect again to allow it.';
    return;
  }
  for (const unused of new Set([pattern, previousPattern])) {
    if (unused && unused !== foundPattern) await api.permissions.remove({ origins: [unused] });
  }
  // Links saved for the old address would open the wrong host.
  if (base !== previous) await api.storage.local.remove(['popupUrl', 'tabsBehind']);
  await api.storage.local.set({ base });
  showConnected(base);
  const url = new URL(base);
  const unencrypted = url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  statusLine.textContent = `Connected. Pin the extension to your toolbar, and make sure you're logged in to Bulwark in this browser.${
    unencrypted ? ' This address isn\'t encrypted, so your password and mail can be read on the network.' : ''}`;
}

document.getElementById('form').addEventListener('submit', (event) => {
  event.preventDefault();
  const address = withScheme(baseInput.value.trim());
  if (!URL.canParse(address)) {
    statusLine.textContent = 'That doesn\'t look like a web address. Try something like mail.example.com.';
    return;
  }
  connect(address);
});

const OPTION_IDS = ['notificationContent', 'overlaySize', 'iconClick', 'wiggle', 'volume'];

function readOption(id) {
  const control = document.getElementById(id);
  if (control.type === 'checkbox') return control.checked;
  return control.type === 'range' ? Number(control.value) : control.value;
}

function writeOption(id, value) {
  const control = document.getElementById(id);
  if (control.type === 'checkbox') control.checked = value;
  else control.value = value;
}

function showVolume() {
  document.getElementById('volumeShown').value = `${readOption('volume')}%`;
}

async function previewVolume() {
  const { base } = await api.storage.local.get('base');
  if (!base || readOption('volume') === 0) return;
  const audio = new Audio(`${base}/notification/involved-notification.mp3`);
  audio.volume = readOption('volume') / 100;
  audio.play().catch(() => {});
}

// With notifications off there's nothing to test.
function showTestButton() {
  document.getElementById('testArea').hidden = readOption('notificationContent') === 'off';
}

for (const id of OPTION_IDS) {
  document.getElementById(id).addEventListener('change', () => {
    api.storage.local.set({ options: Object.fromEntries(OPTION_IDS.map((key) => [key, readOption(key)])) });
    if (id === 'volume') previewVolume();
    if (id === 'notificationContent') showTestButton();
  });
}
document.getElementById('volume').addEventListener('input', showVolume);

// A made-up email through the same alert as real mail, so it follows the options above. Clicking it opens the mail.
document.getElementById('testNotification').addEventListener('click', async () => {
  const { base } = await api.storage.local.get('base');
  api.runtime.sendMessage({
    test: true,
    mail: [{
      from: 'Mail Checker for Bulwark',
      subject: 'Test message',
      preview: 'New mail will look like this. Click to open your mail.',
      url: `${base}/mail`,
    }],
    base,
    sound: 'involved-notification.mp3',
    inboxUrl: `${base}/mail`,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  });
});

async function showShortcut() {
  const commands = await api.commands.getAll();
  const icon = commands.find((c) => c.name === '_execute_action' || c.name === '_execute_browser_action');
  document.getElementById('shortcutKeys').textContent = icon?.shortcut || 'Not set';
}

// Chromium has no call for this and opens its page instead.
document.getElementById('setShortcut').addEventListener('click', () => {
  if (api.commands.openShortcutSettings) api.commands.openShortcutSettings();
  else api.tabs.create({ url: 'chrome://extensions/shortcuts' });
});
// Coming back from the shortcut settings.
window.addEventListener('focus', showShortcut);
showShortcut();

const RULE_LABELS = { always: 'Always', unmuted: 'When not muted', never: 'Never' };
const DEFAULT_RULES = { notify: 'unmuted', badge: 'always' };
let accountRules = {};

function ruleSelect(username, kind, labelText) {
  const label = document.createElement('label');
  label.textContent = labelText;
  const select = document.createElement('select');
  for (const [value, text] of Object.entries(RULE_LABELS)) {
    select.append(new Option(text, value));
  }
  select.value = accountRules[username]?.[kind] ?? DEFAULT_RULES[kind];
  select.addEventListener('change', () => {
    accountRules = { ...accountRules, [username]: { ...accountRules[username], [kind]: select.value } };
    api.storage.local.set({ accountRules });
  });
  label.append(select);
  return label;
}

function showAccounts(accounts = []) {
  const list = document.getElementById('accounts');
  if (!accounts.length) {
    const empty = document.createElement('p');
    empty.className = 'note';
    empty.textContent = 'Log in to Bulwark in this browser, and your accounts will appear here.';
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...accounts.map((username) => {
    const group = document.createElement('fieldset');
    const name = document.createElement('legend');
    name.textContent = username;
    const rules = document.createElement('div');
    rules.className = 'rules';
    rules.append(ruleSelect(username, 'notify', 'Notify'), ruleSelect(username, 'badge', 'Badge count'));
    group.append(name, rules);
    return group;
  }));
}

api.storage.local.get(['base', 'icon', 'options', 'accounts', 'accountRules']).then(({ base, icon, options, accounts, accountRules: savedRules }) => {
  accountRules = savedRules ?? {};
  showAccounts(accounts);
  if (icon) showIcon(icon);
  if (base) showConnected(base);
  for (const [id, value] of Object.entries(options ?? {})) writeOption(id, value);
  showVolume();
  showTestButton();
});

api.storage.onChanged.addListener(({ icon, accounts }) => {
  if (icon?.newValue) showIcon(icon.newValue);
  if (accounts) showAccounts(accounts.newValue);
});
