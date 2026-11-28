# WebSocket 허브 → Chrome Native Messaging 전환 설계

상태: **완료 (S1~S4, 확장 2.0.2·PROTOCOL 3)** · 설계 기준 코드: `29d38c1` · 작성 2026-11-27 · 현행화 2026-11-28

상시 실행되던 WebSocket 허브(`hub/server.js`, 예약 작업 `ChromeBookmarkSyncHub`)를 없앴다(S4에서 파일과 예약 작업 등록 삭제). 대신 Chrome이 요청할 때만 띄우는 Native Messaging 호스트가 공유 파일을 읽고 쓰고, 각 프로필의 확장이 3-way 비교로 병합한다.

---

## 1. 확정된 결정 (사용자 승인 완료)

| # | 결정 |
|---|---|
| D-1 | 상시 허브 대신 **Native Messaging 호스트**(Node)를 쓴다. 요청 때만 실행되고 응답 뒤 종료하며, 공유 파일(최신 트리)을 읽고 쓴다. 레지스트리 HKCU에 한 번 등록한다. |
| D-2 | **3-way 비교**를 한다. 프로필마다 「마지막으로 맞춘 기준점」을 저장한다. 기준점↔내 트리 = 내 변경, 기준점↔공유 트리 = 다른 프로필의 변경이다. |
| D-3 | 맞추는 시점은 **창 포커스**(`chrome.windows.onFocusChanged`)와 **프로필 시작**이다. 내 변경은 즉시 공유 파일에 쓴다. 다른 프로필의 열린 창에는 그 창으로 전환할 때 반영된다(수용함). |
| D-4 | 실기기 확인 뒤 **WebSocket 허브를 제거**한다. `hub/tree.js`는 재사용한다. 현재 `hub/data/state.json`(gid 포함 228개)을 공유 파일 초기값으로 옮긴다. 각 프로필의 `map`(gid→로컬 ID)은 유지해 **어떤 프로필도 다시 덮어써지지 않게** 한다. |
| D-5 | §5.7의 「제거」 R1~R10은 문서에 적힌 근거대로 제거한다. |
| D-6 | 병합 규칙(§4.3, §4.5): 나중에 맞춘 쪽이 이긴다. 지워진 폴더 안에 새로 만든 노드는 「기타 북마크」 끝으로 옮겨 살린다. 수정·이동과 삭제가 부딪치면 삭제가 이긴다. 나가는 쪽 대량 삭제 보호를 새로 넣는다. |
| D-7 | D-3에 더해 5분 알람 sync와 diskVersion 자동 다시 읽기(§3.4)를 넣는다. |
| D-8 | 세션은 S1~S4로 나눈다. 대상은 확장이 설치된 10개 프로필과 **Profile 16**(S3에서 설치)이다. |

---

## 2. 조사로 확정한 사실

| 항목 | 결과 | 근거 |
|---|---|---|
| Chrome 버전 | **158.0.8127.38** (문서와 README의 「157」보다 새 버전) | `chrome.exe` 파일 버전 |
| 확장 설치 프로필 | **10개**: Profile 1, 4, 5, 6, 8, 11, 12, 13, 14, 15. Profile 16은 미설치 | `Local State` info_cache와 `Local Extension Settings\cchkhligdoboaipldlkkjjdfpmieomcd` 존재 여부 |
| 북마크 파일 | Profile 1·4·5·6·8은 `Bookmarks`, **Profile 11~15는 `AccountBookmarks`만** 있음 | 프로필 폴더 조회 |
| 백업 스크립트 빈틈 | `scripts/backup-bookmarks.mjs:15`가 `Bookmarks`, `Bookmarks.bak`만 복사한다. **Profile 11~15는 지금 백업되지 않는다** | 코드 |
| 공유 트리 크기 | `state.json` 33,860 B, 노드 228개(폴더 32개, 최대 깊이 4), 노드당 약 149 B | 실측 |
| 1MB 한도까지 여유 | 응답 전체가 약 34 KB로 **한도의 3.2%**다. 약 7,000개 노드까지 단일 메시지로 보낼 수 있다 | 실측 값으로 계산 |
| 허브 현재 상태 | initialized, 노드 228개, 연결 1개(v1.0.1, protocol 2, stuck 없음) | `/status` |
| node | `C:\Program Files\nodejs\node.exe` v24.16.0 | `where node` |
| 레지스트리 | `HKCU\Software\Google\Chrome\NativeMessagingHosts\`에 다른 호스트 4개가 이미 있다. 이 중 Claude Code 호스트는 **`.bat` 래퍼(절대 경로 exe 호출)**로 등록되어 있다. 이 PC에서 `.bat` 방식이 동작한다는 실례다 | 레지스트리와 manifest 조회 |
| 테스트 계약 | 11개 (sync.test.js 10개, real-data.test.js 1개) | 코드 |
| 출처 주석 | 소스에 날짜나 이슈 번호가 달린 주석은 **없다**. 출처가 적힌 것은 「Chrome 157 빈 모바일 폴더」(README:33, core.js:162, fake:44), 「BookmarkModel::Move index-- 규칙」(fake:2), 「1.0.0은 reload 미처리」(README:61) 세 가지다 | 전수 조사 |

### Native Messaging 규칙 (Chrome 문서 기준, 실기기 동작 확인은 S3)

- 확장 manifest에 `"nativeMessaging"` 권한이 필요하다. 압축해제 확장은 새로고침할 때 권한이 바로 부여된다.
- 호스트 manifest는 `{ name, description, path, type: "stdio", allowed_origins: ["chrome-extension://<ID>/"] }` 형식이다. `name`에는 소문자·숫자·`_`·`.`만 쓸 수 있다. `allowed_origins`는 끝에 `/`가 있어야 하고 와일드카드는 쓸 수 없다.
- Windows에서는 `HKCU\Software\Google\Chrome\NativeMessagingHosts\<name>`의 (기본값)에 manifest의 절대 경로를 적는다.
- Windows의 Chrome은 호스트를 `cmd.exe /d /s /c`로 실행한다. 그래서 `.bat`를 쓸 수 있다. 인자로는 호출한 확장의 origin(`chrome-extension://<ID>/`)과 `--parent-window=<hwnd>`가 넘어온다. `path`에 `node.exe`를 직접 적으면 스크립트 인자를 줄 수 없으므로 **`.bat` 래퍼가 필요하다**.
- 메시지는 4바이트 길이(native byte order, x64는 little-endian) + UTF-8 JSON이다. **호스트→확장은 메시지당 1 MB**, 확장→호스트는 64 MiB가 한도다. 호스트의 stdout에 메시지가 아닌 바이트가 섞이면 연결이 끊긴다(「Error when communicating with the native messaging host」).
- `chrome.runtime.sendNativeMessage`는 메시지마다 호스트 프로세스를 새로 띄우고, 첫 응답을 받으면 끝낸다. MV3 서비스 워커에서 쓸 수 있다.
- `chrome.windows.onFocusChanged`는 권한 없이 쓸 수 있다. 각 프로필의 확장은 **자기 프로필의 창만** 본다. 다른 프로필의 창이 포커스를 받으면, 이 프로필은 「포커스를 잃음(`WINDOW_ID_NONE`)」을 받는 것으로 본다. 최상위에서 동기로 등록한 리스너는 잠든 서비스 워커를 깨운다.

---

## 3. 새 구조

```
[프로필 확장 ×10]                                   (요청 때만 실행)
  chrome.bookmarks ─┐                       ┌─ hub/host.js ── hub/data/shared.json (잠금·원자적 쓰기·버전)
  storage.local     ├─ sendNativeMessage ──▶│   (hub/native/host.bat 래퍼)   └─ hub/data/backups/shared-YYYY-MM-DD.json
   {map, base,      │   {type:'sync', ops}  │
    baseVersion}    │ ◀── {version, roots?}  └─ hub/merge.js(ops→Tree) + hub/tree.js(검증·적용, 수정 없음)
  extension/diff.js ┘   (3-way: base↔local = 내 ops)
```

### 3.1 파일 배치

