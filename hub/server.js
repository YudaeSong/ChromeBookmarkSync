// 로컬 허브: 127.0.0.1에서 각 프로필의 확장과 WebSocket으로 연결해 북마크 변경을 실시간으로 전달한다.
// 기준 트리는 data/state.json에 저장하고, 날마다 data/backups/에 한 벌씩 남긴다.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { HUB_PORT } from '../extension/shared.js';
import { HubCore } from './core.js';
import { Tree } from './tree.js';

const dir = import.meta.dirname;
const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
const port = config.port || HUB_PORT;
const allowedOrigin = `chrome-extension://${config.extensionId}`;

const dataDir = path.join(dir, 'data');
const backupDir = path.join(dataDir, 'backups');
const stateFile = path.join(dataDir, 'state.json');
const logFile = path.join(dataDir, 'hub.log');
fs.mkdirSync(backupDir, { recursive: true });

function log(...a) {
  const line = `${new Date().toISOString()} ${a.join(' ')}\n`;
  process.stdout.write(line);
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 5 * 1024 * 1024) fs.renameSync(logFile, `${logFile}.old`);
    fs.appendFileSync(logFile, line);
  } catch { /* 로그 실패는 무시 */ }
}

const tree = new Tree();
if (fs.existsSync(stateFile)) {
  tree.load(JSON.parse(fs.readFileSync(stateFile, 'utf8')));
  log(`state loaded: initialized=${tree.initialized} nodes=${tree.count()}`);
}

let saveTimer = null;
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const body = JSON.stringify(tree.dump());
  const tmp = `${stateFile}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, stateFile);
  const day = new Date().toISOString().slice(0, 10);
  const daily = path.join(backupDir, `state-${day}.json`);
  if (!fs.existsSync(daily)) {
    fs.writeFileSync(daily, body);
    const old = fs.readdirSync(backupDir).filter((f) => f.startsWith('state-')).sort();
    for (const f of old.slice(0, Math.max(0, old.length - 30))) fs.unlinkSync(path.join(backupDir, f));
  }
}
function scheduleSave() {
  if (!saveTimer) saveTimer = setTimeout(() => { try { saveNow(); } catch (e) { log('save failed', e.message); } }, 1000);
}

const hub = new HubCore({ tree, masterEmail: config.masterEmail, onChange: scheduleSave, log });

const server = http.createServer((req, res) => {
  // 사용자 지정 헤더를 요구해 웹페이지(브라우저)가 이 주소를 호출하지 못하게 한다(CORS 사전 요청에 응답하지 않음).
  if (req.url === '/reload-extensions' && req.method === 'POST' && req.headers['x-bmsync'] === '1') {
    hub.handle({ send: () => {} }, { type: 'reload-all' });
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ sent: hub.status().clients.length }));
    return;
  }
  if (req.url === '/status') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(hub.status(), null, 2));
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({
  server,
  maxPayload: 64 * 1024 * 1024,
  verifyClient: ({ origin }) => origin === allowedOrigin,
});

wss.on('connection', (ws) => {
  const c = hub.connect((obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); });
  ws.on('message', (data) => {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    hub.handle(c, m).catch((e) => log('handle error', e.stack));
  });
  ws.on('close', () => { hub.disconnect(c); log(`bye ${c.email ?? '(before hello)'}`); });
  ws.on('error', () => {});
});

server.on('error', (e) => {
  log(e.code === 'EADDRINUSE' ? `port ${port} already in use — hub already running?` : `server error ${e.message}`);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => log(`hub listening on 127.0.0.1:${port} master=${config.masterEmail}`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { if (saveTimer) saveNow(); process.exit(0); });
}
