import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// PATH の先頭に置く、偽物の claude（中身はシェルのスクリプト）。本物の claude の無い CI でも、起動の仕方まで確かめる。
// 返す関数で PATH を戻し、偽物を消す
export function fakeClaudeOnPath(script: string): () => void {
  const dir = mkdtempSync(join(tmpdir(), 'tanacode-fake-claude-'));
  writeFileSync(join(dir, 'claude'), `#!/bin/sh\n${script}\n`);
  chmodSync(join(dir, 'claude'), 0o755);
  const before = process.env.PATH;
  process.env.PATH = `${dir}:${before ?? ''}`;
  return () => {
    process.env.PATH = before;
    rmSync(dir, { recursive: true, force: true });
  };
}