| 파일 | 상태 | 역할 |
|---|---|---|
| `hub/host.js` | 신규 (S1) | stdio 프레이밍과 요청 처리를 맡는다. `handleRequest(req, ctx)`를 export해서 테스트가 프로세스 없이 부를 수 있게 한다. `--import-state`, `--export-state`, `--status` CLI도 제공한다. |
| `hub/store.js` | 신규 (S1) | 공유 파일 잠금, 읽기, 원자적 쓰기, 날짜별 백업(30개), 로그(5MB 회전)를 맡는다. |
| `hub/merge.js` | 신규 (S1) | 확장이 보낸 ops(앵커 `after` 포함)를 `Tree.apply`가 받는 index로 바꿔 적용한다. 병합 규칙(§4.3)을 둔다. |
| `extension/diff.js` | 신규 (S1) | `diffTrees(base, local)` → ops를 만드는 순수 함수다. merge.js와 짝이라서 S1에서 함께 만들고 왕복 테스트를 한다. |
| `scripts/install-host.ps1` | 신규 (S1) | `hub/native/host.bat`와 `hub/native/com.chromebookmarksync.host.json`을 생성한다. node 절대 경로와 `config.extensionId`를 쓴다. HKCU 등록도 한다. |
| `hub/tree.js` | **수정 없음** | 검증과 적용 규칙을 그대로 재사용한다. |
| `extension/core.js` | 재작성 (S2), reconcile 2단계 (S3b) | 3-way 동기화 엔진이다. moveLocal·resolveRoots·대량 삭제 보호는 유지한다. reconcile은 배치→정리 2단계로 바꿨다(§4.2 8단계). |
| `extension/background.js` | 재작성 (S2) | 네이티브 호출, 포커스·시작·5분 알람·북마크 이벤트 트리거를 맡는다. |
| `hub/server.js`, `hub/core.js`, `scripts/install-autostart.ps1` | **삭제됨 (S4)** | WebSocket 허브. `ws` 의존성과 `npm run hub`도 지웠고 `npm run host:status`를 추가했다. |

호스트 이름은 `com.chromebookmarksync.host`다. 이 이름은 `scripts/install-host.ps1`과 `extension/shared.js`(`HOST_NAME`) **두 곳에 있으므로 함께 바꿔야 한다**.

### 3.2 네이티브 호스트 (`hub/host.js`)

- **실행**: `hub/native/host.bat`가 node를 부른다. 이 파일은 ASCII만 쓰고 생성 스크립트가 만든다. 맨 위 두 줄은 전역 훅 헤더(`@chcp 65001 >nul`, ASCII `@rem`)이고, 그다음에 `@echo off`, `"C:\Program Files\nodejs\node.exe" "%~dp0..\host.js" %*`가 온다. `@`가 붙지 않은 줄이 stdout에 찍히면 프레이밍이 깨진다. 그래서 출력하는 명령을 넣지 않는다.
- **출처 확인**: 첫 인자가 `chrome-extension://<config.extensionId>/`가 아니면 응답하지 않고 끝낸다. 지금 허브의 `verifyClient` origin 검사(server.js:77)를 대신한다.
- **stdout 오염 금지**: 로그는 `hub/data/host.log`에만 쓴다(5MB 회전, server.js:24-31 규칙을 옮김). `console.log`는 쓰지 않는다.
- **응답 크기**: 응답 JSON이 1,000,000 B를 넘으면 트리를 빼고 `{ error: 'too-large', bytes }`만 보낸다. 지금은 34 KB라 분할 전송은 만들지 않는다.
- **동시성**: 모든 요청은 잠금(§3.3) 안에서 「읽기 → 적용 → 쓰기」를 한다. 이 때문에 낙관적 재시도가 필요 없다. 잠금 안에서 항상 최신 트리에 병합하기 때문이다.

### 3.3 공유 저장소 (`hub/data/shared.json`, `hub/store.js`)

```json
{ "version": 17, "initialized": true, "roots": { "root_bar": [...], "root_other": [...], "root_mobile": [...] },
  "updatedAt": "…", "updatedBy": "<clientId>",
  "clients": { "<clientId>": { "email": "…", "version": "2.0.2", "protocol": 3, "at": "…", "result": "ok|blocked|stuck" } },
  "confirmed": [ { "version": 18, "gids": ["…"] } ] }
```

- `confirmed`: 확인된 대량 삭제(§4.5). push 요청이 `confirmRemove: true`를 실으면, 호스트는 그 요청으로 사라진 gid를 version과 함께 기록하고 최근 `CONFIRMED_KEEP = 5`건만 남긴다.

- `roots`의 형식은 지금 `Tree.dump()`와 같다. 그래서 `state.json`을 그대로 옮길 수 있다.
- **잠금**: `shared.json.lock`을 `fs.openSync(…, 'wx')`로 만든다(배타 생성). 실패하면 25 ms 간격으로 최대 5초 기다린다. 잠금 파일이 30초보다 오래됐으면 남은 찌꺼기로 보고 지운 뒤 다시 시도한다. 해제는 `finally`에서 한다.
- **원자적 쓰기**: `shared.json.tmp`에 쓴 뒤 rename한다(server.js:42-44 규칙을 유지). Windows에서 rename이 `EPERM`·`EBUSY`로 실패하면 20 ms 간격으로 10번까지 다시 시도한다. 읽기도 잠금 안에서 하므로, 다른 호스트가 파일을 열고 있어서 rename이 실패하는 일은 없다.
- **버전**: 트리가 실제로 바뀐 경우에만 `version`을 1 올린다.
- **백업**: 바뀐 날의 첫 저장 때 `backups/shared-YYYY-MM-DD.json`을 남기고 30개만 보존한다(server.js:45-51 규칙을 유지).
- **옮기기(D-4)**: `node hub/host.js --import-state`가 `state.json`을 `version: 1`로 `shared.json`에 복사한다. 이미 `shared.json`이 있으면 거부한다.
- **재초기화 금지(신규 방어)**: `shared.json`이 없는데 `state.json`이 있으면, 호스트는 메인 프로필의 init 요청을 **거부하고** `{ error: 'migrate-first' }`를 보낸다. 실수로 메인 프로필 트리로 새로 초기화해서 모든 프로필이 다시 덮어써지는 사고를 막는다.
- **되돌리기용**: `--export-state`는 공유 트리를 `state.json` 형식으로 내보낸다. 허브로 되돌릴 때 v2 기간에 생긴 변경을 잃지 않게 하기 위해서다.

### 3.4 요청과 응답

| 요청 (확장→호스트) | 응답 |
|---|---|
| `{type:'sync', clientId, email, protocol, version, result, baseVersion, ops:[…], confirmRemove?}` | `{version, roots?, confirmed?, results:{applied, unchanged, skipped, rescued}, diskVersion}`. `roots`는 `ops`가 있거나 `version !== baseVersion`일 때만 넣는다. `confirmed`는 `baseVersion` 이후의 항목만 싣는다. |
| 예외 프로필(`config.excludeEmails`)의 sync·init | `{excluded:true}`만 돌려준다. `shared.json`과 `clients`를 쓰지 않고 host.log에 `excluded <email>`을 남긴다. |
| (공유가 초기화되지 않았을 때 sync) | 메인이면 `{need:'init'}`, 아니면 `{need:'wait'}`. `masterEmail`은 `hub/config.json`에서 읽는다. |
| `{type:'init', roots, …}` | 메인 프로필이고 초기화 전이며 `state.json`이 없을 때만 받아들인다. 응답은 `{version, roots}`다. |
| 공통 오류 | `{error:'protocol', want}`, `{error:'migrate-first'}`, `{error:'too-large'}`, `{error:'lock-timeout'}`, `{error:'bad-request'}` |

- **판정 순서**: protocol 검사 → 형식 검사 → 제외 검사 → 잠금. 제외 검사는 email을 trim·소문자로 비교하고, 빈 email은 일치시키지 않는다. `masterEmail`이 목록에 있으면 무시하고 로그를 남긴다.
- `diskVersion`은 호스트가 디스크의 `extension/manifest.json`에서 읽은 version이다. 확장은 **`shared.js`의 `CODE_VERSION`**이 이보다 낮으면 큐가 빈 뒤 `chrome.runtime.reload()`로 다시 읽는다. 같은 diskVersion에는 한 번만 한다(저장소의 `reloadedFor`로 확인). 허브의 `POST /reload-extensions`를 대신한다. 「Chrome은 디스크 코드를 고쳐도 새로고침 전까지 옛 코드를 돌린다」 문제를 자동으로 푼다.
  - `getManifest().version`이 아니라 `CODE_VERSION`과 비교하는 이유가 있다(S3b). Chrome은 닫혀 있던 프로필을 열 때 manifest는 디스크에서 새로 읽고, 서비스 워커는 옛 ScriptCache 코드로 띄운다. Profile 4·6에서 첫 요청부터 새 version이 보고됐지만 캐시는 옛 시각이었다. 그래서 manifest 값으로는 옛 코드를 알아볼 수 없다. 반면 실행 중인 서비스 워커의 `chrome.runtime.reload()`는 새 코드를 정상적으로 받는다(Profile 1·5).
  - 호스트 보고와 팝업의 version도 `CODE_VERSION`을 쓴다. host.test.js가 `CODE_VERSION === manifest.version`을 지킨다. **버전을 올릴 때는 두 값을 함께 올린다.**
  - 2.0.1 → 2.0.2 전환 때는 옛 코드가 이 문제를 감지하지 못해 9개 프로필을 수동으로 새로고침했다. 2.0.2부터는 필요 없다.
