// Runs the extension's logic against fakes of Bulwark, the mail server and the browser: node test.js
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });

function run({
  authMode,
  settings = {},
  inboxMail,
  lockBusy = false,
  tokenExpired = false,
  streamHangs = false,
  secondAccount = false,
  stuckMarkRead = false,
  failingSlots = [],
  tabRenewed = false,
  basicRefused = false,
  serverSettings,
  activeAccountId,
  accountRules,
  timeScale = 1,
  frameUrl = 'https://mail.test/webmail/api/version',
  sessionOverrides = {},
}) {
  const calls = [];
  const planned = [];
  let cancelledStreams = 0;
  let markReadRequests = 0;
  const listeners = {};
  const sent = [];
  let pushChunk;
  let tokenRenewals = 0;
  let validAuth = tokenExpired ? 'Bearer new' : 'Bearer old';
  let serverState = 's1';
  let cachedTokenReads = 0;
  const unreadIds = Array.from({ length: 7 }, (_, i) => `u${i}`);
  const marked = [];
  const emails = {
    new1: { id: 'new1', from: [{ name: 'Ana' }], subject: 'Hi', preview: 'Hello', mailboxIds: { inbox1: true }, keywords: {} },
    draft1: { id: 'draft1', from: [], subject: 'D', mailboxIds: { inbox1: true }, keywords: { $draft: true } },
    other1: { id: 'other1', from: [], subject: 'O', mailboxIds: { spam1: true }, keywords: {} },
  };

  const fetchFake = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET' });
    if (url.includes('/api/settings')) {
      if (!serverSettings) return json(404, {});
      return json(200, { settings: serverSettings[init.headers['x-settings-username']] ?? null });
    }
    if (url.includes('/api/auth/token')) {
      if (url.includes('force=true')) { tokenRenewals++; validAuth = 'Bearer new'; }
      cachedTokenReads++;
      const cookieHasNew = tabRenewed && cachedTokenReads > 1;
      return json(200, { access_token: url.includes('force=true') || cookieHasNew ? 'new' : 'old' });
    }
    if (url.includes('/api/auth/session')) {
      if (failingSlots.some((slot) => url.includes(`slot=${slot}`))) return json(401, {});
      return json(200, { username: 'u', password: 'p' });
    }
    if (authMode === 'oauth' && init.headers?.Authorization !== validAuth) return json(401, {});
    if (basicRefused && init.headers?.Authorization?.startsWith('Basic')) return json(402, {});
    if (url.endsWith('/.well-known/jmap')) {
      return json(200, {
        primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acc1' },
        apiUrl: 'https://jmap.test/api',
        eventSourceUrl: 'https://jmap.test/events?types={types}&closeafter={closeafter}&ping={ping}',
        ...sessionOverrides,
      });
    }
    if (url.includes('/events')) {
      assert.match(url, /types=\*&closeafter=no&ping=30/);
      if (streamHangs) return new Promise(() => {});
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: () => new Promise((resolve) => { pushChunk = resolve; }),
            cancel: async () => { cancelledStreams++; },
          }),
        },
      };
    }
    const [[method, args, tag]] = JSON.parse(init.body).methodCalls;
    const plan = planned.findIndex((p) => p.method === method);
    if (plan >= 0) {
      const [{ outcome }] = planned.splice(plan, 1);
      if (outcome === 'hang') return new Promise(() => {});
      if (typeof outcome === 'number') return json(outcome, {});
      return json(200, { methodResponses: [['error', { type: outcome }, tag]] });
    }
    if (method === 'Mailbox/get') {
      return json(200, { methodResponses: [[method, { list: [{ id: 'inbox1', role: 'inbox', unreadEmails: unreadIds.length }] }, tag]] });
    }
    if (method === 'Email/query') {
      assert.deepStrictEqual(args.filter, { inMailbox: 'inbox1', notKeyword: '$seen' });
      return json(200, { methodResponses: [[method, { ids: unreadIds.slice(0, 3) }, tag]] });
    }
    if (method === 'Email/set') {
      markReadRequests++;
      if (stuckMarkRead) return json(200, { methodResponses: [[method, { updated: null }, tag]] });
      for (const [id, patch] of Object.entries(args.update)) {
        assert.deepStrictEqual(patch, { 'keywords/$seen': true });
        marked.push(id);
        unreadIds.splice(unreadIds.indexOf(id), 1);
      }
      return json(200, { methodResponses: [[method, { updated: args.update }, tag]] });
    }
    if (method === 'Email/changes') {
      const created = args.sinceState === serverState ? [] : inboxMail;
      return json(200, { methodResponses: [[method, { created, newState: serverState, hasMoreChanges: false }, tag]] });
    }
    if (args.ids.length === 0) return json(200, { methodResponses: [[method, { state: serverState, list: [] }, tag]] });
    return json(200, { methodResponses: [[method, { list: args.ids.map((id) => emails[id]) }, tag]] });
  };

  const store = {
    'account-registry': JSON.stringify({ state: { activeAccountId, accounts: [{
      id: 'login-u', cookieSlot: 2, username: 'u', serverUrl: 'https://jmap.test', authMode, rememberMe: true,
    }, ...(secondAccount ? [{
      cookieSlot: 3, username: 'v', serverUrl: 'https://jmap.test', authMode, rememberMe: true,
    }] : [])] } }),
    'settings-storage': JSON.stringify({ state: settings }),
  };
  const context = {
    window: { parent: { postMessage() {} }, addEventListener: (type, fn) => { listeners[type] = fn; } },
    location: { href: frameUrl },
    localStorage: { getItem: (key) => store[key] ?? null },
    navigator: {
      locks: {
        request: async (name, ...rest) => {
          assert.strictEqual(name, 'bulwark-token-refresh:2');
          const callback = rest.at(-1);
          if (rest[0].ifAvailable && lockBusy) return callback(null);
          return callback({});
        },
      },
    },
    chrome: {
      runtime: { sendMessage: async (message) => { sent.push(message); } },
      storage: {
        local: { get: async () => ({ accountRules, base: 'https://mail.test/webmail' }) },
        onChanged: { addListener: (fn) => { listeners.rules = fn; } },
      },
    },
    fetch: fetchFake,
    setTimeout: (fn, ms) => setTimeout(fn, ms * timeScale).unref(),
    setInterval() {},
    btoa,
    matchMedia: () => ({ matches: false }),
    encodeURIComponent,
    TextDecoder,
    URL,
    console,
  };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(`${__dirname}/../src/bridge.js`, 'utf8'), context);

  const push = (changed) => {
    serverState = changed.Email ?? serverState;
    pushChunk({
      done: false,
      value: new TextEncoder().encode(`event: state\ndata: ${JSON.stringify({ changed: { acc1: changed } })}\n\n`),
    });
  };
  const newMailWithoutPush = (state) => { serverState = state; };
  const refresh = () => listeners.message({ data: 'bridge-refresh' });
  const markRead = () => listeners.message({ data: 'bridge-mark-read' });
  const logInAgainWith = (mode) => {
    store['account-registry'] = JSON.stringify({ state: { accounts: [{
      cookieSlot: 2, username: 'u', serverUrl: 'https://jmap.test', authMode: mode, rememberMe: true,
    }] } });
    listeners.storage({ key: 'account-registry' });
  };
  const changeRules = (newValue) => listeners.rules({ accountRules: { newValue } });
  // The next call of this method fails: 'hang', an HTTP status, or a JMAP error type.
  const failNext = (method, outcome) => planned.push({ method, outcome });
  const endStream = () => pushChunk({ done: true });
  return {
    calls,
    sent,
    push,
    newMailWithoutPush,
    refresh,
    markRead,
    logInAgainWith,
    changeRules,
    failNext,
    endStream,
    unreadIds,
    marked,
    tokenRenewals: () => tokenRenewals,
    cancelledStreams: () => cancelledStreams,
    markReadRequests: () => markReadRequests,
  };
}

