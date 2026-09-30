// npm が node-pty の prebuilt spawn-helper を実行ビットなしで展開することがあり、
// その場合 pty.spawn() が "posix_spawnp failed" で落ちるため付け直す。
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const ptyRoot = dirname(require.resolve('node-pty/package.json'));

const candidates = [join(ptyRoot, 'build', 'Release', 'spawn-helper')];
const prebuilds = join(ptyRoot, 'prebuilds');
if (existsSync(prebuilds)) {
  for (const platform of readdirSync(prebuilds)) {
    candidates.push(join(prebuilds, platform, 'spawn-helper'));
  }
}

for (const file of candidates) {
  if (existsSync(file)) {
    chmodSync(file, 0o755);
    console.log(`chmod +x ${file}`);
  }
}
