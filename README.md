# Chrome 프로필 북마크 동기화

이 PC의 모든 Chrome 프로필이 같은 북마크를 쓰게 한다. 어느 프로필에서 북마크를 추가·수정·이동·삭제·정렬하든, 그 변경은 바로 공유 파일에 올라간다. 다른 프로필은 **그 프로필의 창으로 전환할 때**(또는 열 때, 5분마다) 받아서 맞춘다.

```
[프로필 확장] [프로필 확장] …
   │  chrome.runtime.sendNativeMessage (맞출 때만, 응답 뒤 종료)
   ▼
hub/native/host.bat → node hub/host.js ── hub/data/shared.json   공유 트리(잠금·원자적 쓰기·version)
                                         └ hub/data/backups/shared-YYYY-MM-DD.json  날짜별 30개
```

- **확장(extension/)**: 각 프로필에 같은 확장을 설치한다. `manifest.json`의 `key`로 확장 ID를 `cchkhligdoboaipldlkkjjdfpmieomcd`로 고정한다. 프로필마다 「마지막으로 맞춘 공유 트리(기준점)」를 저장해 두고 3-way로 비교한다. 기준점↔내 트리는 내 변경, 기준점↔공유 트리는 다른 프로필의 변경이다.
- **네이티브 호스트(hub/host.js)**: 상시 실행되는 프로세스가 없다. 확장이 맞출 때 Chrome이 호스트를 띄우고, 호스트는 잠금 안에서 공유 트리에 변경을 병합한 뒤 최신 트리를 돌려주고 끝난다. 호스트 이름은 `com.chromebookmarksync.host`다.
- **처음 만들기**: 공유 트리가 없으면 `hub/config.json`의 `masterEmail` 프로필의 북마크로 만든다. 다른 프로필은 처음 맞출 때 공유 트리로 덮어써진다.

## 설치