- `protocol`이 호스트의 `PROTOCOL`과 다르면 오류로 답한다. 확장은 배지 `!`를 띄우고 팝업에 「확장 새로고침 필요」를 보인다. 이것이 옛 코드 감지(옛 hub/core.js)를 대신한다.

---

## 4. 확장 3-way 동기화 (`extension/core.js`, `extension/diff.js`)

### 4.1 저장소 (`chrome.storage.local`)

| 키 | 내용 |
|---|---|
| `map` | gid→로컬 ID. **v1 값을 그대로 유지**한다(D-4). |
| `base` | 마지막으로 맞춘 공유 트리(`roots`, 약 34 KB). `unlimitedStorage` 권한이 이미 있다. |
| `baseVersion` | 위 트리의 공유 version |
| `initialized`, `clientId` | v1의 의미 그대로 유지한다. |
| `mismatch` | `{key, count}`. stuck 판정에 쓴다(§4.5). |
| `blocked` | 대량 삭제 보호로 멈춘 상태(방향 `in`·`out`과 숫자) |
| `pending` | v1 잔여 ops다. 첫 sync에서 한 번 올리고 `[]`로 비운다. |
| `status` | 팝업과 배지용 상태(hostOk, synced, waiting, stuck, blocked, protocolError, excluded, 마지막 오류 등) |
| `reloadedFor` | 마지막으로 다시 읽기를 한 diskVersion(§3.4) |

예외 프로필이 되면 `enterExcluded()`가 `base`·`baseVersion`=null, `initialized`=false, `pending`=[], `blocked`·`mismatch`=null을 `saveState` 한 번으로 저장한다. `map`과 `clientId`는 유지한다. 그래서 목록에서 빠지면 새 프로필처럼 공유 트리로 덮어쓰지만, 같은 노드는 로컬 ID가 그대로다. 첫 맞춤에서는 들어오는 쪽 보호가 꺼진다(`initialized`=false, 의도). 나가는 쪽 보호 경로에서 받은 응답이 excluded여도 같은 처리를 한다.

`map`, `base`, `baseVersion`, `initialized`는 **한 번의 `store.set`으로 함께** 저장한다. v1의 200 ms 지연 저장(`dirty`)은 map만 쓰고, 기준점과 map이 어긋난 채 저장되지 않게 한다.

### 4.2 한 번의 동기화 흐름 (`sync()`, 한 줄 큐 안에서 실행)

1. `epoch0 = localEpoch`. 북마크 이벤트가 올 때마다 `localEpoch`가 1씩 오른다.
2. `local = localRoots()`. gid가 없는 로컬 노드에는 여기서 uuid를 붙이고 `bind`한다(v1 sweep 역할).
3. `ops = base ? diffTrees(base, local) : (v1 pending || [])`
4. **나가는 대량 삭제 보호(신규)**: `ops`가 지우는 노드 수(하위 포함)가 `GUARD_MIN` 이상이고 base 노드 수 × `GUARD_RATIO`를 넘으면 보내지 않는다. `blocked = {dir:'out'}`로 둔다.
5. 호스트 호출: `sync{baseVersion, ops}`. 시간 제한은 15초다. 실패하면 `hostOk=false`(배지 `OFF`)로 두고 다음 트리거에 다시 한다. 기준점은 바꾸지 않는다.
6. 응답에 `roots`가 없고 `mismatch`도 없으면 끝낸다(빠른 경로: 포커스만 바뀌고 변경이 없는 경우).
7. **이벤트 경합 확인**: `localEpoch !== epoch0`이면 reconcile하지 않고 1단계부터 다시 한다(최대 3번). 호스트를 호출하는 동안 생긴 사용자 변경이 reconcile로 지워지지 않게 한다. 이것이 v1 core.js:363 방어를 대신한다. 기준점이 아직 옛것이라 이미 올린 ops가 다시 나가지만, 모든 op가 gid 기준으로 멱등이라 결과가 같다.
8. `reconcile(roots)`. **들어오는 대량 삭제 보호**는 v1 그대로다. 응답의 `confirmed` gid는 이 판정에서 뺀다. 본체는 S3b에서 2단계로 바꿨다.
   - **배치**: `syncFolder`가 공유 순서대로 놓기만 한다. 남는 노드는 지우지 않고 (폴더, pos)를 `plan`에 전위 순서로 쌓는다.
   - **정리**: `sweepExtras`가 모든 루트의 배치가 끝난 뒤 `plan` 순서대로 각 폴더의 pos 뒤에 남은 노드를 `removeLocal`한다. `getChildren`이 실패한 폴더는 건너뛴다.
   - 바꾼 이유: 폴더마다 바로 지우면, 옛 부모를 새 부모보다 먼저 지날 때 옮겨진 노드가 지워지고 새로 만들어졌다(로컬 ID 변경). 대량 삭제 보호도 우회됐다.
   - 받아들인 한계: 종류가 바뀐 폴더(폴더↔북마크) 안에서 뒤쪽으로 옮겨진 노드는 재생성된다.
   - 실기기: Profile 4에서 북마크바→기타 북마크로 옮긴 뒤 Profile 1의 ID 1454가 유지됐다.
   - `removeLocal`은 지우기에 성공한 뒤에 대응표를 푼다. `bind`는 같은 짝이면 저장하지 않는다.
9. 기준점 저장: reconcile에 실패 항목이 없으면 `base = roots`(공유 트리)다. 실패 항목이 있으면 맞춘 직후의 내 트리(그 사이 새로 만든 노드는 뺌)다. 그러지 않으면 다음 diff가 공유 트리를 되돌리는 op를 보낸다. 이어서 `baseVersion = version`, `initialized = true`. map과 함께 한 번에 저장한다.
10. 검증과 stuck 판정(§4.5).

**멱등성**: 5단계(호스트 쓰기)와 9단계(기준점 저장) 사이에 서비스 워커가 꺼지면, 다음 동기화가 옛 기준점으로 같은 ops를 다시 보낸다. create는 gid가 이미 있으면 변경 없음(tree.js:63), remove는 없으면 변경 없음(tree.js:99), update·move는 같은 값이면 변경 없음이다. 그래서 결과가 같다.

### 4.3 diff와 병합 규칙

`diffTrees(base, local)`은 local 트리를 전위 순회한다. 폴더 P의 i번째 자식 c에 대해, 바로 앞 형제의 gid(첫 자식이면 `null`)를 앵커 `after`로 쓴다.

| 경우 | 만드는 op |
|---|---|
| c가 base에 없음 | `create {gid, parent:P, after, title, url?}` |
| base에서 부모가 P가 아님 | `move {gid, parent:P, after}` |
| 부모는 P인데 순서가 바뀜 | base와 local의 P 자식 순서(공통 gid) 사이 LCS에 들지 않은 노드만 `move {after}` |
| title·url이 다름 | `update {gid, title, url?}` |
| base에 있고 local에 없음 | `remove {gid}`. 지워진 하위 트리의 꼭대기에만 만든다. **모든 create·move·update 뒤에** 둔다. |

- remove를 마지막에 두는 이유: 폴더 F에서 X를 꺼낸 뒤 F를 지운 경우, F를 먼저 지우면 X가 함께 사라진다.
- `reorder` op는 만들지 않는다. `Tree.apply`의 reorder는 공유 쪽 자식 집합과 정확히 같아야 해서(tree.js:111-112), 다른 프로필이 같은 폴더에 추가했으면 실패한다. 정렬은 move들로 표현한다.

호스트(`hub/merge.js`)는 잠금 안에서 최신 공유 트리에 ops를 순서대로 적용한다.

