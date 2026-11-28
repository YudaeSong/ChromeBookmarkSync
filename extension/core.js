// 한 프로필의 북마크를 공유 트리(네이티브 호스트 hub/host.js가 관리)와 3-way로 맞추는 엔진. 설계: docs/native-messaging-design.md §4.
// chrome.bookmarks·저장소·호스트 호출 함수를 주입받으므로 Node 테스트(가짜 bookmarks + handleRequest)에서도 그대로 돈다.
//
// 핵심 개념
// - gid: 모든 프로필에 공통인 북마크 ID. 프로필마다 다른 로컬 ID와는 map(gid→로컬)·rev(로컬→gid)로 잇는다.
// - base(기준점): 마지막으로 맞춘 공유 트리. diffTrees(base, 내 트리) = 내 변경. 공유 트리와 base의 차이 = 다른 프로필의 변경.
// - sync 한 번: 내 변경(ops)을 호스트에 보내 공유 트리에 병합 → 응답의 최신 공유 트리로 reconcile → 기준점 저장.
// - 모든 작업은 한 줄 큐로 차례대로 처리한다. 북마크 이벤트는 localEpoch를 올리고 잠시 뒤 sync를 부를 뿐이다.
//   내 reconcile이 일으킨 이벤트(메아리)는 거르지 않는다. 그 뒤의 diff가 비어 호스트를 부르지 않고 끝난다.
import { diffTrees } from './diff.js';
import { ROOT_GIDS, PROTOCOL, hashRoots, countNodes } from './shared.js';

const ROOT_FOLDER_TYPES = { root_bar: 'bookmarks-bar', root_other: 'other', root_mobile: 'mobile' };
const ROOT_FALLBACK_IDS = { root_bar: '1', root_other: '2', root_mobile: '3' };
// 이미 한 번 맞춘 프로필에서 공유 트리가 이만큼 지우라고 하면(들어오는 쪽), 또는 이 프로필의 변경이 이만큼 지우려 하면(나가는 쪽)
// 멈추고 사용자 확인을 받는다. 공유 트리나 대응표가 깨졌을 때 모든 프로필(과 각 Google 계정 동기화)까지 북마크가 지워지는 사고를 막는다.
const GUARD_MIN = 20;
const GUARD_RATIO = 0.3;
// 같은 (내 트리 해시, 공유 트리 해시) 불일치가 reconcile 뒤에도 이 횟수만큼 이어지면 강제 reconcile을 멈춘다(배지 '?').
// 그 프로필이 공유 트리를 적용하지 못하는 상태라 다시 맞춰도 소용없이 매번 반복되기 때문이다.
// 테스트 '동시에 마구 고쳐도'가 모든 프로필 sync 3회 안에 바로잡히기를 기대하므로 3보다 커야 한다.
export const STUCK_AFTER = 5;
// 호스트를 부르는 동안 사용자가 북마크를 고치면 reconcile하지 않고 처음부터 다시 한다. 그 최대 횟수.
export const MAX_EPOCH_RETRY = 3;
export const CALL_TIMEOUT_MS = 15000;
// 기준점과 공유 트리가 같은지 볼 필요 없이 sync를 건너뛰어도 되는 자동 트리거. 대량 삭제 보호로 멈춘 동안에는 이 트리거로 다시 맞추지 않는다.
const AUTO_TRIGGERS = new Set(['focus', 'alarm', 'event']);

// a가 b보다 높은 버전이면 true ("2.0.10" > "2.0.9")
export function newerVersion(a, b) {
  const pa = String(a ?? '').split('.').map((x) => Number(x) || 0);
  const pb = String(b ?? '').split('.').map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

const withTimeout = (fn, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`시간 초과(${ms / 1000}초)`)), ms);
  Promise.resolve().then(fn).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});

// 찾지 못한 루트(skip)는 []로 둔다. 기준점 저장과 해시 비교에 쓴다.
const normalize = (roots, skip) => Object.fromEntries(ROOT_GIDS.map((g) => [g, skip.includes(g) ? [] : (roots?.[g] || [])]));

const ERROR_TEXT = {
  'migrate-first': '공유 파일이 아직 없습니다 — node hub/host.js --import-state 를 먼저 실행',
  'too-large': '공유 트리가 메시지 한도(1 MB)를 넘음',
  'lock-timeout': '공유 파일 잠금 대기 시간 초과',
  'bad-request': '호스트가 요청을 거부함',
  internal: '호스트 내부 오류',
};

