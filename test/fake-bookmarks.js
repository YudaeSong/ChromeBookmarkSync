// Node 테스트용 chrome.bookmarks 흉내. Chrome의 실제 규칙을 따라 한다.
// - move: 같은 폴더 안에서 아래로 옮길 때 index는 '옮기기 전 기준'(BookmarkModel::Move의 index-- 규칙),
//         index가 현재 위치 또는 그 다음이면 아무것도 안 하고 이벤트도 없다.
// - update: 실제로 바뀐 필드마다 onChanged를 한 번씩 쏜다.
// - eventMode 'sync'면 API 응답 전에, 'deferred'면 응답 뒤(setTimeout 0, 순서 유지)에 이벤트가 온다.
// 실패 주입(테스트용): failGet — 이 ID들의 get()이 실패(루트를 찾지 못하는 프로필 흉내),
//                    _failIds — 이 Set에 든 ID의 update·move·remove가 실패(공유 트리를 적용하지 못하는 프로필 흉내).
export function createFakeBookmarks({ eventMode = 'sync', failGet = [] } = {}) {
  let nextId = 4;
  const nodes = new Map();
  nodes.set('0', { id: '0', title: '', children: ['1', '2', '3'] });
  nodes.set('1', { id: '1', parentId: '0', title: 'Bookmarks bar', folderType: 'bookmarks-bar', children: [] });
  nodes.set('2', { id: '2', parentId: '0', title: 'Other bookmarks', folderType: 'other', children: [] });
  nodes.set('3', { id: '3', parentId: '0', title: 'Mobile bookmarks', folderType: 'mobile', children: [] });

  const names = ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered', 'onImportBegan', 'onImportEnded'];
  const listeners = Object.fromEntries(names.map((n) => [n, []]));
  const fire = (name, ...args) => {
    const run = () => listeners[name].forEach((f) => f(...structuredClone(args)));
    if (eventMode === 'sync') run(); else setTimeout(run, 0);
  };

  const must = (id) => {
    const n = nodes.get(String(id));
    if (!n) throw new Error("Can't find bookmark for id.");
    return n;
  };
  const isRoot = (id) => ['0', '1', '2', '3'].includes(String(id));
  const indexOf = (n) => (n.parentId != null ? nodes.get(n.parentId).children.indexOf(n.id) : undefined);
  const shallow = (n) => {
    const o = { id: n.id, title: n.title };
    if (n.parentId != null) { o.parentId = n.parentId; o.index = indexOf(n); }
    if (n.url != null) o.url = n.url;
    if (n.folderType) o.folderType = n.folderType;
    return o;
  };
  const deep = (n) => {
    const o = shallow(n);
    if (n.children) o.children = n.children.map((c) => deep(nodes.get(c)));
    return o;
  };

  const api = {
    async getTree() {
      const t = deep(nodes.get('0'));
      t.children = t.children.filter((c) => c.id !== '3' || c.children.length); // Chrome은 빈 모바일 폴더를 숨긴다
      return [t];
    },
    async getSubTree(id) { return [deep(must(id))]; },
    async get(ids) {
      return (Array.isArray(ids) ? ids : [ids]).map((i) => {
        if (failGet.includes(String(i))) throw new Error("Can't find bookmark for id.");
        return shallow(must(i));
      });
    },
    async getChildren(id) { const n = must(id); if (!n.children) throw new Error('not folder'); return n.children.map((c) => shallow(nodes.get(c))); },
    async create({ parentId, index, title = '', url }) {
      const p = must(parentId ?? '2');
      if (!p.children || p.id === '0') throw new Error("Can't modify the root bookmark folders.");
      const i = index ?? p.children.length;
      if (i < 0 || i > p.children.length) throw new Error('Index out of bounds.');
      const id = String(nextId++);
      const n = { id, parentId: p.id, title };
      if (url != null) n.url = url; else n.children = [];
      nodes.set(id, n);
      p.children.splice(i, 0, id);
      const r = shallow(n);
      fire('onCreated', id, r);
      return r;
    },
    async update(id, { title, url }) {
      const n = must(id);
      if (isRoot(id)) throw new Error("Can't modify the root bookmark folders.");
      if (api._failIds.has(String(id))) throw new Error('injected failure');
      if (url != null && !n.url) throw new Error("Can't set URL of a bookmark folder.");
      if (title != null && title !== n.title) { n.title = title; fire('onChanged', n.id, { title: n.title, url: n.url }); }
      if (url != null && url !== n.url) { n.url = url; fire('onChanged', n.id, { title: n.title, url: n.url }); }
      return shallow(n);
    },
    async move(id, { parentId, index }) {
      const n = must(id);
      if (api._failIds.has(String(id))) throw new Error('injected failure');
      if (isRoot(id)) throw new Error("Can't modify the root bookmark folders.");
      const np = must(parentId ?? n.parentId);
      if (!np.children || np.id === '0') throw new Error("Can't modify the root bookmark folders.");
      for (let a = np; a; a = a.parentId != null ? nodes.get(a.parentId) : null) if (a.id === n.id) throw new Error("Can't move a folder to itself or its descendant.");
      const op = nodes.get(n.parentId);
      const oi = op.children.indexOf(n.id);
      let i = index ?? np.children.length;
      if (i < 0 || i > np.children.length) throw new Error('Index out of bounds.');
      if (op === np && (i === oi || i === oi + 1)) return shallow(n);
      if (op === np && i > oi) i--;
      op.children.splice(oi, 1);
      np.children.splice(i, 0, n.id);
      n.parentId = np.id;
      fire('onMoved', n.id, { parentId: np.id, index: i, oldParentId: op.id, oldIndex: oi });
      return shallow(n);
    },
    async remove(id) {
      const n = must(id);
      if (n.children?.length) throw new Error("Can't remove non-empty folder (use recursive to force).");
      return api.removeTree(id);
    },
    async removeTree(id) {
      const n = must(id);
      if (api._failIds.has(String(id))) throw new Error('injected failure');
      if (isRoot(id)) throw new Error("Can't modify the root bookmark folders.");
      const snap = deep(n);
      const p = nodes.get(n.parentId);
      const oi = p.children.indexOf(n.id);
      p.children.splice(oi, 1);
      const del = (x) => { x.children?.forEach((c) => del(nodes.get(c))); nodes.delete(x.id); };
      del(n);
      fire('onRemoved', snap.id, { parentId: p.id, index: oi, node: snap });
    },
    // UI의 '이름순 정렬' 흉내(API에는 없음)
    async _sort(id) {
      const p = must(id);
      p.children.sort((a, b) => nodes.get(a).title.localeCompare(nodes.get(b).title));
      fire('onChildrenReordered', p.id, { childIds: [...p.children] });
    },
  };
  for (const n of names) api[n] = { addListener: (f) => listeners[n].push(f) };
  api._failIds = new Set();

  // 비교용: 루트 3개 아래를 [title, url, children] 로
  api._dump = () => {
    const enc = (id) => { const n = nodes.get(id); return n.children ? [n.title, n.children.map(enc)] : [n.title, n.url]; };
    return ['1', '2', '3'].map((r) => nodes.get(r).children.map(enc));
  };
  api._all = () => [...nodes.values()].filter((n) => !isRoot(n.id)).map((n) => n.id);
  api._folders = () => [...nodes.values()].filter((n) => n.children && n.id !== '0').map((n) => n.id);
  return api;
}