| 상황 | 처리 | 결과 |
|---|---|---|
| 앵커 `after`가 공유 쪽의 같은 부모에 있음 | index = (그 노드를 뺀 자식 목록에서) `after`의 위치 + 1 | 다른 프로필이 같은 폴더에 추가한 것과 섞여도 내 순서가 유지된다. |
| 앵커가 없음(다른 곳에서 지워지거나 옮겨짐) | op의 `index`를 범위 안으로 줄여 쓴다(`clamp`) | 대략 같은 위치 |
| 양쪽이 같은 노드를 수정하거나 이동함 | **나중에 동기화한 쪽이 이긴다** | v1은 「허브에 먼저 도착한 쪽이 이김」이었다. README의 해당 문구를 고친다. |
| 다른 프로필이 지운 노드를 내가 수정하거나 이동함 | `Tree.apply`가 `no node` → **건너뜀(삭제 우선)** | 다음 reconcile에서 내 쪽에서도 지워진다. |
| 다른 프로필이 지운 폴더 안에 내가 새로 만듦 | `no parent` → **`root_other` 끝으로 구조(rescued)** | 새로 추가한 북마크를 조용히 잃지 않는다. 팝업에 「다른 프로필이 지운 폴더에 있던 새 북마크 N개를 기타 북마크로 옮김」을 보인다. |
| 다른 프로필이 지운 폴더로 내가 옮김 | `no parent` → 건너뜀 | 공유 쪽 원래 위치에 남는다. |
| 자기 하위로 옮기기(cycle) | 건너뜀 | tree.js:87 |
| v1 pending의 `reorder` | `Tree.apply` 결과를 따르고, 실패하면 건너뜀(quiet) | hub/core.js:66과 같다. |

### 4.4 트리거 (`extension/background.js`)

| 트리거 | 동작 |
|---|---|
| 최상위 실행, `onStartup`, `onInstalled` | `sync()`. 이미 대기 중인 sync가 있으면 합친다. |
| `windows.onFocusChanged(id)`, `id !== WINDOW_ID_NONE` | 300 ms 뒤 `sync()`. 마지막 성공 뒤 2초 안이면 건너뛴다(같은 프로필의 창끼리 전환할 때). |
| 북마크 이벤트 7종 | `localEpoch++`, 1초 디바운스 뒤 `sync()`. 가져오기 중(`onImportBegan`~`Ended`)에는 미루고, 끝나면 한 번 한다. |
| `alarms` 'sync' `periodInMinutes: 5` | `sync()`. 놓친 이벤트를 복구하고, 포커스가 오래 머문 창도 갱신한다. |
| 팝업 `sync` 「지금 맞추기」 | `sync()` |
| 팝업 `force` 「공유 기준으로 적용」(나가는 쪽 보호로 멈췄으면 「공유 기준으로 되돌리기」) | 들어오는 쪽: 보호를 끄고 reconcile. 나가는 쪽: 내 변경을 버리고 공유 트리로 되돌림 |
| 팝업 `push` 「다른 프로필에도 반영」 | 나가는 쪽 보호를 넘겨 ops를 `confirmRemove: true`로 보낸다. |

- 리스너는 모두 **최상위에서 동기로 등록한다**(background.js:43 규칙을 유지).
- **blocked 동안**에는 focus·alarm·event 트리거를 건너뛴다. startup·수동·가져오기 끝은 다시 판정한다.
- 5분 알람 'sync'는 없을 때만 만든다. v1의 'tick' 알람은 지운다.
- 서비스 워커가 잠든 상태에서 창을 열면 startup·focus sync가 1초 안에 2~3번 겹친다. 빠른 경로라 무해하며 알려진 동작이다(S3 관찰).
- v1의 1분 tick + `ticks % 5`는 쓰지 않는다. WebSocket이 서비스 워커를 깨워 두지 않으면 모듈 변수 `ticks`가 깨어날 때마다 0으로 돌아가서, 5분 점검이 영영 오지 않는다.
- 북마크 이벤트의 메아리(내 reconcile이 일으킨 이벤트)는 거르지 않는다. 디바운스 뒤 `diffTrees(base, local)`이 빈 결과라 **호스트를 부르지 않고** 끝난다. ops가 비고 트리거가 북마크 이벤트일 때는 호스트를 부르지 않는다.

### 4.5 보호 장치

| 장치 | 새 구조에서 |
|---|---|
| 들어오는 대량 삭제 보호 | v1 그대로다(`GUARD_MIN = 20`, `GUARD_RATIO = 0.3`, `initialized`일 때만). 멈추면 `blocked = {dir:'in', remove, total, incoming}`로 둔다. |
| 나가는 대량 삭제 보호 | **신규**. 같은 상수로 판정한다. map이 깨지거나 Google 계정 동기화가 프로필을 갈아엎은 경우, 공유 트리를 거쳐 모든 프로필이 지워지는 것을 막는다(v1에는 없던 경로). 팝업에서 「이 프로필에서 N개를 지운 것으로 보입니다. 다른 프로필에도 반영할까요? / 공유 기준으로 되돌리기」를 고른다. |
| 확인된 대량 삭제 | 「다른 프로필에도 반영」으로 확정한 삭제는 `shared.json`의 `confirmed`에 남는다(§3.3). 받는 프로필은 그 gid를 들어오는 쪽 보호 판정에서 빼서, 같은 삭제에 프로필마다 다시 멈추지 않는다. 오래 맞추지 않은 프로필에 다른 프로필들의 정상 삭제가 쌓여 들어오는 쪽 보호에 걸리는 것은 의도된 동작이다(사용자 결정). |
| 예외 프로필 | `config.excludeEmails`(§3.4, §4.1). 배지 `EX`. |
| stuck (같은 불일치 반복) | 허브에서 **확장으로 옮긴다**. reconcile 뒤 `hashRoots(내 트리)`와 `hashRoots(공유 트리, 못 찾은 루트는 [])`를 비교한다. 다르면 `mismatch {key: 내해시:공유해시, count}`를 올리고, 다음 동기화는 빠른 경로 없이 다시 reconcile한다. 같은 key가 `STUCK_AFTER = 5`번을 넘으면 강제 reconcile을 멈추고 배지 `?`를 띄우며, 호스트의 `clients[clientId].result`에 `stuck`을 기록한다. key가 바뀌거나 일치하면 풀린다. |
| 모바일 루트 skip | `resolveRoots`(core.js:155-172)를 그대로 쓴다. 찾지 못한 루트는 reconcile과 해시 비교에서 빼고(`[]`로 처리), **diff에서도 그 루트 아래는 비교하지 않는다**. 그렇지 않으면 「공유에는 있는데 내게는 없음」이 삭제로 잘못 잡힌다. |
| 옛 코드 감지 | §3.4의 protocol 오류와 diskVersion 자동 다시 읽기로 한다. |

### 4.6 배지와 팝업

우선순위 순서(background.js `badge()`):

| 배지 | 뜻 |
|---|---|
| `!` 빨강 | protocol 불일치(확장 새로고침 필요) |
| `EX` 회색 #9aa0a6 | 동기화 예외 |
| `!` 빨강 | 대량 삭제 보호로 멈춤(blocked, 들어오는 쪽 또는 나가는 쪽) |
| `OFF` | 호스트 호출 실패. 등록이 안 됐거나(「Specified native messaging host not found」) 호스트 오류다. |
| `?` | stuck |
| `…` | 기다리는 중이거나 아직 맞추지 못함 |
| 없음 | 맞춰짐 |

팝업의 「다시 연결」은 없앴다. 명령은 `sync` 「지금 맞추기」, `force` 「공유 기준으로 적용」(나가는 쪽 보호로 멈췄으면 「공유 기준으로 되돌리기」), `push` 「다른 프로필에도 반영」 세 가지다(§4.4). 예외 프로필에서는 「지금 맞추기」만 보인다.

---

## 5. 영향도 표

전수 확인 대상: `extension/*.js`, `extension/manifest.json`, `hub/*.js`, `test/*.js`, `scripts/*`, `README.md`, `package.json`. 출처 열의 「주석」은 날짜 없는 코드 주석, 「코드」는 주석 없는 구현이다. 날짜나 이슈 번호가 달린 주석은 없었다.

### 5.1 확장 엔진 (`extension/core.js`, `extension/diff.js`) — S1(diff.js), S2(core.js)

