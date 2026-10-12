import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TranscriptEntry } from '@shared/chat';
import type { ContextItem } from '@shared/context';
import { ContextTracker, estimateTokens, imageTokens, readContext } from '../src/main/context-tracker';

// コンテキストの中身（ContextTracker）の、test/context.test.ts で確かめていないところ。
// 行の形は、Claude Code 2.1.292 の控えと、同じバージョンをモックの API で動かして取った会話ログ（@ の添付・サブフォルダの CLAUDE.md・
// 作業中に送った発言・作業中に届いた完了通知・/compact・! のコマンド・中断・API エラー）に合わせた。
// 次のものはそれらの会話ログに出なかったので、src の読み取りに合わせて組み立てた: CLAUDE.md・AGENTS.md の instructions の attachment・
// edited_text_file・スキルの本文（sourceToolUseID の付いた isMeta の行）・別の Claude からの知らせ（<agent-message from>）・GIF と JPEG の画像

const CWD = '/work/app';
let seq = 0;
let last: string | null = null;
function row(entry: TranscriptEntry & Record<string, unknown>, parent: string | null | undefined = last): TranscriptEntry {
  const uuid = `c${++seq}`;
  last = uuid;
  return { uuid, parentUuid: parent, ...entry };
}
const prompt = (text: string, parent?: string | null) => row({ type: 'user', message: { content: text } }, parent);
const reply = (id: string | undefined, output: number | undefined, input: number, blocks: unknown[], extra: Record<string, unknown> = {}) =>
  row({
    type: 'assistant',
    message: { id, model: 'claude-opus-5-5', content: blocks, usage: { input_tokens: input, output_tokens: output } } as TranscriptEntry['message'],
    ...extra,
  });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });
const result = (toolUseId: string, content: unknown, toolUseResult?: unknown, extra: unknown[] = []) =>
  row({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content }, ...extra] as never }, toolUseResult });
const attachment = (a: Record<string, unknown>) => row({ type: 'attachment', attachment: a });

function track(entries: TranscriptEntry[]): ContextItem[] {
  const tracker = new ContextTracker(CWD);
  for (const e of entries) tracker.handle(e);
  return tracker.current().items;
}
const find = (items: ContextItem[], label: string) => items.find((i) => i.label === label);
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const png = (data = PNG_1x1) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });

