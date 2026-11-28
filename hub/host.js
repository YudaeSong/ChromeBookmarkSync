// Chrome Native Messaging 호스트. Chrome이 sendNativeMessage마다 hub/native/host.bat를 통해 이 파일을 띄우고,
// 요청 하나(4바이트 LE 길이 + UTF-8 JSON)를 받아 응답 하나를 보낸 뒤 끝난다.
// 공유 트리는 hub/data/shared.json(store.js)에 있고, 모든 요청은 잠금 안에서 「읽기 → 적용 → 쓰기」를 한다.
// stdout에는 응답 프레임 말고 아무것도 쓰지 않는다(섞이면 Chrome이 연결을 끊는다). 로그는 host.log에만 쓴다.
//
// CLI(사람이 직접 실행): node hub/host.js --import-state | --export-state | --status
import fs from 'node:fs';
import path from 'node:path';
import { PROTOCOL, countNodes } from '../extension/shared.js';
import { mergeOps } from './merge.js';
import { createLogger, readShared, storePaths, withLock, writeShared } from './store.js';
import { Tree } from './tree.js';

export const MAX_RESPONSE_BYTES = 1_000_000; // Chrome의 호스트→확장 메시지 한도(1 MB)
export const MAX_REQUEST_BYTES = 64 * 1024 * 1024; // 확장→호스트 한도(64 MiB)
// 사용자가 확인한 대량 삭제(confirmRemove)의 gid 목록을 최근 몇 건까지 남긴다. 받는 프로필은 기준점 이후의
// 확인된 삭제를 들어오는 쪽 대량 삭제 보호 판정에서 뺀다(확인한 삭제 때문에 나머지 프로필이 모두 멈추지 않게).
// 이보다 오래 동기화하지 않은 프로필은 그 삭제를 보호에 걸린 것으로 보고 사용자가 한 번 더 확인한다.
export const CONFIRMED_KEEP = 5;

const hubDir = import.meta.dirname;
const defaultManifest = path.join(hubDir, '..', 'extension', 'manifest.json');

