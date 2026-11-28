// 네이티브 호스트(hub/host.js)·공유 저장소(hub/store.js)·3-way diff(extension/diff.js)↔병합(hub/merge.js) 검증.
// 모든 파일은 임시 폴더에서 다루고 hub/data는 건드리지 않는다.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { diffTrees } from '../extension/diff.js';
import { PROTOCOL, countNodes, serializeRoots } from '../extension/shared.js';
import { encodeFrame, handleRequest } from '../hub/host.js';
import { mergeOps, mergeRoots } from '../hub/merge.js';
import { readShared } from '../hub/store.js';
import { Tree } from '../hub/tree.js';

const HOST = path.join(import.meta.dirname, '..', 'hub', 'host.js');
const MASTER = 'main@example.com';
const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const ORIGIN = `chrome-extension://${EXT_ID}/`;

function makeEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmsync-host-'));
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir);
  const config = { masterEmail: MASTER, extensionId: EXT_ID };
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(config));
  return { dir, dataDir, config, configFile, ctx: { dataDir, config } };
}

function runHost(env, args, { input = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOST, ...args], {
      env: { ...process.env, BMSYNC_DATA_DIR: env.dataDir, BMSYNC_CONFIG: env.configFile },
    });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() }));
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

// 응답 프레임이 정확히 하나이고 그 밖의 바이트가 없어야 한다.
function decodeOne(buf) {
  assert.ok(buf.length >= 4, `no frame (got ${buf.length} bytes)`);
  const len = buf.readUInt32LE(0);
  assert.equal(buf.length, 4 + len, 'stdout must contain exactly one frame');
  return JSON.parse(buf.subarray(4).toString('utf8'));
}

const sendNative = async (env, msg, origin = ORIGIN) => {
  const r = await runHost(env, [origin, '--parent-window=0'], { input: encodeFrame(msg) });
  return decodeOne(r.stdout);
};

const req = (type, extra = {}) => ({ type, clientId: 'c-main', email: MASTER, protocol: PROTOCOL, version: '2.0.0', ...extra });
const bm = (gid, url = `https://${gid}.example/`, title = gid) => ({ gid, title, url });
const folder = (gid, children = [], title = gid) => ({ gid, title, children });
const R = (bar = [], other = [], mobile = []) => ({ root_bar: bar, root_other: other, root_mobile: mobile });
const clone = (x) => structuredClone(x);
const same = (a, b) => assert.equal(serializeRoots(a), serializeRoots(b));

// base에서 출발한 각 프로필의 local을 순서대로 공유 트리에 병합한다(나중 것이 나중에 맞춘 쪽).
function mergeAll(base, ...locals) {
  const tree = new Tree();
  tree.initFrom(base);
  const results = locals.map((local) => mergeOps(tree, diffTrees(base, local).ops));
  return { roots: tree.snapshot().roots, results };
}
const kids = (roots, path0) => {
  let list = roots[path0[0]];
  for (const g of path0.slice(1)) list = list.find((n) => n.gid === g).children;
  return list.map((n) => n.gid);
};

// ---------------- 네이티브 프레이밍·출처 ----------------

