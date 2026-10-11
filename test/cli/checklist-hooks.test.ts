import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STOP_ACTIONS_NONE, STOP_ACTIONS_OPEN } from '@shared/checklist-reminder';
import { CHECKLIST_REMINDER_TAG, checklistToolId } from '@shared/checklist-tools';
import { ChecklistControl } from '../../src/main/checklist-control';
import { ChecklistStore } from '../../src/main/checklist-store';
import { McpBridge } from '../../src/main/mcp-bridge';
import { buildRelay } from './browser-relay-build';
import { ClaudeRun, claudeVersion } from './claude-run';
import { MockApi, type Block } from './mock-api';

// 本物の claude をモックの API で動かし、チェックリストを使い続けさせるフック（src/main/checklist-hook.ts）を確かめる。
// アプリと同じ起動の引数（--settings の hooks）と環境変数で起動し、フック（src/main/checklist-mcp.ts をビルドしたものを --hook で動かす）が、
// アプリの代わりのソケットの先の ChecklistControl に聞いて、Claude Code に返すか。
// - 人が発言すると、今のチェックリストが Claude に渡る（UserPromptSubmit）
// - チェックリストに触れないまま作業がたまると、ターンの終わりが 1 回だけ止まり、理由が Claude に渡って続きが始まる（Stop）。
//   止めたあとの続きは止まらない。読むだけのターン・触れてから間もないターンは止まらない
// - /compact で会話を圧縮すると、今のチェックリストが渡る（SessionStart の compact）
// - どれも、チャットのフックの一覧には出ない

const WORK = 'チェックリストに触れずに作業してください';
const QUESTION = '質問に答えてください';
const MORE = '続きの作業をしてください';
const SMALL = '小さな直しをしてください';
const version = claudeVersion();
const say = (text: string): Block[] => [{ type: 'text', text }];

