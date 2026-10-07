import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { COVERAGE_RAW } from './app';

// npm run coverage:e2e のときは、前に集めたものを消してから始め、終わったら src の行に戻して coverage/e2e に書く
// （落ちたテストがあっても、ほかのテストで通ったところは数える）。
// 戻すのには十秒ほどかかるので、別のプロセスで動かして待つ（同期で待つと、その間 vitest がテストのプロセスを片付けられない）
export default function setup(): (() => Promise<void>) | undefined {
  if (process.env.TANACODE_E2E_COVERAGE !== '1') return undefined;
  rmSync(COVERAGE_RAW, { recursive: true, force: true });
  return () =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(__dirname, '..', '..', 'scripts', 'e2e-coverage.mjs')], { stdio: 'inherit' });
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`scripts/e2e-coverage.mjs が失敗しました（${code}）`))));
    });
}
