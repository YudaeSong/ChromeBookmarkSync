// 확장이 보낸 ops(extension/diff.js가 만든 것)를 공유 트리(Tree)에 순서대로 적용한다. 병합 규칙은 설계 문서 §4.3.
// - create/move의 앵커 after: 같은 부모(공유 쪽)에 있으면 그 노드를 뺀 자식 목록에서 after 다음 자리,
//   null이면 맨 앞, 없으면 op.index를 Tree.apply가 범위 안으로 줄여 쓴다. after가 아예 없는 op(v1 pending)는 index 그대로.
// - no node(다른 프로필이 지운 노드를 수정·이동) → 건너뜀(삭제 우선)
// - create의 no parent(다른 프로필이 지운 폴더 안에 새로 만듦) → root_other 끝으로 구조(rescued)
// - move의 no parent, cycle, reorder 불일치 등 그 밖의 거부 → 건너뜀
// 거부돼도 예외를 올리지 않고 결과에만 집계한다(quiet). 확장은 응답의 최신 트리로 reconcile한다.
import { Tree } from './tree.js';

export const RESCUE_PARENT = 'root_other';

function resolveIndex(tree, op) {
  if (op.after === undefined) return op.index;
  const p = tree.nodes.get(op.parent);
  if (!p || !Array.isArray(p.children)) return op.index;
  if (op.after === null) return 0;
  const i = p.children.filter((g) => g !== op.gid).indexOf(op.after);
  return i >= 0 ? i + 1 : op.index;
}

// tree를 제자리에서 바꾼다. 반환: { applied, unchanged, skipped, rescued, changed, rejects:[{op,gid,error}] }
export function mergeOps(tree, ops) {
  const res = { applied: 0, unchanged: 0, skipped: 0, rescued: 0, changed: false, rejects: [] };
  for (const op of ops || []) {
    if (!op || typeof op !== 'object' || typeof op.op !== 'string') {
      res.skipped++;
      res.rejects.push({ op: String(op?.op), gid: op?.gid, error: 'bad op' });
      continue;
    }
    const want = (op.op === 'create' || op.op === 'move') ? { ...op, index: resolveIndex(tree, op) } : op;
    let r = tree.apply(want);
    if (r.error === 'no parent' && op.op === 'create') {
      r = tree.apply({ ...want, parent: RESCUE_PARENT, index: undefined });
      if (r.changed) { res.rescued++; res.changed = true; continue; }
    }
    if (r.error) {
      res.skipped++;
      res.rejects.push({ op: op.op, gid: op.gid ?? op.parent, error: r.error });
    } else if (r.changed) {
      res.applied++;
      res.changed = true;
    } else {
      res.unchanged++;
    }
  }
  return res;
}

// 편의 함수: roots(Tree.dump 형식)에 ops를 적용한 새 roots와 결과를 돌려준다.
export function mergeRoots(roots, ops) {
  const tree = new Tree();
  tree.initFrom(roots);
  const res = mergeOps(tree, ops);
  return { roots: tree.snapshot().roots, count: tree.count(), ...res };
}
