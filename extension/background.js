// 서비스 워커: 북마크 이벤트·창 포커스·5분 알람·시작을 엔진(core.js)에 연결하고, 네이티브 호스트(hub/host.js)를 부른다.
// 오래 유지하는 연결이 없다. 맞출 때마다 sendNativeMessage가 호스트를 띄우고, 응답을 받으면 호스트는 끝난다.
import { createEngine, newerVersion } from './core.js';
import { HOST_NAME } from './shared.js';

const VERSION = chrome.runtime.getManifest().version;
const FOCUS_DELAY_MS = 300; // 호스트 1회 호출 중앙값 130 ms(S1 실측)보다 넉넉하게
const FOCUS_SKIP_MS = 2000; // 마지막으로 맞춘 지 이만큼 안 됐으면(같은 프로필의 창끼리 전환) 건너뛴다

let email = '';
const emailReady = chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' })
  .then((u) => { email = u?.email || ''; }, () => { email = ''; });

function badge(s) {
  const [text, color] = (s.blocked || s.protocolError) ? ['!', '#d93025']
    : s.hostOk === false ? ['OFF', '#80868b']
      : s.stuck ? ['?', '#e8710a']
        : (s.waiting || !s.synced) ? ['…', '#f9ab00']
          : ['', '#1e8e3e'];
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

// 디스크의 확장 코드가 더 새 버전이면 큐가 빈 뒤 다시 읽는다(Chrome은 새로고침 전까지 옛 서비스 워커를 계속 돌린다).
// 같은 디스크 버전에는 한 번만 한다(다시 읽어도 버전이 그대로인 경우 무한 반복하지 않게).
let reloading = false;
async function checkDiskVersion(v) {
  if (reloading || !newerVersion(v, VERSION)) return;
  const { reloadedFor } = await chrome.storage.local.get('reloadedFor');
  if (reloadedFor === v) return;
  reloading = true;
  await chrome.storage.local.set({ reloadedFor: v });
  engine.idle().then(() => chrome.runtime.reload());
}

const engine = createEngine({
  bm: chrome.bookmarks,
  store: { get: (k) => chrome.storage.local.get(k), set: (o) => chrome.storage.local.set(o) },
  call: (req) => chrome.runtime.sendNativeMessage(HOST_NAME, req),
  uuid: () => crypto.randomUUID(),
  version: VERSION,
  getEmail: async () => { await emailReady; return email; },
  log: (...a) => console.log('[bmsync]', ...a),
  onStatus: (s) => {
    chrome.storage.local.set({ status: { ...s, email, version: VERSION } });
    badge(s);
  },
  onDiskVersion: (v) => { checkDiskVersion(v).catch((e) => console.log('[bmsync] reload check failed', e)); },
});

// 리스너는 최상위에서 동기로 등록해야 서비스 워커가 꺼져 있다가도 이벤트로 깨어난다.
chrome.bookmarks.onCreated.addListener(engine.onCreated);
chrome.bookmarks.onRemoved.addListener(engine.onRemoved);
chrome.bookmarks.onChanged.addListener(engine.onChanged);
chrome.bookmarks.onMoved.addListener(engine.onMoved);
chrome.bookmarks.onChildrenReordered.addListener(engine.onChildrenReordered);
chrome.bookmarks.onImportBegan.addListener(engine.onImportBegan);
chrome.bookmarks.onImportEnded.addListener(engine.onImportEnded);

// 이 프로필의 창이 포커스를 받으면 맞춘다. 다른 프로필의 창으로 가면 이 프로필은 WINDOW_ID_NONE을 받는다.
let focusTimer = null;
chrome.windows.onFocusChanged.addListener((id) => {
  if (id === chrome.windows.WINDOW_ID_NONE) return;
  clearTimeout(focusTimer);
  focusTimer = setTimeout(() => {
    if (Date.now() - engine.lastSuccess() < FOCUS_SKIP_MS) return;
    engine.sync({ trigger: 'focus' });
  }, FOCUS_DELAY_MS);
});

// 5분 알람: 놓친 이벤트를 복구하고, 포커스가 오래 머문 창도 갱신한다.
// 모듈 변수로 횟수를 세면 서비스 워커가 잠들 때마다 0으로 돌아가므로 알람 주기를 그대로 쓴다.
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'sync') engine.sync({ trigger: 'alarm' }); });

chrome.runtime.onStartup.addListener(() => engine.sync({ trigger: 'startup' }));
chrome.runtime.onInstalled.addListener(() => engine.sync({ trigger: 'startup' }));

// 팝업 명령: sync 「지금 맞추기」, force 「공유 기준으로 적용/되돌리기」, push 「다른 프로필에도 반영」
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const run = { sync: () => engine.sync({ trigger: 'manual' }), force: engine.force, push: engine.push }[msg?.cmd];
  if (!run) return false;
  run().then(() => reply({ ok: true }), (e) => reply({ ok: false, error: String(e?.message || e) }));
  return true;
});

// 알람은 이미 있으면 다시 만들지 않는다. create는 주기를 처음부터 다시 세므로, 5분 안에 서비스 워커가 다시 깨어나면 영영 울리지 않는다.
chrome.alarms.get('sync').then((a) => { if (!a) chrome.alarms.create('sync', { periodInMinutes: 5 }); });
chrome.alarms.clear('tick'); // v1의 1분 tick 알람

engine.sync({ trigger: 'startup' });
