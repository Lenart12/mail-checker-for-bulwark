// Runs on the Bulwark origin, in the hidden frame only. Credentials stay in this scope.
(() => {
  if (window.parent === window) return;

  const api = globalThis.browser ?? chrome;
  const base = location.href.replace(/\/api\/version.*$/, '');
  const CAPABILITIES = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'];
  const MAX_CHANGE_PAGES = 5;
  const MARK_READ_BATCH = 100;
  // Stalwart answers a stored password with 402 once the account has 2FA. Renewing can't help that, so only 401 retries.
  const LOGIN_REFUSED = new Set([401, 402]);
  const STREAM_SILENCE_MS = 90_000; // Three missed 30s pings.
  const REQUEST_TIMEOUT_MS = 30_000;
  const RECONNECT_DELAY_MS = 3000;
  const MAX_RECONNECT_DELAY_MS = 60_000;
  const MIN_RECHECK_GAP_MS = 6000; // Repeated refusals can get an address banned at the server.
  const HEARTBEAT_MS = 60_000;
  const DEFAULT_RULES = { notify: 'unmuted', badge: 'always' };
  const SOUND_FILES = {
    cheerful: 'cheerful-527.mp3',
    involved: 'involved-notification.mp3',
    swift: 'notification-tone-swift-gesture.mp3',
    relax: 'relax-message-tone.mp3',
  };

  // In Firefox MV2 only content.fetch acts as the page, which Bulwark and the mail server's CORS expect.
  const pageFetch = typeof content !== 'undefined' && content.fetch
    ? (url, init = {}) => content.fetch(url, cloneInto(init, content))
    : (url, init) => fetch(url, init);

  // Parsing the text gives plain objects here. In Firefox, res.json() from a page fetch gives the page's objects.
  const parsed = async (res) => JSON.parse(await res.text());
  const send = (message) => api.runtime.sendMessage(message).catch(() => {});
  const stored = (key) => JSON.parse(localStorage.getItem(key) || 'null')?.state ?? {};
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function withinTime(promise, what) {
    const tooLate = sleep(REQUEST_TIMEOUT_MS).then(() => {
      throw new Error(`${what} timed out`);
    });
    return Promise.race([promise, tooLate]);
  }

  class AuthError extends Error {
    constructor(status) {
      super(`Auth failed: ${status}`);
      this.status = status;
    }
  }

  async function tokenFromBulwark(account, force) {
    const query = `${force ? '&force=true' : ''}${account.rememberMe === false ? '&remember=false' : ''}`;
    const res = await pageFetch(`${base}/api/auth/token?slot=${account.cookieSlot}${query}`, { method: 'PUT' });
    if (!res.ok) throw new AuthError(res.status);
    return `Bearer ${(await parsed(res)).access_token}`;
  }

  // Holds the lock until work finishes, and answers with work's result.
  function withLock(name, options, work) {
    return new Promise((resolve, reject) => {
      const callback = (granted) => {
        const result = work(granted);
        result.then(resolve, reject);
        return result;
      };
      if (typeof exportFunction === 'undefined') {
        navigator.locks.request(name, options, callback).catch(reject);
        return;
      }
      // Through a content script's view of navigator, Firefox denies the lock access to the
      // callback's promise and lets go at once. So ask from the page's side, with its own promise.
      const page = window.wrappedJSObject;
      page.navigator.locks.request(name, cloneInto(options, window), exportFunction((granted) => {
        const result = callback(granted);
        return new page.Promise(exportFunction((release) => {
          result.then(() => release(), () => release());
        }, window));
      }, window)).catch(exportFunction(reject, window));
    });
  }

  // Refresh tokens rotate, and Stalwart can treat parallel renewals as a replay and revoke the login.
  // Newer Bulwark versions take this same lock in their tabs. 1.20.0 doesn't, so there it only covers this frame.
  async function oauthHeader(account, force) {
    const lock = `bulwark-token-refresh:${account.cookieSlot}`;
    const held = await withLock(lock, { ifAvailable: true }, async (granted) => (
      granted ? tokenFromBulwark(account, force) : null
    ));
    // Another window was renewing, so its fresh token is in the cookie: never force after waiting.
    return held ?? withLock(lock, {}, () => tokenFromBulwark(account, false));
  }

  async function authHeader(account, force) {
    if (account.authMode === 'oauth') return oauthHeader(account, force);
    const res = await pageFetch(`${base}/api/auth/session?slot=${account.cookieSlot}`, { method: 'PUT' });
    if (!res.ok) throw new AuthError(res.status);
    const { token, username, password } = await parsed(res);
    return token ? `Bearer ${token}` : `Basic ${btoa(`${username}:${password}`)}`;
  }

  async function authed(watcher, url, init = {}) {
    const attempt = () => pageFetch(url, { ...init, headers: { ...init.headers, Authorization: watcher.auth } });
    watcher.auth ??= await authHeader(watcher.account, false);
    let res = await attempt();
    if (res.status === 401) {
      // A tab may have renewed already: force only if the cookie still holds the refused token.
      const refused = watcher.auth;
      watcher.auth = await authHeader(watcher.account, false);
      if (watcher.auth === refused) watcher.auth = await authHeader(watcher.account, true);
      res = await attempt();
    }
    if (LOGIN_REFUSED.has(res.status)) throw new AuthError(res.status);
    return res;
  }

  // Each account has its own settings on the server when sync is on. The local copy only
  // mirrors the active account, so it's for when sync is off or the server can't answer.
  async function alertSettings(account) {
    const fetchSettings = async () => {
      const res = await pageFetch(`${base}/api/settings`, {
        headers: { 'x-settings-username': account.username, 'x-settings-server': account.serverUrl },
      });
      return res.ok ? (await parsed(res)).settings ?? {} : stored('settings-storage');
    };
    return withinTime(fetchSettings(), 'Settings').catch(() => stored('settings-storage'));
  }

  // Per-account rules from the extension's settings: 'always', 'unmuted' or 'never'.
  let accountRules = {};
  const ruleFor = (username) => ({ ...DEFAULT_RULES, ...accountRules[username] });

  function isMuted(mutes, accountId, mailboxId) {
    return mutes?.mailboxes?.[`${accountId}/${mailboxId}`] ?? !!mutes?.accounts?.includes(accountId);
  }

  function summarize(email, account, accountId) {
    const sender = email.from?.[0];
    return {
      from: sender?.name || sender?.email || 'New mail',
      subject: email.subject || '(no subject)',
      preview: email.preview || '',
      username: watchers.size > 1 ? account.username : undefined,
      url: `${base}/mail/message/${encodeURIComponent(email.id)}?slot=${account.cookieSlot}&owner=${encodeURIComponent(accountId)}`,
    };
  }

  async function alertNewMail(account, jmap, accountId, inbox, created) {
    const { list } = await jmap('Email/get', {
      ids: created,
      properties: ['from', 'subject', 'preview', 'mailboxIds', 'keywords'],
    });
    const rule = ruleFor(account.username).notify;
    if (rule === 'never') return;
    const settings = await alertSettings(account);
    const bulwarkAlerts = settings.emailNotificationsEnabled !== false && !settings.doNotDisturb
      && !isMuted(settings.notificationMutes, accountId, inbox);
    if (!bulwarkAlerts && rule !== 'always') return;
    const mail = list
      .filter((email) => email.mailboxIds?.[inbox] && !email.keywords?.$draft)
      .map((email) => summarize(email, account, accountId));
    if (!mail.length) return;
    // Bulwark's "default" beep is synthesized, so it plays as the involved file. An oscillator would match it.
    const sound = settings.emailNotificationSound === false
      ? null
      : SOUND_FILES[settings.notificationSoundChoice] ?? SOUND_FILES.involved;
    const isActiveAccount = account.id === stored('account-registry').activeAccountId;
    send({
      mail,
      base,
      sound,
      isActiveAccount,
      // An open tab follows Bulwark's own settings, so it stays quiet for mail only the 'always' rule lets through.
      tabMayAlert: isActiveAccount && bulwarkAlerts,
      // Chromium's background worker has no matchMedia, so this frame asks.
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      inboxUrl: `${base}/mail/folder/inbox?slot=${account.cookieSlot}&owner=${encodeURIComponent(accountId)}`,
    });
  }

  // Same rule as Bulwark's reportNewInboxMail: created since the baseline, in the Inbox, not a draft.
  // The baseline only moves once the alert is out, so a failed request tries the same mail again.
  async function reportNewMail(watcher, jmap, accountId, inbox) {
    const created = [];
    let state = watcher.emailState;
    for (let page = 0; page < MAX_CHANGE_PAGES; page++) {
      const delta = await jmap('Email/changes', { sinceState: state }).catch((error) => {
        if (error.jmapType === 'cannotCalculateChanges') return null;
        throw error;
      });
      if (!delta) {
        // The baseline is too old for the server; start over from here.
        watcher.emailState = (await jmap('Email/get', { ids: [] })).state;
        return;
      }
      created.push(...delta.created);
      state = delta.newState;
      if (!delta.hasMoreChanges) break;
    }
    if (created.length) await alertNewMail(watcher.account, jmap, accountId, inbox, created);
    watcher.emailState = state;
  }

  // The server may report a base it can't be reached on behind a proxy, so like Bulwark, use the origin
  // it logged in to. Slices the string because these URLs can hold {templates} that URL would encode.
  function onServerOrigin(url, serverUrl) {
    const { origin } = new URL(serverUrl);
    if (!/^(https?:)?\/\//i.test(url)) return origin + (url.startsWith('/') ? url : `/${url}`);
    const pathStart = url.indexOf('/', url.indexOf('//') + 2);
    return origin + (pathStart === -1 ? '' : url.slice(pathStart));
  }

  function changedTypes(event, accountId) {
    if (!/^event:\s*state/m.test(event)) return null;
    const data = event.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
    try {
      return JSON.parse(data).changed?.[accountId];
    } catch {
      return null; // A malformed event shouldn't drop the connection. The next one catches up.
    }
  }

  async function readEvents(watcher, stream, accountId, update) {
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    watcher.cancel = () => reader.cancel().catch(() => {});
    try {
      // Anything that arrived while disconnected.
      await update();
      let buffer = '';
      while (!watcher.stopped) {
        const chunk = await Promise.race([reader.read(), sleep(STREAM_SILENCE_MS)]);
        if (!chunk || chunk.done) return;
        buffer += decoder.decode(chunk.value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop();
        for (const event of events) {
          const changed = changedTypes(event, accountId);
          if (changed?.Email || changed?.Mailbox) await update();
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  async function connect(watcher) {
    const { account } = watcher;
    watcher.lastAttempt = Date.now();
    // Read again on each connection, so Bulwark's session limits still apply.
    watcher.auth = null;
    const serverUrl = account.serverUrl.replace(/\/$/, '');
    const session = await withinTime((async () => {
      const res = await authed(watcher, `${serverUrl}/.well-known/jmap`);
      if (!res.ok) throw new Error(`JMAP session: ${res.status}`);
      return parsed(res);
    })(), 'JMAP session');
    const accountId = session.primaryAccounts[CAPABILITIES[1]];
    const apiUrl = onServerOrigin(session.apiUrl, serverUrl);

    const jmap = (method, args) => withinTime((async () => {
      const res = await authed(watcher, apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ using: CAPABILITIES, methodCalls: [[method, { accountId, ...args }, 'c']] }),
      });
      if (!res.ok) throw new Error(`JMAP: ${res.status}`);
      const [[name, result]] = (await parsed(res)).methodResponses;
      if (name === 'error') throw Object.assign(new Error(`${method}: ${result.type}`), { jmapType: result.type });
      return result;
    })(), method);
    const readMailboxes = async () => {
      const { list } = await jmap('Mailbox/get', { properties: ['role', 'unreadEmails'] });
      const inbox = list.find((mailbox) => mailbox.role === 'inbox');
      watcher.unread = inbox.unreadEmails;
      watcher.muted = ruleFor(account.username).badge === 'unmuted'
        && isMuted((await alertSettings(account)).notificationMutes, accountId, inbox.id);
      return inbox.id;
    };

    let inbox = await readMailboxes();
    report();
    watcher.emailState ??= (await jmap('Email/get', { ids: [] })).state;

    // Push events and menu commands take turns, or one message could alert twice.
    const inTurn = (task) => {
      watcher.queue = (watcher.queue ?? Promise.resolve()).catch(() => {}).then(task);
      return watcher.queue;
    };
    const sync = async () => {
      await reportNewMail(watcher, jmap, accountId, inbox);
      inbox = await readMailboxes();
      watcher.problem = null;
      report();
    };
    const update = () => inTurn(sync);
    const markInboxRead = async () => {
      for (;;) {
        const { ids } = await jmap('Email/query', {
          filter: { inMailbox: inbox, notKeyword: '$seen' },
          limit: MARK_READ_BATCH,
        });
        if (!ids.length) break;
        const result = await jmap('Email/set', {
          update: Object.fromEntries(ids.map((id) => [id, { 'keywords/$seen': true }])),
        });
        // Nothing changed, so the server would hand back the same batch forever.
        if (!Object.keys(result.updated ?? {}).length) break;
      }
      await sync();
    };
    watcher.commands = { refresh: update, 'mark-read': () => inTurn(markInboxRead) };

    const eventSourceUrl = session.eventSourceUrl || session.capabilities?.[CAPABILITIES[0]]?.eventSourceUrl;
    if (!eventSourceUrl) throw new Error('The server offers no push stream');
    const streamUrl = onServerOrigin(eventSourceUrl, serverUrl)
      .replace('{types}', '*').replace('{closeafter}', 'no').replace('{ping}', '30');
    // The stream may not answer until its first ping, and a dead connection never does.
    const opening = authed(watcher, streamUrl, { headers: { Accept: 'text/event-stream' } });
    const stream = await Promise.race([opening, sleep(STREAM_SILENCE_MS)]);
    if (!stream) {
      opening.then((late) => late.body?.cancel()).catch(() => {});
      return;
    }
    if (!stream.ok) throw new Error(`Push stream: ${stream.status}`);
    watcher.delay = RECONNECT_DELAY_MS;
    await readEvents(watcher, stream, accountId, update);
  }

  function fail(watcher, error) {
    watcher.auth = null;
    watcher.problem = error instanceof AuthError && LOGIN_REFUSED.has(error.status) ? 'logged-out' : 'error';
    watcher.detail = error.message;
    report();
  }

  async function watch(watcher) {
    while (!watcher.stopped) {
      try {
        await connect(watcher);
      } catch (error) {
        watcher.delay = Math.min(watcher.delay * 2, MAX_RECONNECT_DELAY_MS);
        fail(watcher, error);
      }
      if (watcher.stopped) return;
      await Promise.race([sleep(watcher.delay), new Promise((resolve) => { watcher.wake = resolve; })]);
      watcher.wake = null;
    }
  }

  const watchers = new Map();

  const describe = (w) => ({ username: w.account.username, problem: w.problem, detail: w.detail });

  function badgeCount(w) {
    const rule = ruleFor(w.account.username).badge;
    return rule === 'never' || (rule === 'unmuted' && w.muted) ? 0 : w.unread;
  }

  function report() {
    const all = [...watchers.values()];
    if (!all.length) {
      send({ status: 'logged-out' });
      return;
    }
    const failing = all.filter((w) => w.problem);
    const working = all.filter((w) => !w.problem);
    if (!working.length) {
      send({ status: failing[0].problem, problems: failing.map(describe) });
      return;
    }
    if (working.some((w) => w.unread === undefined)) {
      send({ status: 'connecting', problems: failing.map(describe) }); // Don't claim 0.
      return;
    }
    send({
      status: 'ok',
      unread: working.reduce((sum, w) => sum + badgeCount(w), 0),
      problems: failing.map(describe),
    });
  }

  function syncAccounts() {
    const accounts = stored('account-registry').accounts ?? [];
    // The login method is part of the key: logging in again with 2FA turns a password login into OAuth.
    const keyOf = (a) => `${a.cookieSlot}:${a.username}:${a.authMode}`;
    const keys = new Set(accounts.map(keyOf));
    for (const [key, watcher] of watchers) {
      if (keys.has(key)) continue;
      watcher.stopped = true;
      watcher.cancel?.();
      watchers.delete(key);
    }
    for (const account of accounts) {
      const key = keyOf(account);
      if (watchers.has(key)) continue;
      const watcher = { account, delay: RECONNECT_DELAY_MS };
      watchers.set(key, watcher);
      watch(watcher);
    }
    send({ accounts: accounts.map((a) => a.username) });
    report();
  }

  function heartbeat() {
    window.parent.postMessage('bridge-alive', '*');
    syncAccounts();
  }

  function runCommand(command, targets = watchers.values()) {
    for (const watcher of targets) {
      watcher.lastAttempt = Date.now();
      watcher.commands?.[command]().catch((error) => {
        fail(watcher, error);
        watcher.cancel?.(); // Nothing else retries while the stream stays open.
      });
    }
  }

  const notJustTried = () => [...watchers.values()].filter((w) => Date.now() - w.lastAttempt >= MIN_RECHECK_GAP_MS);

  // The overlay failed, so working accounts may have lost their connection without noticing: check now.
  function checkWorking() {
    runCommand('refresh', notJustTried().filter((w) => !w.problem));
  }

  // The overlay loaded, so Bulwark is up and failing accounts may recover: check now.
  function recheckFailing() {
    const due = notJustTried().filter((w) => w.problem);
    for (const watcher of due) {
      watcher.delay = RECONNECT_DELAY_MS;
      watcher.wake?.();
    }
    runCommand('refresh', due.filter((w) => !w.wake));
  }

  // Scripts match every port of the host, because match patterns can't name one. Only the saved address counts.
  api.storage.local.get(['base', 'accountRules']).then((saved) => {
    if (!location.href.startsWith(`${saved.base}/api/version`)) return;
    accountRules = saved.accountRules ?? {};
    window.addEventListener('storage', (event) => {
      if (event.key === 'account-registry') syncAccounts();
    });
    window.addEventListener('message', (event) => {
      const command = /^bridge-(refresh|mark-read|check|recheck)$/.exec(event.data)?.[1];
      if (command === 'check') checkWorking();
      else if (command === 'recheck') recheckFailing();
      else if (command) runCommand(command);
    });
    api.storage.onChanged.addListener((changes) => {
      if (!changes.accountRules) return;
      accountRules = changes.accountRules.newValue ?? {};
      runCommand('refresh');
    });
    setInterval(heartbeat, HEARTBEAT_MS);
    heartbeat();
  });
})();
