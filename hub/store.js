// 공유 저장소: hub/data/shared.json 하나를 여러 네이티브 호스트 프로세스가 번갈아 읽고 쓴다.
// 잠금(shared.json.lock 배타 생성) 안에서만 읽기·쓰기를 하고, 쓰기는 tmp→rename으로 원자적으로 한다.
// 로그는 host.log에만 쓴다 — 네이티브 호스트의 stdout에 메시지가 아닌 바이트가 섞이면 Chrome이 연결을 끊는다.
import fs from 'node:fs';
import path from 'node:path';

export const LOCK_RETRY_MS = 25;
export const LOCK_WAIT_MS = 5000;
export const LOCK_STALE_MS = 30000;
export const RENAME_RETRY_MS = 20;
export const RENAME_RETRIES = 10;
export const BACKUP_KEEP = 30;
export const LOG_MAX_BYTES = 5 * 1024 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function storePaths(dataDir) {
  return {
    dataDir,
    shared: path.join(dataDir, 'shared.json'),
    lock: path.join(dataDir, 'shared.json.lock'),
    tmp: path.join(dataDir, 'shared.json.tmp'),
    state: path.join(dataDir, 'state.json'),
    backups: path.join(dataDir, 'backups'),
    log: path.join(dataDir, 'host.log'),
  };
}

export function createLogger(dataDir) {
  const file = storePaths(dataDir).log;
  return (...a) => {
    const line = `${new Date().toISOString()} [${process.pid}] ${a.join(' ')}\n`;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      if (fs.existsSync(file) && fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, `${file}.old`);
      fs.appendFileSync(file, line);
    } catch { /* 로그 실패는 무시 */ }
  };
}

export class LockTimeoutError extends Error {
  constructor() { super('lock-timeout'); this.code = 'LOCK_TIMEOUT'; }
}

// fn은 잠금을 쥔 채로 실행된다. 잠금 파일이 LOCK_STALE_MS보다 오래됐으면 죽은 프로세스의 찌꺼기로 보고 지운다.
export async function withLock(dataDir, fn, { log = () => {} } = {}) {
  const { lock } = storePaths(dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd;
  for (;;) {
    try {
      fd = fs.openSync(lock, 'wx');
      break;
    } catch (e) {
      if (e.code !== 'EEXIST' && e.code !== 'EPERM' && e.code !== 'EBUSY') throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lock);
          log('stale lock removed');
          continue;
        }
      } catch { /* 그 사이 다른 프로세스가 지웠다 */ }
      if (Date.now() >= deadline) throw new LockTimeoutError();
      await sleep(LOCK_RETRY_MS);
    }
  }
  try {
    try { fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}`); } catch { /* 내용은 참고용 */ }
    return await fn();
  } finally {
    try { fs.closeSync(fd); } catch { /* 무시 */ }
    try { fs.unlinkSync(lock); } catch { /* 무시 */ }
  }
}

// 파일이 없으면 null. 깨진 JSON은 예외로 올린다(조용히 새로 만들면 모든 프로필이 덮어써진다).
export function readShared(dataDir) {
  const { shared } = storePaths(dataDir);
  let text;
  try { text = fs.readFileSync(shared, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  return JSON.parse(text);
}

async function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return; } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || i >= RENAME_RETRIES) throw e;
      await sleep(RENAME_RETRY_MS);
    }
  }
}

// 잠금 안에서 부른다. 날짜 백업은 그날 첫 저장 때 한 벌 남기고 BACKUP_KEEP개만 보존한다.
// 백업 실패는 로그만 남긴다(본 파일은 이미 저장됐으므로 요청을 실패로 돌리지 않는다).
export async function writeShared(dataDir, data, { log = () => {} } = {}) {
  const p = storePaths(dataDir);
  const body = JSON.stringify(data);
  fs.writeFileSync(p.tmp, body);
  await renameRetry(p.tmp, p.shared);
  try {
    const day = new Date().toISOString().slice(0, 10);
    const daily = path.join(p.backups, `shared-${day}.json`);
    if (!fs.existsSync(daily)) {
      fs.mkdirSync(p.backups, { recursive: true });
      fs.writeFileSync(daily, body);
      const old = fs.readdirSync(p.backups).filter((f) => f.startsWith('shared-')).sort();
      for (const f of old.slice(0, Math.max(0, old.length - BACKUP_KEEP))) fs.unlinkSync(path.join(p.backups, f));
    }
  } catch (e) { log('backup failed', e.message); }
}
