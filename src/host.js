// Runs in Firefox's background page, or Chromium's offscreen document. In Firefox it shares
// one global scope with background.js, so this can't be called api too.
const hostApi = globalThis.browser ?? chrome;
const WATCHER_PATH = '/api/version';
const BRIDGE_SILENCE_MS = 150_000; // Two and a half missed HEARTBEAT_MS beats from bridge.js.
const FIRST_BEAT_MS = 30_000; // The bridge beats as soon as it loads, so this much silence means it never ran.
const BRIDGE_CHECK_MS = 10_000;

let watcherFrame;
let watcherBase;
let beatDeadline = 0;
let bridgeSilent = false; // True once a frame's heartbeat has been missed, until the next one.

function sendStatus(status) {
  const message = { status };
  if (globalThis.handleMessage) handleMessage(message);
  else hostApi.runtime.sendMessage(message).catch(() => {});
}

function loadFrame(status, waitMs) {
  sendStatus(status);
  // Any small page on Bulwark's origin would do: the bridge only needs the origin and the frame.
  watcherFrame.src = `${watcherBase}${WATCHER_PATH}`;
  beatDeadline = Date.now() + waitMs;
}

function loadWatcher(base) {
  if (watcherFrame && base === watcherBase) return;
  watcherBase = base;
  watcherFrame?.remove();
  watcherFrame = document.createElement('iframe');
  bridgeSilent = false;
  loadFrame('connecting', FIRST_BEAT_MS);
  document.body.append(watcherFrame);
}

function playSound(url, volume) {
  const audio = new Audio(url);
  audio.volume = volume;
  audio.play().catch(() => {});
}

window.addEventListener('message', (event) => {
  if (event.data !== 'bridge-alive') return;
  beatDeadline = Date.now() + BRIDGE_SILENCE_MS;
  bridgeSilent = false;
});

// The frame stays on an error page if the server was down when it loaded.
setInterval(() => {
  if (!watcherFrame || Date.now() < beatDeadline) return;
  loadFrame('error', BRIDGE_SILENCE_MS);
  bridgeSilent = true;
}, BRIDGE_CHECK_MS);

// A frame in a background page has no tab id, so this is the only way to reach the bridge.
function commandWatcher(command) {
  watcherFrame?.contentWindow.postMessage(`bridge-${command}`, '*');
}

function overlayLoaded(result) {
  if (result === 'failed') {
    commandWatcher('check');
  } else if (bridgeSilent) {
    bridgeSilent = false;
    loadFrame('connecting', FIRST_BEAT_MS);
  } else {
    commandWatcher('recheck');
  }
}

hostApi.runtime.onMessage.addListener((msg) => {
  if (msg.overlayLoad) overlayLoaded(msg.overlayLoad);
  if (msg.play) playSound(msg.play, msg.volume);
  if (msg.command) commandWatcher(msg.command);
});

const baseParam = new URLSearchParams(location.search).get('base');
if (baseParam) loadWatcher(baseParam);