| 기존 규칙 | 위치 | 출처 | 지금 무엇을 막나 | 이번 수정 후 | 근거 |
|---|---|---|---|---|---|
| gid 대응표 `map`/`rev`, `bind` 시 옛 짝 해제 | core.js:5,116-131 | 주석 | 프로필마다 다른 로컬 ID를 공통 gid로 잇는다. | **유지** | D-4: 덮어쓰기 방지의 핵심 |
| 저장소의 `map`, `initialized`, `clientId` 키 이름과 의미 | core.js:46-52,59 | 코드 | 재시작 뒤 대응표 유지 | **유지** (키 이름 그대로) | v1 저장값을 그대로 읽어야 다시 덮어쓰지 않는다. |
| 모든 작업을 한 줄 큐로 | core.js:6,73-95 | 주석 | 로컬 이벤트와 원격 적용이 섞이는 것 | **유지**. sync도 큐 안에서 돈다. | |
| `ROOT_FOLDER_TYPES`, `ROOT_FALLBACK_IDS` | core.js:11-12 (사용 :160-166) | 코드 | folderType이 없을 때 루트 찾기 | **유지** | fake-bookmarks의 '1'~'3'과 연동 |
| 빈 모바일 폴더를 ID로 다시 찾기 | core.js:162-168 | 주석 「비어 있으면 getTree에 안 나온다」 (Chrome 157 관찰) | 빈 모바일 폴더에 만들지 못하는 것 | **유지** | Chrome 158에서도 유지되는지는 S3에서 확인 |
| `syncing` 루트 우선 선택 | core.js:161 | 코드 | 계정 북마크와 로컬 북마크 루트가 둘일 때 동기화되는 쪽을 고른다(Profile 11~15는 AccountBookmarks만 있음). | **유지** | |
| `GUARD_MIN = 20`, `GUARD_RATIO = 0.3`, `initialized`일 때만 | core.js:13-16, 341-348 | 주석 「모든 프로필(과 각 Google 계정 동기화)까지 지워지는 사고를 막는다」 | 들어오는 대량 삭제 | **유지**. 같은 상수를 나가는 쪽에도 **추가 사용** | README:13 숫자와 연동 |
| `blocked.info {remove,total,incoming}` | core.js:344 ↔ popup.js:14-15 | 코드 | 팝업 경고 문구 | **변경**: `dir:'in'|'out'` 필드 추가 | 나가는 쪽 보호 추가 |
| `force()`: 멈춘 스냅샷 적용, 없으면 다시 맞춤 | core.js:492-497 | 주석 | 사용자 확인 뒤 적용 | **유지**(의미 같음). out일 때는 「반영」/「되돌리기」 둘로 나뉜다. | |
| `syncFolder`/`reconcile` (타입이 바뀌면 다시 생성, 남는 노드 삭제, 항목별 실패 로그) | core.js:306-351 | 코드 | 공유 트리로 정확히 맞추기 | **변경(S3b)**: 배치(syncFolder가 (폴더, pos)를 plan에 전위 순서로 쌓음) → 정리(sweepExtras, 모든 루트 배치 뒤 plan 순서로 남는 노드 removeLocal, getChildren 실패 폴더는 건너뜀). 타입이 바뀌면 다시 생성, 항목별 실패 로그는 유지 | §4.2 8단계: 받는 쪽 이동 때 지웠다 다시 만들던 문제 |
| `moveLocal` +1 규칙 | core.js:294-299 | 주석 (Chrome BookmarkModel::Move) | 같은 폴더 안에서 아래로 옮길 때 한 칸 어긋남 | **유지**. `expect` 호출 한 줄만 제거 | |
| `updateLocal`: 바뀐 필드만, 폴더 url은 무시 | core.js:284-292 | 주석 | 불필요한 update | **유지**. `expect` 호출만 제거 | |
| `unmodifiable` 노드 제외 | core.js:175 등 | 코드 | 관리 정책 북마크를 건드리지 않는다. | **유지** | |
| 「스냅샷을 기다리는 동안 생긴 로컬 변경은 … 다시 받아 반영」 | core.js:363-364 | 주석 | 맞추는 중에 생긴 사용자 변경 유실 | **변경**: `localEpoch` 확인 후 다시 하기(§4.2 7단계) | 같은 방어를 새 구조로 옮긴다. |
| `applyRemote` 실패 시 resync | core.js:416-419 | 코드 | 적용 실패로 어긋난 상태가 남는 것 | **변경**: 항상 공유 트리 전체로 reconcile하고, 검증 불일치는 stuck 판정으로 처리 | |
| sweep (안 묶인 노드에 gid를 붙여 생성으로 보냄) | core.js:257-271 | 주석 | 가져오기 등으로 생긴 노드 누락 | **변경**: `localRoots()`가 gid를 붙이고 diff가 create로 만든다. | |
| `importing` 동안 생성 보류, 끝나면 sweep | core.js:216,243,453-454 | 코드 | 가져오는 동안 노드마다 따로 보내는 것 | **유지**(형태 변경): 가져오는 동안 sync를 미루고 끝난 뒤 한 번 한다. | |
| 「아직 안 묶인 노드가 있으면 주기 점검에서 맞춘다」 (reorder 보류) | core.js:252 | 주석 | 불완전한 reorder 전송 | **제거 ★R5** | diff가 reorder op를 만들지 않으므로 이 경우 자체가 없다. |
| `periodicCheck`: `!connected‖!synced‖blocked‖pending`이면 생략 | core.js:485 | 코드 | 보내기 대기 중의 오판 | **변경**: blocked이면 sync를 건너뛰고, pending 개념은 없어진다. | |
| 「찾지 못한 루트는 허브도 비교에서 뺀다」 skip | core.js:488-489 | 주석 | 없는 루트 때문에 5분마다 다시 맞추기 | **유지**(확장 안에서 양쪽 해시를 모두 계산). **diff에도 적용** | |
| `pending` 큐, `emit`/`flush`, `helloCount` 중복 제거 | core.js:182-196,355,461 | 코드 | 끊긴 동안의 변경 보존, 중복 전송 | **제거 ★R2** (v1 잔여 pending은 한 번 옮김) | 기준점↔내 트리 diff가 오프라인 변경을 그대로 담는다(D-2). |
| 이벤트 → op 변환 핸들러(created/removed/changed/moved/reordered) | core.js:214-255 | 코드 | 실시간 전파 | **제거 ★R3** → 이벤트는 `localEpoch++`와 디바운스 sync로만 쓴다. | op는 diff가 만든다. 놓친 이벤트도 복구된다. |
| 메아리 거르기 `expect`/`consume`, 작업 끝 기한(`Infinity`→`echoGraceMs`), `echoGraceMs = 300` | core.js:7-8,40,84-88,97-113,230,238,290,297; 테스트 :36 | 주석 「작업이 끝난 뒤 echoGraceMs 안에 도착한 이벤트만 메아리로 본다」 | 내 적용이 일으킨 이벤트를 다시 허브로 보내는 루프, 늦게 온 사용자 조작을 메아리로 잘못 삼키는 것 | **제거 ★R1** | 메아리는 diff가 빈 결과라 호스트 호출 없이 끝난다(§4.4). 「늦은 사용자 조작을 메아리로 잘못 삼킴」이라는 위험도 거르기를 없애면 함께 사라진다. |
| `doInit` (메인이 처음 트리를 만듦) | core.js:422-438 | 코드 | 처음 설치 시 기준 트리 생성 | **유지**(호스트의 `need:'init'`에 응답) | |
| `waiting` (메인을 기다림) | core.js:473 | 코드/테스트 | 메인보다 먼저 붙은 프로필이 빈 트리로 덮어쓰는 것 | **유지** | 테스트 1 |
| status 필드 `connected` | core.js:65 ↔ background.js:16 ↔ popup.js:5 | 코드 | 허브 연결 표시 | **변경**: `hostOk` (마지막 호스트 호출 성공) | |
| hello에 `protocol`, `version` 싣기 | core.js:462 | 주석(shared.js:6-8) | 옛 코드 감지 | **변경**: 모든 sync 요청에 싣는다. | |

### 5.2 백그라운드·팝업·manifest (S2)

