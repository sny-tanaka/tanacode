import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { COVERAGE_RAW } from './app';

// npm run coverage:e2e のときは、前に集めたものを消してから始め、終わったら src の行に戻して coverage/e2e に書く
// （落ちたテストがあっても、ほかのテストで通ったところは数える）
export default function setup(): (() => void) | undefined {
  if (process.env.TANACODE_E2E_COVERAGE !== '1') return undefined;
  rmSync(COVERAGE_RAW, { recursive: true, force: true });
  return () => {
    execFileSync(process.execPath, [join(__dirname, '..', '..', 'scripts', 'e2e-coverage.mjs')], { stdio: 'inherit' });
  };
}