describe('ContextTracker（続き）', () => {
  it('巻き戻したあとは、切られた応答で直し終えた分を差から引いて、残りだけを直す', () => {
    last = null;
    const p1 = prompt('一つ目');
    const r1 = reply('m1', 10, 20_000, [toolUse('t1', 'Bash', { command: 'ls' })]);
    // 2,200 文字の結果（見積もり 1,040）。次の応答の入力の増え方で 1,990 に直る
    const res1 = result('t1', 'x'.repeat(2200));
    const r2 = reply('m2', 10, 22_000, [{ type: 'text', text: '見ました' }]);
    const r2b = reply('m2b', 10, 22_020, [{ type: 'text', text: '続けます' }]);
    // 結果のあとまで戻して言い直し、その応答の入力は 9 だけ増えた
    const p2 = prompt('言い直し', res1.uuid);
    const r3 = reply('m3', 10, 22_009, [{ type: 'text', text: 'はい' }]);
    const items = track([p1, r1, res1, r2, r2b, p2, r3]);
    expect(find(items, 'ls')).toMatchObject({ kind: 'tool', tokens: 1990 });
    // 言い直しの発言は 9 に直り、応答の出力 10 と合わせて 19。切られた応答（m2）の分は入らない
    expect(find(items, '言い直し')).toMatchObject({ kind: 'topic', tokens: 19 });
    expect(find(items, '一つ目')!.tokens).toBe(Math.round(3 * 1.07 + 10));
  });

  it('いちばん前まで巻き戻すと、最初から数え直す', () => {
    last = null;
    const items = track([
      prompt('最初'),
      reply('m1', 30, 20_000, [{ type: 'text', text: 'はい' }]),
      // 最初の発言の前（親なし）からやり直す
      prompt('やり直し', null),
      reply('m2', 5, 20_001, [{ type: 'text', text: 'はい' }]),
    ]);
    expect(items.map((i) => [i.label, i.tokens])).toEqual([['やり直し', Math.round(4 * 1.07 + 5)]]);
  });

  it('巻き戻したあとの、発言でない行は、残った中の最後のやりとりに足す', () => {
    last = null;
    const p1 = prompt('一つ目');
    const r1 = reply('m1', 10, 20_000, [{ type: 'text', text: 'はい' }]);
    const items = track([p1, r1, prompt('二つ目'), reply('m2', 10, 20_100, []), prompt('<local-command-stdout>出力です</local-command-stdout>', r1.uuid)]);
    expect(items.map((i) => [i.label, i.tokens])).toEqual([['一つ目', Math.round(3 * 1.07 + 10 + estimateTokens('<local-command-stdout>出力です</local-command-stdout>'))]]);
  });

  it('モデルに渡らない attachment は、一覧にも大きさの直しにも入れない', () => {
    last = null;
    const items = track([
      prompt('始め'),
      reply('m1', 10, 20_000, [toolUse('t1', 'Bash', { command: 'cat big' })]),
      result('t1', 'z'.repeat(2200)),
      attachment({ type: 'deferred_tools_record', content: 'd'.repeat(2200) }),
      reply('m2', 10, 22_000, []),
    ]);
    expect(find(items, 'cat big')!.tokens).toBe(1990);
  });

  it('直す割合が 0.25〜4 倍を外れるとき・増えた中身が無いときは直さない', () => {
    last = null;
    const items = track([
      prompt('始め'),
      reply('m1', 10, 20_000, [toolUse('t1', 'Bash', { command: 'cat big' })]),
      result('t1', 'z'.repeat(2200)),
      // 入力がほとんど増えていない（ツールの定義を読み込み直したなど、比べられない）
      reply('m2', 10, 20_020, [toolUse('t2', 'Bash', { command: 'cat more' })]),
      result('t2', 'w'.repeat(2200)),
      // 入力が 10 倍以上増えた
      reply('m3', 10, 60_000, []),
      reply('m4', 10, 60_500, []),
    ]);
    expect(find(items, 'cat big')!.tokens).toBe(1040);
    expect(find(items, 'cat more')!.tokens).toBe(1040);
  });

  it('同じ uuid の行・サブエージェントの行・uuid の無い行・応答の無い行を扱う', () => {
    last = null;
    const tracker = new ContextTracker(CWD);
    const first = prompt('はじめ');
    tracker.handle(first);
    tracker.handle(first);
    tracker.handle({ ...prompt('サブ'), isSidechain: true });
    tracker.handle({ type: 'attachment', attachment: { type: 'hook_success', content: 'フックの出力です' } });
    tracker.handle({ type: 'assistant', uuid: 'x1' });
    // 再開時の埋め合わせと、API エラーの応答（2.1.292 の形）はモデルに送られない
    tracker.handle(reply(undefined, undefined, 0, [{ type: 'text', text: 'No response requested.' }], { message: { model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } }));
    tracker.handle(reply(undefined, undefined, 0, [{ type: 'text', text: 'API Error: 400' }], { isApiErrorMessage: true }));
    const items = tracker.current().items;
    expect(items.map((i) => i.label)).toEqual(['はじめ']);
    expect(items[0].tokens).toBe(Math.round(3 * 1.07 + estimateTokens('フックの出力です')));
    // やり直すと空になり、同じ行をもう一度読める。発言より前のものは、会話の始まりに入る
    tracker.reset();
    expect(tracker.current().items).toEqual([]);
    tracker.handle(attachment({ type: 'hook_additional_context', content: ['SessionStart の文'] }));
    tracker.handle(first);
    expect(tracker.current().items.map((i) => i.label)).toEqual(['会話の始まり', 'はじめ']);
  });

  it('使用量の無い応答は、文章とツールの入力の文字数から見積もる。書いた中身はそのままファイルの行に移す', () => {
    last = null;
    const content = 'q'.repeat(220);
    const items = track([
      prompt('見積もり'),
      reply(undefined, undefined, 0, [
        { type: 'text', text: 'a'.repeat(22) },
        toolUse('t1', 'Grep', { pattern: 'TODO' }),
        toolUse('w1', 'NotebookEdit', { notebook_path: `${CWD}/book.ipynb`, new_source: content }),
        { type: 'tool_use', id: 'no-name', input: {} },
        // 文字の無い文章・入力の無いツール（{} の 2 文字）
        { type: 'text' },
        { type: 'tool_use', id: 'no-input', name: 'TodoRead' },
      ]),
      // 中身がブロックでない応答
      reply(undefined, undefined, 0, [], { message: { content: '文字だけ' } }),
    ]);
    expect(find(items, 'book.ipynb')).toMatchObject({ kind: 'file', edited: true, tokens: Math.round(estimateTokens(JSON.stringify({ notebook_path: `${CWD}/book.ipynb`, new_source: content }))) });
    expect(find(items, '見積もり')!.tokens).toBe(Math.round(4 * 1.07 + 10 + estimateTokens(JSON.stringify({ pattern: 'TODO' })) + estimateTokens('{}')));
  });

  it('CLAUDE.md・AGENTS.md・記憶、@ の添付・変更に気づいたファイル・サブフォルダの CLAUDE.md をファイルの行にする。フォルダの外はホームからの ~ で出す', () => {
    last = null;
    const home = homedir();
    const items = track([
      attachment({
        type: 'instructions',
        files: [
          { path: `${CWD}/CLAUDE.md`, content: '# 決まり\n'.repeat(10) },
          { path: `${home}/.claude/CLAUDE.md`, content: 'ユーザーの決まり' },
          { path: '/etc/claude/managed.md' },
          { content: 'パスの無いもの' },
          null,
        ],
      }),
      // 2.1.292 の @ の添付
      attachment({ type: 'file', filename: `${CWD}/notes.txt`, content: { type: 'text', file: { filePath: `${CWD}/notes.txt`, content: 'メモ\n' } }, displayPath: 'notes.txt' }),
      attachment({ type: 'edited_text_file', filename: `${CWD}/notes.txt`, snippet: '1\tメモを直した' }),
      // 2.1.292 のサブフォルダの CLAUDE.md
      attachment({ type: 'nested_memory', path: `${CWD}/sub/CLAUDE.md`, content: { path: `${CWD}/sub/CLAUDE.md`, type: 'Project', content: '# 決まり\n' }, displayPath: 'sub/CLAUDE.md' }),
      attachment({ type: 'file', filename: 'relative.txt', content: { file: { content: 'r' } } }),
      prompt('始めます'),
    ]);
    expect(items.filter((i) => i.kind === 'file').map((i) => i.label)).toEqual(['CLAUDE.md', '~/.claude/CLAUDE.md', '/etc/claude/managed.md', 'notes.txt', 'sub/CLAUDE.md', 'relative.txt']);
    expect(find(items, 'CLAUDE.md')!.tokens).toBe(Math.round(estimateTokens('# 決まり\n'.repeat(10))));
    expect(find(items, '/etc/claude/managed.md')!.tokens).toBe(0);
    // 添付と、変更に気づいた知らせは同じファイルの行に足す
    expect(find(items, 'notes.txt')!.tokens).toBe(Math.round(estimateTokens('メモ\n') + estimateTokens('1\tメモを直した')));
    // 中身の無い一覧や環境の知らせ・モデルに渡らないもの（システムプロンプトの控え）は数えない
    const tracker = new ContextTracker(CWD);
    last = null;
    for (const e of [
      prompt('x'),
      attachment({ type: 'date', date: '2026-10-07' }),
      attachment({ type: 'instructions' }),
      attachment({ type: 'prompt_snapshot', systemPrompt: ['s'.repeat(5000)] }),
      row({ type: 'attachment' }),
    ])
      tracker.handle(e);
    expect(tracker.current().items.map((i) => [i.label, i.tokens])).toEqual([['x', 0]]);
  });

  it('作業中に送った人の発言はやりとりを区切り、作業中に届いた完了通知・別の Claude からの知らせは区切らない', () => {
    last = null;
    const items = track([
      prompt('最初の頼み'),
      reply('m1', 10, 20_000, [toolUse('b1', 'Bash', { command: 'sleep 1', run_in_background: true })]),
      result('b1', 'Command running in background with ID: b1.'),
      // 2.1.292 の、作業中に送った発言
      attachment({ type: 'queued_command', prompt: '追加の頼みです', commandMode: 'prompt', origin: { kind: 'human' }, humanTurn: true }),
      // 2.1.292 の、作業中に届いた完了通知（origin の無い古い形は、commandMode で見分ける）
      attachment({ type: 'queued_command', prompt: '<task-notification>\n<tool-use-id>b1</tool-use-id>\n<status>completed</status>\n<summary>Background command "sleep 1" completed (exit code 0)</summary>\n</task-notification>', commandMode: 'task-notification' }),
      attachment({ type: 'queued_command', prompt: '<agent-message from="unknown">途中の報告</agent-message>', commandMode: 'prompt', origin: { kind: 'peer' } }),
      // 文字でない発言は読まない
      attachment({ type: 'queued_command', prompt: [{ type: 'text', text: 'x' }], commandMode: 'prompt' }),
    ]);
    expect(items.filter((i) => i.kind === 'topic').map((i) => i.label)).toEqual(['最初の頼み', '追加の頼みです']);
    // origin の無い古い形の人の発言も区切る
    expect(track([prompt('前'), attachment({ type: 'queued_command', prompt: 'あとから', commandMode: 'prompt' })]).map((i) => i.label)).toEqual(['前', 'あとから']);
    const added = find(items, '追加の頼みです')!;
    expect(added.tokens).toBe(Math.round(estimateTokens('追加の頼みです') + estimateTokens('<task-notification>\n<tool-use-id>b1</tool-use-id>\n<status>completed</status>\n<summary>Background command "sleep 1" completed (exit code 0)</summary>\n</task-notification>') + estimateTokens('<agent-message from="unknown">途中の報告</agent-message>')));
  });

  it('待機中に届いた別の Claude からの知らせは、やりとりを区切る。サブエージェントの報告は起動した行にまとめる', () => {
    last = null;
    const report = 'r'.repeat(2200);
    const items = track([
      prompt('調べて'),
      reply('m1', 30, 20_000, [toolUse('a1', 'Agent', { description: '在庫の持ち方を調査', prompt: '…' })]),
      result('a1', 'Async agent launched successfully.', { isAsync: true, status: 'async_launched', agentId: 'ag1' }),
      row({ type: 'user', isMeta: true, origin: { kind: 'peer' }, message: { content: `<agent-message from="ag1">${report}</agent-message>` } }),
      row({ type: 'user', isMeta: true, origin: { kind: 'peer' }, message: { content: 'ほかのセッションからの知らせ' } }),
    ]);
    expect(items.filter((i) => i.kind === 'topic').map((i) => i.label)).toEqual(['調べて', '知らせ: サブエージェント「在庫の持ち方を調査」の報告', '別の Claude からの知らせ']);
    expect(items.find((i) => i.kind === 'agent')!.tokens).toBeGreaterThan(1000);
    expect(find(items, '別の Claude からの知らせ')!.tokens).toBe(Math.round(estimateTokens('ほかのセッションからの知らせ')));
  });

  it('完了通知: 起動を見ていない大きな結果は 1 行に、小さいものはやりとりに。要約が無ければ決まった文。1 行にした結果の続きは同じ行に足す', () => {
    last = null;
    const big = '<task-notification><tool-use-id>gone</tool-use-id><summary></summary><result>' + 'b'.repeat(2400) + '</result></task-notification>';
    const items = track([
      prompt('始め'),
      reply('m1', 10, 20_000, [toolUse('b1', 'Bash', { command: 'npm run build', run_in_background: true })]),
      result('b1', 'o'.repeat(2400)),
      row({ type: 'user', origin: { kind: 'task-notification' }, message: { content: big } }),
      row({ type: 'user', origin: { kind: 'task-notification' }, message: { content: '<task-notification><summary>小さい</summary></task-notification>' } }),
      row({ type: 'user', message: { content: '<task-notification><tool-use-id>b1</tool-use-id><summary>ビルドが終わりました</summary></task-notification>' } }),
      // 要約の無い通知
      row({ type: 'user', origin: { kind: 'task-notification' }, message: { content: '<task-notification><status>killed</status></task-notification>' } }),
    ]);
    expect(items.filter((i) => i.kind === 'topic').map((i) => i.label)).toEqual([
      '始め',
      '知らせ: バックグラウンドのタスクが終わりました',
      '知らせ: 小さい',
      '知らせ: ビルドが終わりました',
      '知らせ: バックグラウンドのタスクが終わりました',
    ]);
    expect(items.find((i) => i.kind === 'tool' && i.tool === '')).toMatchObject({ label: '', tokens: Math.round(estimateTokens(big)) });
    // 1 行にした Bash の結果に、小さな完了通知も足す
    const build = find(items, 'npm run build')!;
    expect(build.tokens).toBe(Math.round(2400 / 2.2 + 40 + estimateTokens('<task-notification><tool-use-id>b1</tool-use-id><summary>ビルドが終わりました</summary></task-notification>')));
  });

  it('スキルの本文は、Skill のツールの行に入れる。ツールの結果と同じ行の文字はやりとりに足す', () => {
    last = null;
    const body = 's'.repeat(2400);
    const items = track([
      prompt('スキルを使って'),
      reply('m1', 10, 20_000, [toolUse('sk1', 'Skill', { skill: 'review' })]),
      result('sk1', 'Launching skill: review', undefined, [{ type: 'text', text: '添えた文' }]),
      row({ type: 'user', isMeta: true, sourceToolUseID: 'sk1', message: { content: [{ type: 'text', text: body }] } }),
      // 知らないツールのスキルの本文は、やりとりに足す
      row({ type: 'user', isMeta: true, sourceToolUseID: 'unknown', message: { content: [{ type: 'text', text: 'abc' }] } }),
    ]);
    // 起動の結果は小さいのでやりとりに、本文は大きいので Skill の行に
    expect(find(items, 'review')).toMatchObject({ kind: 'tool', tool: 'Skill', tokens: Math.round(estimateTokens(body)) });
    expect(find(items, 'スキルを使って')!.tokens).toBe(Math.round(7 * 1.07 + 10 + estimateTokens('Launching skill: review') + 40 + estimateTokens('添えた文') + estimateTokens('abc')));
  });

  it('ツールの結果の画像は画像の行に、知らないツールの結果はやりとりに。質問に答えなかったときの名前', () => {
    last = null;
    const items = track([
      prompt('画面を見て'),
      reply('m1', 10, 20_000, [toolUse('s1', 'mcp__tanacode-browser__screenshot', { selector: '.menu' }), toolUse('q1', 'AskUserQuestion', { questions: [] })]),
      result('s1', [png(), { type: 'text', text: 'スクリーンショット' }, { type: 'image', source: { type: 'url', url: 'https://x' } }]),
      result('unknown', ['u'.repeat(2400), png()].map((x) => (typeof x === 'string' ? { type: 'text', text: x } : x))),
      // tool_use_id の無い結果・結果の行の画像や文字の無いブロック
      row({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }, png(), { type: 'text' }] as never } }),
      result('q1', 'answered', { questions: [], answers: { q: 3 } }),
      result('q1', 'answered', null),
    ]);
    expect(items.filter((i) => i.kind === 'image').map((i) => [i.tool, i.label, i.tokens])).toEqual([
      ['mcp__tanacode-browser__screenshot', '.menu', 1],
      ['mcp__tanacode-browser__screenshot', '.menu', 1600],
      // 知らないツールの結果の画像
      ['', '', 1],
    ]);
    expect(find(items, '画面を見て')!.tokens).toBeGreaterThan(1000);
    expect(items.filter((i) => i.label === '質問への答え: （回答なし）')).toHaveLength(2);
  });

  it('発言の名前: コマンドは名前と引数、! のコマンドは !、貼り付けの囲みは外す。発言でないものはやりとりに足す', () => {
    last = null;
    const items = track([
      prompt('<command-name>/model</command-name><command-args>opus</command-args>'),
      prompt('<command-name>/clear</command-name><command-args></command-args>'),
      // 2.1.292 の ! のコマンド
      prompt('<bash-input>echo tanacode-shell</bash-input>'),
      prompt('<bash-stdout>tanacode-shell</bash-stdout><bash-stderr></bash-stderr>'),
      prompt('<pasted_content id="1">\n貼り付けた\n二行目\n</pasted_content id="1">'),
      prompt('<pasted_content></pasted_content>'),
      // 2.1.292 の中断の行
      row({ type: 'user', interruptedMessageId: 'msg_mock_3', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }),
      prompt('[Request interrupted by user for tool use]'),
      row({ type: 'user', message: { content: { unexpected: true } as never } }),
    ]);
    expect(items.filter((i) => i.kind === 'topic').map((i) => i.label)).toEqual(['/model opus', '/clear', '!echo tanacode-shell', '貼り付けた 二行目']);
  });
});