test('네이티브 프레이밍: need-init/wait → init → sync, stdout에는 응답 프레임 하나만', async () => {
  const env = makeEnv();
  assert.deepEqual((await sendNative(env, req('sync', { email: 'other@example.com', clientId: 'c-2', baseVersion: null, ops: [] }))).need, 'wait');
  const ni = await sendNative(env, req('sync', { baseVersion: null, ops: [] }));
  assert.equal(ni.need, 'init');
  assert.equal(ni.diskVersion, JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'extension', 'manifest.json'), 'utf8')).version);
  assert.equal(fs.existsSync(path.join(env.dataDir, 'shared.json')), false, 'need-init/wait는 shared.json을 만들지 않는다');

  const base = R([bm('a'), folder('F', [bm('x')])], [bm('o')]);
  const init = await sendNative(env, req('init', { roots: base }));
  assert.equal(init.version, 1);
  same(init.roots, base);

  const s = await sendNative(env, req('sync', { baseVersion: 1, ops: diffTrees(base, R([bm('a'), bm('n'), folder('F', [bm('x')])], [bm('o')])).ops }));
  assert.equal(s.version, 2);
  assert.deepEqual(s.results, { applied: 1, unchanged: 0, skipped: 0, rescued: 0 });
  assert.deepEqual(kids(s.roots, ['root_bar']), ['a', 'n', 'F']);

  // 빠른 경로: ops 없음 + 기준점 최신 → roots 없음. 기준점이 옛것이면 roots를 싣는다.
  const fast = await sendNative(env, req('sync', { baseVersion: 2, ops: [] }));
  assert.equal(fast.version, 2);
  assert.equal('roots' in fast, false);
  const stale = await sendNative(env, req('sync', { clientId: 'c-2', email: 'other@example.com', baseVersion: 1, ops: [], result: 'stuck' }));
  assert.ok(stale.roots);

  const shared = readShared(env.dataDir);
  assert.equal(shared.version, 2);
  assert.equal(shared.clients['c-main'].protocol, PROTOCOL);
  assert.equal(shared.clients['c-2'].result, 'stuck');
  assert.ok(fs.readdirSync(path.join(env.dataDir, 'backups')).some((f) => /^shared-\d{4}-\d\d-\d\d\.json$/.test(f)));
  assert.ok(fs.existsSync(path.join(env.dataDir, 'host.log')));
});

test('출처가 다른 확장이면 응답 없이 종료하고 아무것도 쓰지 않는다', async () => {
  const env = makeEnv();
  for (const origin of ['chrome-extension://ppppppppppppppppppppppppppppppppp/', `chrome-extension://${EXT_ID}`, '']) {
    const r = await runHost(env, origin ? [origin, '--parent-window=0'] : [], { input: encodeFrame(req('sync', { ops: [] })) });
    assert.equal(r.stdout.length, 0, `origin '${origin}' must get no bytes`);
  }
  assert.equal(fs.existsSync(path.join(env.dataDir, 'shared.json')), false);
});

