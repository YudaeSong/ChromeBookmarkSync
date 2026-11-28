// 공유 저장소(hub/host.js의 handleRequest, 임시 폴더)와 여러 프로필(엔진 + 가짜 bookmarks)을 한 프로세스 안에서 이어
// 실제 흐름을 시뮬레이션한다. 확장의 네이티브 호출은 handleRequest로 바로 잇는다(요청·응답은 structuredClone).
// 「포커스」는 engine.sync()를 직접 부르는 것으로 흉내 낸다. hub/data는 건드리지 않는다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createEngine, STUCK_AFTER } from '../extension/core.js';
import { diffTrees } from '../extension/diff.js';
import { PROTOCOL, countNodes } from '../extension/shared.js';
import { handleRequest } from '../hub/host.js';
import { readShared, withLock, writeShared } from '../hub/store.js';
import { createFakeBookmarks } from './fake-bookmarks.js';

const MASTER = 'main@example.com';
const EVENTS = ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered', 'onImportBegan', 'onImportEnded'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeWorld({ eventMode = 'sync', seed = 1 } = {}) {
  let s = seed;
  const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  let uid = 0;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmsync-sync-'));
  const ctx = { dataDir, config: { masterEmail: MASTER, extensionId: 'test' } };
  const profiles = [];

  function addProfile(email, { failGet = [] } = {}) {
    const bm = createFakeBookmarks({ eventMode, failGet });
    const mem = {};
    const p = { email, bm, mem, online: true, calls: 0, requests: [], responses: [], crashAfterCall: false, duringCall: null };
    p.start = () => {
      p.engine?.stop();
      p.engine = createEngine({
        bm,
        store: { get: async () => structuredClone(mem), set: async (o) => { Object.assign(mem, structuredClone(o)); } },
        call: async (req) => {
          if (!p.online) throw new Error('Specified native messaging host not found.');
          p.calls++;
          p.requests.push(structuredClone(req));
          const res = await handleRequest(structuredClone(req), ctx);
          if (p.duringCall) { const f = p.duringCall; p.duringCall = null; await f(); }
          // 호스트는 썼지만 응답을 처리하기 전에 서비스 워커가 꺼진 상황 흉내
          if (p.crashAfterCall) { p.crashAfterCall = false; throw new Error('service worker stopped'); }
          p.responses.push(structuredClone(res));
          return structuredClone(res);
        },
        uuid: () => `g${++uid}`,
        version: '2.0.0',
        getEmail: async () => email,
        eventDelayMs: 5,
      });
      return p.engine;
    };
    p.start();
    for (const n of EVENTS) bm[n].addListener((...a) => p.engine[n](...a));
    profiles.push(p);
    return p;
  }

  async function settle(rounds = 10) {
    for (let i = 0; i < rounds; i++) {
      await sleep(eventMode === 'sync' ? 8 : 20);
      await Promise.all(profiles.map((p) => p.engine.idle()));
    }
  }

  // 모든 프로필을 차례로 포커스한 것처럼 맞춘다.
  async function syncAll() {
    for (const p of profiles) await p.engine.sync({ trigger: 'focus' });
    await settle();
  }

  const shared = () => readShared(dataDir);
  return { dataDir, profiles, addProfile, settle, syncAll, rand, shared };
}

async function seedTree(bm, prefix, n = 3) {
  const f1 = await bm.create({ parentId: '1', title: `${prefix}-폴더A` });
  for (let i = 0; i < n; i++) await bm.create({ parentId: f1.id, title: `${prefix}-a${i}`, url: `https://${prefix}.example/a${i}` });
  const f2 = await bm.create({ parentId: f1.id, title: `${prefix}-하위` });
  await bm.create({ parentId: f2.id, title: `${prefix}-deep`, url: `https://${prefix}.example/deep` });
  for (let i = 0; i < n; i++) await bm.create({ parentId: '1', title: `${prefix}-bar${i}`, url: `https://${prefix}.example/bar${i}` });
  await bm.create({ parentId: '2', title: `${prefix}-other`, url: `https://${prefix}.example/other` });
  return f1;
}

function sharedDump(w) {
  const { roots } = w.shared();
  const enc = (n) => (n.children ? [n.title, n.children.map(enc)] : [n.title, n.url]);
  return ['root_bar', 'root_other', 'root_mobile'].map((g) => roots[g].map(enc));
}

function assertAllEqual(w, msg = '') {
  const want = sharedDump(w);
  for (const p of w.profiles) assert.deepEqual(p.bm._dump(), want, `${p.email} differs from shared ${msg}`);
}

