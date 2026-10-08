import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Menu, ScreenInfo } from '@shared/screen';
import { ClaudeRun, claudeVersion } from './claude-run';
import { MockApi } from './mock-api';

// 本物の claude をモックの API で動かし、続けて出る質問・許可の確認を、カードが出てすぐに押しても答えられるかを確かめる。
// 押すのは、アプリのカードのボタンと同じ session-manager の choose で、1 回だけ（テストの側では待たず、送り直さない）。
// Claude Code は、直前の入力（指示の送信・前のメニューへの Enter）からしばらくの間にメニューに届いた Enter を捨てる。
// モックの API はすぐに応答するので、前の答えのすぐあとに次の確認が出る（E2E で、カードが閉じずに止まった場面と同じ）

const version = claudeVersion();
const PROMPT = '続けて確かめてください';

describe(`Claude Code ${version} の続けて出るメニューを、出てすぐ押す`, () => {
  let api: MockApi;
  let run: ClaudeRun;

  beforeAll(async () => {
    api = new MockApi();
    run = new ClaudeRun(await api.start(), { trusted: true });
    api.conversations = [
      {
        match: PROMPT,
        steps: [
          [{ type: 'tool_use', id: 'toolu_ask', name: 'AskUserQuestion', input: { questions: [{ question: 'どちらで進めますか？', header: '進め方', multiSelect: false, options: [{ label: 'A 案', description: '速い' }, { label: 'B 案', description: '確実' }] }] } }],
          [{ type: 'tool_use', id: 'toolu_write', name: 'Write', input: { file_path: join(run.cwd, 'hello.txt'), content: 'こんにちは\n' } }],
          [{ type: 'tool_use', id: 'toolu_one', name: 'Bash', input: { command: 'mkdir one', description: '1 つ目のフォルダを作る' } }],
          [{ type: 'tool_use', id: 'toolu_two', name: 'Bash', input: { command: 'mkdir two', description: '2 つ目のフォルダを作る' } }],
          [{ type: 'text', text: '確かめ終わりました' }],
        ],
      },
    ];
    run.start();
    await run.waitFor('入力欄', (info) => info.state.kind === 'prompt' && info.ready);
  });

  afterAll(async () => {
    await run?.stop();
    await api?.stop();
  });

  const menu = (info: ScreenInfo): Menu | null => (info.state.kind === 'menu' ? info.state.menu : null);
  // 出ているメニューが、文字（見出しか補足）を含むものか
  const showing = (text: string) => (info: ScreenInfo) => {
    const m = menu(info);
    return !!m && `${m.title}\n${m.context.join('\n')}`.includes(text);
  };

  // メニューが出たら、すぐに 1 回だけ押す。押したメニューが閉じるのを待つ
  const pressAtOnce = async (label: string, text: string) => {
    await run.waitFor(label, showing(text));
    const result = await run.manager.choose(run.sessionId!, { optionId: '1', key: 'enter' });
    await run.waitFor(`${label}が閉じる`, (info) => !showing(text)(info), 8000);
    return result;
  };

  it('質問 → Write の許可 → Bash の許可 2 つを、出てすぐ 1 回ずつ押すと、どれも閉じて最後まで進む', async () => {
    await run.send(PROMPT);
    const results = [
      await pressAtOnce('質問', 'どちらで進めますか'),
      await pressAtOnce('Write の許可', 'hello.txt'),
      await pressAtOnce('1 つ目の Bash の許可', 'mkdir one'),
      await pressAtOnce('2 つ目の Bash の許可', 'mkdir two'),
    ];
    await run.waitFor('返事', () => run.chatEvents.some((e) => e.type === 'assistant-text' && e.text === '確かめ終わりました'));
    expect(results).toEqual(['chosen', 'chosen', 'chosen', 'chosen']);
    expect(readFileSync(join(run.cwd, 'hello.txt'), 'utf8')).toBe('こんにちは\n');
    // 押した 1 回は 1 回のまま（次の確認を勝手に選んでいない）。どの答えも Yes（1 つ目）で、Claude に届いている
    expect(api.toolResults.filter((r) => /A 案/.test(r))).toHaveLength(1);
  });
});
