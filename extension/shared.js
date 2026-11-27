// 허브(hub/)와 확장이 함께 쓰는 값·함수. 허브는 '../extension/shared.js'로 이 파일을 그대로 가져다 쓴다.
// 직렬화 형식을 바꾸면 양쪽 해시가 함께 바뀌므로 반드시 이 파일 한 곳에서만 고친다.

export const ROOT_GIDS = ['root_bar', 'root_other', 'root_mobile'];
export const HUB_PORT = 47321;
// 확장↔허브 메시지 규약 번호. hello에 실어 보내, 허브가 옛 코드를 돌리는 프로필을 알아보게 한다.
// (Chrome은 디스크의 확장 코드를 고쳐도 새로고침 전까지 옛 서비스 워커를 계속 돌린다.)
// 1(번호 없음): check에 skip 없음 / 2: hello에 protocol·version, 허브의 'stuck' 메시지
export const PROTOCOL = 2;

// 트리 형식: { root_bar: [노드…], root_other: […], root_mobile: […] }
// 노드: 폴더 { gid, title, children: [...] } / 북마크 { gid, title, url }
export function serializeRoots(roots) {
  const enc = (n) => [n.gid, n.title ?? '', n.url ?? null, n.children ? n.children.map(enc) : null];
  return JSON.stringify(ROOT_GIDS.map((g) => (roots[g] || []).map(enc)));
}

export async function hashRoots(roots) {
  const data = new TextEncoder().encode(serializeRoots(roots));
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function countNodes(roots) {
  let n = 0;
  const walk = (x) => { n++; x.children?.forEach(walk); };
  for (const g of ROOT_GIDS) (roots[g] || []).forEach(walk);
  return n;
}