// 메인으로 초기화하고 모든 프로필을 한 번 맞춘다.
async function startAll(w) {
  await w.settle();
  await w.syncAll();
  assertAllEqual(w, 'after init');
}

const titles = (w) => JSON.stringify(sharedDump(w));

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
      // 큰 하위 트리를 지우면 대량 삭제 보호(나가는 쪽, 또는 쌓여서 받는 쪽)에 걸려 멈춘다. 그 경로는 따로 검증하고 여기서는 작은 것만 지운다.
      // 크기를 세는 데 rand를 쓰지 않아 무작위 순서는 그대로다.
      const id = pick(all);
      const [t] = await bm.getSubTree(id);
      const size = (n) => 1 + (n.children || []).reduce((a, c) => a + size(c), 0);
      if (size(t) <= 5) await bm.removeTree(id);
    } else {
      await bm._sort(pick(folders));
    }
  } catch { /* 자기 하위로 옮기기 등 Chrome도 거부하는 조작 */ }
}

// ---------------- 기존 계약(설계 §5.6의 1~11) ----------------

test('메인 프로필로 초기화 → 다른 프로필은 메인으로 덮어쓰기', async () => {
  const w = makeWorld();
  const a = w.addProfile('sub1@example.com');
  const m = w.addProfile(MASTER);
  const b = w.addProfile('sub2@example.com');
  await seedTree(m.bm, 'M');
  await seedTree(a.bm, 'A', 2); // A에만 있던 북마크는 사라져야 한다
  await w.settle();
  assert.equal(a.calls + m.calls + b.calls, 0, '맞춘 적 없는 프로필의 북마크 이벤트는 호스트를 부르지 않는다');
  await a.engine.sync(); // 메인보다 먼저 맞추면 기다린다
  assert.equal(a.engine.debugState().waiting, true);
  assert.equal(fs.existsSync(path.join(w.dataDir, 'shared.json')), false);
  await m.engine.sync();
  await b.engine.sync();
  await a.engine.sync();
  await w.settle();
  assert.equal(countNodes(w.shared().roots), 10);
  assertAllEqual(w);
  assert.ok(!JSON.stringify(a.bm._dump()).includes('A-'), 'A의 기존 북마크가 남아 있음');
  assert.equal(a.engine.debugState().waiting, false);
});

test('한 프로필에서 추가·수정·이동·삭제·정렬 → 나머지 프로필은 맞출 때(포커스) 반영', async () => {
  const w = makeWorld();
  const m = w.addProfile(MASTER);
  const a = w.addProfile('a@x');
  const b = w.addProfile('b@x');
  await seedTree(m.bm, 'M');
  await startAll(w);

  const f = await a.bm.create({ parentId: '1', index: 0, title: '새폴더' });
  await a.bm.create({ parentId: f.id, title: '새북마크', url: 'https://new.example/' });
  await w.settle();
  assert.ok(titles(w).includes('새북마크'), '북마크 이벤트 뒤 공유 트리에 바로 올라간다');
  assert.ok(!JSON.stringify(b.bm._dump()).includes('새북마크'), '다른 프로필은 맞추기 전까지 그대로');
  await w.syncAll();
  assertAllEqual(w, 'after create');

  const barKids = await b.bm.getChildren('1');
  await b.bm.update(barKids[1].id, { title: '이름바꿈' });
  await b.bm.move(barKids[1].id, { parentId: '1', index: barKids.length }); // 같은 폴더 맨 아래로(Chrome 위치 규칙 확인)
  await w.settle();
  await w.syncAll();
  assertAllEqual(w, 'after rename/move');

  await m.bm._sort('1');
  await w.settle();
  await w.syncAll();
  assertAllEqual(w, 'after sort');

  const k = await m.bm.getChildren('1');
  await m.bm.removeTree(k.find((x) => x.title === '새폴더').id);
  await w.settle();
  await w.syncAll();
  assertAllEqual(w, 'after remove');
});

