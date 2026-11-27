// 허브(HubCore+Tree)와 여러 프로필(엔진+가짜 bookmarks)을 메모리 안에서 연결해 실제 흐름을 시뮬레이션한다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEngine } from '../extension/core.js';
import { HubCore, STUCK_AFTER } from '../hub/core.js';
import { PROTOCOL, hashRoots } from '../extension/shared.js';
import { Tree } from '../hub/tree.js';
import { createFakeBookmarks } from './fake-bookmarks.js';

const MASTER = 'main@example.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeWorld({ eventMode = 'sync', seed = 1 } = {}) {
  let s = seed;
  const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  let uid = 0;
  const tree = new Tree();
  const hub = new HubCore({ tree, masterEmail: MASTER });
  const profiles = [];

  function addProfile(email) {
    const bm = createFakeBookmarks({ eventMode });
    const mem = {};
    const p = { email, bm, link: null, open: false };
    p.engine = createEngine({
      bm,
      store: { get: async () => structuredClone(mem), set: async (o) => Object.assign(mem, structuredClone(o)) },
      send: (obj) => {
        if (!p.open) return false;
        const c = p.link;
        const copy = structuredClone(obj);
        setImmediate(() => { if (c && hub.clients.has(c)) hub.handle(c, copy); });
        return true;
      },
      uuid: () => `g${++uid}`,
      echoGraceMs: eventMode === 'sync' ? 0 : 30,
    });
    for (const n of ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered', 'onImportBegan', 'onImportEnded']) bm[n].addListener(p.engine[n]);
    p.connect = () => {
      p.open = true;
      p.link = hub.connect((m) => { const copy = structuredClone(m); setImmediate(() => { if (p.open) p.engine.onMessage(copy); }); });
      p.engine.onOpen(email);
    };
    p.disconnect = () => { p.open = false; hub.disconnect(p.link); p.link = null; p.engine.onClose(); };
    profiles.push(p);
    return p;
  }

  async function settle(rounds = 30) {
    for (let i = 0; i < rounds; i++) {
      await sleep(eventMode === 'sync' ? 2 : 40);
      await Promise.all(profiles.map((p) => p.engine.idle()));
    }
  }

  return { hub, tree, profiles, addProfile, settle, rand };
}

async function seedTree(bm, prefix, n = 3) {
  const f1 = await bm.create({ parentId: '1', title: `${prefix}-폴더A` });
  for (let i = 0; i < n; i++) await bm.create({ parentId: f1.id, title: `${prefix}-a${i}`, url: `https://${prefix}.example/a${i}` });
  const f2 = await bm.create({ parentId: f1.id, title: `${prefix}-하위` });
  await bm.create({ parentId: f2.id, title: `${prefix}-deep`, url: `https://${prefix}.example/deep` });
  for (let i = 0; i < n; i++) await bm.create({ parentId: '1', title: `${prefix}-bar${i}`, url: `https://${prefix}.example/bar${i}` });
  await bm.create({ parentId: '2', title: `${prefix}-other`, url: `https://${prefix}.example/other` });
}

function hubDump(tree) {
  const snap = tree.snapshot();
  const enc = (n) => (n.children ? [n.title, n.children.map(enc)] : [n.title, n.url]);
  return ['root_bar', 'root_other', 'root_mobile'].map((g) => snap.roots[g].map(enc));
}

function assertAllEqual(w, msg = '') {
  const want = hubDump(w.tree);
  for (const p of w.profiles) assert.deepEqual(p.bm._dump(), want, `${p.email} differs from hub ${msg}`);
}

async function randomOp(w, p) {
  const { bm } = p;
  const r = w.rand();
  const all = bm._all();
  const folders = bm._folders();
  const pick = (arr) => arr[Math.floor(w.rand() * arr.length)];
  try {
    if (r < 0.3 || all.length < 3) {
      const parent = pick(folders);
      const len = (await bm.getChildren(parent)).length;
      const isFolder = w.rand() < 0.25;
      await bm.create({ parentId: parent, index: Math.floor(w.rand() * (len + 1)), title: `n${Math.floor(w.rand() * 1e6)}`, ...(isFolder ? {} : { url: `https://x.example/${Math.floor(w.rand() * 1e6)}` }) });
    } else if (r < 0.5) {
      const id = pick(all);
      const [n] = await bm.get(id);
      await bm.update(id, { title: `t${Math.floor(w.rand() * 1e6)}`, ...(n.url && w.rand() < 0.5 ? { url: `https://u.example/${Math.floor(w.rand() * 1e6)}` } : {}) });
    } else if (r < 0.8) {
      const id = pick(all);
      const parent = pick(folders);
      const len = (await bm.getChildren(parent)).length;
      await bm.move(id, { parentId: parent, index: Math.floor(w.rand() * (len + 1)) });
    } else if (r < 0.93) {
      await bm.removeTree(pick(all));
    } else {
      await bm._sort(pick(folders));
    }
  } catch { /* 자기 하위로 옮기기 등 Chrome도 거부하는 조작 */ }
}

