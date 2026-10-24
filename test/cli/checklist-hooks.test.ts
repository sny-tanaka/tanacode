import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
// - ツールを使ったのにチェックリストに触れずにターンを終えても、止めない（続きを始めさせない。Stop）。最後の応答は、作業の報告のまま
//   （Remote Control で見える最後の応答も同じ）。そのターンは、アプリが数えておき、次の発言の知らせで、前のターンの分もリストを直させる。
//   読んだだけのターンも数える。チェックリストに触れたターン・ツールを使っていないターンは数えない。
//   モックの API はすぐに応答を返すので、フックが動いた時点では、会話ログに最後の応答（とその前のツール）がまだ書かれていない。
//   フックが、最後の応答（last_assistant_message）まで書かれるのを待ってから数えることも、ここで確かめている
// - /compact で会話を圧縮すると、今のチェックリストが渡る（SessionStart の compact）
// - どれも、チャットのフックの一覧には出ない

const WORK = 'チェックリストに触れずに作業してください';
const DECIDE = '今後は日付を ISO 形式で書いてください';
const QUESTION = '読んで質問に答えてください';
const TOUCH = 'チェックリストを直しながら作業してください';
const TALK = '返事だけしてください';
const LATE = 'ended without touching the checklists';
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
  const idle = (text: string) => run.waitUntil(`「${text}」のあと手が空く`, () => run.idle && said(text), 30_000);
  // 会話ログの最後の応答の文（Remote Control に出る最後の応答と同じもの）
  const lastAnswer = () => {
    const texts = run.entries
      .filter((e) => e.type === 'assistant' && Array.isArray(e.message?.content))
      .map((e) => (e.message!.content as { type?: string; text?: string }[]).filter((b) => b.type === 'text' && b.text).map((b) => b.text).join(' '))
      .filter(Boolean);
    return texts[texts.length - 1];
  };
  // 発言を送って、手が空くまでに API に来た呼び出しの数（本体の会話のもの）と、その発言から後ろの、Claude に渡った文
  // （API には会話の全体が送られるので、その発言より前のものは除く。発言の知らせは、発言のあとに入る）
  const turn = async (prompt: string, last: string) => {
    const from = api.contexts.length;
    await run.send(prompt);
    await idle(last);
    await run.waitUntil(`「${last}」が会話ログに書かれる`, () => lastAnswer() === last);
    return { requests: api.contexts.length - from, contexts: api.contexts.slice(from).map((c) => c.slice(c.lastIndexOf(prompt))) };
  };

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
        steps: [
          write(),
          write(),
          // ここでターンを終える。止めないので、続きの応答は無い
          say('作業を終えました'),
          // 2 つめの発言。前のターンの分を頼まれて、人にやってもらうことと、この発言で決まったことをカードにしてから答える
          [{ type: 'tool_use', id: 'toolu_add', name: checklistToolId('card_add'), input: { list: '人のやること', list_description: '人にやってもらうこと', cards: [{ title: '設定画面で画像を選ぶ' }] } }],
          [{ type: 'tool_use', id: 'toolu_decide', name: checklistToolId('card_add'), input: { list: '決定事項', list_kind: 'decisions', list_description: '決まったこと', cards: [{ title: '日付は ISO 形式で書く' }] } }],
          say('そうします'),
          // 3 つめの発言。読んだだけでも数える
          read(),
          say('質問に答えました'),
          // 4 つめの発言。チェックリストに触れたので数えない
          write(),
          check(),
          say('直しながら終えました'),
          // 5 つめの発言。ツールを使っていないので数えない
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

  it('ツールを使ってチェックリストに触れずにターンを終えても止めず、最後の応答は作業の報告のまま', async () => {
    const { requests, contexts } = await turn(WORK, '作業を終えました');
    // 発言のとき: リストが無いことが Claude に渡っている。前のターンは無いので、その分は頼まない
    expect(hooks('hook:prompt')).toHaveLength(1);
    expect(contexts[0]).toContain(`<${CHECKLIST_REMINDER_TAG}>\nThis session has no checklists yet.`);
    expect(contexts[0]).not.toContain(LATE);
    // ターンの終わり: 会話ログから数えたツールがアプリに届く。settled: フックが、会話ログが最後の応答まで書かれているのを確かめた
    expect(hooks('hook:stop')).toEqual([{ turn: 2, checklist: 0, since: expect.any(Number), settled: true }]);
    // 続きは始まらない（ツール 2 回と最後の応答で、呼び出しは 3 回）。止めた理由はどこにも渡っていない
    expect(requests).toBe(3);
    expect(api.contexts.some((c) => c.includes('Stop hook additional context'))).toBe(false);
    const summary = run.entries.find((e) => e.type === 'system' && e.subtype === 'stop_hook_summary');
    expect(JSON.stringify(summary ?? {})).not.toContain(CHECKLIST_REMINDER_TAG);
    expect(lastAnswer()).toBe('作業を終えました');
    expect(run.chatEvents.some((e) => e.type === 'checklist-stop')).toBe(false);
  });

  it('次の発言の知らせで、前のターンの分（決まったことの記録も）を頼み、Claude は作業の前にリストを直す', async () => {
    const { contexts } = await turn(DECIDE, 'そうします');
    expect(contexts[0]).toContain(
      'Your previous turn ended without touching the checklists (2 tool calls). Before anything else, bring them up to date for that turn as the tanacode-checklist instructions say for the end of a turn (that includes recording what was decided there on the decisions list).',
    );
    expect(store.findList(run.sessionId!, '人のやること')!.cards.map((c) => c.title)).toEqual(['設定画面で画像を選ぶ']);
    expect(store.findList(run.sessionId!, '決定事項')!.cards.map((c) => c.title)).toEqual(['日付は ISO 形式で書く']);
    // チェックリストに触れたターンは、アプリに聞かずに通す
    expect(hooks('hook:stop')).toHaveLength(1);
    expect(lastAnswer()).toBe('そうします');
  });

  it('読んだだけのターンも数えて、次の発言で頼む。触れたターン・ツールを使っていないターンは数えない', async () => {
    const question = await turn(QUESTION, '質問に答えました');
    // 前のターンでチェックリストに触れたので、頼まない。今のリストは渡る
    expect(question.contexts[0]).not.toContain(LATE);
    expect(question.contexts[0]).toContain('## 人のやること (0/1 checked)\nDescription: 人にやってもらうこと\n- [ ] #1 設定画面で画像を選ぶ');
    expect(question.requests).toBe(2);
    expect(hooks('hook:stop')[1]).toEqual({ turn: 1, checklist: 0, since: expect.any(Number), settled: true });
    expect(lastAnswer()).toBe('質問に答えました');

    const touch = await turn(TOUCH, '直しながら終えました');
    expect(touch.contexts[0]).toContain('Your previous turn ended without touching the checklists (1 tool call).');
    const talk = await turn(TALK, '返事をしました');
    expect(talk.contexts[0]).not.toContain(LATE);
    expect(talk.requests).toBe(1);
    // どちらも、アプリに聞かずに通す
    expect(hooks('hook:stop')).toHaveLength(2);
    expect(store.findList(run.sessionId!, '人のやること')!.cards[0].checked).toBe(true);
    expect(run.chatEvents.filter((e) => e.type === 'assistant-text').map((e) => e.type === 'assistant-text' && e.text)).toEqual([
      '作業を終えました',
      'そうします',
      '質問に答えました',
      '直しながら終えました',
      '返事をしました',
    ]);
  });

  it('アプリが足したフックは、チャットのフックの一覧に出ない', () => {
    expect(run.chatEvents.filter((e) => e.type === 'hook')).toEqual([]);
    expect(run.chat().filter((e) => e.type === 'hook')).toEqual([]);
  });

  it('/compact で会話を圧縮すると、今のチェックリストが渡る。有効な決定（チェックで消えないリストのカード）も渡り、取り消したものは渡らない', async () => {
    const decisions = store.findList(run.sessionId!, '決定事項')!;
    const [kept, dropped] = store.addCards(run.sessionId!, 'human', decisions.id, [{ title: '決済には触らない' }, { title: '端数は切り捨て' }]);
    store.revokeCards(run.sessionId!, 'human', decisions.id, [dropped.id], '四捨五入に変わった');
    await run.send('/compact');
    await run.waitUntil('圧縮の区切り', () => run.chatEvents.some((e) => e.type === 'divider'), 30_000);
    await run.waitUntil('圧縮のあとのフック', () => hooks('hook:compact').length > 0, 30_000);
    await run.waitUntil('Claude に渡した記録', () =>
      run.entries.some((e) => {
        const a = e.attachment;
        const content = JSON.stringify(a?.content ?? '');
        return (
          a?.type === 'hook_additional_context' &&
          a.hookEvent === 'SessionStart' &&
          content.includes('The conversation was just compacted.') &&
          content.includes(`- #${kept.number} 決済には触らない`) &&
          !content.includes('端数は切り捨て')
        );
      }),
    );
    expect(run.chatEvents.filter((e) => e.type === 'hook')).toEqual([]);
  });
});