| 기존 규칙 | 위치 | 출처 | 지금 무엇을 막나 | 이번 수정 후 | 근거 |
|---|---|---|---|---|---|
| 리스너는 최상위에서 동기로 등록 | background.js:43 | 주석 | 꺼진 서비스 워커가 이벤트로 깨어나지 못하는 것 | **유지**. `windows.onFocusChanged`, `alarms`도 같은 방식 | |
| 시작 시 connect 중복 호출 공유(`connecting`) | background.js:58-63 | 주석 「소켓이 둘 생기지 않게」 | 중복 연결 | **변경**: 큐에서 sync를 합치는 방식(대기 중이면 추가하지 않음) | 같은 목적(중복 실행 방지) |
| 20초 ping | background.js:78-79 | 주석 「MV3 서비스 워커가 연결 중에 꺼지지 않는다」 | 연결 중에 서비스 워커가 꺼지는 것 | **제거 ★R4** | 오래 유지하는 연결이 없다. 한 번 호출하는 데 100 ms 정도라 꺼질 일이 없다. |
| 재연결 백오프 2 s × 2^n, 최대 60 s | background.js:52-56 | 코드 | 허브가 죽었을 때 재시도 폭주 | **제거 ★R4** | 다음 트리거(포커스·5분 알람)가 재시도 역할을 한다. 실패가 잦아도 5분에 1번 수준이다. |
| 교체된 소켓의 close 무시 | background.js:88 | 주석 | 옛 소켓이 새 연결을 끊는 것 | **제거 ★R4** | 소켓이 없다. |
| reload 전에 `engine.idle()` 기다리기 | background.js:84 | 코드 | 큐가 끝나기 전에 다시 읽는 것 | **유지**(diskVersion 자동 다시 읽기에 사용) | |
| 1분 tick + `ticks % 5` | background.js:97-101 | 코드 | 5분 점검 | **변경**: `periodInMinutes: 5` | §4.4: 서비스 워커가 잠들면 `ticks`가 0으로 돌아간다. |
| 배지 색과 문자 | background.js:15-23 ↔ README:26 | 코드 | 상태 표시 | **변경**: `OFF`의 뜻을 바꾸고 `!`에 protocol 불일치 추가 | §4.6 |
| 팝업 명령 force/check/reconnect | popup.js:23-26 ↔ background.js:107-113 | 코드 | | **변경**: reconnect **제거 ★R6**, check는 「지금 맞추기」로 | 연결 개념이 없다. |
| manifest `key`(확장 ID 고정) | manifest.json:6 | README:10 | 허브가 이 ID만 받는다. | **유지**. 호스트 manifest의 `allowed_origins`, `config.extensionId`와 연동 | |
| 권한 | manifest.json:7 | 코드 | | **변경**: `nativeMessaging` 추가, 나머지 유지(identity는 masterEmail 판정에 필요) | |
| version 1.0.1 | manifest.json:4 | 코드 | | **변경**: 2.0.0 | |

### 5.3 공용 값 (`extension/shared.js`) — S2

| 기존 규칙 | 위치 | 출처 | 지금 무엇을 막나 | 이번 수정 후 | 근거 |
|---|---|---|---|---|---|
| 「직렬화 형식은 이 파일 한 곳에서만 고친다」 | shared.js:1-2, README:66 | 주석 | 확장과 허브의 해시 불일치 | **유지**. 호스트도 이 파일을 import한다. `serializeRoots`·`hashRoots` 형식은 바꾸지 않는다. | |
| `ROOT_GIDS` 순서 = 직렬화 순서 | shared.js:4 (사용처 20곳 넘음, 테스트에도 직접 기재) | 코드 | | **유지** | |
| `PROTOCOL = 2`와 이력 주석 | shared.js:6-9 | 주석 | 옛 코드 감지 | **변경**: 3. 이력 줄에 「3: Native Messaging sync 요청」 추가 | README:53 규칙 |
| `HUB_PORT = 47321` | shared.js:5 (사용: background.js:3, server.js:7) | 코드 | | **제거 ★R7**. S2에서 `hub/server.js`의 import 한 줄을 `config.port`로 바꿔, S3 전환 전까지 허브가 계속 뜨게 한다. | 확장은 더 이상 쓰지 않는다. |
| (신규) `HOST_NAME = 'com.chromebookmarksync.host'` | shared.js | — | — | 추가 | install-host.ps1과 연동 |
| `countNodes` | shared.js:24-29 | 코드 | 경고 숫자 | **유지** | |

### 5.4 허브 규칙의 이전 (`hub/core.js`, `hub/server.js` → `hub/host.js`, `hub/store.js`, `hub/merge.js`) — S1 신규, S4 삭제 완료

S4에서 파일을 지우기 전에, 아래 「이전」 항목이 새 위치에 있는지 다시 확인했다. 확장 `STUCK_AFTER`, host `need:'init'|'wait'`, init 검증 뒤 쓰기, store.js의 tmp→rename·EPERM 재시도·`BACKUP_KEEP`·`LOG_MAX_BYTES`, host origin 검사, `too-large`가 그 대상이다. 남은 참조는 `state.json` 경로뿐이다(`--import-state`·`--export-state`·`migrate-first`). 이것은 남긴다.

| 기존 규칙 | 위치 | 출처 | 지금 무엇을 막나 | 이번 수정 후 | 근거 |
|---|---|---|---|---|---|
| `Tree.apply` 검증(gid, 부모, cycle, 중복 remove는 변경 없음, index = 최종 위치) | tree.js 전체 | 주석 tree.js:2,99 | 잘못된 op가 공유 트리를 깨는 것 | **유지(수정 없음)** | D-4 |
| `STUCK_AFTER = 5`, 「3보다 커야 한다」 | hub/core.js:4-7 | 주석 (랜덤 테스트가 점검 3회 안에 바로잡히기를 기대) | 같은 불일치에 5분마다 끝없이 다시 보내기 | **변경(이전)**: 확장의 stuck 판정으로 옮긴다. 값 5와 「> 랜덤 테스트 수렴 회차(3)」 관계는 유지 | §4.5 |
| key = 프로필해시:허브해시, key가 바뀌면 1부터, 일치하거나 resync하면 해제 | hub/core.js:98-101,120-124 | 코드/테스트 10 | | **유지(이전)** | |
| 메인만 init, 그 밖에는 wait | hub/core.js:63,72 | 코드/주석 | 메인이 아닌 프로필이 기준 트리를 만드는 것 | **유지(이전)** → host `need:'init'|'wait'` | |
| init 실패 시 reset | hub/core.js:73-79 | 코드 | 반쯤 초기화된 상태 | **유지(이전)** | |
| hello pending을 quiet로 적용(거부돼도 스냅샷을 보내지 않음) | hub/core.js:66 | 코드 | 거부된 op마다 스냅샷 폭주 | **유지(이전)**: 모든 ops에 대해 실패하면 건너뛰고 결과에 집계 | |
| 거부되면 스냅샷 재전송 | hub/core.js:41-44 | 코드 | 어긋난 프로필 방치 | **변경**: 응답에 늘 최신 트리를 담고 reconcile한다. | |
| 원자적 저장 tmp→rename | server.js:42-44 | 코드 | 반쯤 쓰인 state.json | **유지(이전)**, EPERM 재시도와 잠금 추가 | |
| 날짜별 백업 30개 | server.js:45-51 ↔ README:42 | 코드 | | **유지(이전)**: 파일 이름 `shared-YYYY-MM-DD.json` | |
| 저장 디바운스 1 s, SIGINT/SIGTERM 시 즉시 저장 | server.js:54,99 | 코드 | 상시 프로세스의 유실 | **제거 ★R8** | 요청마다 잠금 안에서 바로 쓰고 종료한다. |
| 로그 5 MB 회전, 「로그 실패는 무시」 | server.js:24-31 | 주석 | 로그 때문에 죽는 것 | **유지(이전)**: `host.log`. stdout에는 절대 쓰지 않는다. | |
| `verifyClient` origin = 확장 ID | server.js:14,77 | 코드 | 다른 확장이나 웹페이지의 연결 | **변경**: Chrome `allowed_origins` + 호스트 argv origin 확인 | |
| `X-BmSync` 헤더 요구(CSRF) | server.js:60-61 | 주석 | 웹페이지가 reload를 호출하는 것 | **제거 ★R9** | HTTP 서버가 없어진다. 공격 면 자체가 사라진다. |
| `GET /status` | server.js:66-70, README:22,61 | 코드 | 상태 확인 | **변경**: `node hub/host.js --status`(shared.json의 clients) | |
| `POST /reload-extensions`, `reload-all` | server.js:61-65, hub/core.js:109-112 | 주석 | 고친 확장 코드 일괄 다시 읽기 | **변경**: diskVersion 자동 다시 읽기(§3.4) | |
| `maxPayload` 64 MB | server.js:76 | 코드 | 큰 init | **변경**: Chrome 한도(확장→호스트 64 MiB, 호스트→확장 1 MB). 호스트가 too-large를 확인 | |
| 「old extension code …」 로그 | hub/core.js:61 | 코드 | | **변경**: protocol 불일치 오류 응답과 host.log | |
| `masterEmail`, `extensionId` 설정 | config.example.json | 코드 | | **유지**. `port`는 S4에서 삭제했고 `excludeEmails: []`를 추가했다. | |