describe('ContextTracker（使用量と圧縮）', () => {
  it('入力の無い応答では直さず、キャッシュの読み込みだけの入力でも直す。圧縮で残した行の一覧が無ければ、すべて要約に置き換わったとみなす', () => {
    last = null;
    const items = track([
      prompt('始め'),
      reply('m0', 10, 0, [toolUse('t0', 'Bash', { command: 'echo 0' })]),
      result('t0', 'y'.repeat(2200)),
      row({ type: 'assistant', message: { id: 'm1', content: [toolUse('t1', 'Bash', { command: 'echo 1' })], usage: { cache_read_input_tokens: 2_000, output_tokens: 10 } } as TranscriptEntry['message'] }),
      result('t1', 'y'.repeat(2200)),
      row({ type: 'assistant', message: { id: 'm2', content: [], usage: { cache_creation_input_tokens: 3_000, output_tokens: 10 } } as TranscriptEntry['message'] }),
      // 2.1.292 の自動の圧縮に、残した行の一覧が無いもの
      row({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 3_000 } } as never, null),
      prompt('あと'),
      row({ type: 'user', message: { content: [{ type: 'text', text: 'この画像' }, png()] as never } }),
    ]);
    // 入力の無い応答（m0）からは比べず、m1 から m2 の間の結果だけを直す（3,000 − 2,000 − 10 = 990）
    expect(items.find((i) => i.label === 'echo 0')).toMatchObject({ compacted: true, tokens: 1040 });
    expect(items.find((i) => i.label === 'echo 1')).toMatchObject({ compacted: true, tokens: 990 });
    expect(items.find((i) => i.kind === 'image')).toMatchObject({ label: '「この画像」に添付した画像', compacted: false });
  });
});

