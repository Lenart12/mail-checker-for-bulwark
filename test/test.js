// Runs the extension's logic against fakes of Bulwark, the mail server and the browser: node test.js
// Starts as a failure: if a promise here never settles, Node just exits, which would otherwise count as a pass.
process.exitCode = 1;
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
  const posted = [];
  let now = 0;
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
            cancel: async () => {
              cancelledStreams++;
              pushChunk?.({ done: true });
            },
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
    window: { parent: { postMessage: (message) => posted.push(message) }, addEventListener: (type, fn) => { listeners[type] = fn; } },
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
    Date: { now: () => now },
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
  const check = () => listeners.message({ data: 'bridge-check' });
  const recheck = () => listeners.message({ data: 'bridge-recheck' });
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
    posted,
    advance: (ms) => { now += ms; },
    push,
    newMailWithoutPush,
    refresh,
    check,
    recheck,
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

  // Connecting shows first, then the real count, even while the stream hasn't answered. Never 0.
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

  // An overlay that loads makes a failed connection try again without waiting, but not too often.
  const lastStatus = (t) => t.sent.filter((m) => m.status).at(-1).status;
  t = run({ authMode: 'basic', inboxMail: [], timeScale: 10 });
  t.failNext('Mailbox/get', 500);
  await sleep(20);
  assert.strictEqual(lastStatus(t), 'error');
  const callsBefore = t.calls.length;
  await sleep(50);
  assert.strictEqual(t.calls.length, callsBefore, 'waiting out the delay');
  t.advance(5999);
  t.recheck();
  await sleep(20);
  assert.strictEqual(t.calls.length, callsBefore, 'too soon after the last try');
  t.advance(1);
  t.recheck();
  await sleep(20);
  assert.strictEqual(lastStatus(t), 'ok');
  const callsWorking = t.calls.length;
  t.advance(6000);
  t.recheck();
  await sleep(20);
  assert.strictEqual(t.calls.length, callsWorking, 'nothing to do once working');

  // A problem on a connection that's still open checks again the same way.
  t = run({ authMode: 'basic', inboxMail: [], timeScale: 10 });
  await sleep(20);
  t.failNext('Email/changes', 500);
  t.refresh();
  await sleep(20);
  assert.strictEqual(lastStatus(t), 'error');
  t.advance(6000);
  t.recheck();
  await sleep(20);
  assert.strictEqual(lastStatus(t), 'ok');

  // An overlay that fails makes working connections check at once, but not too often, and leaves failing ones alone.
  t = run({ authMode: 'basic', inboxMail: [], timeScale: 10 });
  await sleep(20);
  const callsWhenIdle = t.calls.length;
  t.advance(5999);
  t.check();
  await sleep(20);
  assert.strictEqual(t.calls.length, callsWhenIdle, 'too soon after the last try');
  t.advance(1);
  t.failNext('Email/changes', 500);
  t.check();
  await sleep(20);
  assert.strictEqual(lastStatus(t), 'error', 'a lost connection shows at once');
  const callsWhenFailing = t.calls.length;
  t.advance(6000);
  t.check();
  await sleep(20);
  assert.strictEqual(t.calls.length, callsWhenFailing, 'already retrying');

  // A failed check drops the open stream, so the normal reconnect clears the problem by itself.
  t = run({ authMode: 'basic', inboxMail: [], timeScale: 0.001 });
  await sleep(20);
  t.failNext('Email/changes', 500);
  t.refresh();
  await sleep(50);
  assert.strictEqual(lastStatus(t), 'ok');
  assert.strictEqual(t.calls.filter((c) => c.url.endsWith('/.well-known/jmap')).length, 2);

  // The host needs this beat, and must allow more time than the beats take.
  t = run({ authMode: 'basic', inboxMail: [] });
  await sleep(20);
  assert.deepStrictEqual(t.posted, ['bridge-alive']);
  const constantIn = (file, name) => Number(new RegExp(`${name} = ([\\d_]+)`).exec(fs.readFileSync(`${__dirname}/../src/${file}`, 'utf8'))[1].replaceAll('_', ''));
  assert.ok(constantIn('host.js', 'BRIDGE_SILENCE_MS') > constantIn('bridge.js', 'HEARTBEAT_MS') * 2);
  assert.ok(constantIn('host.js', 'FIRST_BEAT_MS') > constantIn('host.js', 'BRIDGE_CHECK_MS'));

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

  // The overlay's message when Bulwark is slow or unreachable.
  const TROUBLE = 'Having trouble connecting to mail.test:8443';
  const COUNTDOWN = 'Retrying in 15s';
  const EXTENSION = 'moz-extension://x';
  const BASE = 'https://mail.test:8443/webmail';
  const SLOW_LOAD = 5000;
  const REPORT_WAIT = 200;
  const OVERLAY_URL = `${BASE}/mail`;
  const fromExtension = `${EXTENSION}/popup.html`;
  const openPopup = async () => {
    const elements = {};
    const popup = { elements, timers: {}, tick: null, revealed: false, loads: 0, hints: [] };
    const popupContext = {
      browser: {
        runtime: { sendMessage: async ({ overlayLoad }) => { popup.hints.push(overlayLoad); } },
        storage: { local: { get: async () => ({ base: BASE }), set: async () => {} } },
        webRequest: {
          onResponseStarted: { addListener: (listener) => { popup.responded = listener; } },
          onErrorOccurred: { addListener: (listener) => { popup.errored = listener; } },
        },
      },
      document: {
        documentElement: { style: { setProperty() {} } },
        getElementById: (id) => (elements[id] ??= {
          style: {},
          classList: { add() { popup.revealed = true; }, remove() { popup.revealed = false; } },
          addEventListener(type, listener) { this.onLoad = listener; },
          set src(value) { if (id === 'mail') popup.loads += 1; },
        }),
      },
      location: { origin: EXTENSION },
      matchMedia: () => ({ matches: false }),
      setTimeout: (work, ms) => {
        if (ms === REPORT_WAIT) return setTimeout(work, 0);
        const timer = () => {
          delete popup.timers[ms];
          work();
        };
        popup.timers[ms] = timer;
        return timer;
      },
      clearTimeout: (timer) => {
        for (const [ms, pending] of Object.entries(popup.timers)) {
          if (pending === timer) delete popup.timers[ms];
        }
      },
      setInterval: (work, ms) => {
        assert.strictEqual(ms, 1000, 'the countdown ticks once a second');
        assert.strictEqual(popup.tick, null, 'only one countdown at a time');
        popup.tick = work;
        popup.tickId = {};
        return popup.tickId;
      },
      clearInterval: (id) => {
        if (id === popup.tickId) popup.tick = null;
      },
      URL,
    };
    popupContext.globalThis = popupContext;
    vm.runInNewContext(fs.readFileSync(`${__dirname}/../src/popup.js`, 'utf8'), popupContext);
    await sleep(20);
    return popup;
  };
  const shown = (popup) => [popup.elements.trouble.textContent ?? '', popup.elements.retry.textContent ?? ''];
  const ok = { type: 'sub_frame', url: OVERLAY_URL, statusCode: 200, originUrl: fromExtension };
  const badGateway = { type: 'sub_frame', url: OVERLAY_URL, statusCode: 502, initiator: EXTENSION };
  const refused = { type: 'sub_frame', url: OVERLAY_URL, error: 'net::ERR_CONNECTION_REFUSED', initiator: EXTENSION };

  // A slow page after the server answered gets the message alone, and clears once loaded.
  let popup = await openPopup();
  popup.responded(ok);
  assert.deepStrictEqual(shown(popup), ['', ''], 'nothing shown while loading normally');
  popup.timers[SLOW_LOAD]();
  assert.deepStrictEqual(shown(popup), [TROUBLE, ''], 'answered, so no countdown');
  await popup.elements.mail.onLoad();
  assert.deepStrictEqual(shown(popup), ['', '']);
  assert.deepStrictEqual(popup.timers, {}, 'the load clears the timer');
  assert.ok(popup.revealed);

  // No request events at all must still show the mail.
  popup = await openPopup();
  await popup.elements.mail.onLoad();
  assert.ok(popup.revealed);
  assert.deepStrictEqual(popup.timers, {}, 'a load in time never shows the message');

  // A frame fires load for a 502 too: say so at once and keep the error page hidden, in either order.
  popup = await openPopup();
  popup.responded(badGateway);
  assert.deepStrictEqual(shown(popup), [TROUBLE, COUNTDOWN]);
  await popup.elements.mail.onLoad();
  assert.ok(!popup.revealed, 'the error page stays hidden');
  popup = await openPopup();
  const loading = popup.elements.mail.onLoad();
  popup.responded(badGateway);
  await loading;
  assert.ok(!popup.revealed, 'a report just after load never shows it');
  popup = await openPopup();
  await popup.elements.mail.onLoad();
  popup.responded(badGateway);
  assert.deepStrictEqual(shown(popup), [TROUBLE, COUNTDOWN]);
  assert.ok(!popup.revealed, 'a much later report hides it again');

  // Bulwark's service worker can report the load as its own request, as Chrome does when the worker has just started.
  for (const report of ['responded', 'errored']) {
    popup = await openPopup();
    popup[report]({ type: 'xmlhttprequest', url: OVERLAY_URL, statusCode: 502, error: 'net::ERR_FAILED' });
    await popup.elements.mail.onLoad();
    assert.deepStrictEqual(shown(popup), [TROUBLE, COUNTDOWN], report);
    assert.ok(!popup.revealed, 'the error page stays hidden');
  }

  // The browser refuses to show a page the worker answered for, so the overlay loads it again once it's awake.
  const workerOk = { type: 'xmlhttprequest', url: OVERLAY_URL, statusCode: 200, initiator: EXTENSION };
  popup = await openPopup();
  popup.responded(workerOk);
  assert.strictEqual(popup.loads, 1, 'the browser ignores a repeat of a load in flight');
  await popup.elements.mail.onLoad();
  assert.strictEqual(popup.loads, 2);
  assert.ok(!popup.revealed, 'the refused page stays hidden');
  assert.deepStrictEqual(shown(popup), ['', '']);
  popup.responded(ok);
  await popup.elements.mail.onLoad();
  assert.ok(popup.revealed);

  // Offline mode has the worker answer every load, so the page can never show here, whatever the server does.
  const OFFLINE = 'Bulwark\'s Offline mode keeps mail out of this overlay';
  popup = await openPopup();
  popup.responded(workerOk);
  await popup.elements.mail.onLoad();
  popup.responded(workerOk);
  await popup.elements.mail.onLoad();
  assert.deepStrictEqual(shown(popup), [OFFLINE, '']);
  assert.strictEqual(popup.elements['open-tab'].href, OVERLAY_URL);
  assert.strictEqual(popup.elements['open-tab'].hidden, false);
  assert.ok(!popup.revealed);
  assert.strictEqual(popup.loads, 2, 'no more tries');
  assert.strictEqual(popup.tick, null);
  assert.deepStrictEqual(popup.timers, {}, 'nothing left pending');
  popup.errored(refused);
  assert.deepStrictEqual(shown(popup), [OFFLINE, ''], 'stays once known');

  // A worker can stop between tries, so answering again after a countdown doesn't mean Offline mode.
  popup = await openPopup();
  popup.responded({ ...workerOk, statusCode: 502 });
  for (let i = 0; i < 15; i++) popup.tick();
  popup.responded(workerOk);
  await popup.elements.mail.onLoad();
  assert.strictEqual(popup.loads, 3);
  popup.responded(ok);
  await popup.elements.mail.onLoad();
  assert.deepStrictEqual(shown(popup), ['', '']);
  assert.ok(popup.revealed);
  popup = await openPopup();
  popup.responded(workerOk);
  await popup.elements.mail.onLoad();
  popup.errored({ ...refused, type: 'xmlhttprequest' });
  for (let i = 0; i < 15; i++) popup.tick();
  popup.responded(workerOk);
  assert.deepStrictEqual(shown(popup), [TROUBLE, ''], 'the count starts again after a countdown');
  await popup.elements.mail.onLoad();
  popup.responded(ok);
  await popup.elements.mail.onLoad();
  assert.ok(popup.revealed);

  // A tab can open the page while the overlay can't, which with Offline mode can show its saved copy.
  popup = await openPopup();
  assert.strictEqual(popup.elements['open-tab'].href, OVERLAY_URL);
  popup.responded(badGateway);
  assert.strictEqual(popup.elements['open-tab'].hidden, false);
  for (let i = 0; i < 15; i++) popup.tick();
  popup.responded(ok);
  await popup.elements.mail.onLoad();
  assert.strictEqual(popup.elements['open-tab'].hidden, true, 'gone once the mail shows');

  // Another tab's load can't reload a page already showing.
  popup = await openPopup();
  popup.responded(ok);
  await popup.elements.mail.onLoad();
  popup.responded(workerOk);
  await popup.elements.mail.onLoad();
  assert.strictEqual(popup.loads, 1);
  popup = await openPopup();
  await popup.elements.mail.onLoad();
  popup.responded(workerOk);
  assert.strictEqual(popup.loads, 1, 'nor when no report came for it');

  // The countdown ends in another try, which can fail again or show the mail.
  popup = await openPopup();
  popup.responded(badGateway);
  popup.responded(badGateway); // A second report mustn't start a second countdown.
  for (let i = 0; i < 14; i++) popup.tick();
  assert.deepStrictEqual(shown(popup), [TROUBLE, 'Retrying in 1s']);
  assert.strictEqual(popup.loads, 1, 'no retry before the countdown ends');
  popup.tick();
  assert.deepStrictEqual(shown(popup), [TROUBLE, 'Retrying now']);
  assert.strictEqual(popup.loads, 2);
  assert.strictEqual(popup.tick, null);
  popup.errored(refused);
  assert.deepStrictEqual(shown(popup), [TROUBLE, COUNTDOWN], 'a failed retry counts down again');
  for (let i = 0; i < 15; i++) popup.tick();
  assert.strictEqual(popup.loads, 3);
  popup.responded(ok);
  await popup.elements.mail.onLoad();
  assert.deepStrictEqual(shown(popup), ['', '']);
  assert.ok(popup.revealed, 'a retry that works shows the mail');

  // An answer for that address, such as another tab's, can't stop the retries after a failure.
  popup = await openPopup();
  popup.responded(badGateway);
  popup.responded({ ...workerOk, originUrl: `${BASE}/sw.js?v=1` });
  assert.deepStrictEqual(shown(popup), [TROUBLE, COUNTDOWN]);
  for (let i = 0; i < 15; i++) popup.tick();
  assert.strictEqual(popup.loads, 2);
  popup.responded(ok);
  await popup.elements.mail.onLoad();
  assert.ok(popup.revealed);

  // Each result tells the watcher once, however many tries or page changes follow.
  popup = await openPopup();
  popup.responded(ok);
  await popup.elements.mail.onLoad();
  await popup.elements.mail.onLoad();
  assert.deepStrictEqual(popup.hints, ['ok']);
  popup = await openPopup();
  popup.responded(badGateway);
  for (let i = 0; i < 15; i++) popup.tick();
  popup.responded(badGateway);
  assert.deepStrictEqual(popup.hints, ['failed']);
  for (let i = 0; i < 15; i++) popup.tick();
  popup.responded(ok);
  await popup.elements.mail.onLoad();
  assert.deepStrictEqual(popup.hints, ['failed', 'ok']);
  popup = await openPopup();
  popup.timers[SLOW_LOAD]();
  assert.deepStrictEqual(popup.hints, ['failed'], 'no answer counts too');
  popup = await openPopup();
  popup.responded(workerOk);
  await popup.elements.mail.onLoad();
  popup.responded(workerOk);
  await popup.elements.mail.onLoad();
  assert.deepStrictEqual(popup.hints, [], 'Offline mode says nothing about the server');

  // A connection lost partway through the page counts as failed, after an answer too.
  popup = await openPopup();
  popup.responded(ok);
  popup.errored(refused);
  assert.deepStrictEqual(shown(popup), [TROUBLE, COUNTDOWN]);

  // No answer shows the message and countdown together, and a late answer still counts.
  popup = await openPopup();
  popup.timers[SLOW_LOAD]();
  assert.deepStrictEqual(shown(popup), [TROUBLE, COUNTDOWN]);
  popup.responded(ok);
  assert.deepStrictEqual(shown(popup), [TROUBLE, ''], 'answered, so no countdown');
  assert.strictEqual(popup.tick, null);
  await popup.elements.mail.onLoad();
  assert.deepStrictEqual(shown(popup), ['', '']);
  assert.ok(popup.revealed);
  popup = await openPopup();
  popup.timers[SLOW_LOAD]();
  await popup.elements.mail.onLoad();
  assert.strictEqual(popup.tick, null, 'a load with no reports stops the countdown too');
  assert.ok(popup.revealed);

  // A real connection failure counts, but a cancelled load says nothing about the server.
  popup = await openPopup();
  popup.errored({ ...refused, error: 'NS_BINDING_ABORTED' });
  popup.errored({ ...refused, error: 'net::ERR_ABORTED' });
  assert.deepStrictEqual(shown(popup), ['', '']);
  popup.errored({ ...refused, error: 'net::ERR_CONNECTION_ABORTED' });
  assert.deepStrictEqual(shown(popup), [TROUBLE, COUNTDOWN]);

  // Failures in the hidden frame, the extension's other requests, or pages Bulwark opens itself, aren't the overlay's.
  popup = await openPopup();
  popup.responded({ ...badGateway, url: `${BASE}/api/version`, initiator: EXTENSION });
  popup.responded({ ...badGateway, type: 'xmlhttprequest', url: `${BASE}/manifest.webmanifest`, initiator: EXTENSION });
  popup.responded({ ...badGateway, url: `${BASE}/plugin-sandbox`, initiator: 'https://mail.test:8443' });
  popup.errored({ ...refused, initiator: undefined });
  await popup.elements.mail.onLoad();
  assert.deepStrictEqual(shown(popup), ['', '']);
  assert.ok(popup.revealed);

  // The hidden frame's heartbeat: each scenario starts with a frame just loaded.
  const FIRST_BEAT = 30_000;
  const SILENCE = 150_000;
  const openHost = () => {
    let now = 0;
    const host = { loads: 0, commands: [], statuses: [] };
    const context = {
      browser: { runtime: { onMessage: { addListener: (listener) => { host.message = listener; } } } },
      Date: { now: () => now },
      document: {
        createElement: () => ({
          contentWindow: { postMessage: (command) => host.commands.push(command) },
          remove() {},
          set src(value) { host.loads += 1; },
        }),
        body: { append() {} },
      },
      handleMessage: ({ status }) => host.statuses.push(status),
      location: { search: '' },
      setInterval: (work) => { host.check = work; },
      URLSearchParams,
      window: { addEventListener: (type, listener) => { host.windowMessage = listener; } },
    };
    context.globalThis = context;
    vm.runInNewContext(fs.readFileSync(`${__dirname}/../src/host.js`, 'utf8'), context);
    host.load = (base = 'https://mail.test/webmail') => vm.runInNewContext(`loadWatcher("${base}")`, context);
    host.after = (ms) => {
      now += ms;
      host.check();
    };
    host.load();
    return host;
  };

  let host = openHost();
  host.load();
  assert.deepStrictEqual(host.statuses, ['connecting'], 'a repeat for the same address mustn\'t reset the badge');
  assert.strictEqual(host.loads, 1);
  host.after(FIRST_BEAT - 1);
  assert.deepStrictEqual(host.statuses, ['connecting']);
  host.after(1);
  assert.deepStrictEqual(host.statuses, ['connecting', 'error'], 'no first beat in time');
  assert.strictEqual(host.loads, 2);
  host.after(SILENCE - 1);
  assert.strictEqual(host.loads, 2, 'later reloads wait longer');
  host.after(1);
  assert.strictEqual(host.loads, 3);

  // A beat moves the deadline, and nothing else does.
  host = openHost();
  host.windowMessage({ data: 'something-else' });
  host.windowMessage({ data: 'bridge-alive' });
  host.after(SILENCE - 1);
  assert.strictEqual(host.loads, 1);
  host.windowMessage({ data: 'something-else' });
  host.after(1);
  assert.strictEqual(host.loads, 2);

  // The overlay's result makes the watcher check at once.
  host = openHost();
  host.message({ overlayLoad: 'failed' });
  assert.deepStrictEqual(host.commands, ['bridge-check']);
  assert.strictEqual(host.loads, 1, 'the frame stays as it is');
  host.message({ overlayLoad: 'ok' });
  assert.deepStrictEqual(host.commands, ['bridge-check', 'bridge-recheck'], 'a frame not yet late checks for itself');
  assert.strictEqual(host.loads, 1);

  host = openHost();
  host.after(FIRST_BEAT);
  host.statuses.length = 0;
  host.message({ overlayLoad: 'ok' });
  assert.strictEqual(host.loads, 3, 'a silent frame loads again at once');
  assert.deepStrictEqual(host.statuses, ['connecting']);
  assert.deepStrictEqual(host.commands, []);
  host.after(FIRST_BEAT - 1);
  assert.strictEqual(host.loads, 3);
  host.message({ overlayLoad: 'ok' });
  assert.strictEqual(host.loads, 3, 'once for each missed beat');
  assert.deepStrictEqual(host.commands, ['bridge-recheck']);
  host.after(1);
  assert.strictEqual(host.loads, 4, 'with the shorter wait for a first beat');
  host.windowMessage({ data: 'bridge-alive' });
  host.commands.length = 0;
  host.message({ overlayLoad: 'ok' });
  assert.deepStrictEqual(host.commands, ['bridge-recheck'], 'a running bridge checks for itself');
  assert.strictEqual(host.loads, 4);

  // A new address starts clean, even if the old frame had gone silent.
  host = openHost();
  host.after(FIRST_BEAT);
  host.load('https://other.test/webmail');
  const loadsNow = host.loads;
  host.message({ overlayLoad: 'ok' });
  assert.strictEqual(host.loads, loadsNow);

  // What each status shows on the badge.
  const statusCode = background.slice(background.indexOf('function describeProblem'), background.indexOf('async function iconUrl'));
  const badge = {};
  const statusContext = {
    action: {
      setBadgeBackgroundColor: ({ color }) => { badge.color = color; },
      setBadgeText: ({ text }) => { badge.text = text; },
      setTitle: ({ title }) => { badge.title = title; },
    },
    api: { storage: { local: { get: async () => ({ idle: true }), set: async () => {} } } },
    BADGE_COLOR: 'red',
    BADGE_CONNECTING_COLOR: 'grey',
    BADGE_PARTIAL_COLOR: 'amber',
    wiggling: true,
  };
  vm.runInNewContext(statusCode, statusContext);
  const badgeFor = async (message) => {
    await vm.runInNewContext(`showStatus(${JSON.stringify(message)})`, statusContext);
    return { ...badge };
  };
  assert.deepStrictEqual(await badgeFor({ status: 'connecting' }), { color: 'grey', text: '…', title: 'Connecting…' });
  assert.deepStrictEqual(await badgeFor({ status: 'error' }), { color: 'red', text: '!', title: 'Can\'t reach your mail. Retrying.' });
  assert.deepStrictEqual(await badgeFor({ status: 'ok', unread: 0 }), { color: 'red', text: '', title: 'No unread mail' });
  assert.strictEqual((await badgeFor({ status: 'ok', unread: 3 })).text, '3');
  const failedLogin = { username: 'v', problem: 'error', detail: 'x' };
  assert.deepStrictEqual(await badgeFor({ status: 'ok', unread: 3, problems: [failedLogin] }), { color: 'amber', text: '3', title: 'Can\'t reach mail: v (x)' });

  process.exitCode = 0;
  console.log('all checks passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