### 5.5 스크립트·문서 — S1/S4

| 기존 규칙 | 위치 | 출처 | 지금 무엇을 막나 | 이번 수정 후 | 근거 |
|---|---|---|---|---|---|
| 「첫 동기화 전에 반드시 백업」 | backup-bookmarks.mjs:2 | 주석 | 덮어쓰기 사고 | **유지**, 대상 파일에 `AccountBookmarks`, `AccountBookmarks.bak` **추가**(S1) | §2: Profile 11~15가 백업되지 않던 빈틈 |
| 백업 경로 ↔ real-data 테스트 입력 | backup-bookmarks.mjs:8 ↔ real-data.test.js:11-13 | 코드 | | **유지**. real-data는 `Profile 1/Bookmarks`만 읽으므로 영향 없음 | |
| 예약 작업 `ChromeBookmarkSyncHub`(S4U, 창 없음, 재시작 999) | install-autostart.ps1 | 주석 | 로그온 시 허브 자동 실행 | **제거 ★R10**(S4에서 등록 해제와 파일 삭제 완료) | D-4 |
| README 설치·배지·알아둘 점·복원·제거·코드 수정 뒤 절차 | README 전체 | 문서 | | **변경**(S4 전면 개정 완료): 「먼저 도착한 쪽이 기준」 → 「나중에 맞춘 쪽」, 「즉시 반영」 → 「창 전환 때」, 복원 절차의 허브 → 공유 파일 | |
| 공유 백업 되돌리기 | README 「복원」 | 문서(S4 신규) | 백업의 옛 version을 그대로 쓰면, 다시 올라가는 version 번호가 프로필이 받아 둔 옛 기준점 번호와 겹쳐 빠른 경로로 복원을 놓치는 것 | 백업을 **지금 version + 1**로 씌우는 명령을 README에 둔다. | host.js 빠른 경로(`req.baseVersion !== next.version`일 때만 roots) |
| `ws` 의존성, `npm run hub` | package.json | 코드 | | **제거**(S4 완료), `npm run host:status` 추가 | |

### 5.6 테스트 계약 (11개) — S2

| # | 계약 | 위치 | 이번 수정 후 |
|---|---|---|---|
| 1 | 메인으로 초기화, 메인보다 먼저 붙은 프로필은 waiting, 나머지는 덮어쓰기, count 10 | sync.test.js:108 | **유지** (host need-init/wait) |
| 2 | 추가·수정·이동(같은 폴더 맨 아래)·정렬·삭제 전파 | :126 | **유지**. 「즉시」 → 받는 프로필이 sync(포커스 흉내)한 뒤 |
| 3·4 | 동시 무작위 편집이 sync/deferred 모두 수렴 | :158 | **유지**. 편집 사이사이 무작위 sync, 끝에 모든 프로필 sync 3회 안에 일치(`STUCK_AFTER` > 3 관계 유지) |
| 5 | 닫힌 동안의 내 변경은 올리고 남의 변경은 따라잡음 | :183 | **유지**. `pending === 1` 단언 → 「기준점 대비 diff 1개」로 바꿈 |
| 6 | 들어오는 대량 삭제 보호 → force 적용 | :206 | **유지** (공유 파일을 빈 트리, version+1로 바꿈) |
| 7 | 같은 폴더 위→아래, 아래→위 이동 | :226 | **유지** |
| 8 | 모바일 숨김에도 맞춰짐 | :243 | **유지** |
| 9 | hello에 protocol·version → 허브 status | :258 | **변경**: sync 뒤 `shared.json`의 `clients[clientId].protocol === PROTOCOL` |
| 10 | 같은 불일치가 STUCK_AFTER번이면 멈추고, key가 바뀌면 다시, 일치하면 해제 | :269 | **변경(이전)**: 가짜 bm에 특정 노드 update 실패를 주입해 확장 쪽 stuck을 검증 |
| 11 | 실제 Profile 1 규모로 7개 프로필 맞추기 | real-data.test.js:15 | **유지** (새 하네스로 옮김) |

신규 테스트:
- S1 `test/host.test.js`: 실제 `node hub/host.js`를 spawn해서 프레이밍과 origin 거부를 확인한다. 프로세스 여러 개로 동시에 쓰기(잠금, 버전 단조 증가, 유실 없음), too-large, migrate-first, `--import-state` 거부, diff↔merge 왕복(§4.3 표의 모든 행)도 확인한다.
- S2: 추가와 삭제 구분(A가 X를 지우고, 동기화 안 된 B가 sync해도 X는 지워진 상태 유지), 지워진 폴더에 만든 노드 구조, 나가는 대량 삭제 보호, 호스트 쓰기 뒤 기준점 저장 전에 중단돼도 멱등, 호스트 호출 중 사용자 편집 보존(epoch), **v1 저장소(map + pending, base 없음)에서 옮길 때 로컬 ID가 하나도 바뀌지 않음**(D-4), 루트를 찾지 못한 skip 경로(지금은 테스트가 없다는 조사 결과 → fake-bookmarks에 `bm.get('3')` 실패 옵션 추가).
- S3b 이동 ID 보존(sync.test.js 「이동 ID 보존」 7건): 루트 사이, 같은 루트의 폴더 사이, 하위가 있는 폴더, 꺼낸 뒤 폴더 삭제, 33개 폴더 이동, 적용 실패 뒤 복구, 모바일 루트 없음. 받는 프로필의 로컬 ID가 바뀌지 않아야 한다.
- S3b 예외 프로필: host.test.js 4건(대소문자·공백 차이도 일치하면 excluded이고 shared의 version·clients 불변 / 빈 email 불일치 / masterEmail은 무시 / protocol 오류가 제외보다 먼저), sync.test.js (a)~(g)(남의 변경을 받지 않음 / 내 변경을 올리지 않고 이벤트로 호스트를 부르지 않음 / 복귀하면 덮어쓰고 ID 유지 / 복귀할 때 대량 삭제 보호에 걸리지 않음 / v1 저장소의 pending은 올리지 않고 지움 / 나가는 쪽 보호 경로의 excluded 응답).
- S3b 코드 버전: host.test.js 「`CODE_VERSION`은 manifest.json의 version과 같다」.

현재 테스트는 **59개**다(sync 30, host 28, real-data 1). S4는 테스트를 지우지 않았다(지운 `hub/core.js`·`hub/server.js`를 import하는 테스트가 없었다).

### 5.7 「제거」 항목 — 별도 승인 필요

| ID | 제거 대상 | 왜 들어왔던 방어인가 | 제거해도 되는 근거 |
|---|---|---|---|
| R1 | 메아리 거르기 `expect`/`consume`, `echoGraceMs` | 내 적용이 일으킨 Chrome 이벤트를 op로 다시 보내는 루프를 막았다. | 이벤트가 op를 만들지 않는다. 메아리 뒤의 diff는 비어 있어서 호스트를 부르지 않는다(§4.4). |
| R2 | `pending` 큐, `helloCount` | 끊긴 동안의 변경을 보존하고, hello와 flush의 중복 전송을 막았다. | 기준점 diff가 오프라인 변경을 담는다. v1 잔여 pending은 첫 sync에서 한 번 올린다. |
| R3 | 이벤트 → op 핸들러 | 실시간 전파 | D-3에 따라 sync 시점에 diff로 만든다. 놓친 이벤트도 복구된다. |
| R4 | ping 20 s, 재연결 백오프, 교체된 소켓 가드 | WebSocket 유지와 재연결 | 오래 유지하는 연결이 없다. |
| R5 | reorder 보류 가드(core.js:252) | 안 묶인 노드가 낀 reorder 전송 | reorder op 자체를 만들지 않는다. |
| R6 | 팝업 「다시 연결」 | 허브 재연결 | 연결 개념이 없다. |
| R7 | `HUB_PORT` | 확장↔허브 포트 일치 | 허브를 쓰지 않는다. |
| R8 | 저장 디바운스, 시그널 저장 | 상시 프로세스의 쓰기 횟수, 종료 시 유실 | 요청마다 바로 쓰고 종료한다. |
| R9 | `X-BmSync` 헤더 | 웹페이지가 reload를 호출하는 것(CSRF) | HTTP 서버가 없어진다. |
| R10 | 예약 작업, `hub/server.js`, `hub/core.js` | 허브 상시 실행 | D-4 (S3 실기기 확인 뒤 S4에서) |

