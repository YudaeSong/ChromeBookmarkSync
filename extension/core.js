// 한 프로필의 북마크를 허브의 기준 트리와 실시간으로 맞추는 엔진.
// chrome.bookmarks·저장소·전송 함수를 주입받으므로 Node 테스트(가짜 bookmarks)에서도 그대로 돈다.
//
// 핵심 개념
// - gid: 모든 프로필에 공통인 북마크 ID. 프로필마다 다른 로컬 ID와는 map(gid→로컬)·rev(로컬→gid)로 잇는다.
// - 모든 작업(로컬 이벤트·허브 메시지)은 한 줄 큐로 차례대로 처리한다.
// - 허브 변경을 적용하면 Chrome이 다시 이벤트를 쏜다(메아리). 생성·삭제는 대응표로, 이동·수정은 expect/consume으로 거른다.
//   걸러지지 않은 메아리도 '현재 상태'를 다시 읽어 보내므로 허브에서는 변경 없음으로 끝난다.
import { ROOT_GIDS, PROTOCOL, hashRoots, countNodes } from './shared.js';

const ROOT_FOLDER_TYPES = { root_bar: 'bookmarks-bar', root_other: 'other', root_mobile: 'mobile' };
const ROOT_FALLBACK_IDS = { root_bar: '1', root_other: '2', root_mobile: '3' };
// 이미 한 번 맞춘 프로필에서 스냅샷이 이만큼 지우라고 하면 멈추고 사용자 확인을 받는다.
// 허브 상태가 깨졌을 때 모든 프로필(과 각 Google 계정 동기화)까지 북마크가 지워지는 사고를 막는다.
const GUARD_MIN = 20;
const GUARD_RATIO = 0.3;

