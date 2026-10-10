import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { StatusLineInfo } from '@shared/statusline';
import type { UsageLimits } from '@shared/usage';

// Claude Code が持っているもの（~/.claude.json の利用枠の控えとログインしたアカウント・~/.claude/cache のモデルの一覧・claude --version）の読み取り。
// どれも読み込んだときにホームを決めるので、使い捨てのホームに差し替えてから読み込む。claude は、版を答えるだけの偽物にする

let home: string;
let bin: string;
const oldHome = process.env.HOME;
const oldPath = process.env.PATH;
let catalog: typeof import('../src/main/model-catalog');
let version: typeof import('../src/main/claude-version');
let usage: typeof import('../src/main/usage-monitor');
let account: typeof import('../src/main/claude-account');
let config: typeof import('../src/main/claude-config');
let session: typeof import('../src/main/claude-session');

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
  account = await import('../src/main/claude-account');
  config = await import('../src/main/claude-config');
  session = await import('../src/main/claude-session');
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

describe('ログインしたアカウント（readClaudeAccount）', () => {
  const write = (json: unknown) => writeFileSync(join(home, '.claude.json'), typeof json === 'string' ? json : JSON.stringify(json));

  it('~/.claude.json の oauthAccount から、メールアドレス・組織・プランを読む', async () => {
    write({
      oauthAccount: { accountUuid: 'u', emailAddress: 'taro@corp.example', organizationName: 'Acme', planDisplayName: 'Claude Team', billingType: 'x' },
    });
    expect(await account.readClaudeAccount()).toEqual({ email: 'taro@corp.example', organization: 'Acme', plan: 'Claude Team' });
    // 無い項目・空の項目・文字でない項目は null にする
    write({ oauthAccount: { emailAddress: ' taro@example.com ', organizationName: '', planDisplayName: 3 } });
    expect(await account.readClaudeAccount()).toEqual({ email: 'taro@example.com', organization: null, plan: null });
  });

  it('planDisplayName が無ければ（今の Claude Code は書かない）、組織の種類からプランの名前を作る。Max は利用枠の段から倍率も付ける', async () => {
    const plan = async (oauth: Record<string, unknown>) => {
      write({ oauthAccount: { emailAddress: 'taro@example.com', ...oauth } });
      return (await account.readClaudeAccount())?.plan;
    };
    // 2.1.296 の .claude.json の形（Max・Team）
    expect(await plan({ organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_20x', userRateLimitTier: null })).toBe('Claude Max 20x');
    expect(await plan({ organizationType: 'claude_team', organizationRateLimitTier: 'default_raven', userRateLimitTier: 'default_claude_max_5x', seatTier: 'team_tier_1' })).toBe('Claude Team');
    expect(await plan({ organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_5x' })).toBe('Claude Max 5x');
    // 段が無い・読めない形なら、倍率は付けない
    expect(await plan({ organizationType: 'claude_max' })).toBe('Claude Max');
    expect(await plan({ organizationType: 'claude_max', organizationRateLimitTier: 'default_raven' })).toBe('Claude Max');
    expect(await plan({ organizationType: 'claude_pro', organizationRateLimitTier: 'default_claude_ai' })).toBe('Claude Pro');
    expect(await plan({ organizationType: 'claude_enterprise' })).toBe('Claude Enterprise');
    // planDisplayName があれば、そちらを使う
    expect(await plan({ organizationType: 'claude_max', planDisplayName: 'Claude Team' })).toBe('Claude Team');
    // プランとして読めない種類は出さない
    for (const organizationType of ['api', 'claude_', 'claude', '', 3, null]) expect(await plan({ organizationType }), String(organizationType)).toBeNull();
  });

  it('ログインしていない・形が違う・ファイルが無いときは null', async () => {
    write({ numStartups: 1 });
    expect(await account.readClaudeAccount()).toBeNull();
    write({ oauthAccount: { organizationName: 'Acme' } });
    expect(await account.readClaudeAccount()).toBeNull();
    write({ oauthAccount: 'x' });
    expect(await account.readClaudeAccount()).toBeNull();
    write('{');
    expect(await account.readClaudeAccount()).toBeNull();
    expect(await account.readClaudeAccount(join(home, 'missing.json'))).toBeNull();
  });
});

describe('Claude Code の設定のフォルダ（CLAUDE_CONFIG_DIR）', () => {
  afterEach(() => {
    process.env.CLAUDE_CONFIG_DIR = '';
  });

  it('無ければ ~/.claude と ~/.claude.json。会話ログはフォルダの英数字以外を - にした名前の下', () => {
    expect(config.claudeConfigDir()).toBe(join(home, '.claude'));
    expect(config.claudeJsonPath()).toBe(join(home, '.claude.json'));
    expect(session.transcriptPath('/Users/me/my app', 'abc')).toBe(join(home, '.claude', 'projects', '-Users-me-my-app', 'abc.jsonl'));
  });

  it('あれば、設定・会話ログ・.claude.json をすべてその中から読む（Claude Code と同じ）', async () => {
    const dir = join(home, 'work-profile');
    mkdirSync(dir, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = dir;
    expect(config.claudeConfigDir()).toBe(dir);
    expect(config.claudeJsonPath()).toBe(join(dir, '.claude.json'));
    expect(session.transcriptPath('/w', 'abc')).toBe(join(dir, 'projects', '-w', 'abc.jsonl'));
    // ホームの .claude.json ではなく、そのフォルダの中のものを読む
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'home@example.com' } }));
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'work@corp.example' } }));
    expect((await account.readClaudeAccount())?.email).toBe('work@corp.example');
  });

  it('プロファイルの設定のフォルダを渡すと、環境変数よりそちらを使い、起動する Claude Code・シェルにも CLAUDE_CONFIG_DIR として渡す', () => {
    process.env.CLAUDE_CONFIG_DIR = join(home, 'from-env');
    const dir = join(home, '.claude-work');
    expect(config.claudeConfigDir(dir)).toBe(dir);
    expect(config.claudeJsonPath(dir)).toBe(join(dir, '.claude.json'));
    expect(session.transcriptPath('/w', 'abc', dir)).toBe(join(dir, 'projects', '-w', 'abc.jsonl'));
    expect(session.childEnv(dir).CLAUDE_CONFIG_DIR).toBe(dir);
    // 既定のプロファイル（null）は、アプリの環境変数のまま
    expect(config.claudeConfigDir(null)).toBe(join(home, 'from-env'));
    expect(session.childEnv().CLAUDE_CONFIG_DIR).toBe(join(home, 'from-env'));
  });
});