1. **백업**: `npm run backup`을 실행한다. 모든 프로필의 `Bookmarks`·`AccountBookmarks` 파일이 `backups/<시각>/`에 복사된다.
2. **설정**: `hub/config.example.json`을 `hub/config.json`으로 복사하고 채운다. `config.json`은 git에 올라가지 않는다.

   ```json
   {
     "masterEmail": "main@example.com",
     "extensionId": "cchkhligdoboaipldlkkjjdfpmieomcd",
     "excludeEmails": []
   }
   ```

   - `masterEmail`: 처음 공유 트리를 만들 프로필의 Google 계정
   - `extensionId`: manifest의 `key`로 고정된 값이다. 그대로 둔다.
   - `excludeEmails`: 동기화하지 않을 프로필의 Google 계정([예외 프로필](#예외-프로필))
3. **호스트 등록**: PowerShell에서 `powershell -ExecutionPolicy Bypass -File scripts\install-host.ps1`을 실행한다(관리자 권한 불필요). 하는 일은 세 가지다.
   - `hub/native/host.bat`를 만든다(node 절대 경로로 `hub/host.js`를 부르는 래퍼).
   - `hub/native/com.chromebookmarksync.host.json`을 만든다(`allowed_origins`는 `extensionId`).
   - `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.chromebookmarksync.host`에 등록한다.

   node 경로나 저장소 위치가 바뀌면 다시 실행한다.
4. **확장 설치**: 메인 프로필(`masterEmail` 계정)에 **먼저** 설치하고, 이어서 나머지 프로필에 설치한다.
   - `chrome://extensions` → 오른쪽 위 「개발자 모드」 켜기 → 「압축해제된 확장 프로그램 로드」 → `extension` 폴더를 선택한다.
   - 메인보다 먼저 설치한 프로필은 메인의 첫 동기화를 기다린다(배지 `…`).
5. **확인**: `npm run host:status`. 프로필마다 `clients`에 한 줄씩 생기고 `result`가 `ok`이면 된다.

### 1.x(WebSocket 허브)에서 옮길 때

1. `npm run backup`을 실행하고, `hub/data/state.json`도 따로 복사해 둔다.
2. 허브를 멈추고 자동 시작을 해제한다: `Unregister-ScheduledTask -TaskName ChromeBookmarkSyncHub -Confirm:$false`
3. `node hub/host.js --import-state`. 허브의 `state.json`이 `shared.json`(version 1)으로 옮겨진다. 이미 `shared.json`이 있으면 거부한다.
4. 위 설치 3단계(호스트 등록)를 한다.
5. 각 프로필의 `chrome://extensions`에서 이 확장을 「새로고침」한다. 1.x에는 자동 다시 읽기가 없어서 이번 한 번은 직접 해야 한다. 각 프로필의 대응표(gid→로컬 ID)를 그대로 이어 쓰므로 다시 덮어써지지 않는다.

`hub/data/state.json`은 지우지 않는다. `shared.json`이 없는데 `state.json`이 있으면 호스트가 메인 프로필의 새 초기화를 거부한다(`migrate-first`). 실수로 메인 트리로 다시 만들어 모든 프로필이 덮어써지는 사고를 막는 장치다.

## 언제 맞추나

| 시점 | 동작 |
|---|---|
| 북마크를 고친 뒤 1초 | 내 변경을 공유 파일에 올린다(가져오기 중에는 끝난 뒤 한 번). |
| 이 프로필의 창으로 전환 | 0.3초 뒤 맞춘다. 같은 프로필의 창끼리 전환하면 2초 안에는 건너뛴다. |
| 프로필을 열 때, 5분마다 | 맞춘다. |
| 팝업 「지금 맞추기」 | 바로 맞춘다. |

변경이 없으면 호스트는 트리를 보내지 않고 version만 확인한다. 그래서 창을 자주 바꿔도 부담이 거의 없다. 실측으로 창 전환부터 호스트 호출까지 0.3~0.6초가 걸린다.

## 배지와 팝업

| 배지 | 뜻 | 할 일 |
|---|---|---|
| 없음 | 맞춰짐 | |
| `…` | 맞추는 중, 아직 맞추지 못함, 또는 메인의 첫 동기화를 기다림 | |
| `OFF` | 호스트 호출 실패 | [문제 해결](#문제-해결) |
| `!` | 확인 필요: 대량 삭제 보호로 멈춤, 또는 호스트와 확장의 규약(PROTOCOL)이 다름 | 팝업을 연다 |
| `?` | 공유 기준으로 맞춰도 같은 차이가 계속 남음(5번 넘게) | 팝업의 오류를 확인하고 「공유 기준으로 적용」 |
| `EX`(회색) | 동기화 예외 프로필 | |

배지는 위에서부터 우선한다. 규약 불일치 `!`가 가장 앞서고, 그다음이 `EX`, 대량 삭제 `!`, `OFF`, `?`, `…` 순이다.

팝업 버튼:

- **지금 맞추기**: 바로 맞춘다.
- **공유 기준으로 적용**: 들어오는 쪽 보호로 멈췄거나 `?`일 때 보인다. 이 프로필을 공유 트리로 덮어쓴다.
- **공유 기준으로 되돌리기** / **다른 프로필에도 반영**: 나가는 쪽 보호로 멈췄을 때 보인다. 되돌리기는 이 프로필에서 지운 것을 되살린다. 반영은 그 삭제를 모든 프로필에 퍼뜨린다.

팝업에는 이 밖에 계정, 호스트 상태, 공유 version, 마지막으로 맞춘 시각, 마지막 오류가 보인다. 다른 프로필이 지운 폴더 안에 새로 만든 북마크를 구조했으면 그 안내도 나온다.

## 병합 규칙과 보호 장치

- **동시에 같은 북마크를 고치면** 나중에 맞춘 쪽이 이긴다.
- **수정·이동과 삭제가 부딪치면** 삭제가 이긴다.
- **다른 프로필이 지운 폴더 안에 새 북마크를 만들었으면** 「기타 북마크」 끝으로 옮겨 살린다.
- **대량 삭제 보호(양방향)**: 한 번에 지우는 북마크가 20개 이상이고 전체의 30%를 넘으면 적용을 멈추고 배지 `!`를 띄운다.
  - 들어오는 쪽: 공유 트리로 맞추면 이 프로필에서 많이 지워지는 경우다. 맞다면 「공유 기준으로 적용」을 누른다.
  - 나가는 쪽: 이 프로필에서 많이 지운 것으로 보이는 경우다. 대응표가 깨졌거나 Google 계정 동기화가 프로필을 갈아엎었을 때, 공유 트리를 거쳐 모든 프로필이 지워지는 것을 막는다. 「다른 프로필에도 반영」으로 확정하거나 「공유 기준으로 되돌리기」를 고른다.
  - 「다른 프로필에도 반영」으로 확정한 삭제는 공유 파일에 최근 5건까지 기록된다. 다른 프로필은 그 삭제를 받을 때 들어오는 쪽 보호에 걸리지 않는다.
  - 오래 맞추지 않은 프로필에는 다른 프로필들의 정상 삭제가 쌓여서 한꺼번에 들어온다. 그래서 들어오는 쪽 보호에 걸릴 수 있다. 의도된 동작이므로 내용을 확인하고 「공유 기준으로 적용」을 누른다.
- **멈춘 동안**에는 창 전환·5분 알람·북마크 이벤트로는 맞추지 않는다. 프로필을 다시 열거나, 「지금 맞추기」를 누르거나, 가져오기가 끝나면 다시 판정한다.
- **로컬 ID 유지**: 다른 프로필에서 옮긴 북마크는 받는 프로필에서도 지웠다 다시 만들지 않고 옮긴다. 다만 같은 위치의 폴더가 북마크로(또는 반대로) 바뀐 경우, 그 안에서 뒤쪽으로 옮겨진 노드는 새로 만들어진다.

## 알아둘 점

- 프로필 창이 닫혀 있으면 확장이 돌지 않는다. 그 프로필은 다음에 열 때 맞춰진다.
- 각 프로필이 자기 Google 계정과 북마크를 동기화 중이면, 바뀐 북마크가 그 계정(다른 기기 포함)에도 올라간다. 덮어쓰기도 마찬가지다.
- Chrome(157·158에서 확인)은 비어 있는 「모바일 북마크」 폴더를 확장에 보여 주지 않는다. 그런 프로필에는 모바일 북마크가 전파되지 않으므로 모바일 폴더는 쓰지 않는다.

## 예외 프로필

특정 프로필만 동기화에서 빼려면 `hub/config.json`의 `excludeEmails`에 그 프로필의 Google 계정을 적는다. 대소문자는 구분하지 않는다. 호스트가 요청마다 설정을 읽으므로 Chrome을 다시 시작할 필요는 없다. 다음에 맞출 때부터 적용된다.

```json
"excludeEmails": ["sub@example.com"]
```

- 그 프로필의 배지는 회색 `EX`가 된다. 다른 프로필의 변경을 받지 않고, 그 프로필의 변경도 올라가지 않는다. 호스트는 `shared.json`을 건드리지 않고 `host.log`에 `excluded <email>`만 남긴다.
- 목록에서 빼면 새로 설치한 프로필처럼 공유 트리로 덮어쓴다. **예외 기간에 그 프로필에서 바꾼 것은 사라진다.** 이때 들어오는 쪽 보호는 걸리지 않는다. 공유 트리와 같은 노드는 로컬 ID가 그대로 유지된다.
- Google에 로그인하지 않은 프로필은 이메일이 없어서 지정할 수 없다. 그런 프로필에는 확장을 설치하지 않는다.
- `masterEmail`을 넣으면 무시된다(`host.log`에 `config: masterEmail is in excludeEmails, ignored`).

## 상태 확인과 로그

- `npm run host:status`: 공유 트리의 version, 노드 수, 프로필별 `clients`를 보여 준다. `clients`에는 email, 확장 version, protocol, 마지막으로 맞춘 시각, result(`ok`·`blocked`·`stuck`)가 있다. `diskVersion`은 디스크의 `extension/manifest.json` version이다.
- `hub/data/host.log`: 호스트 로그다(5MB가 넘으면 `.old`로 돌린다). 호스트는 stdout에 로그를 쓰지 않는다. stdout에 메시지가 아닌 바이트가 섞이면 Chrome이 연결을 끊기 때문이다.

## 문제 해결

| 증상 | 원인과 조치 |
|---|---|
| 배지 `OFF`, 팝업 「호출 실패」 | 호스트 등록이 없거나 깨졌다. `scripts\install-host.ps1`을 다시 실행하고, 레지스트리 키와 `hub/native/`의 두 파일을 확인한다. 등록이 정상이면 `hub/data/host.log`를 본다. |
| 배지 `!`, 팝업 「확장 새로고침 필요」 | 호스트와 확장의 PROTOCOL이 다르다. 그 프로필의 `chrome://extensions`에서 확장을 「새로고침」한다. |
| 배지 `?` | 공유 트리를 적용해도 같은 차이가 남는다(예: 관리 정책으로 고칠 수 없는 북마크). 팝업의 오류와 `host.log`를 확인한 뒤 「공유 기준으로 적용」을 누른다. |
| 팝업 오류 「공유 파일이 아직 없습니다 — … --import-state …」 | `shared.json`이 없고 `state.json`만 있다(`migrate-first`). `node hub/host.js --import-state`를 실행한다. |
| 팝업 오류 「공유 파일 잠금 대기 시간 초과」 | 5초 동안 잠금을 얻지 못했다. 다음 트리거에 다시 한다. 30초가 넘은 잠금 파일(`shared.json.lock`)은 남은 찌꺼기로 보고 자동으로 지운다. |
| 확장 「오류」 버튼에 `WebSocket … ERR_CONNECTION_REFUSED` | 1.x 코드가 남긴 기록이다. 새로고침한 뒤에도 남는다. 「모두 삭제」로 지운다. |
| 확장 코드를 고쳤는데 옛 동작 | [버전 올리기](#버전-올리기)를 따랐는지 확인한다. `npm run host:status`에서 그 프로필의 `version`을 본다. |

## 복원

### 공유 트리를 날짜별 백업으로 되돌리기

`hub/data/backups/shared-YYYY-MM-DD.json`에 그날 처음 저장된 공유 트리가 30일치 남는다.

1. Chrome 창을 모두 닫는다.
2. 저장소 폴더에서 아래 명령을 실행한다. 지금 `shared.json`을 `shared.json.before-restore`로 보관하고, 백업 내용을 **지금보다 큰 version**으로 씌운다.

   ```
   node -e "const fs=require('fs'),f='hub/data/shared.json',cur=JSON.parse(fs.readFileSync(f)),b=JSON.parse(fs.readFileSync(process.argv[1]));fs.copyFileSync(f,f+'.before-restore');b.version=cur.version+1;b.clients=cur.clients;b.updatedAt=new Date().toISOString();b.updatedBy='restore';delete b.confirmed;fs.writeFileSync(f,JSON.stringify(b));console.log('restored as version',b.version)" hub/data/backups/shared-YYYY-MM-DD.json
   ```

   파일을 그냥 복사하면 안 된다. 백업의 version은 지금보다 작다. 그 뒤 다시 올라가는 version 번호가, 어떤 프로필이 예전에 받아 둔 기준점 번호와 겹칠 수 있다. 그러면 그 프로필은 「이미 최신」으로 보고 복원을 받지 않는다.
3. 프로필을 하나씩 연다. 각 프로필은 복원된 트리로 맞춰진다. 많이 지워지는 프로필은 `!`로 멈추므로, 내용을 확인하고 「공유 기준으로 적용」을 누른다.

### 프로필의 Bookmarks 파일로 되돌리기

공유 백업보다 오래된 시점으로 돌아가야 할 때 쓴다.

1. Chrome 창을 모두 닫는다.
2. `backups/<시각>/<프로필 폴더>/Bookmarks`(Profile 11~15처럼 계정 북마크만 쓰는 프로필은 `AccountBookmarks`)를 `%LOCALAPPDATA%\Google\Chrome\User Data\<프로필 폴더>\`로 복사한다.
3. 그 프로필을 연다. 기준점과 다른 부분은 이 프로필의 변경으로 공유 트리에 올라가 다른 프로필로 퍼진다. 많이 지우는 쪽이면 `!`로 멈춘다. 그때 「다른 프로필에도 반영」으로 확정한다.

## 버전 올리기

Chrome은 디스크의 확장 코드가 바뀌어도, 다시 읽기 전까지 옛 코드를 계속 돌린다. 닫혀 있던 프로필을 열 때도 manifest는 디스크에서 새로 읽지만, 서비스 워커는 옛 캐시 코드로 띄운다.

1. **`extension/manifest.json`의 `version`과 `extension/shared.js`의 `CODE_VERSION`을 함께 올린다.** 두 값이 다르면 테스트가 실패한다.
   - 다시 읽을지는 `CODE_VERSION`(실제로 도는 코드의 버전)과 호스트가 알려 주는 `diskVersion`(디스크의 manifest)을 비교해서 정한다. `getManifest().version`은 옛 코드가 돌 때도 새 값을 돌려주므로 비교 기준으로 쓸 수 없다.
2. 확장↔호스트 요청 형식이 바뀌었으면 `shared.js`의 `PROTOCOL`도 올린다.
3. 각 프로필은 다음에 맞출 때 디스크가 더 새 버전인 것을 알고 스스로 다시 읽는다(같은 diskVersion에는 한 번만). 닫혀 있던 프로필은 열 때 그렇게 된다.
4. `npm run host:status`에서 모든 프로필의 `version`이 새 값인지 확인한다.

자동 다시 읽기는 `CODE_VERSION`으로 비교하는 2.0.2부터 확실히 동작한다. 그보다 옛 코드가 돌고 있으면 `chrome://extensions`에서 직접 「새로고침」한다.

## 제거

1. 각 프로필의 `chrome://extensions`에서 확장을 삭제한다.
2. 호스트 등록을 지운다.

   ```
   Remove-Item 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.chromebookmarksync.host'
   Remove-Item -Recurse -Force hub\native
   ```

## 개발

- `npm test`: 가짜 `chrome.bookmarks`(Chrome의 이동 위치 규칙과 이벤트 순서를 흉내 냄)와 실제 호스트 코드(`handleRequest`)로 여러 프로필을 시뮬레이션한다. `host.test.js`는 `node hub/host.js`를 실제로 띄워 프레이밍, 출처 확인, 동시 쓰기를 확인한다.
- `extension/shared.js`는 호스트도 가져다 쓴다. 직렬화 형식은 이 파일 한 곳에서만 고친다.
- 호스트 이름 `com.chromebookmarksync.host`는 `scripts/install-host.ps1`과 `extension/shared.js`(`HOST_NAME`) 두 곳에 있다. 바꿀 때는 함께 바꾼다.
- 설계와 결정 근거: [docs/native-messaging-design.md](docs/native-messaging-design.md)