export function createEngine({
  bm, store, send, uuid, version = '',
  log = () => {}, onStatus = () => {},
  echoGraceMs = 300, now = () => Date.now(),
}) {
  let map = {};
  const rev = new Map();
  let pending = [];
  let initialized = false;
  let clientId = null;
  let rootIds = {};

  let connected = false;
  let synced = false;
  let waiting = false;
  let blocked = null;
  let stuck = false; // 허브가 같은 불일치 반복으로 스냅샷 재전송을 멈춤
  let helloCount = 0;
  let importing = false;
  let lastSync = 0;
  let lastError = '';

  const expected = new Map();
  let taskKeys = null;
  let persistTimer = null;

  // ---------- 저장 ----------
  const ready = (async () => {
    const s = await store.get(['map', 'pending', 'initialized', 'clientId']);
    map = s.map || {};
    pending = s.pending || [];
    initialized = !!s.initialized;
    clientId = s.clientId || uuid();
    for (const [g, id] of Object.entries(map)) rev.set(id, g);
    await store.set({ clientId });
  })();

  function dirty() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      store.set({ map, pending, initialized, clientId });
    }, 200);
  }

  function status() {
    onStatus({
      connected, synced, waiting, stuck,
      blocked: blocked ? blocked.info : null,
      pending: pending.length, mapped: rev.size,
      lastSync, lastError,
    });
  }

  // ---------- 큐 ----------
  let queue = ready.then(() => resolveRoots()).catch((e) => log('load failed', e));

  function enqueue(fn) {
    const run = async () => {
      taskKeys = [];
      try {
        await fn();
      } catch (e) {
        lastError = String(e?.message || e);
        log('task error', e);
      } finally {
        const until = now() + echoGraceMs;
        for (const k of taskKeys) {
          const e = expected.get(k);
          if (e && e.until === Infinity) e.until = until;
        }
        taskKeys = null;
        status();
      }
    };
    queue = queue.then(run);
    return queue;
  }

  // 이번 작업이 일으킬 이벤트를 등록한다. 작업이 끝난 뒤 echoGraceMs 안에 도착한 이벤트만 메아리로 본다.
  function expect(kind, id, n = 1) {
    if (n <= 0) return;
    const k = `${kind}:${id}`;
    const e = expected.get(k);
    if (e && e.until >= now()) { e.count += n; e.until = Infinity; } else expected.set(k, { count: n, until: Infinity });
    taskKeys?.push(k);
  }

  function consume(kind, id, at) {
    const k = `${kind}:${id}`;
    const e = expected.get(k);
    if (!e) return false;
    if (at > e.until) { expected.delete(k); return false; }
    if (--e.count <= 0) expected.delete(k);
    return true;
  }

  // ---------- 대응표 ----------
  function bind(gid, id) {
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

  async function unbindLocalSubtree(id) {
    try {
      const [t] = await bm.getSubTree(id);
      if (t) unbindTree(t);
    } catch { /* 이미 없음 */ }
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
  const createOp = (gid, parent, n) => ({
    op: 'create', gid, parent, index: n.index, title: n.title ?? '',
    ...(n.url != null ? { url: n.url } : {}),
  });

  // ---------- 보내기 ----------
  function emit(op) {
    pending.push(op);
    dirty();
    flush();
  }

  function flush() {
    if (!connected || !synced || blocked || !pending.length) return;
    const ops = pending;
    for (let i = 0; i < ops.length; i++) {
      if (!send({ type: 'op', op: ops[i] })) { pending = ops.slice(i); dirty(); return; }
    }
    pending = [];
    dirty();
  }

  function requestResync() {
    synced = false;
    send({ type: 'resync' });
  }

  // ---------- 로컬 이벤트 ----------
  async function emitCreateTree(id, parentGid) {
    const [t] = await bm.getSubTree(id);
    const one = (c, pg) => {
      let g = rev.get(c.id);
      if (!g) { g = uuid(); bind(g, c.id); emit(createOp(g, pg, c)); } else emit({ op: 'move', gid: g, parent: pg, index: c.index });
      for (const k of modifiableKids(c)) one(k, g);
    };
    one(t, parentGid);
  }

  const handlers = {
    async created(at, id) {
      if (rev.has(id) || importing) return;
      const n = await getNode(id);
      if (!n) return;
      const pg = rev.get(n.parentId);
      if (!pg) return;
      await emitCreateTree(id, pg);
    },
    async removed(at, id, info) {
      const g = rev.get(id);
      if (!g || ROOT_GIDS.includes(g)) return;
      if (info?.node) unbindTree(info.node); else unbindGid(g);
      emit({ op: 'remove', gid: g });
    },
    async changed(at, id) {
      if (consume('changed', id, at)) return;
      const g = rev.get(id);
      if (!g || ROOT_GIDS.includes(g)) return;
      const n = await getNode(id);
      if (!n) return;
      emit({ op: 'update', gid: g, title: n.title ?? '', ...(n.url != null ? { url: n.url } : {}) });
    },
    async moved(at, id) {
      if (consume('moved', id, at)) return;
      const n = await getNode(id);
      if (!n) return;
      const g = rev.get(id);
      const pg = rev.get(n.parentId);
      if (!g) { if (pg && !importing) await emitCreateTree(id, pg); return; }
      if (!pg) { await unbindLocalSubtree(id); emit({ op: 'remove', gid: g }); return; }
      emit({ op: 'move', gid: g, parent: pg, index: n.index });
    },
    async reordered(at, id) {
      const pg = rev.get(id);
      if (!pg) return;
      const kids = await bm.getChildren(id);
      const gids = kids.filter((k) => !k.unmodifiable).map((k) => rev.get(k.id));
      if (gids.some((x) => !x)) return; // 아직 안 묶인 노드가 있으면 주기 점검에서 맞춘다
      emit({ op: 'reorder', parent: pg, children: gids });
    },
  };

  // 동기화 범위 안의 안 묶인 노드(가져오기 등)를 찾아 생성으로 보낸다.
  async function sweep() {
    if (!initialized) return 0;
    let count = 0;
    const walk = (node, pg) => {
      for (const c of modifiableKids(node)) {
        let g = rev.get(c.id);
        if (!g) { g = uuid(); bind(g, c.id); emit(createOp(g, pg, c)); count++; }
        if (c.url == null) walk(c, g);
      }
    };
    const root = await resolveRoots();
    for (const g of ROOT_GIDS) { const r = rootNode(root, g); if (r) walk(r, g); }
    return count;
  }

  async function localRoots() {
    const root = await resolveRoots();
    const enc = (c) => (c.url != null
      ? { gid: rev.get(c.id) ?? null, title: c.title ?? '', url: c.url }
      : { gid: rev.get(c.id) ?? null, title: c.title ?? '', children: modifiableKids(c).map(enc) });
    const out = {};
    for (const g of ROOT_GIDS) out[g] = modifiableKids(rootNode(root, g)).map(enc);
    return out;
  }

  // ---------- 로컬에 적용 ----------
  async function updateLocal(id, cur, want) {
    const ch = {};
    if ((want.title ?? '') !== (cur.title ?? '')) ch.title = want.title ?? '';
    if (want.url != null && cur.url != null && want.url !== cur.url) ch.url = want.url;
    const n = Object.keys(ch).length;
    if (!n) return;
    expect('changed', id, n); // Chrome은 바뀐 필드마다 onChanged를 한 번씩 쏜다
    await bm.update(id, ch);
  }

  // index는 '옮긴 뒤의 최종 위치'. Chrome move는 같은 폴더 안에서 아래로 옮길 때 '옮기기 전 기준' 위치를 받으므로 +1 한다.
  async function moveLocal(id, cur, parentId, index) {
    const apiIndex = cur.parentId === parentId && index > cur.index ? index + 1 : index;
    expect('moved', id);
    await bm.move(id, { parentId, index: apiIndex });
  }

  async function removeLocal(id) {
    await unbindLocalSubtree(id);
    await bm.removeTree(id);
  }

  async function syncFolder(kids, folderId) {
    let pos = 0;
    for (const c of kids) {
      const isFolder = c.url == null;
      let id = map[c.gid];
      let cur = id ? await getNode(id) : null;
      if (cur && (cur.url == null) !== isFolder) { await removeLocal(id); cur = null; }
      try {
        if (!cur) {
          const n = await bm.create({ parentId: folderId, index: pos, title: c.title ?? '', ...(isFolder ? {} : { url: c.url }) });
          bind(c.gid, n.id);
        } else {
          await updateLocal(id, cur, c);
          if (cur.parentId !== folderId || cur.index !== pos) await moveLocal(id, cur, folderId, pos);
        }
        pos++;
      } catch (e) {
        log('reconcile item failed', c, e?.message);
      }
    }
    const nowKids = modifiableKids({ children: await bm.getChildren(folderId) });
    for (const n of nowKids.slice(pos)) await removeLocal(n.id);
    for (const c of kids) if (c.url == null && map[c.gid]) await syncFolder(c.children || [], map[c.gid]);
  }

  async function reconcile(snap, force) {
    const root = await resolveRoots();
    const local = new Map();
    const collect = (n) => { for (const c of modifiableKids(n)) { local.set(c.id, c); collect(c); } };
    for (const g of ROOT_GIDS) collect(rootNode(root, g));
    for (const [g, id] of Object.entries(map)) if (!ROOT_GIDS.includes(g) && !local.has(id)) unbindGid(g);

    const canon = new Set();
    const walkC = (n) => { canon.add(n.gid); n.children?.forEach(walkC); };
    for (const g of ROOT_GIDS) (snap.roots[g] || []).forEach(walkC);
    let removeCount = 0;
    for (const id of local.keys()) { const g = rev.get(id); if (!g || !canon.has(g)) removeCount++; }
    if (!force && initialized && removeCount >= GUARD_MIN && removeCount > local.size * GUARD_RATIO) {
      blocked = { snap, info: { remove: removeCount, total: local.size, incoming: countNodes(snap.roots) } };
      synced = false;
      log('mass-delete guard', blocked.info);
      return false;
    }
    for (const g of ROOT_GIDS) if (rootIds[g]) await syncFolder(snap.roots[g] || [], rootIds[g]);
    return true;
  }

  async function onSnapshot(snap, force = false) {
    waiting = false;
    if (helloCount) { pending.splice(0, helloCount); helloCount = 0; dirty(); }
    if (!(await reconcile(snap, force))) return;
    blocked = null;
    stuck = false;
    synced = true;
    initialized = true;
    lastSync = now();
    dirty();
    // 스냅샷을 기다리는 동안 생긴 로컬 변경은 방금 맞추며 되돌려졌다. 허브에 보내고 다시 받아 반영한다.
    if (pending.length) { flush(); requestResync(); }
  }

  async function applyRemote(op) {
    if (!synced) return; // 스냅샷을 기다리는 중이면 다음 스냅샷에 포함된다
    try {
      switch (op.op) {
        case 'create': {
          if (map[op.gid]) return;
          const pid = map[op.parent];
          if (!pid) throw new Error('parent not mapped');
          const len = (await bm.getChildren(pid)).length;
          const n = await bm.create({ parentId: pid, index: Math.min(op.index ?? len, len), title: op.title ?? '', ...(op.url != null ? { url: op.url } : {}) });
          bind(op.gid, n.id);
          return;
        }
        case 'update': {
          const id = map[op.gid];
          const cur = id && (await getNode(id));
          if (!cur) throw new Error('node not mapped');
          await updateLocal(id, cur, { title: op.title ?? cur.title, url: op.url });
          return;
        }
        case 'move': {
          const id = map[op.gid];
          const pid = map[op.parent];
          const cur = id && (await getNode(id));
          if (!cur || !pid) throw new Error('node/parent not mapped');
          if (cur.parentId === pid && cur.index === op.index) return;
          const len = (await bm.getChildren(pid)).length;
          await moveLocal(id, cur, pid, Math.min(op.index, cur.parentId === pid ? len - 1 : len));
          return;
        }
        case 'remove': {
          const id = map[op.gid];
          if (id) await removeLocal(id);
          return;
        }
        case 'reorder': {
          const pid = map[op.parent];
          const want = op.children.map((g) => map[g]);
          if (!pid || want.some((x) => !x)) throw new Error('reorder not mapped');
          for (let i = 0; i < want.length; i++) {
            const cur = await getNode(want[i]);
            if (!cur) throw new Error('reorder node missing');
            if (cur.parentId !== pid || cur.index !== i) await moveLocal(want[i], cur, pid, i);
          }
          return;
        }
        default:
          return;
      }
    } catch (e) {
      log('apply failed → resync', op, e?.message);
      requestResync();
    }
  }

  async function doInit() {
    waiting = false;
    const root = await resolveRoots();
    const enc = (c) => {
      let g = rev.get(c.id);
      if (!g) { g = uuid(); bind(g, c.id); }
      return c.url != null
        ? { gid: g, title: c.title ?? '', url: c.url }
        : { gid: g, title: c.title ?? '', children: modifiableKids(c).map(enc) };
    };
    const roots = {};
    for (const g of ROOT_GIDS) roots[g] = modifiableKids(rootNode(root, g)).map(enc);
    pending = [];
    helloCount = 0;
    dirty();
    send({ type: 'init', roots });
  }

  // ---------- 외부에 내놓는 함수 ----------
  const ev = (name) => (...args) => {
    const at = now();
    enqueue(() => handlers[name](at, ...args));
  };

  return {
    ready,
    onCreated: ev('created'),
    onRemoved: ev('removed'),
    onChanged: ev('changed'),
    onMoved: ev('moved'),
    onChildrenReordered: ev('reordered'),
    onImportBegan: () => enqueue(async () => { importing = true; }),
    onImportEnded: () => enqueue(async () => { importing = false; await sweep(); }),

    onOpen(email) {
      return enqueue(async () => {
        connected = true;
        synced = false;
        waiting = false;
        helloCount = pending.length;
        send({ type: 'hello', clientId, email, pending, protocol: PROTOCOL, version });
      });
    },
    onClose() {
      connected = false;
      synced = false;
      status();
    },
    onMessage(m) {
      switch (m.type) {
        case 'need-init': return enqueue(doInit);
        case 'wait': return enqueue(async () => { waiting = true; });
        case 'snapshot': return enqueue(() => onSnapshot(m.snap));
        case 'op': return enqueue(() => applyRemote(m.op));
        case 'check-ok': lastSync = now(); stuck = false; status(); return undefined;
        case 'stuck': stuck = true; lastError = m.message || 'stuck'; status(); return undefined;
        case 'error': lastError = m.message || 'hub error'; status(); return undefined;
        default: return undefined;
      }
    },
    // 주기 점검: 안 묶인 노드를 보내고, 없으면 내 트리 해시를 허브와 비교한다(다르면 허브가 스냅샷을 보낸다).
    periodicCheck() {
      return enqueue(async () => {
        if (!connected || !synced || blocked || pending.length) return;
        if (await sweep()) return;
        const roots = await localRoots();
        // 이 프로필에서 찾지 못한 루트는 허브도 비교에서 뺀다(없는 루트 때문에 5분마다 스냅샷을 다시 받지 않게).
        send({ type: 'check', hash: await hashRoots(roots), skip: ROOT_GIDS.filter((g) => !rootIds[g]) });
      });
    },
    // 대량 삭제 보호로 멈춘 스냅샷을 사용자가 확인하고 적용한다. 멈춘 것이 없으면 허브 기준으로 다시 맞춘다.
    force() {
      return enqueue(async () => {
        if (blocked) { const s = blocked.snap; blocked = null; await onSnapshot(s, true); } else requestResync();
      });
    },
    idle: () => queue,
    localRoots: () => enqueue(() => {}).then(localRoots),
    debugState: () => ({ connected, synced, waiting, stuck, blocked: !!blocked, pending: pending.length, initialized, mapped: rev.size }),
  };
}
