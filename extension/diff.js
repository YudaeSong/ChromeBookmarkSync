// 3-way 동기화의 「내 변경」을 만드는 순수 함수. base(마지막으로 맞춘 공유 트리)와 local(지금 내 트리)을 비교해
// hub/merge.js가 적용할 ops를 만든다. 규칙은 설계 문서 §4.3.
// - local을 전위 순회하며, 바로 앞 형제의 gid(첫 자식이면 null)를 앵커 after로 싣는다(index는 앵커가 없을 때의 대체 위치).
// - base에 없음 → create / 부모가 바뀜 → move / 같은 부모에서 순서가 바뀜 → 공통 자식의 LCS에 들지 않은 노드만 move
// - title·url이 다름 → 바뀐 필드만 update(안 바꾼 필드를 함께 보내면 다른 프로필의 변경을 되돌린다)
// - base에 있고 local에 없음 → 지워진 하위 트리의 꼭대기만 remove. 모든 create·move·update 뒤에 둔다
//   (폴더 F에서 X를 꺼낸 뒤 F를 지운 경우 F를 먼저 지우면 X가 함께 사라진다).
// - reorder op는 만들지 않는다(Tree.apply의 reorder는 공유 쪽 자식 집합과 정확히 같아야 해서 다른 프로필의 추가와 부딪친다).
// - skipRoots(이 프로필에서 찾지 못한 루트) 아래는 비교하지 않는다. 그렇지 않으면 「공유에는 있는데 내게는 없음」이 삭제로 잡힌다.
// 트리 형식: { root_bar: [노드…], root_other: […], root_mobile: […] }, 노드: 폴더 { gid, title, children } / 북마크 { gid, title, url }
import { ROOT_GIDS } from './shared.js';

// a, b는 같은 gid 집합의 두 순열. b에서 a의 순서를 지키는 가장 긴 부분열(=LCS)을 고른다. O(n log n)
function keepInOrder(a, b) {
  const pos = new Map(a.map((g, i) => [g, i]));
  const seq = b.map((g) => pos.get(g));
  const tails = [];
  const tailIdx = [];
  const prev = new Array(seq.length);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < seq[i]) lo = mid + 1; else hi = mid; }
    tails[lo] = seq[i];
    tailIdx[lo] = i;
    prev[i] = lo ? tailIdx[lo - 1] : -1;
  }
  const keep = new Set();
  for (let k = tails.length ? tailIdx[tails.length - 1] : -1; k >= 0; k = prev[k]) keep.add(b[k]);
  return keep;
}

// 반환: { ops, removeCount } — removeCount는 지워지는 노드 수(하위 포함, 다른 곳으로 옮겨 살아남은 노드는 빼고).
export function diffTrees(base, local, { skipRoots = [] } = {}) {
  const skip = new Set(skipRoots);
  const roots = ROOT_GIDS.filter((g) => !skip.has(g));

  const bInfo = new Map();
  const bKids = new Map();
  const walkBase = (parent, list) => {
    bKids.set(parent, list.map((n) => n.gid));
    for (const n of list) {
      bInfo.set(n.gid, { parent, node: n });
      if (n.children) walkBase(n.gid, n.children);
    }
  };
  for (const g of ROOT_GIDS) walkBase(g, base?.[g] || []);

  const lInfo = new Map();
  const walkLocal = (parent, list) => {
    for (const n of list) {
      if (typeof n.gid !== 'string' || !n.gid) throw new Error(`local node without gid: ${n.title ?? ''}`);
      if (lInfo.has(n.gid) || ROOT_GIDS.includes(n.gid)) throw new Error(`duplicate gid in local tree: ${n.gid}`);
      lInfo.set(n.gid, { parent, node: n });
      if (n.children) walkLocal(n.gid, n.children);
    }
  };
  for (const g of roots) walkLocal(g, local?.[g] || []);

  const ops = [];
  const visit = (parent, list) => {
    const common = (bKids.get(parent) || []).filter((g) => lInfo.get(g)?.parent === parent);
    const keep = keepInOrder(common, list.map((n) => n.gid).filter((g) => bInfo.get(g)?.parent === parent));
    list.forEach((n, index) => {
      const after = index ? list[index - 1].gid : null;
      const b = bInfo.get(n.gid);
      if (!b) {
        ops.push({ op: 'create', gid: n.gid, parent, after, index, title: n.title ?? '', ...(n.url != null ? { url: n.url } : {}) });
      } else {
        if (b.parent !== parent || !keep.has(n.gid)) ops.push({ op: 'move', gid: n.gid, parent, after, index });
        const up = { op: 'update', gid: n.gid };
        if ((n.title ?? '') !== (b.node.title ?? '')) up.title = n.title ?? '';
        if (n.url != null && n.url !== b.node.url) up.url = n.url;
        if ('title' in up || 'url' in up) ops.push(up);
      }
      if (n.children) visit(n.gid, n.children);
    });
  };
  for (const g of roots) visit(g, local?.[g] || []);

  let removeCount = 0;
  const removes = [];
  // 부모가 지워지면 그 자식은 부모의 remove에 함께 쓸려 간다. 살아 있는 노드(다른 곳으로 옮겨짐)는 그 사슬을 끊으므로
  // 그 아래에서 지워진 노드는 자기 remove가 따로 필요하다.
  const sweep = (list, parentGone) => {
    for (const n of list) {
      const gone = !lInfo.has(n.gid);
      if (gone) removeCount++;
      if (gone && !parentGone) removes.push({ op: 'remove', gid: n.gid });
      if (n.children) sweep(n.children, gone);
    }
  };
  for (const g of roots) sweep(base?.[g] || [], false);

  return { ops: [...ops, ...removes], removeCount };
}