for (const eventMode of ['sync', 'deferred']) {
  test(`여러 프로필이 동시에 마구 고쳐도 최종적으로 같아진다 (이벤트 ${eventMode})`, async () => {
    const w = makeWorld({ eventMode, seed: eventMode === 'sync' ? 7 : 11 });
    const m = w.addProfile(MASTER);
    w.addProfile('a@x');
    w.addProfile('b@x');
    await seedTree(m.bm, 'M', 4);
    await startAll(w);

    const rounds = eventMode === 'sync' ? 300 : 80;
    for (let i = 0; i < rounds; i++) {
      const p = w.profiles[Math.floor(w.rand() * w.profiles.length)];
      await randomOp(w, p);
      if (w.rand() < 0.2) p.engine.sync({ trigger: 'focus' }); // 편집 사이사이 무작위로 맞춘다(기다리지 않음)
      if (w.rand() < 0.3) await sleep(eventMode === 'sync' ? 0 : 5);
      // 오래 맞추지 않은 프로필에 남의 삭제가 20개 넘게 쌓이면 들어오는 쪽 보호에 걸리는 것이 의도된 동작이다(따로 검증).
      // 실제보다 훨씬 빠르게 편집하는 이 테스트에서는 그 상황이 생기지 않게 가끔 모두 맞춘다(rand는 쓰지 않음).
      if (i % 10 === 9) await w.syncAll();
    }
    await w.settle();
    // 모든 프로필을 3번 맞추면 같아져야 한다(STUCK_AFTER가 3보다 큰 이유)
    for (let i = 0; i < 3; i++) await w.syncAll();
    for (const p of w.profiles) {
      assert.equal(p.engine.debugState().stuck, false);
      assert.equal(p.engine.debugState().blocked, null, `${p.email}가 대량 삭제 보호로 멈춤`);
    }
    assertAllEqual(w, 'after random edits');
  });
}

test('닫혀 있던 프로필: 꺼진 동안의 내 변경은 올리고, 남의 변경은 열 때 따라잡는다', async () => {
  const w = makeWorld();
  const m = w.addProfile(MASTER);
  const a = w.addProfile('a@x');
  await seedTree(m.bm, 'M');
  await startAll(w);

  a.online = false; // 호스트를 부를 수 없음
  await a.bm.create({ parentId: '2', title: '오프라인추가', url: 'https://offline.example/' });
  await m.bm.create({ parentId: '1', index: 0, title: '메인추가', url: 'https://main.example/' });
  await w.settle();
  assert.equal(a.engine.debugState().hostOk, false);
  assert.equal(diffTrees(a.mem.base, await a.engine.localRoots()).ops.length, 1, '기준점 대비 내 변경 1개');

  a.online = true;
  await a.engine.sync();
  await m.engine.sync();
  await w.settle();
  assertAllEqual(w);
  const s = JSON.stringify(m.bm._dump());
  assert.ok(s.includes('오프라인추가') && s.includes('메인추가'));
});

test('공유 트리가 망가져 대량 삭제를 지시하면 멈추고, 사용자가 확인하면 적용한다', async () => {
  const w = makeWorld();
  const m = w.addProfile(MASTER);
  await seedTree(m.bm, 'M', 30);
  await startAll(w);
  const before = JSON.stringify(m.bm._dump());

  // 공유 파일이 빈 트리로 바뀐 상황 흉내
  await withLock(w.dataDir, async () => {
    const s = w.shared();
    await writeShared(w.dataDir, { ...s, version: s.version + 1, roots: { root_bar: [], root_other: [], root_mobile: [] } });
  });
  await m.engine.sync();
  await w.settle();
  assert.equal(JSON.stringify(m.bm._dump()), before, '보호가 동작하지 않고 지워짐');
  assert.equal(m.engine.debugState().blocked, 'in');
  assert.equal(m.mem.blocked.dir, 'in', '멈춤 상태는 저장소에 남는다');

  const calls = m.calls;
  await m.engine.sync({ trigger: 'alarm' });
  assert.equal(m.calls, calls, '멈춘 동안 자동 트리거로는 다시 맞추지 않는다');

  await m.engine.force();
  await w.settle();
  assert.deepEqual(m.bm._dump(), [[], [], []]);
  assert.equal(m.engine.debugState().blocked, null);
});

test('같은 폴더 안 이동의 Chrome 위치 규칙: 위→아래, 아래→위 모두 정확히 옮겨진다', async () => {
  const w = makeWorld();
  const m = w.addProfile(MASTER);
  const a = w.addProfile('a@x');
  for (let i = 0; i < 6; i++) await m.bm.create({ parentId: '1', title: `b${i}`, url: `https://b.example/${i}` });
  await startAll(w);
  const ids = (await m.bm.getChildren('1')).map((x) => x.id);
  await m.bm.move(ids[0], { parentId: '1', index: 4 }); // 위→아래
  await w.settle();
  await a.engine.sync();
  assertAllEqual(w);
  await m.bm.move(ids[5], { parentId: '1', index: 1 }); // 아래→위
  await w.settle();
  await a.engine.sync();
  assertAllEqual(w);
});