const mailMessages = (sent) => sent.filter((m) => m.mail);

(async () => {
  // Inbox mail alerts once with a working link; drafts and other folders don't.
  let t = run({ authMode: 'basic', inboxMail: ['new1', 'draft1', 'other1'], settings: { notificationSoundChoice: 'swift' } });
  await sleep(20);
  assert.deepStrictEqual(mailMessages(t.sent), [], 'existing mail must not alert');
  assert.ok(t.sent.some((m) => m.status === 'ok' && m.unread === 7));
  t.push({ Email: 's2' });
  await sleep(20);
  const [alert] = mailMessages(t.sent);
  assert.strictEqual(alert.mail.length, 1);
  assert.strictEqual(alert.mail[0].from, 'Ana');
  assert.strictEqual(alert.mail[0].url, 'https://mail.test/webmail/mail/message/new1?slot=2&owner=acc1');
  assert.strictEqual(alert.sound, 'notification-tone-swift-gesture.mp3');
  t.push({ Email: 's2' });
  await sleep(20);
  assert.strictEqual(mailMessages(t.sent).length, 1, 'same state must not alert twice');

  // Do Not Disturb, disabled notifications and muted accounts stay silent.
  for (const settings of [
    { doNotDisturb: true },
    { emailNotificationsEnabled: false },
    { notificationMutes: { accounts: ['acc1'], mailboxes: {} } },
    { notificationMutes: { accounts: [], mailboxes: { 'acc1/inbox1': true } } },
  ]) {
    t = run({ authMode: 'basic', inboxMail: ['new1'], settings });
    await sleep(20);
    t.push({ Email: 's2' });
    await sleep(20);
    assert.deepStrictEqual(mailMessages(t.sent), [], JSON.stringify(settings));
  }

  // A folder's own setting beats a muted account; sound off still notifies.
  t = run({
    authMode: 'basic',
    inboxMail: ['new1'],
    settings: { emailNotificationSound: false, notificationMutes: { accounts: ['acc1'], mailboxes: { 'acc1/inbox1': false } } },
  });
  await sleep(20);
  t.push({ Email: 's2' });
  await sleep(20);
  assert.strictEqual(mailMessages(t.sent)[0].sound, null);

  // OAuth renews once after a 401, only with force, and only under the lock.
  t = run({ authMode: 'oauth', inboxMail: [], tokenExpired: true });
  await sleep(20);
  assert.strictEqual(t.tokenRenewals(), 1, 'exactly one forced renewal after the 401');
  assert.ok(t.sent.some((m) => m.status === 'ok'));

  // A tab already renewed: the cached token is new, so nothing is forced.
  t = run({ authMode: 'oauth', inboxMail: [], tokenExpired: true, tabRenewed: true });
  await sleep(20);
  assert.strictEqual(t.tokenRenewals(), 0, 'no force when the cookie already has a newer token');
  assert.ok(t.sent.some((m) => m.status === 'ok'));

  // When another window holds the lock, never force a renewal after waiting.
  t = run({ authMode: 'oauth', inboxMail: [], tokenExpired: true, lockBusy: true });
  await sleep(20);
  assert.strictEqual(t.tokenRenewals(), 0, 'no force while another window renews');

  // Connecting shows first, then the real count at once, even while the stream hasn't answered. 0 is never claimed first.
  t = run({ authMode: 'basic', inboxMail: [], streamHangs: true });
  await sleep(20);
  assert.deepStrictEqual(t.sent.filter((m) => m.status).map((m) => [m.status, m.unread]), [['connecting', undefined], ['ok', 7]]);

  // Check for new mail finds it with no push, and racing a push still alerts once.
  t = run({ authMode: 'basic', inboxMail: ['new1'] });
  await sleep(20);
  t.newMailWithoutPush('s2');
  t.refresh();
  await sleep(20);
  assert.strictEqual(mailMessages(t.sent).length, 1, 'refresh finds new mail');
  t = run({ authMode: 'basic', inboxMail: ['new1'] });
  await sleep(20);
  t.push({ Email: 's2' });
  t.refresh();
  await sleep(20);
  assert.strictEqual(mailMessages(t.sent).length, 1, 'refresh racing a push must not alert twice');

  // Mark all as read works through every batch, and the badge follows.
  t = run({ authMode: 'basic', inboxMail: [] });
  await sleep(20);
  t.markRead();
  await sleep(20);
  assert.strictEqual(t.marked.length, 7);
  assert.strictEqual(t.sent.filter((m) => m.status).at(-1).unread, 0);

  // A server that refuses the change doesn't loop forever.
  t = run({ authMode: 'basic', inboxMail: [], stuckMarkRead: true });
  await sleep(20);
  t.markRead();
  await sleep(20);
  assert.strictEqual(t.markReadRequests(), 1, 'stops after a refused batch');

  // A failed command shows on the badge, rather than vanishing.
  t = run({ authMode: 'basic', inboxMail: [] });
  await sleep(20);
  t.failNext('Email/query', 500);
  t.markRead();
  await sleep(20);
  assert.strictEqual(t.sent.filter((m) => m.status).at(-1).status, 'error');
  t.refresh();
  await sleep(20);
  assert.strictEqual(t.sent.filter((m) => m.status).at(-1).status, 'ok', 'the next success clears it');

  // Mail that arrives during a dropped connection alerts once after reconnecting.
  t = run({ authMode: 'basic', inboxMail: ['new1'], timeScale: 0.01 });
  await sleep(20);
  t.endStream();
  t.newMailWithoutPush('s2');
  await sleep(120);
  assert.strictEqual(mailMessages(t.sent).length, 1, 'catches up after reconnecting');
  await sleep(60);
  assert.strictEqual(mailMessages(t.sent).length, 1);

  // A failed Email/get keeps the baseline, so the alert isn't lost.
  t = run({ authMode: 'basic', inboxMail: ['new1'], timeScale: 0.01 });
  await sleep(20);
  t.failNext('Email/get', 500);
  t.push({ Email: 's2' });
  await sleep(120);
  assert.strictEqual(mailMessages(t.sent).length, 1, 'alerts after a failed Email/get');
  assert.ok(t.cancelledStreams() >= 1, 'the failed connection closes its stream');

  // A passing server error keeps the baseline too.
  t = run({ authMode: 'basic', inboxMail: ['new1'], timeScale: 0.01 });
  await sleep(20);
  t.failNext('Email/changes', 'serverFail');
  t.push({ Email: 's2' });
  await sleep(120);
  assert.strictEqual(mailMessages(t.sent).length, 1, 'alerts after a transient error');

  // Only a baseline the server can't use starts over, and that can't alert.
  t = run({ authMode: 'basic', inboxMail: ['new1'], timeScale: 0.01 });
  await sleep(20);
  t.failNext('Email/changes', 'cannotCalculateChanges');
  t.push({ Email: 's2' });
  await sleep(120);
  assert.strictEqual(mailMessages(t.sent).length, 0);
  assert.strictEqual(t.sent.filter((m) => m.status).at(-1).status, 'ok');

  // A request that never answers times out, and the watcher recovers.
  t = run({ authMode: 'basic', inboxMail: ['new1'], timeScale: 0.01 });
  await sleep(20);
  t.failNext('Email/changes', 'hang');
  t.push({ Email: 's2' });
  await sleep(450);
  assert.strictEqual(mailMessages(t.sent).length, 1, 'recovers from a hung request');

  // A server behind a proxy reports addresses it can't be reached on.
  t = run({
    authMode: 'basic',
    inboxMail: [],
    sessionOverrides: {
      apiUrl: 'http://internal.invalid:8080/api',
      eventSourceUrl: 'http://internal.invalid:8080/events?types={types}&closeafter={closeafter}&ping={ping}',
    },
  });
  await sleep(20);
  assert.ok(!t.calls.some((c) => c.url.includes('internal.invalid')), 'nothing goes to the reported host');
  assert.ok(t.calls.some((c) => c.url === 'https://jmap.test/api'));
  assert.ok(t.calls.some((c) => c.url.startsWith('https://jmap.test/events?types=*')));

  // Bulwark's fallback when the session has no top-level push address.
  t = run({
    authMode: 'basic',
    inboxMail: [],
    sessionOverrides: {
      eventSourceUrl: undefined,
      capabilities: { 'urn:ietf:params:jmap:core': { eventSourceUrl: '/events?types={types}&closeafter={closeafter}&ping={ping}' } },
    },
  });
  await sleep(20);
  assert.ok(t.calls.some((c) => c.url.startsWith('https://jmap.test/events?types=*')));

  // A page on another port of the host isn't the saved address, so nothing runs for it.
  t = run({ authMode: 'basic', inboxMail: [], frameUrl: 'https://mail.test:8443/webmail/api/version' });
  await sleep(20);
  assert.deepStrictEqual(t.sent, [], 'no messages from another port');
  assert.deepStrictEqual(t.calls, [], 'no requests from another port');

  // Two logins add up on the badge, once both have answered.
  t = run({ authMode: 'basic', inboxMail: [], secondAccount: true });
  await sleep(20);
  assert.deepStrictEqual(t.sent.filter((m) => m.status === 'ok').map((m) => m.unread).filter((n) => n !== 14), [], 'no partial count');
  assert.ok(t.sent.some((m) => m.unread === 14));

  // One login failing keeps the other's count and alerts, and says which one failed.
  t = run({ authMode: 'basic', inboxMail: ['new1'], secondAccount: true, failingSlots: [3] });
  await sleep(20);
  const partial = t.sent.filter((m) => m.status).at(-1);
  assert.strictEqual(partial.status, 'ok');
  assert.strictEqual(partial.unread, 7);
  assert.strictEqual(JSON.stringify(partial.problems), JSON.stringify([{ username: 'v', problem: 'logged-out', detail: 'Auth failed: 401' }]));
  t.push({ Email: 's2' });
  await sleep(20);
  assert.strictEqual(mailMessages(t.sent)[0].mail[0].username, 'u', 'names the account with several logins');

  // Every login failing still shows the problem, and one login never names its account.
  t = run({ authMode: 'basic', inboxMail: [], secondAccount: true, failingSlots: [2, 3] });
  await sleep(20);
  assert.strictEqual(t.sent.filter((m) => m.status).at(-1).status, 'logged-out');
  t = run({ authMode: 'basic', inboxMail: ['new1'] });
  await sleep(20);
  t.push({ Email: 's2' });
  await sleep(20);
  assert.strictEqual(mailMessages(t.sent)[0].mail[0].username, undefined);

  // Turning on 2FA makes Stalwart refuse the stored password with a 402: that's a login problem.
  t = run({ authMode: 'basic', inboxMail: [], basicRefused: true });
  await sleep(20);
  assert.strictEqual(t.sent.filter((m) => m.status).at(-1).status, 'logged-out', '402 means log in again');

  // Logging in again with 2FA changes the same account to OAuth: the watcher must follow.
  t.logInAgainWith('oauth');
  await sleep(20);
  assert.ok(t.calls.some((c) => c.url.includes('/api/auth/token')), 'uses the new login method');
  assert.strictEqual(t.sent.filter((m) => m.status).at(-1).status, 'ok');

  // With settings sync on, each login alerts with its own settings, not the active login's local copy.
  t = run({
    authMode: 'basic',
    inboxMail: ['new1'],
    settings: { notificationSoundChoice: 'relax' },
    serverSettings: { u: { notificationSoundChoice: 'cheerful' } },
    activeAccountId: 'login-other',
  });
  await sleep(20);
  t.push({ Email: 's2' });
  await sleep(20);
  let [own] = mailMessages(t.sent);
  assert.strictEqual(own.sound, 'cheerful-527.mp3', 'the recipient chose this sound');
  assert.strictEqual(own.isActiveAccount, false);
  assert.strictEqual(own.inboxUrl, 'https://mail.test/webmail/mail/folder/inbox?slot=2&owner=acc1');

  // A login with nothing saved on the server gets Bulwark's defaults, even if the active login is muted.
  t = run({
    authMode: 'basic',
    inboxMail: ['new1'],
    settings: { doNotDisturb: true, notificationSoundChoice: 'relax' },
    serverSettings: {},
    activeAccountId: 'login-u',
  });
  await sleep(20);
  t.push({ Email: 's2' });
  await sleep(20);
  [own] = mailMessages(t.sent);
  assert.strictEqual(own.sound, 'involved-notification.mp3');
  assert.strictEqual(own.isActiveAccount, true);

  // Connecting follows a redirect to the real address, however the path is written.
  const optionsContext = {
    URL,
    Set,
    location: { search: '' },
    document: {
      documentElement: { classList: { toggle() {} } },
      getElementById: () => ({ addEventListener() {}, replaceChildren() {} }),
      createElement: () => ({}),
    },
    chrome: { storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } } },
    fetch: async (url) => ({
      url: url === 'https://mail.test/' ? 'https://mail.test/webmail/en' : url,
      ok: url.endsWith('/webmail/api/version') || url.endsWith('/mail/api/version'),
      json: async () => ({ buildId: 'x' }),
    }),
  };
  optionsContext.globalThis = optionsContext;
  vm.runInNewContext(fs.readFileSync(`${__dirname}/../src/options.js`, 'utf8'), optionsContext);
  const find = (address) => vm.runInNewContext(`findBulwark(${JSON.stringify(address)})`, optionsContext);
  const scheme = (text) => vm.runInNewContext(`withScheme(${JSON.stringify(text)})`, optionsContext);
  assert.strictEqual(scheme('mail.test'), 'https://mail.test');
  assert.strictEqual(scheme('mail.test:8080/webmail'), 'https://mail.test:8080/webmail');
  assert.strictEqual(scheme('http://mail.test'), 'http://mail.test');
  assert.strictEqual(await find('https://mail.test/'), 'https://mail.test/webmail');
  assert.strictEqual(await find('https://mail.test/webmail/en/mail/folder/inbox'), 'https://mail.test/webmail');
  assert.strictEqual(await find('https://mail.test/webmail/'), 'https://mail.test/webmail');
  optionsContext.fetch = async (url) => ({ url, ok: url === 'https://mail.test/mail/api/version', json: async () => ({ buildId: 'x' }) });
  assert.strictEqual(await find('https://mail.test/mail'), 'https://mail.test/mail', 'sub-path that looks like a page');
  optionsContext.fetch = async (url) => ({ url, ok: false, json: async () => ({}) });
  assert.strictEqual(await find('https://not-bulwark.test/'), null);

  // Per-account notification rules against Bulwark's own settings.
  const alertWith = async (rule, settings) => {
    const r = run({
      authMode: 'basic', inboxMail: ['new1'], settings, activeAccountId: 'login-u',
      accountRules: rule ? { u: { notify: rule } } : undefined,
    });
    await sleep(20);
    r.push({ Email: 's2' });
    await sleep(20);
    return mailMessages(r.sent)[0];
  };
  const muted = { notificationMutes: { accounts: ['acc1'], mailboxes: {} } };
  assert.strictEqual(await alertWith('unmuted', muted), undefined, 'when not muted: muted stays quiet');
  assert.ok(await alertWith('unmuted', {}), 'when not muted: alerts');
  assert.strictEqual(await alertWith('never', {}), undefined, 'never stays quiet');
  let forced = await alertWith('always', muted);
  assert.strictEqual(forced.tabMayAlert, false, 'a tab stays quiet for muted mail, so the extension must play it');
  forced = await alertWith('always', { doNotDisturb: true });
  assert.ok(forced, 'always ignores Do Not Disturb');
  assert.strictEqual((await alertWith('always', {})).tabMayAlert, true, 'a tab alerts for this one too');

  // Per-account badge rules, and changing them while running.
  const lastUnread = (r) => r.sent.filter((m) => m.status).at(-1).unread;
  t = run({ authMode: 'basic', inboxMail: [], settings: muted });
  await sleep(20);
  assert.strictEqual(lastUnread(t), 7, 'muted accounts count by default');
  t.changeRules({ u: { badge: 'unmuted' } });
  await sleep(20);
  assert.strictEqual(lastUnread(t), 0, 'when not muted: leaves a muted account out');
  t.changeRules({ u: { badge: 'always' } });
  await sleep(20);
  assert.strictEqual(lastUnread(t), 7);
  t = run({ authMode: 'basic', inboxMail: [], settings: {}, accountRules: { u: { badge: 'unmuted' } } });
  await sleep(20);
  assert.strictEqual(lastUnread(t), 7, 'when not muted: counts an unmuted account');
  t.changeRules({ u: { badge: 'never' } });
  await sleep(20);
  assert.strictEqual(lastUnread(t), 0, 'never');
  assert.ok(t.sent.some((m) => JSON.stringify(m.accounts) === JSON.stringify(['u'])), 'tells settings which accounts exist');

  // What each notification option shows.
  const background = fs.readFileSync(`${__dirname}/../src/background.js`, 'utf8');
  const notificationCode = background.slice(background.indexOf('function recipient'), background.indexOf('async function tabCanAlert'));
  const backgroundContext = { MAX_SEPARATE_NOTIFICATIONS: 3 };
  vm.runInNewContext(notificationCode, backgroundContext);
  const notify = (mail, content) => JSON.parse(vm.runInNewContext(
    `JSON.stringify(notifications(${JSON.stringify(mail)}, 'inbox', ${JSON.stringify(content)}))`,
    backgroundContext,
  ));
  const one = { url: 'link', from: 'Ana', subject: 'Hi', preview: 'Hello', username: 'u' };
  assert.deepStrictEqual(notify([one], 'full'), [{ url: 'link', title: 'Ana', message: 'To: u\nHi\nHello' }]);
  assert.deepStrictEqual(notify([one], 'subject'), [{ url: 'link', title: 'Ana', message: 'To: u\nHi' }]);
  assert.deepStrictEqual(notify([one], 'minimal'), [{ url: 'link', title: 'New mail', message: '' }]);
  assert.deepStrictEqual(notify([one], 'off'), []);
  const many = [one, one, one, one];
  assert.deepStrictEqual(notify(many, 'minimal'), [{ url: 'inbox', title: '4 new messages', message: '' }]);
  assert.deepStrictEqual(notify(many, 'subject'), [{ url: 'inbox', title: '4 new messages', message: 'To: u\nHi' }]);

  console.log('all checks passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
