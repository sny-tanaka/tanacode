// electron-builder を、署名の証明書を選んでから動かす（npm run dist・release から使う）。
// 自己署名の証明書「tanacode Code Signing」が、信頼された状態でキーチェーンに入っていれば、それで署名する。
// ビルドしても署名の要件が変わらないので、macOS が同じアプリとして扱い、許可（フォルダ・通知など）が残る。作り方は CONTRIBUTING.md の「署名」。
// 無ければ ad-hoc で署名する（ビルドごとに別のアプリとして扱われる）。
// --require を付けたら（配布用のビルド）、証明書が無いときは失敗にする。--check を付けたら、証明書を確かめるだけで終わる。
// ほかの引数は、そのまま electron-builder に渡す
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const IDENTITY_NAME = 'tanacode Code Signing';
const args = process.argv.slice(2);
const required = args.includes('--require');
const checkOnly = args.includes('--check');
const builderArgs = args.filter((arg) => arg !== '--require' && arg !== '--check');

// キーチェーンにある証明書の SHA-1（40 桁）。-v を付けないと、信頼されていないものも出る
function findHash(valid) {
  if (process.platform !== 'darwin') return null;
  try {
    const out = execFileSync('security', ['find-identity', ...(valid ? ['-v'] : []), '-p', 'codesigning'], { encoding: 'utf8' });
    return out.match(new RegExp(`^\\s*\\d+\\) ([0-9A-F]{40}) "${IDENTITY_NAME}"`, 'm'))?.[1] ?? null;
  } catch {
    return null;
  }
}

const hash = findHash(true);
if (hash) {
  console.log(`署名: ${IDENTITY_NAME}（${hash}）`);
} else {
  const reason = findHash(false)
    ? `証明書「${IDENTITY_NAME}」はありますが、コード署名として信頼されていません`
    : `証明書「${IDENTITY_NAME}」がキーチェーンにありません`;
  if (required) {
    console.error(`署名できません: ${reason}（CONTRIBUTING.md の「署名」を見てください）`);
    process.exit(1);
  }
  console.warn(`署名: ad-hoc（${reason}。ビルドごとに別のアプリとして扱われます）`);
}
if (checkOnly) process.exit(0);

// identity の "-" は ad-hoc。証明書は、名前の重なりを避けて SHA-1 で指す
const result = spawnSync(join(root, 'node_modules/.bin/electron-builder'), [...builderArgs, `-c.mac.identity=${hash ?? '-'}`], { stdio: 'inherit' });
process.exit(result.status ?? 1);