test('잘못된 요청: 깨진 JSON, protocol 불일치, 형식 오류', async () => {
  const env = makeEnv();
  const bad = Buffer.from('{not json', 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(bad.length);
  assert.equal(decodeOne((await runHost(env, [ORIGIN], { input: Buffer.concat([head, bad]) })).stdout).error, 'bad-request');
  assert.deepEqual(await handleRequest(req('sync', { protocol: PROTOCOL - 1 }), env.ctx).then(({ diskVersion, ...r }) => r), { error: 'protocol', want: PROTOCOL });
  assert.equal((await handleRequest(req('nope'), env.ctx)).error, 'bad-request');
  assert.equal((await handleRequest(req('sync', { clientId: '' }), env.ctx)).error, 'bad-request');
  assert.equal((await handleRequest(req('sync', { ops: 'x' }), env.ctx)).error, 'bad-request');
  assert.equal((await handleRequest([1], env.ctx)).error, 'bad-request');
  assert.equal((await handleRequest(req('init', { roots: R([bm('d'), bm('d')]) }), env.ctx)).error, 'bad-request', 'gid 중복 init은 거부(init 실패 시 reset)');
  assert.equal(fs.existsSync(path.join(env.dataDir, 'shared.json')), false);
  assert.equal((await handleRequest(req('init', { email: 'other@example.com', roots: R() }), env.ctx)).need, 'wait', '메인만 init');
});

// ---------------- 공유 저장소: 잠금·동시 쓰기 ----------------

test('프로세스 여러 개가 동시에 써도 유실 없이 version이 하나씩 오른다', async () => {
  const env = makeEnv();
  await handleRequest(req('init', { roots: R([bm('a')]) }), env.ctx);
  const N = 8;
  const outs = await Promise.all(Array.from({ length: N }, (_, i) => sendNative(env, req('sync', {
    clientId: `c${i}`, email: `p${i}@example.com`, baseVersion: 1,
    ops: [{ op: 'create', gid: `n${i}`, parent: 'root_bar', after: 'a', index: 1, title: `n${i}`, url: `https://n${i}.example/` }],
  }))));
  assert.ok(outs.every((o) => !o.error), JSON.stringify(outs.filter((o) => o.error)));
  assert.deepEqual(outs.map((o) => o.version).sort((x, y) => x - y), Array.from({ length: N }, (_, i) => i + 2));
  const shared = readShared(env.dataDir);
  assert.equal(shared.version, N + 1);
  assert.equal(countNodes(shared.roots), N + 1);
  assert.equal(Object.keys(shared.clients).length, N + 1, 'init한 c-main + 동시 요청 N개');
  assert.equal(fs.existsSync(path.join(env.dataDir, 'shared.json.lock')), false, '잠금은 해제된다');
});

test('30초 넘은 잠금 파일은 찌꺼기로 보고 지운다', async () => {
  const env = makeEnv();
  const lock = path.join(env.dataDir, 'shared.json.lock');
  fs.writeFileSync(lock, 'dead');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  assert.equal((await handleRequest(req('sync', { ops: [] }), env.ctx)).need, 'init');
  assert.equal(fs.existsSync(lock), false);
});

test('잠금을 못 얻으면 lock-timeout', { timeout: 15_000 }, async () => {
  const env = makeEnv();
  fs.writeFileSync(path.join(env.dataDir, 'shared.json.lock'), 'busy'); // 갓 만든 잠금(찌꺼기 아님)
  const t0 = Date.now();
  const r = await handleRequest(req('sync', { ops: [] }), env.ctx);
  assert.equal(r.error, 'lock-timeout');
  assert.ok(Date.now() - t0 >= 4900);
});

test('응답이 1,000,000 B를 넘으면 트리 없이 too-large', async () => {
  const env = makeEnv();
  const pad = 'x'.repeat(200);
  const big = R(Array.from({ length: 6000 }, (_, i) => bm(`b${i}`, `https://e.example/${i}/${pad}`)));
  const r = await handleRequest(req('init', { roots: big }), env.ctx);
  assert.equal(r.error, 'too-large');
  assert.ok(r.bytes > 1_000_000);
  assert.equal('roots' in r, false);
});

// ---------------- 옮기기(D-4)와 재초기화 금지 ----------------

test('shared.json 없이 state.json만 있으면 메인의 init을 거부(migrate-first)', async () => {
  const env = makeEnv();
  fs.writeFileSync(path.join(env.dataDir, 'state.json'), JSON.stringify({ initialized: true, roots: R([bm('s')]) }));
  assert.equal((await handleRequest(req('sync', { ops: [] }), env.ctx)).error, 'migrate-first');
  assert.equal((await handleRequest(req('init', { roots: R([bm('m')]) }), env.ctx)).error, 'migrate-first');
  assert.equal((await handleRequest(req('sync', { email: 'other@example.com', ops: [] }), env.ctx)).need, 'wait');
  assert.equal(fs.existsSync(path.join(env.dataDir, 'shared.json')), false);
});

test('--import-state는 한 번만: 이미 shared.json이 있으면 거부, --export-state·--status', async () => {
  const env = makeEnv();
  const roots = R([bm('s1'), folder('SF', [bm('s2')])], [bm('s3')]);
  fs.writeFileSync(path.join(env.dataDir, 'state.json'), JSON.stringify({ initialized: true, roots }));
  const first = await runHost(env, ['--import-state']);
  assert.equal(first.code, 0, first.stderr);
  const shared = readShared(env.dataDir);
  assert.equal(shared.version, 1);
  same(shared.roots, roots);

  await handleRequest(req('sync', { baseVersion: 1, ops: [{ op: 'remove', gid: 's3' }] }), env.ctx);
  const before = fs.readFileSync(path.join(env.dataDir, 'shared.json'), 'utf8');
  const again = await runHost(env, ['--import-state']);
  assert.notEqual(again.code, 0);
  assert.equal(fs.readFileSync(path.join(env.dataDir, 'shared.json'), 'utf8'), before, '거부 시 shared.json 그대로');

  const ex = await runHost(env, ['--export-state']);
  assert.equal(ex.code, 0, ex.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(env.dataDir, 'state.json'), 'utf8'));
  assert.equal(state.initialized, true);
  same(state.roots, R([bm('s1'), folder('SF', [bm('s2')])]));
  assert.ok(fs.readdirSync(env.dataDir).some((f) => f.startsWith('state.json.before-export-')), '기존 state.json 보관');

  const st = JSON.parse((await runHost(env, ['--status'])).stdout.toString());
  assert.equal(st.version, 2);
  assert.equal(st.nodes, 3);
  assert.equal(st.clients['c-main'].protocol, PROTOCOL);
});