test('메인에만 모바일 북마크가 있고 다른 프로필의 모바일 폴더가 비어 있어도(숨김) 맞춰진다', async () => {
  const w = makeWorld();
  const m = w.addProfile(MASTER);
  const a = w.addProfile('a@x');
  await seedTree(m.bm, 'M');
  await m.bm.create({ parentId: '3', title: '모바일1', url: 'https://m.example/1' });
  await startAll(w);
  await a.engine.sync();
  const st = a.engine.debugState();
  assert.equal(st.synced, true);
  assert.equal(st.mismatch, 0);
});

test('모든 요청에 규약 번호·버전을 싣고 공유 파일의 clients에 보인다', async () => {
  const w = makeWorld();
  const m = w.addProfile(MASTER);
  await seedTree(m.bm, 'M');
  await startAll(w);
  const c = w.shared().clients[m.mem.clientId];
  assert.equal(c.protocol, PROTOCOL);
  assert.equal(c.version, '2.0.0');
  assert.equal(c.result, 'ok');
  assert.ok(m.requests.every((r) => r.protocol === PROTOCOL && r.version === '2.0.0'));
});

test('같은 불일치가 STUCK_AFTER번 이어지면 다시 맞추기를 멈추고, 불일치가 바뀌면 다시, 맞춰지면 풀린다', async () => {
  const w = makeWorld();
  const m = w.addProfile(MASTER);
  const a = w.addProfile('a@x');
  await seedTree(m.bm, 'M');
  await startAll(w);

  const mx = (await m.bm.getChildren('1'))[1];
  const ax = (await a.bm.getChildren('1'))[1];
  let tries = 0;
  const update = a.bm.update;
  a.bm.update = async (id, ch) => { if (id === ax.id) tries++; return update(id, ch); };
  a.bm._failIds.add(ax.id); // a는 이 노드를 바꾸지도 지우지도 못한다

  await m.bm.update(mx.id, { title: '메인이바꿈1' });
  await w.settle();
  for (let i = 0; i < STUCK_AFTER + 3; i++) await a.engine.sync();
  assert.equal(tries, STUCK_AFTER, '같은 불일치에 계속 다시 맞춤');
  assert.equal(a.engine.debugState().stuck, true);
  assert.equal(w.shared().clients[a.mem.clientId].result, 'stuck');
  assert.ok(titles(w).includes('메인이바꿈1'), '적용하지 못한 프로필이 공유 트리를 되돌리면 안 된다');

  // 공유 쪽이 바뀌면(다른 불일치) 다시 맞춰 본다
  await m.bm.update(mx.id, { title: '메인이바꿈2' });
  await w.settle();
  await a.engine.sync();
  assert.equal(tries, STUCK_AFTER + 1);
  assert.equal(a.engine.debugState().stuck, false);

  // 적용할 수 있게 되면 맞춰지고 풀린다
  a.bm._failIds.clear();
  await a.engine.sync();
  await w.settle();
  assert.equal(a.engine.debugState().mismatch, 0);
  assert.equal(a.engine.debugState().stuck, false);
  assert.ok(titles(w).includes('메인이바꿈2'));
  assertAllEqual(w);
});

// ---------------- S2 신규 ----------------

test('3-way: 다른 프로필이 지운 노드는 맞추지 않은 프로필이 sync해도 되살아나지 않고, 그 프로필의 추가는 남는다', async () => {
  const w = makeWorld();
  const m = w.addProfile(MASTER);
  const a = w.addProfile('a@x');
  const b = w.addProfile('b@x');
  await seedTree(m.bm, 'M');
  await startAll(w);

  b.online = false;
  await b.bm.create({ parentId: '2', title: 'B추가', url: 'https://b.example/new' });
  await w.settle();
  const x = (await a.bm.getChildren('1')).find((n) => n.title === 'M-bar1');
  await a.bm.removeTree(x.id);
  await w.settle();
  assert.ok(!titles(w).includes('M-bar1'));

  b.online = true;
  await b.engine.sync();
  await w.settle();
  assert.ok(!titles(w).includes('M-bar1'), 'B의 sync가 지워진 노드를 되살림');
  assert.ok(titles(w).includes('B추가'));
  assert.ok(!JSON.stringify(b.bm._dump()).includes('M-bar1'));
  await w.syncAll();
  assertAllEqual(w);
});