export function defaultContext() {
  const dataDir = process.env.BMSYNC_DATA_DIR || path.join(hubDir, 'data');
  const configFile = process.env.BMSYNC_CONFIG || path.join(hubDir, 'config.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  return { dataDir, config, log: createLogger(dataDir) };
}

function readDiskVersion(manifestPath) {
  try { return JSON.parse(fs.readFileSync(manifestPath, 'utf8')).version ?? null; } catch { return null; }
}

const isMaster = (config, email) => !!email && String(email).toLowerCase() === String(config.masterEmail || '').toLowerCase();
const normEmail = (e) => String(e ?? '').trim().toLowerCase();

// config.excludeEmails에 적힌 Google 계정의 프로필은 동기화하지 않는다(받지도 올리지도 않음). 빈 email은 일치시키지 않는다.
// 메인 프로필은 목록에 있어도 제외하지 않는다(메인이 빠지면 공유 트리를 처음 만들 수 없다).
function isExcluded(config, email, log) {
  const e = normEmail(email);
  if (!e || !Array.isArray(config.excludeEmails)) return false;
  if (!config.excludeEmails.some((x) => normEmail(x) === e)) return false;
  if (isMaster(config, email)) { log('config: masterEmail is in excludeEmails, ignored'); return false; }
  return true;
}

function clientEntry(req) {
  return {
    email: String(req.email ?? ''),
    version: req.version ?? null,
    protocol: req.protocol ?? null,
    at: new Date().toISOString(),
    result: ['ok', 'blocked', 'stuck'].includes(req.result) ? req.result : 'ok',
  };
}

function validRoots(roots) {
  if (!roots || typeof roots !== 'object' || Array.isArray(roots)) return null;
  const t = new Tree();
  t.initFrom(roots); // gid 중복·누락은 예외
  return t;
}

async function handleInner(req, ctx) {
  const { dataDir, config, log } = ctx;
  if (!req || typeof req !== 'object' || Array.isArray(req)) return { error: 'bad-request' };
  if (req.protocol !== PROTOCOL) {
    log(`protocol mismatch from ${req.email ?? '?'}: got ${req.protocol} want ${PROTOCOL} (v=${req.version ?? '?'})`);
    return { error: 'protocol', want: PROTOCOL };
  }
  if (req.type !== 'sync' && req.type !== 'init') return { error: 'bad-request' };
  if (typeof req.clientId !== 'string' || !req.clientId) return { error: 'bad-request' };
  if (req.type === 'sync' && req.ops != null && !Array.isArray(req.ops)) return { error: 'bad-request' };
  // 예외 프로필: 잠금을 잡지 않고 shared.json도 쓰지 않는다(version·clients 그대로). protocol 검사는 그 앞이라 옛 코드 감지는 유지된다.
  if (isExcluded(config, req.email, log)) {
    log(`excluded ${req.email}`);
    return { excluded: true };
  }
  const master = isMaster(config, req.email);
  const p = storePaths(dataDir);

  return withLock(dataDir, async () => {
    const shared = readShared(dataDir);
    const initialized = !!shared?.initialized;
    // 공유 파일이 없는데 허브의 state.json이 남아 있으면 옮기기(--import-state)가 먼저다.
    // 여기서 메인 트리로 새로 초기화하면 모든 프로필이 다시 덮어써진다.
    const migrateFirst = !shared && fs.existsSync(p.state);

    if (req.type === 'init') {
      if (initialized) return { version: shared.version, roots: shared.roots };
      if (!master) return { need: 'wait' };
      if (migrateFirst) { log(`init refused (state.json exists, run --import-state) from ${req.email}`); return { error: 'migrate-first' }; }
      let tree;
      try { tree = validRoots(req.roots); } catch (e) { log(`init failed from ${req.email}: ${e.message}`); return { error: 'bad-request', message: e.message }; }
      if (!tree) return { error: 'bad-request' };
      const roots = tree.snapshot().roots;
      const now = new Date().toISOString();
      await writeShared(dataDir, {
        version: 1, initialized: true, roots, updatedAt: now, updatedBy: req.clientId,
        clients: { ...(shared?.clients || {}), [req.clientId]: clientEntry(req) },
      }, { log });
      log(`init from ${req.email} (${req.clientId}): ${tree.count()} nodes`);
      return { version: 1, roots };
    }

    // sync
    if (!initialized) {
      if (!master) return { need: 'wait' };
      if (migrateFirst) { log(`sync refused (state.json exists, run --import-state) from ${req.email}`); return { error: 'migrate-first' }; }
      return { need: 'init' };
    }
    const ops = req.ops || [];
    const tree = new Tree();
    tree.initFrom(shared.roots);
    const before = req.confirmRemove === true ? new Set(tree.nodes.keys()) : null;
    const r = mergeOps(tree, ops);
    const next = { ...shared, clients: { ...(shared.clients || {}), [req.clientId]: clientEntry(req) } };
    if (r.changed) {
      next.roots = tree.snapshot().roots;
      next.version = (Number(shared.version) || 0) + 1;
      next.updatedAt = new Date().toISOString();
      next.updatedBy = req.clientId;
      const gone = before ? [...before].filter((g) => !tree.nodes.has(g)) : [];
      if (gone.length) {
        next.confirmed = [...(shared.confirmed || []), { version: next.version, gids: gone }].slice(-CONFIRMED_KEEP);
        log(`confirmed removal from ${req.email}: ${gone.length} nodes at v${next.version}`);
      }
    }
    await writeShared(dataDir, next, { log });
    if (ops.length || r.skipped) {
      log(`sync ${req.email} ops=${ops.length} applied=${r.applied} unchanged=${r.unchanged} skipped=${r.skipped} rescued=${r.rescued} v=${shared.version}->${next.version}`
        + (r.rejects.length ? ` rejects=${JSON.stringify(r.rejects.slice(0, 20))}` : ''));
    }
    const out = { version: next.version, results: { applied: r.applied, unchanged: r.unchanged, skipped: r.skipped, rescued: r.rescued } };
    // 빠른 경로: 보낸 ops가 없고 기준점이 최신이면 트리를 싣지 않는다.
    if (ops.length || req.baseVersion !== next.version) {
      out.roots = next.roots;
      const since = Number(req.baseVersion) || 0;
      const confirmed = (next.confirmed || []).filter((e) => e.version > since);
      if (confirmed.length) out.confirmed = confirmed;
    }
    return out;
  }, { log });
}

// 테스트가 프로세스 없이 부를 수 있게 export한다. ctx: { dataDir, config:{masterEmail, extensionId}, log?, manifestPath? }
export async function handleRequest(req, ctx) {
  const c = { log: () => {}, ...ctx };
  let res;
  try {
    res = await handleInner(req, c);
  } catch (e) {
    if (e.code === 'LOCK_TIMEOUT') { c.log('lock-timeout'); res = { error: 'lock-timeout' }; } else { c.log('internal error', e.stack); res = { error: 'internal', message: e.message }; }
  }
  res.diskVersion = readDiskVersion(c.manifestPath || defaultManifest);
  const bytes = Buffer.byteLength(JSON.stringify(res));
  if (bytes > MAX_RESPONSE_BYTES) {
    c.log(`response too large: ${bytes} B`);
    return { error: 'too-large', bytes, diskVersion: res.diskVersion };
  }
  return res;
}

export function encodeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

// ---- 네이티브 모드 ----
function runNative(origin) {
  // 어떤 경로로도 stdout에 섞이지 않게 막는다.
  let ctx;
  try { ctx = defaultContext(); } catch { process.exit(1); }
  const { log } = ctx;
  console.log = console.info = console.debug = (...a) => log('console', a.join(' '));
  const allowed = `chrome-extension://${ctx.config.extensionId}/`;
  if (origin !== allowed) { log(`refused origin ${origin}`); process.exit(1); }

  let buf = Buffer.alloc(0);
  let done = false;
  const reply = (obj) => {
    done = true;
    process.stdin.pause();
    process.stdout.write(encodeFrame(obj), () => process.exit(0));
  };
  process.stdin.on('data', (chunk) => {
    if (done) return;
    buf = Buffer.concat([buf, chunk]);
    if (buf.length < 4) return;
    const len = buf.readUInt32LE(0);
    if (len > MAX_REQUEST_BYTES) { reply({ error: 'bad-request' }); return; }
    if (buf.length < 4 + len) return;
    let req;
    try { req = JSON.parse(buf.subarray(4, 4 + len).toString('utf8')); } catch { reply({ error: 'bad-request' }); return; }
    done = true;
    handleRequest(req, ctx).then(reply, (e) => { log('fatal', e.stack); reply({ error: 'internal' }); });
  });
  process.stdin.on('end', () => { if (!done) { log('stdin closed before a full message'); process.exit(0); } });
}

// ---- CLI ----
async function runCli(cmd) {
  const ctx = defaultContext();
  const { dataDir, log } = ctx;
  const p = storePaths(dataDir);
  if (cmd === '--import-state') {
    await withLock(dataDir, async () => {
      if (fs.existsSync(p.shared)) throw new Error(`이미 ${p.shared}가 있습니다. 옮기기는 한 번만 합니다(덮어쓰지 않음).`);
      const state = JSON.parse(fs.readFileSync(p.state, 'utf8'));
      if (!state.initialized) throw new Error('state.json이 초기화되지 않은 상태입니다.');
      const roots = validRoots(state.roots).snapshot().roots;
      await writeShared(dataDir, { version: 1, initialized: true, roots, updatedAt: new Date().toISOString(), updatedBy: 'import-state', clients: {} }, { log });
      log(`import-state: ${countNodes(roots)} nodes`);
      process.stdout.write(`shared.json 생성: version 1, 노드 ${countNodes(roots)}개\n`);
    });
    return;
  }
  if (cmd === '--export-state') {
    await withLock(dataDir, async () => {
      const shared = readShared(dataDir);
      if (!shared?.initialized) throw new Error('shared.json이 없거나 초기화되지 않았습니다.');
      if (fs.existsSync(p.state)) {
        const keep = `${p.state}.before-export-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        fs.copyFileSync(p.state, keep);
        process.stdout.write(`기존 state.json 보관: ${keep}\n`);
      }
      fs.writeFileSync(`${p.state}.tmp`, JSON.stringify({ initialized: true, roots: shared.roots }));
      fs.renameSync(`${p.state}.tmp`, p.state);
      log(`export-state: version ${shared.version}, ${countNodes(shared.roots)} nodes`);
      process.stdout.write(`state.json 내보냄: version ${shared.version}, 노드 ${countNodes(shared.roots)}개\n`);
    });
    return;
  }
  if (cmd === '--status') {
    const shared = await withLock(dataDir, async () => readShared(dataDir));
    const status = shared
      ? { initialized: !!shared.initialized, version: shared.version, nodes: countNodes(shared.roots || {}), updatedAt: shared.updatedAt, updatedBy: shared.updatedBy, clients: shared.clients || {} }
      : { initialized: false, sharedFile: 'none', stateJson: fs.existsSync(p.state) ? 'exists (run --import-state)' : 'none' };
    process.stdout.write(`${JSON.stringify({ ...status, protocol: PROTOCOL, diskVersion: readDiskVersion(defaultManifest) }, null, 2)}\n`);
    return;
  }
  throw new Error(`알 수 없는 명령: ${cmd}`);
}

// .bat가 "%~dp0..\host.js"로 부르면 드라이브 문자 대소문자가 다를 수 있다(다르면 응답 없이 끝나 버린다).
const norm = (f) => (process.platform === 'win32' ? path.resolve(f).toLowerCase() : path.resolve(f));
const isMain = process.argv[1] && norm(process.argv[1]) === norm(import.meta.filename);
if (isMain) {
  const first = process.argv[2] || '';
  if (first.startsWith('--')) {
    runCli(first).catch((e) => { process.stderr.write(`${e.message}\n`); process.exit(1); });
  } else {
    runNative(first);
  }
}