test('메인 프로필로 초기화 → 다른 프로필은 메인으로 덮어쓰기', async () => {
  const w = makeWorld();
  const a = w.addProfile('sub1@example.com');
  const m = w.addProfile(MASTER);
  const b = w.addProfile('sub2@example.com');
  await seedTree(m.bm, 'M');
  await seedTree(a.bm, 'A', 2); // A에만 있던 북마크는 사라져야 한다
  a.connect(); // 메인보다 먼저 붙어도 기다렸다가 맞춘다
  await w.settle(5);
  assert.equal(a.engine.debugState().waiting, true);
  m.connect();
  b.connect();
  await w.settle();
  assert.equal(w.tree.count(), 10);
  assertAllEqual(w);
  assert.ok(!JSON.stringify(a.bm._dump()).includes('A-'), 'A의 기존 북마크가 남아 있음');
});

test('한 프로필에서 추가·수정·이동·삭제·정렬 → 나머지 프로필에 즉시 반영', async () => {
  const w = makeWorld();
  const m = w.addProfile(MASTER);
  const a = w.addProfile('a@x');
  const b = w.addProfile('b@x');
  await seedTree(m.bm, 'M');
  for (const p of w.profiles) p.connect();
  await w.settle();
  assertAllEqual(w, 'after init');

  const f = await a.bm.create({ parentId: '1', index: 0, title: '새폴더' });
  await a.bm.create({ parentId: f.id, title: '새북마크', url: 'https://new.example/' });
  await w.settle();
  assertAllEqual(w, 'after create');

  const barKids = await b.bm.getChildren('1');
  await b.bm.update(barKids[1].id, { title: '이름바꿈' });
  await b.bm.move(barKids[1].id, { parentId: '1', index: barKids.length }); // 같은 폴더 맨 아래로(Chrome 위치 규칙 확인)
  await w.settle();
  assertAllEqual(w, 'after rename/move');

  await m.bm._sort('1');
  await w.settle();
  assertAllEqual(w, 'after sort');

  const k = await m.bm.getChildren('1');
  await m.bm.removeTree(k.find((x) => x.title === '새폴더').id);
  await w.settle();
  assertAllEqual(w, 'after remove');
});

for (const eventMode of ['sync', 'deferred']) {
  test(`여러 프로필이 동시에 마구 고쳐도 최종적으로 같아진다 (이벤트 ${eventMode})`, async () => {
    const w = makeWorld({ eventMode, seed: eventMode === 'sync' ? 7 : 11 });
    const m = w.addProfile(MASTER);
    w.addProfile('a@x');
    w.addProfile('b@x');
    await seedTree(m.bm, 'M', 4);
    for (const p of w.profiles) p.connect();
    await w.settle();
    assertAllEqual(w, 'after init');

    const rounds = eventMode === 'sync' ? 300 : 80;
    for (let i = 0; i < rounds; i++) {
      await randomOp(w, w.profiles[Math.floor(w.rand() * w.profiles.length)]);
      if (w.rand() < 0.3) await sleep(eventMode === 'sync' ? 0 : 5);
    }
    await w.settle();
    // 동시 편집 충돌로 어긋난 곳은 주기 점검(해시 비교)이 허브 기준으로 바로잡는다
    for (let i = 0; i < 3; i++) {
      for (const p of w.profiles) p.engine.periodicCheck();
      await w.settle();
    }
    assertAllEqual(w, 'after random edits');
  });
}

test('닫혀 있던 프로필: 꺼진 동안의 내 변경은 올리고, 남의 변경은 열 때 따라잡는다', async () => {
  const w = makeWorld();
  const m = w.addProfile(MASTER);
  const a = w.addProfile('a@x');
  await seedTree(m.bm, 'M');
  m.connect();
  a.connect();
  await w.settle();
  assertAllEqual(w);

  a.disconnect();
  await a.bm.create({ parentId: '2', title: '오프라인추가', url: 'https://offline.example/' });
  await m.bm.create({ parentId: '1', index: 0, title: '메인추가', url: 'https://main.example/' });
  await w.settle();
  assert.equal(a.engine.debugState().pending, 1);

  a.connect();
  await w.settle();
  assertAllEqual(w);
  const s = JSON.stringify(m.bm._dump());
  assert.ok(s.includes('오프라인추가') && s.includes('메인추가'));
});

