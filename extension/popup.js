const $ = (id) => document.getElementById(id);
const time = (t) => (t ? new Date(t).toLocaleString('ko-KR') : '-');
let current = {};

function render(s = {}) {
  current = s;
  $('email').textContent = s.email || '(로그인 안 됨)';
  $('host').textContent = s.hostOk == null ? '-' : s.hostOk ? '정상' : '호출 실패 — 호스트 등록(scripts/install-host.ps1) 확인';
  $('state').textContent = s.protocolError ? `확장 새로고침 필요(호스트 규약 ${s.protocolError.want}, 이 확장 ${s.protocolError.have})`
    : s.excluded ? '동기화 예외'
    : s.blocked ? '멈춤(확인 필요)'
      : s.stuck ? '공유 트리와 계속 어긋남(오류 참고)'
        : s.waiting ? '메인 프로필의 첫 동기화를 기다리는 중'
          : s.synced ? '맞춰짐' : '맞추는 중';
  $('ver').textContent = s.baseVersion ?? '-';
  $('last').textContent = time(s.lastSync);
  $('err').textContent = s.lastError || '-';

  $('rescued').hidden = !s.rescued;
  if (s.rescued) $('rescued').textContent = `다른 프로필이 지운 폴더에 있던 새 북마크 ${s.rescued.count}개를 기타 북마크로 옮겼습니다(${time(s.rescued.at)}).`;

  $('excluded').hidden = !s.excluded;

  const b = s.excluded ? null : s.blocked; // 예외면 「공유 기준으로 적용」·「다른 프로필에도 반영」을 숨긴다(「지금 맞추기」는 남김)
  $('warn').hidden = !b;
  $('push').hidden = b?.dir !== 'out';
  $('force').hidden = s.excluded || (!b && !s.stuck);
  $('force').textContent = b?.dir === 'out' ? '공유 기준으로 되돌리기' : '공유 기준으로 적용';
  if (b?.dir === 'out') {
    $('warn').textContent = `이 프로필에서 ${b.remove}개를 지운 것으로 보입니다(공유 기준 ${b.total}개 중). 다른 프로필에도 반영할까요? `
      + '아니면 "공유 기준으로 되돌리기"로 지운 북마크를 되살립니다.';
  } else if (b) {
    $('warn').textContent = `공유 기준으로 맞추면 이 프로필의 북마크 ${b.remove}개(전체 ${b.total}개)가 지워집니다. `
      + `공유 기준 북마크는 ${b.incoming}개입니다. 맞다면 "공유 기준으로 적용"을 누르세요.`;
  }
}

chrome.storage.local.get('status').then(({ status }) => render(status));
chrome.storage.onChanged.addListener((ch) => { if (ch.status) render(ch.status.newValue); });

$('force').onclick = () => {
  const out = current.blocked?.dir === 'out';
  const msg = out
    ? '이 프로필의 변경을 버리고 공유 기준으로 되돌립니다(지운 북마크가 되살아납니다). 계속할까요?'
    : '이 프로필의 북마크를 공유 기준으로 덮어씁니다. 계속할까요?';
  if (confirm(msg)) chrome.runtime.sendMessage({ cmd: 'force' });
};
$('push').onclick = () => {
  const n = current.blocked?.remove ?? 0;
  if (confirm(`다른 모든 프로필에서도 북마크 ${n}개가 지워집니다. 계속할까요?`)) chrome.runtime.sendMessage({ cmd: 'push' });
};
$('syncNow').onclick = () => chrome.runtime.sendMessage({ cmd: 'sync' });