// ---------------- diff ----------------

test('diff: create/move/update/remove 모양, remove는 맨 뒤, reorder 없음, 바뀐 필드만 update', () => {
  const base = R([bm('a'), folder('F', [bm('x'), bm('y')]), bm('b')]);
  const local = R([bm('b'), bm('a', 'https://a2.example/'), bm('x'), bm('n')], [folder('G', [bm('g1')])]);
  const { ops, removeCount } = diffTrees(base, local);
  assert.equal(removeCount, 2, 'F와 y가 지워짐(x는 꺼내져 살아남음)');
  assert.deepEqual(ops.map((o) => o.op), ['move', 'update', 'move', 'create', 'create', 'create', 'remove']);
  assert.deepEqual(ops.at(-1), { op: 'remove', gid: 'F' });
  assert.deepEqual(ops[1], { op: 'update', gid: 'a', url: 'https://a2.example/' });
  assert.ok(!ops.some((o) => o.op === 'reorder'));
  assert.deepEqual(ops.find((o) => o.gid === 'n'), { op: 'create', gid: 'n', parent: 'root_bar', after: 'x', index: 3, title: 'n', url: 'https://n.example/' });
  assert.deepEqual(ops.find((o) => o.gid === 'g1'), { op: 'create', gid: 'g1', parent: 'G', after: null, index: 0, title: 'g1', url: 'https://g1.example/' });
  same(mergeRoots(base, ops).roots, local);
  assert.deepEqual(diffTrees(local, clone(local)).ops, [], '같은 트리는 빈 결과(메아리는 호스트를 부르지 않는다)');
});

test('diff: 같은 폴더 순서 변경은 LCS 밖 노드만 move', () => {
  const base = R([bm('a'), bm('b'), bm('c'), bm('d'), bm('e')]);
  const local = R([bm('e'), bm('a'), bm('b'), bm('c'), bm('d')]);
  const { ops } = diffTrees(base, local);
  assert.deepEqual(ops, [{ op: 'move', gid: 'e', parent: 'root_bar', after: null, index: 0 }]);
  same(mergeRoots(base, ops).roots, local);
  const swap = diffTrees(R([bm('a'), bm('b')]), R([bm('b'), bm('a')])).ops;
  assert.equal(swap.length, 1);
});

test('diff: skipRoots 아래는 비교하지 않고, removeCount는 하위까지 센다', () => {
  const base = R([folder('F', [bm('x'), folder('G', [bm('y')])])], [], [bm('m1'), bm('m2')]);
  const local = R([], [], []);
  const skipped = diffTrees(base, local, { skipRoots: ['root_mobile'] });
  assert.deepEqual(skipped.ops, [{ op: 'remove', gid: 'F' }]);
  assert.equal(skipped.removeCount, 4);
  assert.equal(diffTrees(base, local).removeCount, 6);
  assert.throws(() => diffTrees(base, R([{ title: 'no gid', url: 'u' }])), /without gid/);
});

// ---------------- diff → merge 왕복: 설계 §4.3 표 ----------------

test('§4.3 앵커 유지: 다른 프로필이 같은 폴더에 추가해도 내 순서가 유지된다', () => {
  const base = R([folder('F', [bm('a'), bm('b'), bm('c')])]);
  const A = R([folder('F', [bm('a'), bm('x'), bm('b'), bm('c')])]);
  const B = R([folder('F', [bm('a'), bm('b'), bm('y'), bm('c')])]);
  assert.deepEqual(kids(mergeAll(base, A, B).roots, ['root_bar', 'F']), ['a', 'x', 'b', 'y', 'c']);
  assert.deepEqual(kids(mergeAll(base, B, A).roots, ['root_bar', 'F']), ['a', 'x', 'b', 'y', 'c']);
  // 맨 앞(after null)
  const C = R([folder('F', [bm('z'), bm('a'), bm('b'), bm('c')])]);
  assert.deepEqual(kids(mergeAll(base, A, C).roots, ['root_bar', 'F']), ['z', 'a', 'x', 'b', 'c']);
});