---

## 6. 전환 절차 (S3, 실기기)

1. `npm run backup`(S1에서 AccountBookmarks 포함으로 고친 버전)을 실행한다. `hub/data/state.json`도 따로 복사해 둔다.
2. 허브를 멈춘다: `Disable-ScheduledTask ChromeBookmarkSyncHub`, `Stop-ScheduledTask`. 되돌릴 수 있게 **등록은 지우지 않는다**. 이때부터 v1 확장은 `OFF`를 띄우고, 변경을 pending으로 모은다.
3. `node hub/host.js --import-state`를 실행한다. `state.json`이 `shared.json`(version 1)로 옮겨진다.
4. `scripts/install-host.ps1`이 이미 실행돼 있는지(S1) 레지스트리로 확인한다.
5. 프로필 10개의 확장을 새로고침한다. 메모리 `install-extension-new-profile.md`의 UIA 방식을 쓰고, **키를 입력하기 전에 해당 창이 포그라운드인지 확인한다**. v1에는 diskVersion 자동 다시 읽기가 없으므로 이번 한 번은 직접 해야 한다. 이어서 **Profile 16에 확장을 새로 설치하고 북마크바 항상 표시까지 켠다**(같은 UIA 방식). Profile 16은 base가 없는 새 프로필이므로 공유 트리로 덮어써진다(테스트 1과 같은 경로).
6. 확인한다:
   - `host.js --status`에 clientId 11개(Profile 16 포함)가 보이고 모두 protocol 3, result ok인지
   - 프로필마다 노드 수가 228개 그대로이고 로컬 ID가 바뀌지 않았는지. 다시 덮어썼다면 Chrome 이벤트로 북마크가 새로 만들어졌을 것이다. host.log에서 ops 0을 확인한다.
   - 두 프로필 사이에서 추가·수정·이동·삭제를 한 뒤 창을 전환해 반영되는지
   - `onFocusChanged`가 다른 프로필로 전환할 때 받는 쪽에서만 sync를 일으키는지
   - 빈 모바일 폴더 처리(Chrome 158)
   - 배지
7. 되돌리기(문제가 있을 때): `node hub/host.js --export-state`로 v2 기간의 변경을 `state.json`에 반영한다. 그다음 확장을 v1(`git checkout 29d38c1 -- extension/`)로 되돌리고, 예약 작업을 다시 켜고, 확장을 새로고침한다.

공존 기간은 두지 않는다. 2단계에서 허브를 먼저 멈추므로 허브와 호스트가 동시에 쓰는 일이 없다. 아직 새로고침하지 않은 v1 프로필의 변경은 pending으로 보존되고, v2로 다시 읽을 때 올라간다(§4.1).

### 6.1 전환 결과 (S3, 2026-11-28)

- 백업: `backups/2026-11-28T03-34-17/`
- import 노드는 **229개**다(§2의 228은 D1 조사 때 값). 11개 프로필 모두 protocol 3, result ok였다. 기존 프로필의 첫 sync는 모두 ops 0이었다(다시 덮어쓰지 않음).
- v1 시절의 어긋남이 정리됐다. Profile 6·8·11~15에 중복으로 있던 `개발/영상생성/127.0.0.1`(:8787)은 공유 트리의 `소스/무료음악검색`으로 맞춰졌다. 공유 트리에만 있던 `Play Console`은 그 프로필들도 따라 받았다.
- 확장 「오류」 버튼에 v1 코드가 남긴 `WebSocket … ERR_CONNECTION_REFUSED`가 새로고침 뒤에도 남는다. 「모두 삭제」로 지운다(README 문제 해결).
- 7단계의 되돌리기 경로는 S4에서 예약 작업 등록과 `install-autostart.ps1`을 지웠으므로, 쓰려면 git 기록에서 그 파일을 꺼내 다시 등록해야 한다. `--export-state`는 남아 있다.

---

## 7. 확정 대기

모두 S1·S3에서 확정됐다. 남은 항목은 없다.

| 항목 | 결과 |
|---|---|
| Chrome 158 `onFocusChanged`에서 잃는 쪽 | `WINDOW_ID_NONE`만 받아서 sync하지 않는다. |
| Chrome 158의 빈 모바일 폴더 | 157과 같이 숨겨진다. 기존 코드(ID로 다시 찾기)가 그대로 동작한다. |
| `nativeMessaging` 권한 추가 뒤 새로고침 | 확인 창 없이 권한이 붙는다. |
| 호스트 호출 지연 | 1회 중앙값 130 ms(S1), 창 전환부터 호스트 호출까지 0.3~0.6초(S3). 디바운스 조정은 필요 없다. |

---

## 8. 세션 작업표

S1, S2, S3, S3b, S4 모두 완료했다. S3b(받는 쪽 이동 ID 보존, 예외 프로필, 코드 버전 기준 다시 읽기, 2.0.2)는 S3 실사용 중에 나온 문제로 추가한 세션이다. 아래 표는 계획 당시의 작업표다.

| 세션 | 포함 항목 | 선행 조건 | 건드리는 파일 | 검증 방법 | 완료 신호(커밋) |
|---|---|---|---|---|---|
| **S1** 네이티브 호스트·공유 저장소·diff | §3.2·§3.3·§3.4 호스트, §4.3 diff↔merge, 설치 스크립트, 백업 빈틈 | 이 문서 승인 | 신규: `hub/host.js`, `hub/store.js`, `hub/merge.js`, `extension/diff.js`, `scripts/install-host.ps1`, `test/host.test.js` / 수정: `.gitignore`(`hub/native/`), `scripts/backup-bookmarks.mjs` | `npm test`(기존 11개 + 신규). `install-host.ps1` 실제 실행 → 레지스트리 확인 → `host.bat`를 spawn해 프레이밍된 요청에 응답하는지 확인. 호출 지연 실측. `npm run backup`이 Profile 11~15를 담는지 확인 | `feat: Native Messaging 호스트·공유 저장소·3-way diff/merge` |
| **S2** 확장 3-way 동기화 | §4 엔진, 트리거, 보호 장치, 배지와 팝업, 테스트 계약 이전 | S1 | `extension/core.js`, `extension/background.js`, `extension/shared.js`, `extension/manifest.json`, `extension/popup.js`, `extension/popup.html`, `test/sync.test.js`, `test/real-data.test.js`, `test/fake-bookmarks.js`, `hub/server.js`(import 1줄) | `npm test` 전체. 실기기에는 아직 올리지 않는다(허브 계속 운영). `node hub/server.js`가 뜨는지 확인 | `feat: 확장을 Native Messaging 3-way 동기화로 전환(2.0.0, PROTOCOL 3)` |
| **S3** 실기기 전환 | §6 절차 1~6(Profile 16 설치 포함), 확정 대기 처리 | S2 | 코드 없음(실기기 문제가 나오면 S1·S2 파일을 같은 세션에서 고침) | §6의 6단계 확인 목록 전부, 사용자 화면 확인 | `chore: Native Messaging 실기기 전환`(수정이 생겼을 때만) |
| **S4** 허브 제거·문서 정리 | R10, README 전면 개정, 설정 정리 | S3 뒤 하루 이상 실사용에 문제 없음 | 삭제: `hub/server.js`, `hub/core.js`, `scripts/install-autostart.ps1` / 수정: `package.json`, `package-lock.json`, `hub/config.example.json`, `README.md`, `docs/native-messaging-design.md`(상태 「완료」) / 실기기: 예약 작업 등록 해제 | `npm test`, `npm ls`에 ws 없음, README 절차대로 `--status` 확인 | `chore: WebSocket 허브 제거, README를 Native Messaging 기준으로 개정` |

공통 주의:
- 저장소는 공개 저장소다. `hub/config.json`, `hub/data/`, `hub/native/`, `backups/`, `.claude/`는 올리지 않는다. 예시 계정은 `main@example.com`을 쓴다.
- `.bat`와 `.ps1`의 한글 처리는 전역 규칙을 따른다. `host.bat`는 생성 파일이므로 ASCII만 쓴다.
- 커밋은 SessionEnd 훅이 한다. `.git/SESSION_COMMIT_MSG`에 한 줄만 쓴다.
