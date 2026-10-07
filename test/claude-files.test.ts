import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StatusLineInfo } from '@shared/statusline';
import type { UsageLimits } from '@shared/usage';

// Claude Code が持っているもの（~/.claude.json の利用枠の控え・~/.claude/cache のモデルの一覧・claude --version）の読み取り。
// どれも読み込んだときにホームを決めるので、使い捨てのホームに差し替えてから読み込む。claude は、版を答えるだけの偽物にする

let home: string;
let bin: string;
const oldHome = process.env.HOME;
const oldPath = process.env.PATH;
let catalog: typeof import('../src/main/model-catalog');
let version: typeof import('../src/main/claude-version');
let usage: typeof import('../src/main/usage-monitor');

// 偽の claude。CLAUDE_FAKE_VERSION の版を答える（無ければ失敗する）
function fakeClaude(): void {
  const file = join(bin, 'claude');
  writeFileSync(file, '#!/bin/sh\n[ -n "$CLAUDE_FAKE_VERSION" ] || exit 1\necho "$CLAUDE_FAKE_VERSION (Claude Code)"\n');
  chmodSync(file, 0o755);
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'tanacode-claude-files-'));
  bin = join(home, 'bin');
  mkdirSync(bin);
  fakeClaude();
  process.env.HOME = home;
  process.env.PATH = `${bin}:${oldPath}`;
  catalog = await import('../src/main/model-catalog');
  version = await import('../src/main/claude-version');
  usage = await import('../src/main/usage-monitor');
});
afterAll(() => {
  process.env.HOME = oldHome;
  process.env.PATH = oldPath;
  delete process.env.CLAUDE_FAKE_VERSION;
  rmSync(home, { recursive: true, force: true });
});

describe('claude --version', () => {
  it('版の数字だけを読む。claude が無い・失敗するときは null', async () => {
    process.env.CLAUDE_FAKE_VERSION = '2.1.300';
    expect(await version.claudeVersion()).toBe('2.1.300');
    delete process.env.CLAUDE_FAKE_VERSION;
    expect(await version.claudeVersion()).toBeNull();
  });

  it('ClaudeVersionMonitor: 版が変わったときだけ知らせ、確かめている途中の refresh は 1 回にまとめる', async () => {
    const changes: (string | null)[] = [];
    const monitor = new version.ClaudeVersionMonitor((v) => changes.push(v));
    process.env.CLAUDE_FAKE_VERSION = '2.1.300';
    const [a, b] = await Promise.all([monitor.refresh(), monitor.refresh()]);
    expect([a, b]).toEqual(['2.1.300', '2.1.300']);
    await monitor.refresh();
    expect(changes).toEqual(['2.1.300']);
    process.env.CLAUDE_FAKE_VERSION = '2.1.301';
    expect(await monitor.get()).toBe('2.1.300');
    await monitor.refresh();
    expect(changes).toEqual(['2.1.300', '2.1.301']);
  });
});

describe('モデルの一覧（~/.claude/cache/model-catalog）', () => {
  const dir = () => join(home, '.claude', 'cache', 'model-catalog');
  const write = (name: string, data: unknown, mtime: number) => {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(join(dir(), name), JSON.stringify(data));
    utimesSync(join(dir(), name), mtime, mtime);
  };

  it('控えが無ければ null', async () => {
    expect(await catalog.readModelCatalog()).toBeNull();
  });

  it('Claude Code 用（-cc.json）でいちばん新しい控えを読み、主なものを先に並べ、新しい Claude Code が要るものは選べなくする', async () => {
    process.env.CLAUDE_FAKE_VERSION = '2.1.290';
    write('org-old-cc.json', { fetchedAt: 1, catalog: { config: { models: [{ id: 'old', name: 'Old' }] } } }, 1000);
    write('org-web.json', { fetchedAt: 9, catalog: { config: { models: [{ id: 'web' }] } } }, 3000);
    write(
      'org-new-cc.json',
      {
        fetchedAt: 2,
        catalog: {
          config: {
            models: [
              { id: 'legacy', name: 'Legacy', section: 'overflow' },
              { id: 'opus', name: 'Opus', description: '最も賢い', thinking: { effort_options: [{ id: 'low' }, { id: 'high' }, {}] } },
              { id: 'next', name: 'Next', min_claude_code_version: '2.1.300' },
              { name: 'ID の無いもの' },
            ],
          },
        },
      },
      2000,
    );
    expect(await catalog.readModelCatalog()).toEqual({
      updatedAt: 2,
      choices: [
        { value: 'opus', name: 'Opus', detail: '最も賢い', disabled: false, efforts: ['low', 'high'] },
        { value: 'next', name: 'Next', detail: 'Claude Code 2.1.300 以上が必要（今は 2.1.290）', disabled: true, efforts: [] },
        { value: 'legacy', name: 'Legacy', detail: '', disabled: false, efforts: [] },
      ],
    });
  });
});

describe('利用枠（UsageMonitor）', () => {
  const info = (updatedAt: number, five: number): StatusLineInfo =>
    ({ updatedAt, rateLimits: { fiveHour: { percent: five, resetsAt: 100 }, sevenDay: { percent: 10, resetsAt: 200 } } }) as unknown as StatusLineInfo;

  it('statusLine から 5 時間枠と週の枠を受け取って保存し、古いものでは上書きしない', async () => {
    const file = join(home, 'usage.json');
    const changes: UsageLimits[] = [];
    const monitor = new usage.UsageMonitor(file, (u) => changes.push(u));
    monitor.fromStatusLine(info(2000, 40));
    monitor.fromStatusLine(info(1000, 99));
    expect(monitor.get()).toEqual({
      limits: [
        { label: '5時間', percent: 40, resetsAt: 100 },
        { label: '週', percent: 10, resetsAt: 200 },
      ],
      updatedAt: 2000,
      source: 'statusline',
    });
    expect(changes).toHaveLength(1);
    // 起動し直すと、保存したものから始める
    await new Promise((r) => setTimeout(r, 50));
    const restarted = new usage.UsageMonitor(file, () => {});
    await restarted.start();
    expect(restarted.get()?.updatedAt).toBe(2000);
  });

  it('Claude Code の控え（/usage を開いたときのもの）の方が新しければ、それを使う', async () => {
    const monitor = new usage.UsageMonitor(join(home, 'usage2.json'), () => {});
    monitor.fromStatusLine(info(2000, 40));
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        cachedUsageUtilization: {
          fetchedAtMs: 3000,
          utilization: { limits: [{ kind: 'session', percent: 55, resets_at: '2026-10-07T10:00:00Z' }, { kind: 'weekly_all', percent: 20, resets_at: null }] },
        },
      }),
    );
    await monitor.refresh();
    expect(monitor.get()).toEqual({
      limits: [
        { label: '5時間', percent: 55, resetsAt: Date.parse('2026-10-07T10:00:00Z') },
        { label: '週', percent: 20, resetsAt: null },
      ],
      updatedAt: 3000,
      source: 'claude-cache',
    });
    // 古い控えでは戻さない
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: 1, utilization: { limits: [{ kind: 'session', percent: 1 }] } } }));
    await monitor.refresh();
    expect(monitor.get()?.updatedAt).toBe(3000);
  });
});
