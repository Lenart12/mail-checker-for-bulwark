// Runs in Firefox's background page, or Chromium's offscreen document. In Firefox it shares
// one global scope with background.js, so this can't be called api too.
const hostApi = globalThis.browser ?? chrome;
const BRIDGE_SILENCE_MS = 150_000; // Two and a half missed 60s heartbeats.
const BRIDGE_CHECK_MS = 30_000;

let watcherFrame;
let watcherBase;
let lastBeat = 0;

function loadWatcher(base) {
  if (watcherFrame && base === watcherBase) return;
  watcherBase = base;
  watcherFrame?.remove();
  watcherFrame = document.createElement('iframe');
  // Any small page on Bulwark's origin would do: the bridge only needs the origin and the frame.
  watcherFrame.src = `${base}/api/version`;
  document.body.append(watcherFrame);
  lastBeat = Date.now();
}

function playSound(url, volume) {
  const audio = new Audio(url);
  audio.volume = volume;
  audio.play().catch(() => {});
}

window.addEventListener('message', (event) => {
  if (event.data === 'bridge-alive') lastBeat = Date.now();
});

// The frame stays on an error page if the server was down when it loaded.
setInterval(() => {
  if (!watcherFrame || Date.now() - lastBeat < BRIDGE_SILENCE_MS) return;
  const message = { status: 'error' };
  if (globalThis.handleMessage) handleMessage(message);
  else hostApi.runtime.sendMessage(message).catch(() => {});
  watcherFrame.src = `${watcherBase}/api/version`;
  lastBeat = Date.now();
}, BRIDGE_CHECK_MS);

// A frame in a background page has no tab id, so this is the only way to reach the bridge.
function commandWatcher(command) {
  watcherFrame?.contentWindow.postMessage(`bridge-${command}`, '*');
}

hostApi.runtime.onMessage.addListener((msg) => {
  if (msg.play) playSound(msg.play, msg.volume);
  if (msg.command) commandWatcher(msg.command);
});

const baseParam = new URLSearchParams(location.search).get('base');
if (baseParam) loadWatcher(baseParam);
