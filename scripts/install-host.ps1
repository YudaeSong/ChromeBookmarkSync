# Chrome Native Messaging 호스트 등록 (현재 사용자, 관리자 권한 불필요)
#
# 하는 일
#   1. hub/native/host.bat 생성 — node 절대 경로로 hub/host.js를 부르는 래퍼(ASCII만).
#      Chrome은 호스트를 cmd.exe /d /s /c 로 띄우고 인자로 확장 origin과 --parent-window를 넘긴다.
#      host.json의 path에 node.exe를 직접 적으면 스크립트 인자를 줄 수 없어서 .bat 래퍼를 쓴다.
#      @가 붙지 않은 줄이 stdout에 찍히면 프레이밍이 깨지므로 출력하는 명령을 넣지 않는다.
#   2. hub/native/com.chromebookmarksync.host.json 생성 — allowed_origins는 hub/config.json의 extensionId
#   3. HKCU\Software\Google\Chrome\NativeMessagingHosts\com.chromebookmarksync.host (기본값) = 위 json 절대 경로
#
# 호스트 이름 com.chromebookmarksync.host 는 extension/shared.js 의 HOST_NAME 과 같아야 한다(함께 바꿀 것).
# node 경로나 저장소 위치가 바뀌면 이 스크립트를 다시 실행한다. hub/native/ 는 생성물이라 git에 올리지 않는다.
#
# 실행:  powershell -ExecutionPolicy Bypass -File scripts\install-host.ps1
#
# 제거:
#   Remove-Item 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.chromebookmarksync.host'
#   Remove-Item -Recurse -Force hub\native

$ErrorActionPreference = 'Stop'
$hostName = 'com.chromebookmarksync.host'
$root = Split-Path -Parent $PSScriptRoot
$hubDir = Join-Path $root 'hub'
$nativeDir = Join-Path $hubDir 'native'
$configFile = Join-Path $hubDir 'config.json'

if (-not (Test-Path $configFile)) { throw "hub\config.json 이 없습니다. hub\config.example.json 을 복사해 masterEmail, extensionId 를 채우세요." }
$config = Get-Content -Raw -Encoding UTF8 $configFile | ConvertFrom-Json
$extId = [string]$config.extensionId
if ($extId -notmatch '^[a-p]{32}$') { throw "config.json 의 extensionId 형식이 아닙니다: '$extId'" }

$node = (Get-Command node -ErrorAction Stop).Source
if ($node -notmatch '^[\x20-\x7e]+$') { throw "node 경로에 ASCII가 아닌 문자가 있습니다: $node (.bat는 ASCII만 씁니다)" }

New-Item -ItemType Directory -Force $nativeDir | Out-Null

# 맨 위 두 줄은 전역 스크립트 인코딩 훅의 헤더와 같게 둔다(훅이 다시 보정해도 바뀌지 않게).
$batPath = Join-Path $nativeDir 'host.bat'
$bat = @(
  '@chcp 65001 >nul',
  '@rem -- UTF-8 file: keep this line ASCII (cmd reads the line after chcp with the old codepage) --',
  '@echo off',
  ('"{0}" "%~dp0..\host.js" %*' -f $node)
) -join "`r`n"
[System.IO.File]::WriteAllText($batPath, $bat + "`r`n", [System.Text.Encoding]::ASCII)

$manifestPath = Join-Path $nativeDir "$hostName.json"
$manifest = [ordered]@{
  name            = $hostName
  description     = 'ChromeBookmarkSync shared bookmark store'
  path            = $batPath
  type            = 'stdio'
  allowed_origins = @("chrome-extension://$extId/")
}
# Chrome이 읽는 JSON이므로 BOM 없는 UTF-8로 쓴다.
[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json), (New-Object System.Text.UTF8Encoding $false))

$key = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
New-Item -Path $key -Force | Out-Null
Set-Item -Path $key -Value $manifestPath

Write-Host "등록 완료: $hostName"
Write-Host "  manifest: $manifestPath"
Write-Host "  wrapper : $batPath"
Write-Host "  node    : $node"
Write-Host "  origin  : chrome-extension://$extId/"
