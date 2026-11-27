# 로그온할 때 허브를 창 없이 자동 실행하도록 작업 스케줄러에 등록한다.
# S4U(암호 저장 없이 사용자 권한으로 백그라운드 실행)로 등록하므로 콘솔 창이 뜨지 않는다.
# 해제: Unregister-ScheduledTask -TaskName ChromeBookmarkSyncHub -Confirm:$false
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source
$name = 'ChromeBookmarkSyncHub'

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$root\hub\server.js`"" -WorkingDirectory "$root\hub"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $name
Start-Sleep -Seconds 2
try {
  $s = Invoke-RestMethod -Uri 'http://127.0.0.1:47321/status' -TimeoutSec 3
  Write-Host "허브 실행 중: initialized=$($s.initialized) nodes=$($s.nodes) clients=$($s.clients.Count)"
} catch {
  Write-Host "작업은 등록했지만 허브 응답이 없습니다. hub\data\hub.log 를 확인하세요."
}
