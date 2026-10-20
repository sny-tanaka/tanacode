import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as pty from 'node-pty';
import { afterAll, describe, expect, it } from 'vitest';
import { CLAUDE_BIN, claudeVersion } from './claude-run';
import { MockApi, type Block } from './mock-api';

// ターミナルモード（TUI）で、Stop のフックが文を渡して続けさせたときの会話ログ。アプリは、TUI のターンの終わりを、書くだけの Stop の
// フックではなく、会話ログのターンの終わりの行（turn_duration）で知る（session-manager.ts の tuiStopHook・tuiEntry）。一緒に動く
// チェックリストの Stop のフックが続けさせると、Stop のフックは 2 回動くが、turn_duration は続きを終えたあとに 1 回だけ書かれることに頼っている。
// アプリの道（ClaudeRun）では TUI に発言を送れない（キーは押さない。決めたこと）ので、ここだけは TUI を node-pty で直に起動し、
// 最初の発言を起動の引数で渡す。画面は読まず、会話ログの行だけを見る
const PROMPT = 'ターミナルモードの Stop のフックを確かめます';
const API_KEY = 'sk-ant-api03-tanacode-cli-check-00000000000000000000';
const say = (text: string): Block[] => [{ type: 'text', text }];

type Line = { type: string; subtype?: string; message?: { content?: unknown }; hookAdditionalContext?: unknown };

describe(`Claude Code ${claudeVersion()} のターミナルモードの Stop のフック`, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tanacode-cli-stop-hook-')));
  const home = join(root, 'home');
  const cwd = join(root, 'work');
  const api = new MockApi();
  let proc: pty.IPty | null = null;

  afterAll(async () => {
    proc?.kill();
    await api.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it('フックが続けさせたターンでも、turn_duration は続きを終えたあとに 1 回だけ書かれる（最初の Stop では書かれない）', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    // 最初の案内・API キーの確認・フォルダの信頼の確認は済んだことにする
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        hasCompletedOnboarding: true,
        theme: 'dark',
        customApiKeyResponses: { approved: [API_KEY.slice(-20)], rejected: [] },
        projects: { [cwd]: { hasTrustDialogAccepted: true } },
      }),
    );
    // 続きでない Stop（stop_hook_active が無い）だけ、チェックリストの Stop のフックと同じ形（additionalContext）で文を渡して続けさせる
    const hook = `case "$(cat)" in *'"stop_hook_active":true'*) exit 0;; esac; printf '%s\\n' '{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"Please continue once more."}}'`;
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: hook, timeout: 10 }] }] } }));
    api.conversations = [{ match: PROMPT, steps: [say('作業を終えました'), say('続きを終えました')] }];
    const baseUrl = await api.start();
    const id = randomUUID();
    proc = pty.spawn(CLAUDE_BIN, ['--session-id', id, PROMPT], {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        LANG: 'en_US.UTF-8',
        TERM: 'xterm-256color',
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_API_KEY: API_KEY,
        NO_PROXY: '127.0.0.1,localhost',
        DISABLE_AUTOUPDATER: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    });
    // 会話ログのうち、応答・Stop のフックの要約・ターンの終わりの行（書かれた順。会話ログは書き足すだけなので、読むたびに前から同じ並び）
    const lines = (): string[] => {
      const dir = join(home, '.claude', 'projects');
      const folder = existsSync(dir) ? readdirSync(dir).find((d) => existsSync(join(dir, d, `${id}.jsonl`))) : undefined;
      if (!folder) return [];
      return readFileSync(join(dir, folder, `${id}.jsonl`), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((text) => JSON.parse(text) as Line)
        .flatMap((e) => {
          if (e.type === 'assistant') return [`応答: ${JSON.stringify(e.message?.content)}`];
          if (e.type === 'system' && e.subtype === 'stop_hook_summary') return [`Stop のフック: ${JSON.stringify(e.hookAdditionalContext ?? [])}`];
          if (e.type === 'system' && e.subtype === 'turn_duration') return ['ターンの終わり'];
          return [];
        });
    };
    // 最初のターンの終わりの行が書かれるまで待つ（会話ログは途中まで書かれた形でも、前から順に並ぶ）
    const until = Date.now() + 60_000;
    while (!lines().includes('ターンの終わり')) {
      if (Date.now() > until) throw new Error(`ターンの終わりの行が書かれません: ${JSON.stringify(lines())}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const seen = lines();
    const end = seen.indexOf('ターンの終わり');
    // 最初の Stop（続けさせた）のあとの続きの応答と、続きの Stop のあとに、はじめてターンの終わりが書かれる
    expect(seen.slice(0, end + 1)).toEqual([
      `応答: ${JSON.stringify([{ type: 'text', text: '作業を終えました' }])}`,
      `Stop のフック: ${JSON.stringify(['Please continue once more.'])}`,
      `応答: ${JSON.stringify([{ type: 'text', text: '続きを終えました' }])}`,
      'Stop のフック: []',
      'ターンの終わり',
    ]);
  }, 90_000);
});
