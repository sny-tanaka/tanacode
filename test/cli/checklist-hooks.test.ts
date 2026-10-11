import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHECKLIST_REMINDER_TAG, CHECKLIST_UNCHANGED_MARK, checklistToolId } from '@shared/checklist-tools';
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
// - ツールを使ったのにチェックリストに触れずにターンを終えようとすると、1 回だけ止まり、理由が Claude に渡って続きが始まる（Stop）。
//   止めたあとの続きは止まらない。読んだだけのターンも止まる。チェックリストに触れたターン・ツールを使っていないターンは止まらない
// - 直すものが無いと答えた目印は、チャットに出ない
// - /compact で会話を圧縮すると、今のチェックリストが渡る（SessionStart の compact）
// - どれも、チャットのフックの一覧には出ない

const WORK = 'チェックリストに触れずに作業してください';
const QUESTION = '読んで質問に答えてください';
const TOUCH = 'チェックリストを直しながら作業してください';
const TALK = '返事だけしてください';
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
    // ターンの終わりを止められたあとの応答も、台本から返す
    api.scriptChecklistStops = true;
    // ファイルを書くツールを、許可の確認なしに通す
    run = new ClaudeRun(await api.start(), { mode: 'acceptEdits', checklist: { command: process.execPath, script, socketPath: bridge.socketPath, version: 'test' } });
    await run.open();
    let files = 0;
    const write = (): Block[] => [{ type: 'tool_use', id: `toolu_w${++files}`, name: 'Write', input: { file_path: join(run.cwd, `file-${files}.txt`), content: 'メモ\n' } }];
    const read = (): Block[] => [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: join(run.cwd, 'file-1.txt') } }];
    const check = (): Block[] => [{ type: 'tool_use', id: 'toolu_check', name: checklistToolId('card_check'), input: { list: '人のやること', numbers: '1' } }];
    api.conversations = [
      {
        match: WORK,
        // 会話ログに書かれる前にターンが終わらないよう、本物の応答と同じくらいの間を空ける
        delayMs: 250,
        steps: [
          write(),
          write(),
          say('作業を終えました'),
          // ここで止まる。理由を受けて、人にやってもらうことをカードにする
          [{ type: 'tool_use', id: 'toolu_add', name: checklistToolId('card_add'), input: { list: '人のやること', list_description: '人にやってもらうこと', cards: [{ title: '設定画面で画像を選ぶ' }] } }],
          say('チェックリストに 1 件足しました'),
          // 2 つめの発言。読んだだけでも止まる。直すものが無いので、目印だけを返す
          read(),
          say('質問に答えました'),
          say(CHECKLIST_UNCHANGED_MARK),
          // 3 つめの発言。チェックリストに触れたので止まらない
          write(),
          check(),
          say('直しながら終えました'),
          // 4 つめの発言。ツールを使っていないので止まらない
          say('返事をしました'),
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

  it('ツールを使ってチェックリストに触れずに終えようとすると、1 回だけ止まり、理由を受けた Claude がチェックリストを直す', async () => {
    await run.send(WORK);
    await idle('チェックリストに 1 件足しました');
    // 発言のとき: リストが無いことが Claude に渡っている
    expect(hooks('hook:prompt')).toHaveLength(1);
    expect(api.contexts[0]).toContain(`<${CHECKLIST_REMINDER_TAG}>\nThis session has no checklists yet.`);
    // ターンの終わり: 会話ログから数えたツールがアプリに届き、止めた理由が Claude に渡った。止めたあとの続きの終わりでは、アプリに聞かない
    expect(hooks('hook:stop')).toEqual([{ turn: 2, checklist: 0 }]);
    const afterStop = api.contexts[api.contexts.length - 1];
    expect(afterStop).toContain(`Stop hook feedback:\n<${CHECKLIST_REMINDER_TAG}>\nYou are about to end your turn. In this turn you made 2 tool calls and did not touch the checklists`);
    expect(calls.map((c) => c.tool)).toEqual(['hook:prompt', 'hook:stop', 'card_add']);
    expect(store.findList(run.sessionId!, '人のやること')!.cards.map((c) => c.title)).toEqual(['設定画面で画像を選ぶ']);
  });

  it('次の発言では今のチェックリストが渡る。読んだだけのターンも止まり、直すものが無いと答えた目印はチャットに出ない', async () => {
    await run.send(QUESTION);
    await run.waitFor('止めたあとの続きが終わる', (info) => info.state.kind === 'prompt' && api.contexts.some((c) => c.includes('In this turn you made 1 tool call and')), 30_000);
    expect(api.contexts.some((c) => c.includes('## 人のやること (0/1 checked)\nDescription: 人にやってもらうこと\n- [ ] #1 設定画面で画像を選ぶ'))).toBe(true);
    expect(hooks('hook:stop')[1]).toEqual({ turn: 1, checklist: 0 });
    // 目印の応答は会話ログにはあるが、チャットには出ない
    await run.waitFor('目印の応答', () => run.entries.some((e) => JSON.stringify(e.message?.content ?? '').includes(CHECKLIST_UNCHANGED_MARK) && e.type === 'assistant'));
    expect(said('質問に答えました')).toBe(true);
    expect(run.chatEvents.some((e) => e.type === 'assistant-text' && e.text.includes(CHECKLIST_UNCHANGED_MARK))).toBe(false);
  });

  it('チェックリストに触れたターンと、ツールを使っていないターンは止まらない', async () => {
    await run.send(TOUCH);
    await idle('直しながら終えました');
    await run.send(TALK);
    await idle('返事をしました');
    // どちらも、アプリに聞かずに通す
    expect(hooks('hook:stop')).toHaveLength(2);
    expect(store.findList(run.sessionId!, '人のやること')!.cards[0].checked).toBe(true);
    expect(run.chatEvents.filter((e) => e.type === 'assistant-text').map((e) => e.type === 'assistant-text' && e.text)).toEqual([
      '作業を終えました',
      'チェックリストに 1 件足しました',
      '質問に答えました',
      '直しながら終えました',
      '返事をしました',
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