test('허브 상태가 망가져 대량 삭제를 지시하면 멈추고, 사용자가 확인하면 적용한다', async () => {
  const w = makeWorld();
  const m = w.addProfile(MASTER);
  await seedTree(m.bm, 'M', 30);
  m.connect();
  await w.settle();
  const before = JSON.stringify(m.bm._dump());

  // 허브가 빈 트리로 초기화된 상황 흉내
  w.tree.initFrom({ root_bar: [], root_other: [], root_mobile: [] });
  m.engine.periodicCheck();
  await w.settle();
  assert.equal(JSON.stringify(m.bm._dump()), before, '보호가 동작하지 않고 지워짐');
  assert.equal(m.engine.debugState().blocked, true);

  m.engine.force();
  await w.settle();
  assert.deepEqual(m.bm._dump(), [[], [], []]);
});

test('같은 폴더 안 이동의 Chrome 위치 규칙: 위→아래, 아래→위 모두 정확히 옮겨진다', async () => {
  const w = makeWorld();
  const m = w.addProfile(MASTER);
  const a = w.addProfile('a@x');
  for (let i = 0; i < 6; i++) await m.bm.create({ parentId: '1', title: `b${i}`, url: `https://b.example/${i}` });
  m.connect();
  a.connect();
  await w.settle();
  const ids = (await m.bm.getChildren('1')).map((x) => x.id);
  await m.bm.move(ids[0], { parentId: '1', index: 4 }); // 위→아래
  await w.settle();
  assertAllEqual(w);
  await m.bm.move(ids[5], { parentId: '1', index: 1 }); // 아래→위
  await w.settle();
  assertAllEqual(w);
});

test('메인에만 모바일 북마크가 있고 다른 프로필의 모바일 폴더가 비어 있어도(숨김) 맞춰진다', async () => {
  const w = makeWorld();
  const m = w.addProfile(MASTER);
  const a = w.addProfile('a@x');
  await seedTree(m.bm, 'M');
  await m.bm.create({ parentId: '3', title: '모바일1', url: 'https://m.example/1' });
  m.connect();
  a.connect();
  await w.settle();
  assertAllEqual(w);
  a.engine.periodicCheck();
  await w.settle();
  assert.equal(a.engine.debugState().synced, true);
});

test('hello에 규약 번호·버전을 싣고 허브 상태에 보인다', async () => {
  const w = makeWorld();
  const m = w.addProfile(MASTER);
  await seedTree(m.bm, 'M');
  m.connect();
  await w.settle();
  const [c] = w.hub.status().clients;
  assert.equal(c.protocol, PROTOCOL);
  assert.equal(c.stuck, false);
});

test('스냅샷을 보내도 같은 불일치가 이어지면 재전송을 멈추고, 맞춰지면 다시 정상으로 돌아온다', async () => {
  const tree = new Tree();
  tree.initFrom({ root_bar: [{ gid: 'x', title: 't', url: 'https://x.example/' }], root_other: [], root_mobile: [] });
  const hub = new HubCore({ tree, masterEmail: MASTER });
  const got = [];
  const c = hub.connect((msg) => got.push(msg.type));
  await hub.handle(c, { type: 'hello', clientId: 'c1', email: 'old@x', pending: [] }); // 옛 코드: protocol 없음
  assert.equal(c.protocol, null);
  got.length = 0;

  for (let i = 0; i < STUCK_AFTER + 5; i++) await hub.handle(c, { type: 'check', hash: 'never-matches' });
  assert.equal(got.filter((t) => t === 'snapshot').length, STUCK_AFTER, '같은 불일치에 스냅샷을 계속 보냄');
  assert.equal(got.filter((t) => t === 'stuck').length, 1);
  assert.equal(hub.status().clients[0].stuck, true);

  // 프로필 쪽 해시가 바뀌면(다른 불일치) 다시 스냅샷을 보낸다
  got.length = 0;
  await hub.handle(c, { type: 'check', hash: 'another' });
  assert.deepEqual(got, ['snapshot']);

  // 맞으면 check-ok와 함께 상태가 풀린다
  got.length = 0;
  await hub.handle(c, { type: 'check', hash: await hashRoots(tree.snapshot().roots) });
  assert.deepEqual(got, ['check-ok']);
  assert.equal(hub.status().clients[0].stuck, false);
});