describe(`Claude Code ${version} とチェックリストを使い続けさせるフック`, () => {
  let api: MockApi;
  let bridge: McpBridge;
  let dir: string;
  let store: ChecklistStore;
  let control: ChecklistControl | null = null;
  let run: ClaudeRun;
  // アプリに届いた呼び出し（ツールとフック）
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const hooks = (tool: string) => calls.filter((c) => c.tool === tool).map((c) => c.args);
  const said = (text: string) => run.chatEvents.some((e) => e.type === 'assistant-text' && e.text === text);
  // 入力欄に戻った（ターンが終わった）。止めたあとの続きが残っていないことも待つ
  const idle = (text: string) => run.waitFor(`「${text}」のあと入力欄に戻る`, (info) => info.state.kind === 'prompt' && said(text), 30_000);

  beforeAll(async () => {
    const script = await buildRelay('checklist-mcp');
    dir = mkdtempSync(join(tmpdir(), 'tanacode-checklist-hooks-'));
    store = new ChecklistStore(join(dir, 'checklists'));
    bridge = new McpBridge(join(dir, 'checklist.sock'), (session, tool, args) => {
      calls.push({ tool, args });
      return control!.handle(session, tool, args);
    });
    await bridge.start();
    api = new MockApi();
    // ファイルを書くツールを、許可の確認なしに通す（何かを変えうるツールとして数えられる）
    run = new ClaudeRun(await api.start(), { mode: 'acceptEdits', checklist: { command: process.execPath, script, socketPath: bridge.socketPath, version: 'test' } });
    await run.open();
    let files = 0;
    const write = (): Block[] => [{ type: 'tool_use', id: `toolu_w${++files}`, name: 'Write', input: { file_path: join(run.cwd, `file-${files}.txt`), content: 'メモ\n' } }];
    const read = (): Block[] => [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: join(run.cwd, 'file-1.txt') } }];
    api.conversations = [
      {
        match: WORK,
        // 会話ログに書かれる前にターンが終わらないよう、本物の応答と同じくらいの間を空ける
        delayMs: 250,
        steps: [
          ...Array.from({ length: STOP_ACTIONS_NONE }, write),
          say('作業を終えました'),
          // ここで止まる。理由を受けて、人にやってもらうことをカードにする
          [{ type: 'tool_use', id: 'toolu_add', name: checklistToolId('card_add'), input: { list: '人のやること', list_description: '人にやってもらうこと', cards: [{ title: '設定画面で画像を選ぶ' }] } }],
          say('チェックリストに 1 件足しました'),
          // 2 つめの発言。読むだけなので止まらない
          read(),
          say('質問に答えました'),
          // 3 つめの発言。未チェックのカードがあるので、少ない作業で止まる
          ...Array.from({ length: STOP_ACTIONS_OPEN }, write),
          say('続きを終えました'),
          say('直すものはありません'),
          // 4 つめの発言。止められてから間もないので止まらない
          write(),
          say('小さな直しを終えました'),
        ],
      },
    ];
    control = new ChecklistControl({ store, host: run.manager, enabled: () => true, notifyDelayMs: 50 });
  });

  afterAll(async () => {
    control?.dispose();
    await run?.stop();
    await api?.stop();
    bridge?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('リストなしで作業がたまると、ターンの終わりが 1 回だけ止まり、理由を受けた Claude がチェックリストを直す', async () => {
    await run.send(WORK);
    await idle('チェックリストに 1 件足しました');
    // 発言のとき: リストが無いことが Claude に渡っている
    expect(hooks('hook:prompt')).toHaveLength(1);
    expect(api.contexts[0]).toContain(`<${CHECKLIST_REMINDER_TAG}>\nThis session has no checklists yet.`);
    // ターンの終わり: 会話ログから数えたツールがアプリに届き、止めた理由が Claude に渡った。止めたあとの続きの終わりでは、アプリに聞かない
    expect(hooks('hook:stop')).toEqual([{ turn: STOP_ACTIONS_NONE, checklist: 0, actions: STOP_ACTIONS_NONE }]);
    const afterStop = api.contexts[api.contexts.length - 1];
    expect(afterStop).toContain(`Stop hook feedback:\n<${CHECKLIST_REMINDER_TAG}>\nYou are about to end your turn. You have made ${STOP_ACTIONS_NONE} tool calls that change things`);
    expect(calls.map((c) => c.tool)).toEqual(['hook:prompt', 'hook:stop', 'card_add']);
    expect(store.findList(run.sessionId!, '人のやること')!.cards.map((c) => c.title)).toEqual(['設定画面で画像を選ぶ']);
  });

  it('次の発言では今のチェックリストが渡る。読むだけのターンは止まらない', async () => {
    await run.send(QUESTION);
    await idle('質問に答えました');
    expect(api.contexts[api.contexts.length - 1]).toContain('## 人のやること (0/1 checked)\nDescription: 人にやってもらうこと\n- [ ] #1 設定画面で画像を選ぶ');
    // アプリには聞くが（ツールを使ったターン）、たまった作業が無いので止まらない
    expect(hooks('hook:stop')[1]).toEqual({ turn: 1, checklist: 0, actions: 0 });
    expect(said('続きを終えました')).toBe(false);
  });

  it('未チェックのカードがあれば、少ない作業で止まる。止められてから間もないターンは止まらない', async () => {
    await run.send(MORE);
    await idle('直すものはありません');
    expect(hooks('hook:stop')[2]).toEqual({ turn: STOP_ACTIONS_OPEN, checklist: 0, actions: STOP_ACTIONS_OPEN });
    await run.send(SMALL);
    await idle('小さな直しを終えました');
    // 数え直しは、止めた理由の行（会話ログに残る）から
    expect(hooks('hook:stop')[3]).toEqual({ turn: 1, checklist: 0, actions: 1 });
    expect(hooks('hook:stop')).toHaveLength(4);
    expect(run.chatEvents.filter((e) => e.type === 'assistant-text').map((e) => e.type === 'assistant-text' && e.text)).toEqual([
      '作業を終えました',
      'チェックリストに 1 件足しました',
      '質問に答えました',
      '続きを終えました',
      '直すものはありません',
      '小さな直しを終えました',
    ]);
  });

  it('アプリが足したフックは、チャットのフックの一覧に出ない', () => {
    expect(run.chatEvents.filter((e) => e.type === 'hook')).toEqual([]);
    expect(run.chat().filter((e) => e.type === 'hook')).toEqual([]);
  });

  it('/compact で会話を圧縮すると、今のチェックリストが渡る', async () => {
    await run.send('/compact');
    await run.waitFor('圧縮の区切り', () => run.chatEvents.some((e) => e.type === 'divider'), 30_000);
    await run.waitFor('圧縮のあとのフック', () => hooks('hook:compact').length > 0, 30_000);
    await run.waitFor('Claude に渡した記録', () =>
      run.entries.some((e) => {
        const a = e.attachment;
        return a?.type === 'hook_additional_context' && a.hookEvent === 'SessionStart' && JSON.stringify(a.content).includes('The conversation was just compacted.');
      }),
    );
    expect(run.chatEvents.filter((e) => e.type === 'hook')).toEqual([]);
  });
});