test('§4.3 앵커 없음: 다른 곳에서 지워진 앵커면 op.index를 범위 안으로 줄여 쓴다', () => {
  const base = R([folder('F', [bm('a'), bm('b'), bm('c')])]);
  const A = R([folder('F', [bm('c')])]); // a, b 삭제
  const B = R([folder('F', [bm('a'), bm('b'), bm('y'), bm('c')])]); // b 뒤(index 2)에 y
  const { roots, results } = mergeAll(base, A, B);
  assert.deepEqual(kids(roots, ['root_bar', 'F']), ['c', 'y']);
  assert.equal(results[1].applied, 1);
});

test('§4.3 양쪽이 같은 노드를 수정·이동하면 나중에 맞춘 쪽이 이긴다', () => {
  const base = R([bm('a'), folder('G'), folder('H')]);
  const A = R([folder('G', [bm('a', 'https://A.example/', 'A')]), folder('H')]);
  const B = R([folder('G'), folder('H', [bm('a', 'https://B.example/', 'B')])]);
  const { roots } = mergeAll(base, A, B);
  same(roots, B);
  // 한쪽은 제목만, 다른 쪽은 url만 고쳤으면 둘 다 남는다(바뀐 필드만 보냄)
  const T = R([bm('a', 'https://a.example/', 'T'), folder('G'), folder('H')]);
  const U = R([bm('a', 'https://U.example/'), folder('G'), folder('H')]);
  same(mergeAll(base, T, U).roots, R([bm('a', 'https://U.example/', 'T'), folder('G'), folder('H')]));
});

test('§4.3 다른 프로필이 지운 노드를 수정·이동하면 건너뜀(삭제 우선)', () => {
  const base = R([bm('a'), bm('b'), folder('G')]);
  const A = R([bm('a'), folder('G')]);
  const B = R([bm('a'), folder('G', [bm('b', 'https://b2.example/', 'b2')])]);
  const { roots, results } = mergeAll(base, A, B);
  same(roots, R([bm('a'), folder('G')]));
  assert.equal(results[1].skipped, 2);
  assert.equal(results[1].changed, false);
});

test('§4.3 다른 프로필이 지운 폴더 안에 새로 만든 것은 기타 북마크 끝으로 구조', () => {
  const base = R([folder('F', [bm('x')])], [bm('o')]);
  const A = R([], [bm('o')]);
  const B = R([folder('F', [bm('x'), bm('z'), folder('N', [bm('n1')])])], [bm('o')]);
  const { roots, results } = mergeAll(base, A, B);
  same(roots, R([], [bm('o'), bm('z'), folder('N', [bm('n1')])]));
  assert.equal(results[1].rescued, 2);
  assert.equal(results[1].applied, 1, 'N 안의 n1은 구조된 N 안에 그대로 만들어진다');
});

test('§4.3 다른 프로필이 지운 폴더로 옮기면 건너뛰어 원래 자리에 남는다', () => {
  const base = R([bm('a'), folder('F')]);
  const A = R([bm('a')]);
  const B = R([folder('F', [bm('a')])]);
  const { roots, results } = mergeAll(base, A, B);
  same(roots, R([bm('a')]));
  assert.equal(results[1].skipped, 1);
});

test('§4.3 자기 하위로 옮기기(cycle)는 건너뜀', () => {
  const base = R([folder('P'), folder('Q')]);
  const A = R([folder('Q', [folder('P')])]);
  const B = R([folder('P', [folder('Q')])]);
  const { roots, results } = mergeAll(base, A, B);
  same(roots, A);
  assert.equal(results[1].skipped, 1);
});