test('다른 프로필이 지운 폴더 안에 새로 만든 북마크는 기타 북마크 끝으로 옮겨 살린다', async () => {
  const w = makeWorld();
  const m = w.addProfile(MASTER);
  const a = w.addProfile('a@x');
  await seedTree(m.bm, 'M');
  await startAll(w);

  a.online = false;
  const af = (await a.bm.getChildren('1')).find((n) => n.title === 'M-폴더A');
  await a.bm.create({ parentId: af.id, title: '살릴것', url: 'https://rescue.example/' });
  await w.settle();
  const mf = (await m.bm.getChildren('1')).find((n) => n.title === 'M-폴더A');
  await m.bm.removeTree(mf.id);
  await w.settle();

  a.online = true;
  await a.engine.sync();
  await w.settle();
  const other = w.shared().roots.root_other;
  assert.equal(other.at(-1).title, '살릴것');
  assert.ok(!titles(w).includes('M-폴더A'));
  assert.equal(a.engine.debugState().rescued, 1);
  await w.syncAll();
  assertAllEqual(w);
});

test('나가는 대량 삭제 보호: 멈춤 → 되돌리기, 또는 반영(확인된 삭제는 다른 프로필에서 다시 멈추지 않음)', async () => {
  const w = makeWorld();
  const m = w.addProfile(MASTER);
  const a = w.addProfile('a@x');
  await seedTree(m.bm, 'M', 30); // 노드 64개, 폴더A 하위 포함 33개
  await startAll(w);
  const total = countNodes(w.shared().roots);
  const removeFolder = async () => {
    const f = (await a.bm.getChildren('1')).find((n) => n.title === 'M-폴더A');
    await a.bm.removeTree(f.id);
    await w.settle();
  };

  await removeFolder();
  assert.equal(a.engine.debugState().blocked, 'out');
  assert.equal(countNodes(w.shared().roots), total, '보호가 동작하지 않고 공유 트리에서 지워짐');
  assert.equal(w.shared().clients[a.mem.clientId].result, 'blocked');
  const calls = a.calls;
  await a.engine.sync({ trigger: 'focus' });
  assert.equal(a.calls, calls, '멈춘 동안 자동 트리거로는 다시 맞추지 않는다');

  // 「공유 기준으로 되돌리기」
  await a.engine.force();
  await w.settle();
  assert.equal(a.engine.debugState().blocked, null);
  assertAllEqual(w, 'after revert');
  assert.equal(countNodes(w.shared().roots), total);

  // 다시 지우고 「다른 프로필에도 반영」
  await removeFolder();
  assert.equal(a.engine.debugState().blocked, 'out');
  await a.engine.push();
  await w.settle();
  assert.equal(countNodes(w.shared().roots), total - 33);
  assert.equal(w.shared().confirmed.at(-1).gids.length, 33);
  await m.engine.sync();
  await w.settle();
  assert.equal(m.engine.debugState().blocked, null, '확인된 삭제인데 다른 프로필의 들어오는 쪽 보호가 다시 멈춤');
  assertAllEqual(w, 'after push');
});

test('호스트가 쓴 뒤 기준점을 저장하기 전에 꺼져도, 다시 보내면 결과가 같다(멱등)', async () => {
  const w = makeWorld();
  const m = w.addProfile(MASTER);
  const a = w.addProfile('a@x');
  await seedTree(m.bm, 'M');
  await startAll(w);

  a.crashAfterCall = true;
  const kids = await a.bm.getChildren('1');
  const f = await a.bm.create({ parentId: '1', index: 1, title: '새폴더' });
  await a.bm.create({ parentId: f.id, title: '새것', url: 'https://n.example/' });
  await a.bm.update(kids[2].id, { title: '바꿈' });
  await a.bm.move(kids[3].id, { parentId: f.id, index: 0 });
  await a.bm.removeTree(kids.at(-1).id);
  await w.settle();
  const after1 = w.shared();
  assert.ok(titles(w).includes('새것') && titles(w).includes('바꿈'), '첫 호출이 공유 트리에 썼다');
  assert.equal(a.mem.baseVersion, 1, '기준점은 저장되지 않았다');

  a.start(); // 서비스 워커 다시 시작
  await a.engine.sync();
  await w.settle();
  const after2 = w.shared();
  assert.equal(after2.version, after1.version, '같은 ops를 다시 보냈는데 공유 트리가 바뀜');
  assert.deepEqual(after2.roots, after1.roots);
  assert.equal(a.responses.at(-1).results.applied, 0);
  assert.equal(countNodes(after2.roots), countNodes(after1.roots), '중복 생성');
  await w.syncAll();
  assertAllEqual(w);
});