export function createEngine({
  bm, store, call, uuid, version = '',
  getEmail = async () => '',
  log = () => {}, onStatus = () => {}, onDiskVersion = () => {},
  now = () => Date.now(), eventDelayMs = 1000, callTimeoutMs = CALL_TIMEOUT_MS,
}) {
  let map = {};
  const rev = new Map();
  let base = null; // 마지막으로 맞춘 공유 트리(찾지 못한 루트는 [])
  let baseVersion = null;
  let initialized = false;
  let clientId = null;
  let pending = []; // v1이 남긴 보내지 못한 ops. base가 없을 때 한 번 올리고 지운다.
  let mismatch = null; // { key: 내해시:공유해시, count }
  let blocked = null; // 대량 삭제 보호: { dir:'in', remove, total, incoming } | { dir:'out', remove, total }
  let rootIds = {};

  let hostOk = null; // 마지막 호스트 호출 성공 여부(null: 아직 안 부름)
  let synced = false;
  let waiting = false;
  let protocolError = null;
  let importing = false;
  let lastSync = 0;
  let lastError = '';
  let rescued = null; // { count, at }
  let localEpoch = 0;
  let failures = 0; // 이번 reconcile에서 적용에 실패한 항목 수
  let eventTimer = null;
  let persistTimer = null;
  let queued = null; // 아직 시작하지 않은 sync(합치기용)
  let stopped = false;

  const isStuck = () => !!mismatch && mismatch.count >= STUCK_AFTER;

  // ---------- 저장 ----------
  const ready = (async () => {
    const s = await store.get(['map', 'base', 'baseVersion', 'initialized', 'clientId', 'pending', 'mismatch', 'blocked']);
    map = s.map || {};
    base = s.base || null;
    baseVersion = s.baseVersion ?? null;
    initialized = !!s.initialized;
    clientId = s.clientId || uuid();
    pending = Array.isArray(s.pending) ? s.pending : [];
    mismatch = s.mismatch || null;
    blocked = s.blocked || null;
    synced = !!base && !mismatch && !blocked;
    for (const [g, id] of Object.entries(map)) rev.set(id, g);
    await store.set({ clientId });
  })();

  // map만 조금 늦게 저장한다. 기준점은 map과 함께 saveState로만 저장해 둘이 어긋난 채 남지 않게 한다.
  function dirty() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      store.set({ map });
    }, 200);
  }

  function saveState(extra = {}) {
    clearTimeout(persistTimer);
    persistTimer = null;
    return store.set({ map, base, baseVersion, initialized, mismatch, blocked, ...extra });
  }

  function status() {
    onStatus({
      hostOk, synced, waiting, stuck: isStuck(), protocolError,
      blocked: blocked ? { ...blocked } : null,
      baseVersion, mapped: rev.size, lastSync, lastError, rescued,
    });
  }

  // ---------- 큐 ----------
  let queue = ready.then(() => resolveRoots()).catch((e) => log('load failed', e));

  function enqueue(fn) {
    const run = async () => {
      try {
        await fn();
      } catch (e) {
        lastError = String(e?.message || e);
        log('task error', e);
      } finally {
        status();
      }
    };
    queue = queue.then(run);
    return queue;
  }

  // ---------- 대응표 ----------
  function bind(gid, id) {
    if (map[gid] === id && rev.get(id) === gid) return;
    const oldId = map[gid];
    if (oldId) rev.delete(oldId);
    const oldGid = rev.get(id);
    if (oldGid) delete map[oldGid];
    map[gid] = id;
    rev.set(id, gid);
    dirty();
  }

  function unbindGid(gid) {
    const id = map[gid];
    if (id) rev.delete(id);
    delete map[gid];
    dirty();
  }

  function unbindTree(node) {
    const g = rev.get(node.id);
    if (g && !ROOT_GIDS.includes(g)) unbindGid(g);
    node.children?.forEach(unbindTree);
  }


  async function getNode(id) {
    try {
      const [n] = await bm.get(id);
      return n || null;
    } catch {
      return null;
    }
  }

  async function resolveRoots() {
    const [root] = await bm.getTree();
    const kids = root.children || [];
    rootIds = {};
    for (const g of ROOT_GIDS) {
      const cands = kids.filter((c) => c.folderType === ROOT_FOLDER_TYPES[g]);
      let pick = cands.find((c) => c.syncing) || cands[0] || kids.find((c) => c.id === ROOT_FALLBACK_IDS[g]);
      // '모바일 북마크'는 비어 있으면 getTree에 안 나온다. ID로 직접 찾아 그 안에 만들 수 있게 한다.
      if (!pick) {
        try {
          const [n] = await bm.get(ROOT_FALLBACK_IDS[g]);
          if (n && n.url == null && (n.folderType === ROOT_FOLDER_TYPES[g] || n.parentId === root.id)) pick = n;
        } catch { /* 없음 */ }
      }
      if (pick) { rootIds[g] = pick.id; bind(g, pick.id); }
    }
    return root;
  }

  const rootNode = (root, g) => (root.children || []).find((c) => c.id === rootIds[g]);
  const modifiableKids = (n) => (n?.children || []).filter((c) => !c.unmodifiable);
  const skipped = () => ROOT_GIDS.filter((g) => !rootIds[g]);

  // 지금 내 트리. gid가 없는 노드(가져오기, 놓친 이벤트, 이 프로필에서 새로 만든 노드)에는 여기서 gid를 붙이고 묶는다(v1 sweep 역할).
  // 찾지 못한 루트는 []이고 skip에 담는다. fresh: 이번에 새로 gid를 붙인 노드.
  async function readLocal() {
    const root = await resolveRoots();
    const fresh = new Set();
    const enc = (c) => {
      let g = rev.get(c.id);
      if (!g) { g = uuid(); bind(g, c.id); fresh.add(g); }
      return c.url != null
        ? { gid: g, title: c.title ?? '', url: c.url }
        : { gid: g, title: c.title ?? '', children: modifiableKids(c).map(enc) };
    };
    const roots = {};
    for (const g of ROOT_GIDS) roots[g] = modifiableKids(rootNode(root, g)).map(enc);
    return { roots, fresh, skip: skipped() };
  }

  // roots에서 fresh(이번에 새로 gid를 붙인 노드)를 뺀 트리
  function withoutFresh({ roots, fresh }) {
    const strip = (list) => list.filter((n) => !fresh.has(n.gid)).map((n) => (n.children ? { ...n, children: strip(n.children) } : n));
    return Object.fromEntries(ROOT_GIDS.map((g) => [g, strip(roots[g])]));
  }

  // 기준점이 없는 v1 프로필(이미 맞춘 적 있음)에서, 아직 묶이지 않았던 노드를 생성 op로 만든다(v1 sweep이 하던 일).
  function freshCreates(local) {
    if (!local.fresh.size) return [];
    return diffTrees(withoutFresh(local), local.roots, { skipRoots: local.skip }).ops;
  }

  // ---------- 로컬에 적용 ----------
  async function updateLocal(id, cur, want) {
    const ch = {};
    if ((want.title ?? '') !== (cur.title ?? '')) ch.title = want.title ?? '';
    if (want.url != null && cur.url != null && want.url !== cur.url) ch.url = want.url;
    if (!Object.keys(ch).length) return;
    await bm.update(id, ch);
  }

  // index는 '옮긴 뒤의 최종 위치'. Chrome move는 같은 폴더 안에서 아래로 옮길 때 '옮기기 전 기준' 위치를 받으므로 +1 한다.
  async function moveLocal(id, cur, parentId, index) {
    const apiIndex = cur.parentId === parentId && index > cur.index ? index + 1 : index;
    await bm.move(id, { parentId, index: apiIndex });
  }

  // 지운 뒤에 대응표를 푼다. 지우기가 실패했는데 먼저 풀어 버리면 남은 노드가 다음 diff에서 새 노드로 올라가 중복된다.
  async function removeLocal(id) {
    let t = null;
    try { [t] = await bm.getSubTree(id); } catch { /* 이미 없음 */ }
    await bm.removeTree(id);
    if (t) unbindTree(t);
  }

  async function syncFolder(kids, folderId) {
    let pos = 0;
    for (const c of kids) {
      const isFolder = c.url == null;
      let id = map[c.gid];
      let cur = id ? await getNode(id) : null;
      try {
        if (cur && (cur.url == null) !== isFolder) { await removeLocal(id); cur = null; }
        if (!cur) {
          const n = await bm.create({ parentId: folderId, index: pos, title: c.title ?? '', ...(isFolder ? {} : { url: c.url }) });
          bind(c.gid, n.id);
          id = n.id;
        } else {
          await updateLocal(id, cur, c);
          if (cur.parentId !== folderId || cur.index !== pos) await moveLocal(id, cur, folderId, pos);
        }
        pos++;
      } catch (e) {
        failures++;
        log('reconcile item failed', c.gid, c.title, e?.message);
      }
    }
    const nowKids = modifiableKids({ children: await bm.getChildren(folderId) });
    for (const n of nowKids.slice(pos)) {
      try { await removeLocal(n.id); } catch (e) { failures++; log('reconcile remove failed', n.id, e?.message); }
    }
    for (const c of kids) if (c.url == null && map[c.gid]) await syncFolder(c.children || [], map[c.gid]);
  }

  // 공유 트리(roots)로 내 트리를 정확히 맞춘다. 들어오는 대량 삭제 보호에 걸리면 아무것도 바꾸지 않고 { ok:false, info }.
  // confirmed: 다른 프로필에서 사용자가 확인하고 보낸 삭제의 gid(보호 판정에서 뺀다).
  async function reconcile(roots, { force = false, confirmed = new Set() } = {}) {
    const root = await resolveRoots();
    const local = new Map();
    const collect = (n) => { for (const c of modifiableKids(n)) { local.set(c.id, c); collect(c); } };
    for (const g of ROOT_GIDS) collect(rootNode(root, g));
    for (const [g, id] of Object.entries(map)) if (!ROOT_GIDS.includes(g) && !local.has(id)) unbindGid(g);

    const canon = new Set();
    const walkC = (n) => { canon.add(n.gid); n.children?.forEach(walkC); };
    for (const g of ROOT_GIDS) (roots[g] || []).forEach(walkC);
    let removeCount = 0;
    for (const id of local.keys()) {
      const g = rev.get(id);
      if (!g || (!canon.has(g) && !confirmed.has(g))) removeCount++;
    }
    if (!force && initialized && removeCount >= GUARD_MIN && removeCount > local.size * GUARD_RATIO) {
      const info = { remove: removeCount, total: local.size, incoming: countNodes(roots) };
      log('mass-delete guard (in)', info);
      return { ok: false, info };
    }
    failures = 0;
    for (const g of ROOT_GIDS) if (rootIds[g]) await syncFolder(roots[g] || [], rootIds[g]);
    return { ok: true, failed: failures };
  }

  // ---------- 호스트 ----------
  const currentResult = () => (blocked ? 'blocked' : isStuck() ? 'stuck' : 'ok');

  async function request(type, extra) {
    return { type, clientId, email: await getEmail(), protocol: PROTOCOL, version, result: currentResult(), ...extra };
  }

  // 호스트를 부른다. 실패·오류 응답이면 상태를 적고 null을 돌려준다.
  async function callHost(req) {
    let res;
    try {
      res = await withTimeout(() => call(req), callTimeoutMs);
    } catch (e) {
      hostOk = false;
      lastError = `호스트 호출 실패: ${e?.message || e}`;
      log('host call failed', e?.message || e);
      return null;
    }
    if (!res || typeof res !== 'object') {
      hostOk = false;
      lastError = '호스트 응답 없음';
      return null;
    }
    if (res.diskVersion) onDiskVersion(res.diskVersion);
    if (res.error === 'protocol') {
      hostOk = true;
      protocolError = { want: res.want, have: PROTOCOL };
      lastError = `규약 불일치(호스트 ${res.want}, 확장 ${PROTOCOL}) — 확장 새로고침 필요`;
      return null;
    }
    protocolError = null;
    if (res.error) {
      hostOk = res.error === 'migrate-first';
      lastError = `${ERROR_TEXT[res.error] || res.error}${res.message ? `: ${res.message}` : ''}`;
      log('host error', res.error, res.message || '');
      return null;
    }
    hostOk = true;
    lastError = '';
    return res;
  }

  // ---------- sync (설계 §4.2) ----------
  async function runSync(opts) {
    if (stopped) return;
    if (blocked && AUTO_TRIGGERS.has(opts.trigger)) return; // 멈춘 동안은 사용자가 고를 때까지 자동으로 맞추지 않는다
    if (opts.forceIn) mismatch = null;

    for (let attempt = 0; attempt < MAX_EPOCH_RETRY; attempt++) {
      if (importing) return; // 가져오기가 끝나면 한 번 맞춘다
      const epoch0 = localEpoch;
      const local = await readLocal();
      // 새로 붙인 gid는 호스트에 보내기 전에 저장한다. 그 사이에 꺼지면 같은 노드가 새 gid로 다시 올라가 중복된다.
      if (local.fresh.size) { clearTimeout(persistTimer); persistTimer = null; await store.set({ map }); }

      let ops = [];
      let removeCount = 0;
      let fromPending = false;
      if (opts.discardLocal) {
        ops = [];
      } else if (base) {
        ({ ops, removeCount } = diffTrees(base, local.roots, { skipRoots: local.skip }));
      } else {
        ops = [...pending, ...(initialized ? freshCreates(local) : [])];
        fromPending = true;
      }
      // 메아리 등으로 바뀐 것이 없으면 호스트를 부르지 않는다.
      if (opts.trigger === 'event' && !ops.length) return;

      // 나가는 대량 삭제 보호: 대응표가 깨지거나 Google 계정 동기화가 프로필을 갈아엎었을 때 공유 트리를 거쳐 모든 프로필이 지워지지 않게 한다.
      if (base && !opts.allowOut && !opts.discardLocal) {
        const total = countNodes(normalize(base, local.skip));
        if (removeCount >= GUARD_MIN && removeCount > total * GUARD_RATIO) {
          blocked = { dir: 'out', remove: removeCount, total };
          synced = false;
          log('mass-delete guard (out)', blocked);
          await saveState();
          await callHost(await request('sync', { baseVersion, ops: [] })); // 호스트 상태에 blocked를 남긴다(트리는 쓰지 않음)
          return;
        }
      }

      // 불일치가 남아 있으면(멈춘 경우는 빼고) 빠른 경로 없이 최신 트리를 받아 다시 맞춘다.
      const wantRoots = !base || blocked || opts.forceIn || opts.discardLocal || (mismatch && !isStuck());
      let res = await callHost(await request('sync', {
        baseVersion: wantRoots ? null : baseVersion, ops, ...(opts.allowOut ? { confirmRemove: true } : {}),
      }));
      if (!res) return;
      if (res.need === 'wait') { waiting = true; synced = false; return; }
      waiting = false;
      if (res.need === 'init') {
        // 메인 프로필이고 공유 트리가 아직 없다: 내 트리로 만든다.
        res = await callHost(await request('init', { roots: local.roots }));
        if (!res) return;
        if (res.need === 'wait') { waiting = true; synced = false; return; }
        if (!res.roots) { lastError = 'init 응답에 트리가 없음'; return; }
        if ((await hashRoots(res.roots)) === (await hashRoots(local.roots))) {
          // 공유 트리 = 내 트리. 아래에서 다시 시도하더라도 그 사이 편집이 '내 변경'으로 잡히게 기준점을 먼저 둔다.
          base = normalize(res.roots, local.skip);
          baseVersion = res.version;
          initialized = true;
          await saveState();
        }
      }
      if (res.results?.rescued) rescued = { count: res.results.rescued, at: now() };

      if (!res.roots) {
        // 빠른 경로: 보낸 변경이 없고 기준점이 최신이다(멈춘 불일치면 다시 맞추지 않는다).
        const wasBlocked = !!blocked;
        blocked = null;
        synced = !mismatch;
        lastSync = now();
        if (wasBlocked) await saveState();
        return;
      }

      // 호스트를 부르는 동안 사용자가 고쳤다. 지금 맞추면 그 변경이 지워지므로 처음부터 다시 한다(보낸 ops는 gid 기준으로 멱등).
      if (localEpoch !== epoch0) continue;

      const confirmed = new Set((res.confirmed || []).flatMap((e) => e.gids || []));
      const r = await reconcile(res.roots, { force: !!(opts.forceIn || opts.discardLocal), confirmed });
      if (!r.ok) {
        blocked = { dir: 'in', ...r.info };
        synced = false;
        await saveState();
        return;
      }

      // 기준점 저장: 공유 트리(찾지 못한 루트는 []). 적용에 실패한 항목이 있으면 그 차이는 '내 변경'이 아니므로
      // 맞춘 직후의 내 트리를 기준점으로 둔다(그러지 않으면 다음 diff가 공유 트리를 되돌리는 op를 보낸다).
      // 그때도 맞추는 사이에 사용자가 새로 만든 노드(fresh)는 빼서 다음 sync에 올라가게 한다.
      const after = await readLocal();
      const want = normalize(res.roots, after.skip);
      const mine = await hashRoots(after.roots);
      const theirs = await hashRoots(want);
      base = r.failed ? withoutFresh(after) : want;
      baseVersion = res.version;
      initialized = true;
      blocked = null;
      if (fromPending) pending = [];
      if (mine === theirs) {
        mismatch = null;
      } else {
        const key = `${mine}:${theirs}`;
        mismatch = { key, count: mismatch?.key === key ? mismatch.count + 1 : 1 };
        log('mismatch after reconcile', mismatch.count, r.failed ? `failed=${r.failed}` : '');
      }
      synced = !mismatch;
      lastSync = now();
      await saveState(fromPending ? { pending: [] } : {});
      return;
    }
  }

  // 대기 중인(아직 시작하지 않은) sync가 있으면 새로 넣지 않고 합친다.
  function requestSync(opts = {}) {
    if (stopped) return Promise.resolve();
    if (queued) {
      const q = queued.opts;
      if (AUTO_TRIGGERS.has(q.trigger) && !AUTO_TRIGGERS.has(opts.trigger)) q.trigger = opts.trigger;
      else if (q.trigger === 'event' && opts.trigger !== 'event') q.trigger = opts.trigger;
      for (const k of ['forceIn', 'allowOut', 'discardLocal']) if (opts[k]) q[k] = true;
      return queued.promise;
    }
    const entry = { opts: { trigger: 'manual', ...opts } };
    queued = entry;
    entry.promise = enqueue(async () => {
      if (queued === entry) queued = null;
      await runSync(entry.opts);
    });
    return entry.promise;
  }

  // 북마크 이벤트 7종: 고친 것이 끝날 때까지 기다렸다가(디바운스) 한 번 맞춘다.
  function touch() {
    localEpoch++;
    if (stopped) return;
    clearTimeout(eventTimer);
    eventTimer = setTimeout(() => { eventTimer = null; requestSync({ trigger: 'event' }); }, eventDelayMs);
  }

  // ---------- 외부에 내놓는 함수 ----------
  return {
    ready,
    onCreated: touch,
    onRemoved: touch,
    onChanged: touch,
    onMoved: touch,
    onChildrenReordered: touch,
    onImportBegan() { importing = true; localEpoch++; },
    onImportEnded() { importing = false; localEpoch++; return requestSync({ trigger: 'import' }); },

    // trigger: 'startup' | 'focus' | 'alarm' | 'event' | 'manual'
    sync: (opts = {}) => requestSync({ trigger: 'manual', ...opts }),
    // 「공유 기준으로 적용」: 들어오는 쪽 보호로 멈췄거나 계속 어긋날 때 공유 트리로 강제로 맞춘다.
    // 나가는 쪽 보호로 멈췄을 때는 「공유 기준으로 되돌리기」: 이 프로필의 변경을 버리고 공유 트리로 되살린다.
    force: () => requestSync(blocked?.dir === 'out'
      ? { trigger: 'manual', discardLocal: true, forceIn: true }
      : { trigger: 'manual', forceIn: true }),
    // 「다른 프로필에도 반영」: 나가는 쪽 보호로 멈춘 삭제를 확인하고 보낸다(호스트가 확인된 삭제로 기록).
    push: () => requestSync({ trigger: 'manual', allowOut: true }),
    stop() {
      stopped = true;
      clearTimeout(eventTimer);
      if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; store.set({ map }); }
    },
    idle: () => queue,
    lastSuccess: () => lastSync,
    localRoots: async () => { let out; await enqueue(async () => { out = (await readLocal()).roots; }); return out; },
    debugState: () => ({
      hostOk, synced, waiting, stuck: isStuck(), blocked: blocked?.dir ?? null, protocolError: !!protocolError,
      initialized, mapped: rev.size, baseVersion, mismatch: mismatch?.count ?? 0, rescued: rescued?.count ?? 0,
      pending: pending.length, hasBase: !!base, localEpoch,
    }),
  };
}
