const $ = (id) => document.getElementById(id);

function render(s = {}) {
  $('email').textContent = s.email || '(로그인 안 됨)';
  $('conn').textContent = s.connected ? '연결됨' : '끊김 — 허브가 실행 중인지 확인';
  $('sync').textContent = s.blocked ? '멈춤(확인 필요)' : s.stuck ? '허브와 계속 어긋남(오류 참고)' : s.waiting ? '메인 프로필의 첫 동기화를 기다리는 중' : s.synced ? '맞춰짐' : '맞추는 중';
  $('pending').textContent = String(s.pending ?? 0);
  $('last').textContent = s.lastSync ? new Date(s.lastSync).toLocaleString('ko-KR') : '-';
  $('err').textContent = s.lastError || '-';
  const b = s.blocked;
  $('warn').hidden = !b;
  $('force').hidden = !b;
  if (b) {
    $('warn').textContent = `허브 기준으로 맞추면 이 프로필의 북마크 ${b.remove}개(전체 ${b.total}개)가 지워집니다. `
      + `허브 기준 북마크는 ${b.incoming}개입니다. 맞다면 "허브 기준으로 적용"을 누르세요.`;
  }
}

chrome.storage.local.get('status').then(({ status }) => render(status));
chrome.storage.onChanged.addListener((ch) => { if (ch.status) render(ch.status.newValue); });

$('force').onclick = () => {
  if (confirm('이 프로필의 북마크를 허브 기준으로 덮어씁니다. 계속할까요?')) chrome.runtime.sendMessage({ cmd: 'force' });
};
$('check').onclick = () => chrome.runtime.sendMessage({ cmd: 'check' });
$('reconnect').onclick = () => chrome.runtime.sendMessage({ cmd: 'reconnect' });
