#!/usr/bin/env python3
# Runs the built Firefox add-on, headless, against a fake Bulwark and JMAP server, and fails if it doesn't
# connect and alert. Catches what test.js can't: Firefox's content script rules.
#
# Usage: ./build.sh && python3 test/test-firefox.py [oauth|basic] [idle|clicked|other-folder]
# Environment: OPTIONS and RULES take the JSON to store as options and accountRules. The account is test@x.
import http.server
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse

SOURCE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'dist', 'firefox')
LOGIN_METHOD = sys.argv[1] if len(sys.argv) > 1 else 'oauth'
TAB = sys.argv[2] if len(sys.argv) > 2 else 'idle'
TAB_PATH = '/mail/folder/sent' if TAB == 'other-folder' else '/mail'
OPTIONS = os.environ.get('OPTIONS', '{}')
RULES = os.environ.get('RULES', '{}')
PORT = 8799
ORIGIN = f'http://127.0.0.1:{PORT}'
BASE = f'{ORIGIN}/app'
MARIONETTE_PORT = 2829
log = []
messages = []
state = {'email': 's1', 'stream': None, 'in_token_request': False}


class FakeServer(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def reply(self, code, body, content_type='application/json', headers=()):
        data = body.encode() if isinstance(body, str) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
        for name, value in headers:
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.reply(204, '')

    def handle_request(self):
        length = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(length) if length else b''
        url = urllib.parse.urlparse(self.path)
        path = url.path
        if path == '/msg':
            message = json.loads(urllib.parse.parse_qs(url.query)['m'][0])
            messages.append(message)
            log.append(f'MESSAGE: {message}')
            return self.reply(200, {})
        if path == '/command':
            command, state['command'] = state.get('command', ''), ''
            return self.reply(200, command, 'text/plain')
        if path == '/app' + TAB_PATH:
            account = {
                'id': 'login-1', 'cookieSlot': 0, 'username': 'test@x', 'serverUrl': ORIGIN,
                'authMode': LOGIN_METHOD, 'rememberMe': True,
            }
            registry = json.dumps({'state': {'activeAccountId': 'login-1', 'accounts': [account]}})
            page = f"<!doctype html><script>localStorage.setItem('account-registry', {json.dumps(registry)})</script><button>x</button>"
            return self.reply(200, page, 'text/html')
        if path == '/app/api/version':
            log.append(f'{self.command} {path}')
            return self.reply(200, {'buildId': 'x'}, headers=[('X-Frame-Options', 'DENY')])
        if path in ('/app/api/auth/token', '/app/api/auth/session'):
            site = self.headers.get('Sec-Fetch-Site')
            log.append(f'{self.command} {path} query={url.query} sec-fetch-site={site}')
            if self.command == 'PUT' and site != 'same-origin':
                return self.reply(403, {'error': 'cross-origin'})
            if 'token' in path:
                # Long enough for the test to see the lock held during the request.
                state['in_token_request'] = True
                time.sleep(3)
                state['in_token_request'] = False
                return self.reply(200, {'access_token': 'tok', 'expires_in': 3600})
            return self.reply(200, {'username': 'test@x', 'password': 'p'})
        if path == '/app/api/settings':
            log.append(f'{self.command} {path} for={self.headers.get("x-settings-username")}')
            return self.reply(200, {'settings': {'notificationSoundChoice': 'relax'}})
        if path == '/.well-known/jmap':
            log.append(f'{self.command} {path}')
            # An internal address, as behind a proxy: the add-on must use the origin it logged in to.
            return self.reply(200, {
                'primaryAccounts': {'urn:ietf:params:jmap:mail': 'a1'},
                'apiUrl': 'http://internal.invalid/jmap/api',
                'eventSourceUrl': 'http://internal.invalid/jmap/events?types={types}&closeafter={closeafter}&ping={ping}',
            })
        if path == '/jmap/api':
            return self.reply(200, {'methodResponses': [jmap_response(*call) for call in json.loads(raw)['methodCalls']]})
        if path == '/jmap/events':
            log.append('STREAM opened')
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Connection', 'close')
            self.end_headers()
            state['stream'] = self
            self.wfile.write(b'event: ping\ndata: {}\n\n')
            self.wfile.flush()
            time.sleep(40)
            self.close_connection = True
            return None
        return self.reply(404, {})

    do_GET = do_PUT = do_POST = handle_request


def jmap_response(name, args, tag):
    log.append(f'JMAP {name}')
    if name == 'Mailbox/get':
        return [name, {'list': [{'id': 'in', 'role': 'inbox', 'unreadEmails': 5}]}, tag]
    if name == 'Email/changes':
        created = [] if args['sinceState'] == state['email'] else ['m1']
        return [name, {'created': created, 'newState': state['email'], 'hasMoreChanges': False}, tag]
    if name == 'Email/get' and not args['ids']:
        return [name, {'state': state['email'], 'list': []}, tag]
    email = {'id': 'm1', 'from': [{'name': 'Ana'}], 'subject': 'Hi', 'preview': 'p', 'mailboxIds': {'in': True}, 'keywords': {}, 'receivedAt': '2026-11-05T10:00:00Z'}
    return [name, {'list': [email]}, tag]


def prepared_extension(folder):
    """A copy of the build that already has its permission and address, and reports what it would only show in the UI."""
    extension = os.path.join(folder, 'extension')
    shutil.copytree(SOURCE, extension)
    with open(f'{extension}/manifest.json') as file:
        manifest = json.load(file)
    manifest['permissions'].append('http://127.0.0.1/*')
    manifest['background']['scripts'].insert(0, 'seed.js')
    with open(f'{extension}/manifest.json', 'w') as file:
        json.dump(manifest, file)
    with open(f'{extension}/seed.js', 'w') as file:
        file.write(f"""browser.storage.local.set({{ base: {json.dumps(BASE)}, options: {OPTIONS}, accountRules: {RULES} }});
const report = (m) => fetch('{ORIGIN}/msg?m=' + encodeURIComponent(JSON.stringify(m)));
browser.runtime.onMessage.addListener((m) => {{ if (m.status || m.mail) report(m); }});
addEventListener('unhandledrejection', (e) => report({{ unhandled: String(e.reason) }}));
browser.commands.getAll().then((commands) => report({{
  commands: commands.map((c) => c.name),
  openShortcutSettings: typeof browser.commands.openShortcutSettings,
}}));
const createMenu = browser.contextMenus.create;
browser.contextMenus.create = (props, done) => createMenu(props, () => {{
  if (browser.runtime.lastError) report({{ menuError: `${{props.id}}: ${{browser.runtime.lastError.message}}` }});
  done?.();
}});
// The test pauses and resumes through the fake server, as the menu would.
setInterval(async () => {{
  const command = await (await fetch('{ORIGIN}/command')).text();
  if (command === 'pause') await pauseUntil('pause-indefinitely');
  if (command === 'resume') await endPause();
  if (command) report({{ done: command, title: await browser.browserAction.getTitle({{}}) }});
}}, 500);
const createNotification = browser.notifications.create;
browser.notifications.create = (id, o) => {{ report({{ notification: o.title, message: o.message }}); return createNotification(id, o); }};
setTimeout(() => {{ globalThis.playSound = (url, volume) => report({{ extensionPlayed: url, volume }}); }}, 100);""")
    return extension


class Marionette:
    def __init__(self):
        for _ in range(60):
            try:
                self.sock = socket.create_connection(('127.0.0.1', MARIONETTE_PORT), timeout=30)
                break
            except OSError:
                time.sleep(1)
        else:
            raise SystemExit('Marionette never came up')
        self.next_id = 0
        self.receive()

    def receive(self):
        length = b''
        while (byte := self.sock.recv(1)) != b':':
            length += byte
        data = b''
        while len(data) < int(length):
            data += self.sock.recv(int(length) - len(data))
        return json.loads(data)

    def command(self, name, params=None):
        self.next_id += 1
        body = json.dumps([0, self.next_id, name, params or {}]).encode()
        self.sock.sendall(str(len(body)).encode() + b':' + body)
        _, _, error, result = self.receive()
        if error:
            raise SystemExit(f'{name}: {error}')
        return result


def exercise_addon(browser, extension):
    browser.command('WebDriver:NewSession', {'capabilities': {'alwaysMatch': {'moz:webdriverClick': True}}})
    print('browser:', browser.command('WebDriver:ExecuteScript', {'script': 'return navigator.userAgent', 'args': []})['value'])
    browser.command('WebDriver:Navigate', {'url': BASE + TAB_PATH})
    if TAB != 'idle':
        button = browser.command('WebDriver:FindElement', {'using': 'css selector', 'value': 'button'})['value']
        browser.command('WebDriver:ElementClick', {'id': next(iter(button.values()))})
    browser.command('Addon:Install', {'path': extension, 'temporary': True})

    locks_during_token_request = []
    for _ in range(40):
        locks = browser.command('WebDriver:ExecuteAsyncScript', {
            'script': 'navigator.locks.query().then(s => arguments[0](s.held.map(l => l.name)))', 'args': [],
        })['value']
        if state['in_token_request']:
            locks_during_token_request = locks
            break
        time.sleep(0.2)
    time.sleep(9)

    print('--- new mail arrives')
    state['email'] = 's2'
    if state['stream']:
        state['stream'].wfile.write(b'event: state\ndata: {"changed":{"a1":{"Email":"s2"}}}\n\n')
        state['stream'].wfile.flush()
    time.sleep(4)

    print('--- new mail arrives while the add-on is away, and no push announces it')
    state['alerts_before_reload'] = sum('mail' in message for message in messages)
    state['email'] = 's3'
    browser.command('Addon:Install', {'path': extension, 'temporary': True})
    time.sleep(12)

    print('--- paused: new mail stays quiet, and resuming sums it up')
    state['command'] = 'pause'
    time.sleep(2)
    state['email'] = 's4'
    if state['stream']:
        try:
            state['stream'].wfile.write(b'event: state\ndata: {"changed":{"a1":{"Email":"s4"}}}\n\n')
            state['stream'].wfile.flush()
        except OSError:
            pass  # The stream closed; the reconnect finds the mail instead.
    time.sleep(6)
    state['command'] = 'resume'
    time.sleep(2)
    return locks_during_token_request


def failures(locks_during_token_request):
    found = []
    if 'STREAM opened' not in log:
        found.append('the push stream never opened')
    for message in messages:
        if 'unhandled' in message:
            found.append(f'unhandled rejection: {message["unhandled"]}')
        if message.get('problems') or message.get('status') in ('error', 'logged-out'):
            found.append(f'reported a problem: {message}')
    for message in messages:
        if 'menuError' in message:
            found.append(f'a menu entry failed: {message["menuError"]}')
    done = [i for i, message in enumerate(messages) if 'done' in message]
    if len(done) != 2:
        found.append(f'pause and resume did not both run: {[messages[i] for i in done]}')
    elif json.loads(RULES).get('test@x', {}).get('notify') != 'never':
        if not messages[done[0]]['title'].startswith('Notifications paused'):
            found.append(f'the tooltip does not show the pause: {messages[done[0]]["title"]!r}')
        # Resuming creates the summary before it reports back.
        notified = [m['notification'] for m in messages[done[0]:done[1]] if 'notification' in m]
        if notified != ['1 new message while paused']:
            found.append(f'expected only the summary between pausing and resuming: {notified}')
    if not any('_execute_browser_action' in message.get('commands', []) for message in messages):
        found.append('the toolbar shortcut is not offered')
    if not any(message.get('openShortcutSettings') == 'function' for message in messages):
        found.append('the settings page can\'t open Firefox\'s shortcut settings')
    if LOGIN_METHOD == 'oauth' and 'bulwark-token-refresh:0' not in locks_during_token_request:
        found.append(f'the lock was not held during the token request: {locks_during_token_request}')
    rules = json.loads(RULES).get('test@x', {})
    if rules.get('notify') != 'never' and not any('mail' in message for message in messages):
        found.append('no new mail alert was sent')
    if rules.get('notify') != 'never' and sum('mail' in message for message in messages) <= state['alerts_before_reload']:
        found.append('no alert for mail that arrived while the add-on was away')
    if rules.get('notify') == 'never' and any('mail' in message for message in messages):
        found.append('an alert was sent despite the never rule')
    return found


def main():
    server = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), FakeServer)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory() as folder:
        extension = prepared_extension(folder)
        profile = os.path.join(folder, 'profile')
        os.makedirs(profile)
        with open(f'{profile}/user.js', 'w') as file:
            file.write(f'user_pref("marionette.port", {MARIONETTE_PORT});\n')
            file.write('user_pref("browser.shell.checkDefaultBrowser", false);\n')
            file.write('user_pref("datareporting.policy.dataSubmissionEnabled", false);\n')
        firefox = subprocess.Popen(
            ['firefox', '--headless', '--no-remote', '--marionette', '--profile', profile],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        browser = None
        try:
            browser = Marionette()
            locks = exercise_addon(browser, extension)
        finally:
            try:
                if browser:
                    browser.command('Marionette:Quit')
                firefox.wait(timeout=15)
            except (OSError, SystemExit, subprocess.TimeoutExpired):
                firefox.terminate()
                firefox.wait()
    for line in log:
        print(line)
    found = failures(locks)
    for failure in found:
        print('FAILED:', failure)
    if found:
        sys.exit(1)
    print('all checks passed')


main()
