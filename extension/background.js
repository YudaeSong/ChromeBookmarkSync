// 서비스 워커: chrome.bookmarks 이벤트와 허브 WebSocket을 엔진(core.js)에 연결한다.
import { createEngine } from './core.js';
import { HUB_PORT } from './shared.js';

const HUB_URL = `ws://127.0.0.1:${HUB_PORT}`;

let ws = null;
let pingTimer = null;
let retryTimer = null;
let retry = 0;
let email = '';
let lastStatus = {};
let ticks = 0;

function badge(s) {
  const [text, color] = s.blocked ? ['!', '#d93025']
    : !s.connected ? ['OFF', '#80868b']
      : s.stuck ? ['?', '#e8710a']
      : (s.waiting || !s.synced) ? ['…', '#f9ab00']
        : ['', '#1e8e3e'];
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

const engine = createEngine({
  bm: chrome.bookmarks,
  store: { get: (k) => chrome.storage.local.get(k), set: (o) => chrome.storage.local.set(o) },
  send: (obj) => {
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(obj));
    return true;
  },
  uuid: () => crypto.randomUUID(),
  version: chrome.runtime.getManifest().version,
  log: (...a) => console.log('[bmsync]', ...a),
  onStatus: (s) => {
    lastStatus = { ...s, email };
    chrome.storage.local.set({ status: lastStatus });
    badge(s);
  },
});

// 리스너는 최상위에서 동기로 등록해야 서비스 워커가 꺼져 있다가도 이벤트로 깨어난다.
chrome.bookmarks.onCreated.addListener(engine.onCreated);
chrome.bookmarks.onRemoved.addListener(engine.onRemoved);
chrome.bookmarks.onChanged.addListener(engine.onChanged);
chrome.bookmarks.onMoved.addListener(engine.onMoved);
chrome.bookmarks.onChildrenReordered.addListener(engine.onChildrenReordered);
chrome.bookmarks.onImportBegan.addListener(engine.onImportBegan);
chrome.bookmarks.onImportEnded.addListener(engine.onImportEnded);

function scheduleReconnect() {
  clearTimeout(retryTimer);
  const delay = Math.min(60000, 2000 * 2 ** Math.min(retry++, 5));
  retryTimer = setTimeout(connect, delay);
}

// 시작 시 connect()가 최상위·onInstalled·onStartup에서 거의 동시에 불린다. 진행 중인 연결 시도를 공유해 소켓이 둘 생기지 않게 한다.
let connecting = null;
function connect() {
  if (!connecting) connecting = openSocket().finally(() => { connecting = null; });
  return connecting;
}

async function openSocket() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  clearTimeout(retryTimer);
  try {
    email = (await chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' })).email || '';
  } catch { email = ''; }
  await engine.ready;
  const sock = new WebSocket(HUB_URL);
  ws = sock;
  sock.onopen = () => {
    retry = 0;
    engine.onOpen(email);
    clearInterval(pingTimer);
    // 20초마다 메시지를 주고받아야 MV3 서비스 워커가 연결 중에 꺼지지 않는다.
    pingTimer = setInterval(() => { if (sock.readyState === WebSocket.OPEN) sock.send('{"type":"ping"}'); }, 20000);
  };
  sock.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'reload') { engine.idle().then(() => chrome.runtime.reload()); return; }
    engine.onMessage(m);
  };
  sock.onclose = () => {
    if (ws !== sock) return; // 이미 교체된 소켓이면 현재 연결 상태를 건드리지 않는다
    ws = null;
    clearInterval(pingTimer);
    engine.onClose();
    scheduleReconnect();
  };
  sock.onerror = () => {};
}

chrome.alarms.create('tick', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== 'tick') return;
  if (!ws) { connect(); return; }
  if (++ticks % 5 === 0) engine.periodicCheck();
});

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.cmd === 'force') engine.force().then(() => reply({ ok: true }));
  else if (msg?.cmd === 'check') engine.periodicCheck().then(() => reply({ ok: true }));
  else if (msg?.cmd === 'reconnect') { ws?.close(); retry = 0; connect().then(() => reply({ ok: true })); }
  else return false;
  return true;
});

connect();
