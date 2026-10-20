import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { mergeInventories, type Inventory } from '../transcript-inventory';

// npm run test:cli の始めと終わり。台本ごとの目録（ClaudeRun の stop が置く。TANACODE_RECORD=1 のとき）を、全部の台本が終わったら
// 1 つにまとめて、確かめた Claude Code のバージョンの控え（test/fixtures/claude-code/<バージョン>/inventory.json）に書く。
// 目録は、全部の台本が通ったときだけ書く（一部の台本だけ・落ちた台本があるときの目録は、比べると、無い種類が消えたように見えるため）

declare module 'vitest' {
  export interface ProvidedContext {
    // 台本ごとの目録を置くフォルダ
    inventoryDir: string;
  }
}

export default function setup(project: TestProject): () => Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'tanacode-inventory-'));
  project.provide('inventoryDir', dir);
  return async () => {
    try {
      if (process.env.TANACODE_RECORD) await writeInventory(project, dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

async function writeInventory(project: TestProject, dir: string): Promise<void> {
  const { testFiles } = await project.globTestFiles();
  const ran = new Set(project.vitest.state.getFilepaths());
  const missing = testFiles.filter((file) => !ran.has(file));
  const failed = project.vitest.state.getFailedFilepaths();
  if (missing.length > 0 || failed.length > 0) {
    console.warn(`目録は書きません（流していない台本: ${missing.length}・落ちた台本: ${failed.length}）`);
    return;
  }
  const parts = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as Inventory);
  const claude = process.env.TANACODE_CLAUDE_BIN || 'claude';
  const version = execFileSync(claude, ['--version'], { encoding: 'utf8' }).match(/\d+\.\d+\.\d+/)?.[0];
  if (!version || parts.length === 0) return;
  const out = join(__dirname, '..', 'fixtures', 'claude-code', version);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'inventory.json'), `${JSON.stringify(mergeInventories(parts), null, 2)}\n`);
}
