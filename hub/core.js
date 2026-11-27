// 허브의 메시지 처리. 전송(WebSocket)과 저장은 server.js가 맡고, 여기서는 규칙만 다룬다(테스트에서 그대로 쓴다).
import { ROOT_GIDS, hashRoots } from '../extension/shared.js';

// 같은 (프로필 해시, 허브 해시) 불일치가 스냅샷을 보낸 뒤에도 이 횟수를 넘게 이어지면 재전송을 멈춘다.
// 그 프로필이 스냅샷을 적용하지 못하는 상태라 다시 보내도 소용없이 5분마다 반복되기 때문이다.
// 테스트 '동시에 마구 고쳐도'가 주기 점검 3회 안에 바로잡히기를 기대하므로 3보다 커야 한다.
export const STUCK_AFTER = 5;
export class HubCore {
  constructor({ tree, masterEmail, onChange = () => {}, log = () => {} }) {
    this.tree = tree;
    this.masterEmail = String(masterEmail || '').toLowerCase();
    this.onChange = onChange;
    this.log = log;
    this.clients = new Set();
  }

  connect(send) {
    const c = {
      send, email: null, clientId: null, ready: false, helloed: false, connectedAt: Date.now(),
      protocol: null, version: null, mismatchKey: null, mismatchCount: 0, stuck: false,
    };
    this.clients.add(c);
    return c;
  }

  disconnect(c) {
    this.clients.delete(c);
  }

  isMaster(c) {
    return !!c.email && c.email.toLowerCase() === this.masterEmail;
  }

  sendSnapshot(c) {
    c.ready = true;
    c.send({ type: 'snapshot', snap: this.tree.snapshot() });
  }

  applyFrom(c, op, { quiet = false } = {}) {
    const r = this.tree.apply(op);
    if (r.error) {
      this.log(`reject ${op?.op} from ${c.email}: ${r.error}`);
      if (!quiet) this.sendSnapshot(c);
      return;
    }
    if (!r.changed) return;
    this.onChange();
    for (const o of this.clients) if (o !== c && o.ready) o.send({ type: 'op', op: r.op });
  }

  async handle(c, m) {
    switch (m?.type) {
      case 'hello': {
        c.helloed = true;
        c.clientId = m.clientId || null;
        c.email = m.email || '';
        c.protocol = m.protocol ?? null;
        c.version = m.version ?? null;
        this.resetMismatch(c);
        this.log(`hello ${c.email || '(no email)'} pending=${m.pending?.length || 0} v=${c.version ?? '?'} p=${c.protocol ?? 1}`);
        if (c.protocol == null) this.log(`old extension code in ${c.email} — reload it in chrome://extensions (/reload-extensions won't work)`);
        if (!this.tree.initialized) {
          c.send(this.isMaster(c) ? { type: 'need-init' } : { type: 'wait' });
          return;
        }
        for (const op of m.pending || []) this.applyFrom(c, op, { quiet: true });
        this.sendSnapshot(c);
        return;
      }
      case 'init': {
        if (this.tree.initialized) { this.sendSnapshot(c); return; }
        if (!this.isMaster(c)) { c.send({ type: 'error', message: '메인 프로필만 처음 동기화를 시작할 수 있습니다' }); return; }
        try {
          this.tree.initFrom(m.roots);
        } catch (e) {
          this.tree.reset();
          this.tree.initialized = false;
          c.send({ type: 'error', message: `초기화 실패: ${e.message}` });
          return;
        }
        this.log(`init from ${c.email}: ${this.tree.count()} nodes`);
        this.onChange();
        for (const o of this.clients) if (o.helloed) this.sendSnapshot(o);
        return;
      }
      case 'op':
        if (this.tree.initialized && c.ready) this.applyFrom(c, m.op);
        return;
      case 'resync':
        if (this.tree.initialized) { this.resetMismatch(c); this.sendSnapshot(c); }
        return;
      case 'check': {
        if (!this.tree.initialized) return;
        const roots = { ...this.tree.snapshot().roots };
        for (const g of m.skip || []) if (ROOT_GIDS.includes(g)) roots[g] = [];
        const hubHash = await hashRoots(roots);
        if (m.hash === hubHash) { this.resetMismatch(c); c.send({ type: 'check-ok' }); return; }
        const key = `${m.hash}:${hubHash}`;
        c.mismatchCount = c.mismatchKey === key ? c.mismatchCount + 1 : 1;
        c.mismatchKey = key;
        if (c.mismatchCount <= STUCK_AFTER) { this.log(`check mismatch ${c.email} → snapshot`); this.sendSnapshot(c); return; }
        if (!c.stuck) {
          c.stuck = true;
          this.log(`check stuck ${c.email}: same mismatch ${c.mismatchCount} times — snapshot resend stopped`);
          c.send({ type: 'stuck', message: '허브 기준으로 맞춰도 같은 차이가 계속 남습니다. 허브 로그를 확인하세요.' });
        }
        return;
      }
      case 'reload-all':
        // 확장 코드를 고친 뒤 모든 프로필의 확장을 한 번에 다시 읽게 한다(허브의 POST /reload-extensions).
        for (const o of this.clients) if (o.helloed) o.send({ type: 'reload' });
        return;
      case 'ping':
        c.send({ type: 'pong' });
        return;
      default:
    }
  }

  resetMismatch(c) {
    c.mismatchKey = null;
    c.mismatchCount = 0;
    c.stuck = false;
  }

  status() {
    return {
      initialized: this.tree.initialized,
      masterEmail: this.masterEmail,
      nodes: this.tree.count(),
      clients: [...this.clients].map((c) => ({
        email: c.email, ready: c.ready, version: c.version, protocol: c.protocol, stuck: c.stuck,
        connectedAt: new Date(c.connectedAt).toISOString(),
      })),
    };
  }
}
