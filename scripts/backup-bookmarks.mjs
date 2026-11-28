// 모든 Chrome 프로필의 북마크 파일(Bookmarks, 계정 북마크만 쓰는 프로필의 AccountBookmarks)을 backups/<시각>/<프로필폴더>/ 에 복사한다.
// 첫 동기화(메인 프로필로 덮어쓰기) 전에 반드시 한 번 실행한다. 복원 방법은 README 참고.
import fs from 'node:fs';
import path from 'node:path';

const userData = path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const out = path.join(import.meta.dirname, '..', 'backups', stamp);

const localState = JSON.parse(fs.readFileSync(path.join(userData, 'Local State'), 'utf8'));
const info = localState.profile?.info_cache || {};

const summary = {};
for (const dir of Object.keys(info)) {
  summary[dir] = { name: info[dir].name, user: info[dir].user_name, files: [] };
  for (const f of ['Bookmarks', 'Bookmarks.bak', 'AccountBookmarks', 'AccountBookmarks.bak']) {
    const src = path.join(userData, dir, f);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(path.join(out, dir), { recursive: true });
    fs.copyFileSync(src, path.join(out, dir, f));
    summary[dir].files.push(f);
  }
}
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'profiles.json'), JSON.stringify(summary, null, 2));
console.log(out);
for (const [dir, s] of Object.entries(summary)) console.log(`  ${dir.padEnd(11)} ${s.user.padEnd(28)} ${s.files.join(', ') || '(북마크 없음)'}`);
