import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as pty from 'node-pty';
import { afterAll, describe, expect, it } from 'vitest';
import { CLAUDE_BIN, claudeVersion } from './claude-run';
import { MockApi, usageLimitFailure, type ApiFailure, type Block } from './mock-api';

// ターミナルモード（TUI）のターンの終わりの、会話ログの行。アプリは、TUI のターンの終わりを、書くだけの Stop のフックではなく、
// 会話ログのターンの終わりの行（turn_duration）で知る（session-manager.ts の tuiStopHook・tuiEntry）。それが書かれることに頼っているので、
// - 一緒に動くチェックリストの Stop のフックが続けさせたターン: Stop のフックは 2 回動くが、turn_duration は続きを終えたあとに 1 回だけ
// - API エラーで終わったターン（529 の再試行をあきらめた・400・プランの利用枠の上限）: Stop のフックは動かないが、エラーの行
//   （isApiErrorMessage の応答）のあとに turn_duration が書かれる
// を確かめる。アプリの道（ClaudeRun）では TUI に発言を送れない（キーは押さない。決めたこと）ので、ここだけは TUI を node-pty で直に起動し、
// 最初の発言を起動の引数で渡す。画面は読まず、会話ログの行だけを見る
const API_KEY = 'sk-ant-api03-tanacode-cli-check-00000000000000000000';
// プランの利用枠の知らせは、OAuth のトークンで動いているときだけ Claude Code が読む（claude-run.ts の oauth と同じ偽物）
const OAUTH_TOKEN = 'sk-ant-oat01-tanacode-cli-check-00000000000000000000';
const say = (text: string): Block[] => [{ type: 'text', text }];
const TURN_END = 'ターンの終わり';

type Line = { type: string; subtype?: string; message?: { content?: unknown }; hookAdditionalContext?: unknown; isApiErrorMessage?: boolean; apiError?: unknown };

const roots: string[] = [];
const procs: pty.IPty[] = [];
const apis: MockApi[] = [];

afterAll(async () => {
  for (const proc of procs) proc.kill();
  await Promise.all(apis.map((api) => api.stop()));
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// TUI を起動して、prompt を最初の発言として渡す。会話ログのうち、応答・API エラー・Stop のフックの要約・ターンの終わりの行を、
// 書かれた順に返す関数を返す（会話ログは書き足すだけなので、読むたびに前から同じ並び）。
// stopHook: Stop のフック（settings.json に入れる）/ failure: 最初の応答の代わりに返す API エラー / oauth: OAuth のトークンで動かす
async function startTui(prompt: string, steps: Block[][], { stopHook, failure, oauth = false }: { stopHook?: string; failure?: ApiFailure; oauth?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tanacode-cli-turn-end-')));
  roots.push(root);
  const home = join(root, 'home');
  const cwd = join(root, 'work');
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
  if (stopHook) writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: stopHook, timeout: 10 }] }] } }));
  const api = new MockApi();
  apis.push(api);
  api.conversations = [{ match: prompt, steps, ...(failure ? { failures: { 0: failure } } : {}) }];
  const baseUrl = await api.start();
  const id = randomUUID();
  procs.push(
    pty.spawn(CLAUDE_BIN, ['--session-id', id, prompt], {
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
        ...(oauth ? { CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN } : { ANTHROPIC_API_KEY: API_KEY }),
        NO_PROXY: '127.0.0.1,localhost',
        DISABLE_AUTOUPDATER: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        // 529 の再試行を短くする（既定では 10 回まで、待ち時間を延ばしながら再試行する）
        CLAUDE_CODE_MAX_RETRIES: '2',
      },
    }),
  );
  return (): string[] => {
    const dir = join(home, '.claude', 'projects');
    const folder = existsSync(dir) ? readdirSync(dir).find((d) => existsSync(join(dir, d, `${id}.jsonl`))) : undefined;
    if (!folder) return [];
    return readFileSync(join(dir, folder, `${id}.jsonl`), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((text) => JSON.parse(text) as Line)
      .flatMap((e) => {
        if (e.type === 'assistant' && e.isApiErrorMessage) return [`API エラー: ${String(e.apiError ?? '')}`];
        if (e.type === 'assistant') return [`応答: ${JSON.stringify(e.message?.content)}`];
        if (e.type === 'system' && e.subtype === 'stop_hook_summary') return [`Stop のフック: ${JSON.stringify(e.hookAdditionalContext ?? [])}`];
        if (e.type === 'system' && e.subtype === 'turn_duration') return [TURN_END];
        return [];
      });
  };
}

// 最初のターンの終わりの行が書かれるまで待ち、そこまでの行を返す（会話ログは途中まで書かれた形でも、前から順に並ぶ）
async function untilTurnEnd(lines: () => string[]): Promise<string[]> {
  const until = Date.now() + 60_000;
  for (;;) {
    const seen = lines();
    const end = seen.indexOf(TURN_END);
    if (end !== -1) return seen.slice(0, end + 1);
    if (Date.now() > until) throw new Error(`ターンの終わりの行が書かれません: ${JSON.stringify(seen)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe(`Claude Code ${claudeVersion()} のターミナルモードのターンの終わり`, () => {
  it('Stop のフックが続けさせたターンでも、turn_duration は続きを終えたあとに 1 回だけ書かれる（最初の Stop では書かれない）', async () => {
    // 続きでない Stop（stop_hook_active が無い）だけ、チェックリストの Stop のフックと同じ形（additionalContext）で文を渡して続けさせる
    const stopHook = `case "$(cat)" in *'"stop_hook_active":true'*) exit 0;; esac; printf '%s\\n' '{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"Please continue once more."}}'`;
    const lines = await startTui('ターミナルモードの Stop のフックを確かめます', [say('作業を終えました'), say('続きを終えました')], { stopHook });
    expect(await untilTurnEnd(lines)).toEqual([
      `応答: ${JSON.stringify(say('作業を終えました'))}`,
      `Stop のフック: ${JSON.stringify(['Please continue once more.'])}`,
      `応答: ${JSON.stringify(say('続きを終えました'))}`,
      'Stop のフック: []',
      TURN_END,
    ]);
  }, 90_000);

  it('529 を返し続けて再試行をあきらめたターンも、エラーの行のあとに turn_duration が書かれる', async () => {
    const lines = await startTui('ターミナルモードで 529 を確かめます', [say('届かない返事')], { failure: { status: 529, errorType: 'overloaded_error', message: 'Overloaded' } });
    expect(await untilTurnEnd(lines)).toEqual(['API エラー: ', TURN_END]);
  }, 90_000);

  it('400 で終わったターンも、エラーの行のあとに turn_duration が書かれる', async () => {
    const lines = await startTui('ターミナルモードで 400 を確かめます', [say('届かない返事')], { failure: { status: 400, errorType: 'invalid_request_error', message: 'Bad request' } });
    expect(await untilTurnEnd(lines)).toEqual(['API エラー: ', TURN_END]);
  }, 90_000);

  it('プランの利用枠の上限で止まったターンも、エラーの行（usage_limit_reached）のあとに turn_duration が書かれる', async () => {
    const reset = Math.floor(Date.now() / 1000) * 1000 + 3 * 60 * 60_000;
    const lines = await startTui('ターミナルモードで利用枠を確かめます', [say('届かない返事')], { failure: usageLimitFailure(reset), oauth: true });
    expect(await untilTurnEnd(lines)).toEqual(['API エラー: usage_limit_reached', TURN_END]);
  }, 90_000);
});