test('§4.3 폴더 F에서 X를 꺼낸 뒤 F를 지우면 X는 살아남는다', () => {
  const base = R([folder('F', [bm('X'), folder('S', [bm('s1'), bm('s2')]), bm('Y')])]);
  const local = R([bm('X'), folder('S', [bm('s2')])]); // X·S를 꺼내고 s1·F·Y 삭제
  const { ops, removeCount } = diffTrees(base, local);
  assert.equal(removeCount, 3);
  assert.deepEqual(ops.filter((o) => o.op === 'remove').map((o) => o.gid), ['F', 's1']);
  same(mergeRoots(base, ops).roots, local);
});

test('§4.3 v1 pending의 reorder는 실패해도 조용히 건너뛴다, 같은 ops를 다시 보내도 결과가 같다(멱등)', () => {
  const tree = new Tree();
  tree.initFrom(R([bm('a'), bm('b')]));
  const r = mergeOps(tree, [{ op: 'reorder', parent: 'root_bar', children: ['b'] }, null, { op: 'move', gid: 'b', parent: 'root_bar', index: 0 }]);
  assert.deepEqual([r.skipped, r.applied], [2, 1]);
  assert.deepEqual(tree.snapshot().roots.root_bar.map((n) => n.gid), ['b', 'a']);

  const base = R([bm('a'), folder('F', [bm('x')])]);
  const local = R([folder('F', [bm('x', 'u2', 't2'), bm('a')]), bm('n')]);
  const { ops } = diffTrees(base, local);
  const once = mergeRoots(base, ops);
  const twice = mergeRoots(once.roots, ops);
  same(twice.roots, local);
  assert.equal(twice.changed, false);
});

// ---------------- 무작위 왕복: diff(base, local)를 base에 병합하면 local과 같다 ----------------

test('무작위 편집 500회: diff → merge 왕복이 local과 정확히 같다', () => {
  let s = 7;
  const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  let uid = 0;
  const gen = (depth) => Array.from({ length: Math.floor(rand() * 5) }, () => (depth < 3 && rand() < 0.3
    ? folder(`f${++uid}`, gen(depth + 1)) : bm(`b${++uid}`)));
  const allNodes = (roots) => {
    const out = [];
    const walk = (list, parentList) => list.forEach((n) => { out.push({ n, parentList }); if (n.children) walk(n.children, n.children); });
    for (const g of Object.keys(roots)) walk(roots[g], roots[g]);
    return out;
  };
  const folders = (roots) => [...Object.values(roots), ...allNodes(roots).filter((x) => x.n.children).map((x) => x.n.children)];
  const isInside = (node, list) => node.children && (node.children === list || node.children.some((c) => isInside(c, list)));

  for (let round = 0; round < 500; round++) {
    const base = R(gen(0), gen(0), gen(0));
    const local = clone(base);
    for (let k = Math.floor(rand() * 8); k > 0; k--) {
      const nodes = allNodes(local);
      const act = rand();
      if (act < 0.25 || !nodes.length) {
        const dest = pick(folders(local));
        dest.splice(Math.floor(rand() * (dest.length + 1)), 0, rand() < 0.3 ? folder(`f${++uid}`, [bm(`b${++uid}`)]) : bm(`b${++uid}`));
      } else if (act < 0.45) {
        const { n, parentList } = pick(nodes);
        parentList.splice(parentList.indexOf(n), 1);
      } else if (act < 0.65) {
        const { n } = pick(nodes);
        if (rand() < 0.5) n.title = `${n.title}*`; else if (n.url) n.url = `${n.url}#${uid++}`; else n.title = `${n.title}!`;
      } else {
        const { n, parentList } = pick(nodes);
        const dest = pick(folders(local));
        if (isInside(n, dest)) continue;
        parentList.splice(parentList.indexOf(n), 1);
        dest.splice(Math.floor(rand() * (dest.length + 1)), 0, n);
      }
    }
    const { ops } = diffTrees(base, local);
    const merged = mergeRoots(base, ops);
    assert.equal(serializeRoots(merged.roots), serializeRoots(local), `round ${round}`);
    assert.equal(merged.skipped + merged.rescued, 0, `round ${round}: 같은 기준점 위에서는 거부가 없어야 한다`);
  }
});
