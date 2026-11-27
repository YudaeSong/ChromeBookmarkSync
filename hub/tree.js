// 허브가 들고 있는 기준 북마크 트리. 모든 변경(op)은 여기서 검증·적용된 뒤 다른 프로필로 퍼진다.
// op의 index는 언제나 '옮긴/만든 뒤의 최종 위치'다.
import { ROOT_GIDS } from '../extension/shared.js';

const isFolder = (n) => Array.isArray(n.children);
const clamp = (i, len) => (Number.isInteger(i) ? Math.max(0, Math.min(i, len)) : len);
const err = (error) => ({ changed: false, error });

export class Tree {
  constructor() {
    this.nodes = new Map();
    this.initialized = false;
    this.reset();
  }

  reset() {
    this.nodes.clear();
    for (const g of ROOT_GIDS) this.nodes.set(g, { gid: g, parent: null, title: '', children: [] });
  }

  count() {
    return this.nodes.size - ROOT_GIDS.length;
  }

  // roots: { root_bar: [중첩 노드…], … }
  initFrom(roots) {
    this.reset();
    const add = (parentGid, n) => {
      if (typeof n.gid !== 'string' || !n.gid || this.nodes.has(n.gid)) throw new Error(`bad/duplicate gid ${n.gid}`);
      const node = { gid: n.gid, parent: parentGid, title: String(n.title ?? '') };
      if (n.url != null) node.url = String(n.url); else node.children = [];
      this.nodes.set(n.gid, node);
      this.nodes.get(parentGid).children.push(n.gid);
      if (node.children) for (const c of n.children || []) add(n.gid, c);
    };
    for (const g of ROOT_GIDS) for (const n of roots?.[g] || []) add(g, n);
    this.initialized = true;
  }

  snapshot() {
    const enc = (gid) => {
      const n = this.nodes.get(gid);
      return isFolder(n) ? { gid, title: n.title, children: n.children.map(enc) } : { gid, title: n.title, url: n.url };
    };
    const roots = {};
    for (const g of ROOT_GIDS) roots[g] = this.nodes.get(g).children.map(enc);
    return { roots };
  }

  dump() {
    return { initialized: this.initialized, ...this.snapshot() };
  }

  load(data) {
    if (data?.initialized) this.initFrom(data.roots); else { this.reset(); this.initialized = false; }
  }

  apply(op) {
    const N = this.nodes;
    switch (op?.op) {
      case 'create': {
        if (typeof op.gid !== 'string' || !op.gid) return err('bad gid');
        if (N.has(op.gid)) return { changed: false };
        const p = N.get(op.parent);
        if (!p || !isFolder(p)) return err('no parent');
        const node = { gid: op.gid, parent: op.parent, title: String(op.title ?? '') };
        if (op.url != null) node.url = String(op.url); else node.children = [];
        const index = clamp(op.index, p.children.length);
        p.children.splice(index, 0, op.gid);
        N.set(op.gid, node);
        return { changed: true, op: { op: 'create', gid: op.gid, parent: op.parent, index, title: node.title, ...(node.url != null ? { url: node.url } : {}) } };
      }
      case 'update': {
        const n = N.get(op.gid);
        if (!n || n.parent === null) return err('no node');
        const out = { op: 'update', gid: op.gid };
        let changed = false;
        if (op.title != null && String(op.title) !== n.title) { n.title = String(op.title); out.title = n.title; changed = true; }
        if (op.url != null && !isFolder(n) && String(op.url) !== n.url) { n.url = String(op.url); out.url = n.url; changed = true; }
        return changed ? { changed, op: out } : { changed: false };
      }
      case 'move': {
        const n = N.get(op.gid);
        if (!n || n.parent === null) return err('no node');
        const p = N.get(op.parent);
        if (!p || !isFolder(p)) return err('no parent');
        for (let a = p; a; a = a.parent ? N.get(a.parent) : null) if (a.gid === n.gid) return err('cycle');
        const old = N.get(n.parent);
        const oi = old.children.indexOf(n.gid);
        old.children.splice(oi, 1);
        const index = clamp(op.index, p.children.length);
        if (old === p && index === oi) { old.children.splice(oi, 0, n.gid); return { changed: false }; }
        p.children.splice(index, 0, n.gid);
        n.parent = p.gid;
        return { changed: true, op: { op: 'move', gid: n.gid, parent: p.gid, index } };
      }
      case 'remove': {
        const n = N.get(op.gid);
        if (!n) return { changed: false }; // 이미 다른 프로필에서 지워짐
        if (n.parent === null) return err('root');
        const p = N.get(n.parent);
        p.children.splice(p.children.indexOf(n.gid), 1);
        const del = (g) => { const x = N.get(g); if (x.children) x.children.forEach(del); N.delete(g); };
        del(n.gid);
        return { changed: true, op: { op: 'remove', gid: op.gid } };
      }
      case 'reorder': {
        const p = N.get(op.parent);
        if (!p || !isFolder(p)) return err('no parent');
        const want = op.children;
        if (!Array.isArray(want) || want.length !== p.children.length || new Set(want).size !== want.length
          || !want.every((g) => p.children.includes(g))) return err('reorder mismatch');
        if (want.every((g, i) => g === p.children[i])) return { changed: false };
        p.children = [...want];
        return { changed: true, op: { op: 'reorder', parent: p.gid, children: [...want] } };
      }
      default:
        return err('unknown op');
    }
  }
}
