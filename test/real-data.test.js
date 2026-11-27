// 백업해 둔 실제 Profile 1 북마크로 초기화 → 6개 프로필 덮어쓰기를 돌려 본다(백업 폴더가 없으면 건너뜀).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createEngine } from '../extension/core.js';
import { HubCore } from '../hub/core.js';
import { Tree } from '../hub/tree.js';
import { createFakeBookmarks } from './fake-bookmarks.js';

const backups = path.join(import.meta.dirname, '..', 'backups');
const latest = fs.existsSync(backups) ? fs.readdirSync(backups).sort().pop() : null;
const file = latest && path.join(backups, latest, 'Profile 1', 'Bookmarks');

test('실제 Profile 1 북마크 규모로 7개 프로필 맞추기', { skip: !file || !fs.existsSync(file) }, async () => {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const tree = new Tree();
  const hub = new HubCore({ tree, masterEmail: 'm' });
  let uid = 0;
  const profiles = [];
  for (let i = 0; i < 7; i++) {
    const bm = createFakeBookmarks();
    const mem = {};
    const p = { bm, open: true };
    p.engine = createEngine({
      bm, uuid: () => `g${++uid}`, echoGraceMs: 0,
      store: { get: async () => ({ ...mem }), set: async (o) => Object.assign(mem, o) },
      send: (o) => { const c = structuredClone(o); setImmediate(() => hub.handle(p.link, c)); return true; },
    });
    for (const n of ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered']) bm[n].addListener(p.engine[n]);
    profiles.push(p);
  }
  const load = async (bm, parentId, kids) => {
    for (const k of kids || []) {
      const n = await bm.create({ parentId, title: k.name, ...(k.type === 'url' ? { url: k.url } : {}) });
      if (k.type === 'folder') await load(bm, n.id, k.children);
    }
  };
  const m = profiles[0].bm;
  await load(m, '1', data.roots.bookmark_bar.children);
  await load(m, '2', data.roots.other.children);
  await load(m, '3', data.roots.synced?.children);
  const total = m._all().length;
  await load(profiles[1].bm, '1', [{ type: 'url', name: 'x', url: 'https://x/' }]);

  const t0 = Date.now();
  profiles.forEach((p, i) => { p.link = hub.connect((msg) => { const c = structuredClone(msg); setImmediate(() => p.engine.onMessage(c)); }); p.engine.onOpen(i === 0 ? 'm' : `p${i}`); });
  for (let i = 0; i < 50; i++) { await new Promise((r) => setTimeout(r, 20)); await Promise.all(profiles.map((p) => p.engine.idle())); }
  const want = JSON.stringify(m._dump());
  for (const p of profiles) assert.equal(JSON.stringify(p.bm._dump()), want);
  assert.equal(tree.count(), total);
  console.log(`  nodes=${total} 7 profiles synced in ${Date.now() - t0}ms`);
});