test('호스트를 부르는 동안 사용자가 고친 것은 reconcile로 지워지지 않는다(localEpoch)', async () => {
  const w = makeWorld();
  const m = w.addProfile(MASTER);
  const a = w.addProfile('a@x');
  await seedTree(m.bm, 'M');
  await startAll(w);

  await m.bm.create({ parentId: '1', title: '메인추가', url: 'https://m.example/add' });
  await w.settle();
  a.duringCall = async () => { await a.bm.create({ parentId: '2', title: '호출중추가', url: 'https://during.example/' }); };
  await a.engine.sync();
  await w.settle();
  assert.ok(JSON.stringify(a.bm._dump()).includes('호출중추가'), '호출 중 사용자 추가가 reconcile로 지워짐');
  assert.ok(titles(w).includes('호출중추가'));
  assert.ok(JSON.stringify(a.bm._dump()).includes('메인추가'));
  await w.syncAll();
  assertAllEqual(w);
});

test('v1 저장소(map + pending, 기준점 없음)에서 옮길 때 로컬 ID가 하나도 바뀌지 않는다', async () => {
  const w = makeWorld();
  const m = w.addProfile(MASTER);
  const a = w.addProfile('a@x');
  await seedTree(m.bm, 'M');
  await startAll(w);
  const before = new Map();
  for (const id of a.bm._all()) before.set(id, (await a.bm.get(id))[0].title);

  // v1 상태 만들기: 허브가 멈춘 동안 v1이 pending에 모은 생성 1개 + 아직 묶이지 않은 노드 1개, 기준점 없음
  a.engine.stop();
  const pn = await a.bm.create({ parentId: '2', title: 'v1대기', url: 'https://v1.example/pending' });
  const un = await a.bm.create({ parentId: '1', index: 0, title: 'v1안묶임', url: 'https://v1.example/unbound' });
  for (const k of ['base', 'baseVersion', 'mismatch', 'blocked']) delete a.mem[k];
  a.mem.map.gv1 = pn.id;
  a.mem.pending = [{ op: 'create', gid: 'gv1', parent: 'root_other', index: pn.index, title: 'v1대기', url: 'https://v1.example/pending' }];
  await m.bm.create({ parentId: '1', title: '메인추가', url: 'https://m.example/add' });
  await w.settle();

  let creates = 0;
  const create = a.bm.create;
  a.bm.create = async (o) => { creates++; return create(o); };
  a.start();
  await a.engine.sync();
  await w.settle();

  for (const [id, title] of [...before, [pn.id, 'v1대기'], [un.id, 'v1안묶임']]) {
    const [n] = await a.bm.get(id);
    assert.equal(n.title, title, `로컬 노드 ${id}가 바뀜`);
  }
  assert.equal(creates, 1, '메인이 추가한 1개 말고는 새로 만들지 않는다(다시 덮어쓰기 없음)');
  assert.ok(titles(w).includes('v1대기') && titles(w).includes('v1안묶임'));
  assert.deepEqual(a.mem.pending, []);
  assert.ok(a.mem.base);
  await w.syncAll();
  assertAllEqual(w);
});

test('루트를 찾지 못한 프로필(모바일): 그 루트는 지우지도 비교하지도 않는다', async () => {
  const w = makeWorld();
  const m = w.addProfile(MASTER);
  const a = w.addProfile('a@x', { failGet: ['3'] }); // 빈 모바일 폴더가 숨겨지고 ID로도 못 찾음
  await seedTree(m.bm, 'M');
  await m.bm.create({ parentId: '3', title: '모바일1', url: 'https://m.example/1' });
  await w.settle();
  await m.engine.sync();
  await a.engine.sync();
  await w.settle();

  await a.bm.create({ parentId: '1', title: 'A추가', url: 'https://a.example/add' });
  await w.settle();
  assert.ok(titles(w).includes('A추가'));
  assert.ok(titles(w).includes('모바일1'), '찾지 못한 루트의 공유 노드가 지워짐');
  assert.ok(a.requests.every((r) => !(r.ops || []).some((o) => o.op === 'remove')), '삭제 op를 보냄');
  assert.deepEqual(a.mem.base.root_mobile, []);
  const st = a.engine.debugState();
  assert.equal(st.mismatch, 0);
  assert.equal(st.stuck, false);
  assert.equal(st.synced, true);
});