describe('readContext', () => {
  it('会話ログ全体を読んで、コンテキストの中身を集める。無いファイルは空', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tanacode-context-'));
    try {
      const file = join(dir, 's1.jsonl');
      last = null;
      const entries = [prompt('読み直す'), reply('m1', 25, 20_000, [{ type: 'text', text: 'はい' }])];
      writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n書きかけ`);
      expect((await readContext(file, CWD)).items).toEqual([expect.objectContaining({ label: '読み直す', tokens: Math.round(4 * 1.07 + 25) })]);
      expect((await readContext(join(dir, 'missing.jsonl'), CWD)).items).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('imageTokens', () => {
  const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64');
  it('PNG・GIF・JPEG の頭から幅と高さを読み、幅 × 高さ ÷ 750（切り上げ）にする', () => {
    expect(imageTokens(png())).toBe(1);
    // 1500 × 1000 の PNG の頭
    const head = Buffer.alloc(24);
    head.writeUInt32BE(0x89504e47, 0);
    head.writeUInt32BE(1500, 16);
    head.writeUInt32BE(1000, 20);
    expect(imageTokens(png(head.toString('base64')))).toBe(2000);
    // 300 × 250 の GIF
    expect(imageTokens({ source: { type: 'base64', data: b64([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 300 & 0xff, 300 >> 8, 250, 0]) } })).toBe(100);
    // APP0 のあとに SOF0（高さ 600・幅 800）がある JPEG
    const jpeg = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 0, 0, 0];
    expect(imageTokens({ source: { type: 'base64', data: b64(jpeg) } })).toBe(640);
    // 大きさの書かれていない（DHT だけの）JPEG
    const noSize = [0xff, 0xd8, 0xff, 0xc4, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9, 0, 0, 0, 0, 0, 0];
    expect(imageTokens({ source: { type: 'base64', data: b64(noSize) } })).toBe(1600);
  });

  it('大きさが読めない画像は 1600 とみなす', () => {
    expect(imageTokens({ source: { type: 'base64', data: b64([1, 2, 3, 4]) } })).toBe(1600);
    expect(imageTokens({ source: { type: 'url', url: 'https://x' } })).toBe(1600);
    expect(imageTokens({ source: { type: 'base64', data: 7 } })).toBe(1600);
    expect(imageTokens(null)).toBe(1600);
  });
});
