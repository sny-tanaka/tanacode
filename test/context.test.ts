import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TranscriptEntry } from '@shared/chat';
import { clip, compactInstructions, toolDisplayName, type CompactMark, type ContextItem } from '@shared/context';
import { setLanguage } from '@shared/i18n';
import { promptKeys } from '@shared/prompt-keys';
import { ContextTracker, estimateTokens } from '../src/main/context-tracker';
import { VERIFIED_CLAUDE_CODE_VERSION } from '@shared/claude-code';

// コンテキストの中身（ContextTracker）と、圧縮の指示の組み立て（compactInstructions）

const CWD = '/work/app';
let seq = 0;
let last: string | null = null;

// 会話ログの行を、前の行を親にして作る
function row(entry: TranscriptEntry & Record<string, unknown>, parent: string | null | undefined = last): TranscriptEntry {
  const uuid = `u${++seq}`;
  last = uuid;
  return { uuid, parentUuid: parent, ...entry };
}
const prompt = (text: string, parent?: string | null) => row({ type: 'user', message: { content: text } }, parent);
const reply = (id: string, output: number, input: number, blocks: unknown[]) =>
  row({
    type: 'assistant',
    message: { id, content: blocks, usage: { input_tokens: input, output_tokens: output } } as TranscriptEntry['message'],
  });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });
const result = (toolUseId: string, content: unknown, toolUseResult?: unknown) =>
  row({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] as never }, toolUseResult });

function track(entries: TranscriptEntry[]): ContextItem[] {
  const tracker = new ContextTracker(CWD);
  for (const e of entries) tracker.handle(e);
  return tracker.current().items;
}
const find = (items: ContextItem[], label: string) => items.find((i) => i.label === label);

describe('ContextTracker', () => {
  it('読んだファイル・大きなツールの結果・発言ごとのやりとりに分ける', () => {
    last = null;
    const big = 'x'.repeat(22_000);
    const items = track([
      prompt('設計を読んで'),
      reply('m1', 50, 30_000, [toolUse('t1', 'Read', { file_path: `${CWD}/src/design.md` })]),
      result('t1', '1\t# 設計\n2\t親子は parentId で持つ'),
      reply('m2', 40, 30_100, [toolUse('t2', 'Bash', { command: 'npm install' })]),
      result('t2', big),
      reply('m3', 30, 40_200, [toolUse('t3', 'Bash', { command: 'ls' })]),
      result('t3', 'a.ts\nb.ts'),
      reply('m4', 20, 40_300, [{ type: 'text', text: 'できました' }]),
    ]);
    expect(find(items, 'src/design.md')).toMatchObject({ kind: 'file', edited: false, compacted: false });
    // 大きな結果は 1 行に。応答の使用量の差（40,200 − 30,100 − 40）で直した大きさになる
    expect(find(items, 'npm install')).toMatchObject({ kind: 'tool', tool: 'Bash', tokens: 10_060 });
    // 小さな結果と応答（出力トークン数）は、発言のやりとりにまとめる
    const topic = find(items, '設計を読んで')!;
    expect(topic.kind).toBe('topic');
    expect(items.some((i) => i.label === 'ls')).toBe(false);
    expect(topic.tokens).toBeGreaterThanOrEqual(50 + 40 + 30 + 20);
  });

  it('書いたファイルは、書いた中身を応答からそのファイルの行に移す', () => {
    last = null;
    const content = 'y'.repeat(2200);
    const items = track([
      prompt('作って'),
      reply('m1', 1100, 20_000, [toolUse('w1', 'Write', { file_path: `${CWD}/a.ts`, content })]),
      result('w1', 'File created'),
    ]);
    const file = find(items, 'a.ts')!;
    expect(file.edited).toBe(true);
    expect(file.tokens).toBeGreaterThan(1000);
    expect(find(items, '作って')!.tokens).toBeLessThan(200);
  });

  it('サブエージェントの結果は、完了の知らせも起動した行にまとめる', () => {
    last = null;
    const report = 'r'.repeat(4400);
    const items = track([
      prompt('調べて'),
      reply('m1', 30, 20_000, [toolUse('a1', 'Agent', { description: '在庫の持ち方を調査', prompt: '…' })]),
      result('a1', 'Async agent launched', { status: 'async_launched', agentId: 'ag1' }),
      row({
        type: 'user',
        origin: { kind: 'task-notification' },
        message: { content: `<task-notification><tool-use-id>a1</tool-use-id><summary>終わりました</summary><result>${report}</result></task-notification>` },
      }),
    ]);
    const agent = items.find((i) => i.kind === 'agent')!;
    expect(agent.label).toBe('在庫の持ち方を調査');
    expect(agent.tokens).toBeGreaterThan(2000);
    // 待機中に届いた知らせは、新しいやりとりになる
    expect(items.some((i) => i.kind === 'topic' && i.label.startsWith('知らせ: 終わりました'))).toBe(true);
  });

  it('質問への答えで、やりとりを区切る', () => {
    last = null;
    const items = track([
      prompt('どちらにする?'),
      reply('m1', 30, 20_000, [toolUse('q1', 'AskUserQuestion', { questions: [] })]),
      result('q1', 'answered', { questions: [{ question: 'どれ?' }], answers: { 'どれ?': '在庫の数で持つ' } }),
      reply('m2', 500, 20_100, [{ type: 'text', text: '了解' }]),
    ]);
    expect(find(items, '質問への答え: 在庫の数で持つ')?.tokens).toBeGreaterThanOrEqual(500);
  });

  it('圧縮より前のものは compacted。そのまま残された行と、圧縮のあとに添付し直されたファイルは今のもの', () => {
    last = null;
    const before = [
      prompt('最初の発言'),
      reply('m1', 30, 20_000, [toolUse('t1', 'Read', { file_path: `${CWD}/old.ts` })]),
      result('t1', 'old'),
    ];
    const kept = reply('m2', 25, 20_100, [{ type: 'text', text: '読みました' }]);
    const items = track([
      ...before,
      kept,
      // 圧縮を送った時点の発言（アプリから送ると、この形でも残る）
      prompt('/compact 設計は残す\n手で足した行'),
      row({ type: 'system', subtype: 'compact_boundary', compactMetadata: { preservedMessages: { allUuids: [kept.uuid] } } } as never, null),
      row({ type: 'user', isCompactSummary: true, message: { content: 'Summary: これまでの要約' } }),
      row({ type: 'user', message: { content: '<command-name>/compact</command-name><command-args>設計は残す</command-args>' } }),
      row({ type: 'attachment', attachment: { type: 'file', filename: `${CWD}/old.ts`, content: { file: { content: 'old' } } } }),
      prompt('次の発言'),
    ]);
    expect(items.find((i) => i.id === 'compacted:file:old.ts')?.compacted).toBe(true);
    expect(items.find((i) => i.id === 'file:old.ts')?.compacted).toBe(false);
    // そのまま残された応答は、圧縮より前のやりとりの名前のまま、今のものとして数える
    expect(items.find((i) => i.label === '最初の発言' && !i.compacted)?.tokens).toBe(25);
    // 圧縮のコマンドの記録は、要約の行に入る（やりとりにしない）
    expect(items.find((i) => i.kind === 'summary')?.compacted).toBe(false);
    expect(items.some((i) => i.label.includes('/compact'))).toBe(false);
    expect(find(items, '次の発言')?.compacted).toBe(false);
  });

  it('巻き戻した発言から後ろは捨てる', () => {
    last = null;
    const first = prompt('一つ目');
    const r1 = reply('m1', 30, 20_000, [toolUse('t1', 'Read', { file_path: `${CWD}/kept.ts` })]);
    const kept = result('t1', 'kept');
    const items = track([
      first,
      r1,
      kept,
      prompt('二つ目'),
      reply('m2', 30, 20_100, [toolUse('t2', 'Read', { file_path: `${CWD}/dropped.ts` })]),
      result('t2', 'dropped'),
      // 二つ目の発言の前（一つ目の結果）まで戻して、言い直す
      prompt('言い直し', kept.uuid),
    ]);
    expect(items.map((i) => i.label)).toEqual(expect.arrayContaining(['一つ目', 'kept.ts', '言い直し']));
    expect(items.some((i) => i.label === 'dropped.ts' || i.label === '二つ目')).toBe(false);
  });

  it('Claude Code が足す一覧や環境の知らせは、一覧に出さない（「そのほか」に入る）。hooks が足した文はやりとりに入れる', () => {
    last = null;
    const items = track([
      prompt('始めます'),
      row({ type: 'attachment', attachment: { type: 'skill_listing', content: 's'.repeat(5000) } }),
      row({ type: 'attachment', attachment: { type: 'deferred_tools_delta', addedLines: ['t'.repeat(3000)] } }),
      row({ type: 'attachment', attachment: { type: 'hook_additional_context', content: ['h'.repeat(220)] } }),
    ]);
    expect(items.map((i) => i.label)).toEqual(['始めます']);
    // 発言（4 字）と hooks の文（220 字 ≒ 100）だけ
    expect(find(items, '始めます')!.tokens).toBe(Math.round(4 * 1.07 + 100));
  });

  it('書いた中身は、その応答の出力より多くは移さない', () => {
    last = null;
    const items = track([
      prompt('前置き'),
      reply('m0', 500, 20_000, [{ type: 'text', text: '説明' }]),
      reply('m1', 300, 20_600, [toolUse('w1', 'Write', { file_path: `${CWD}/b.md`, content: 'あ'.repeat(1000) })]),
    ]);
    expect(find(items, 'b.md')!.tokens).toBe(300);
    expect(find(items, '前置き')!.tokens).toBeGreaterThanOrEqual(500);
  });

  it('同じ uuid の発言の行がもう一度書かれても、そこから後ろを捨てない', () => {
    last = null;
    const first = prompt('最初');
    const r1 = reply('m1', 30, 20_000, [toolUse('t1', 'Read', { file_path: `${CWD}/a.ts` })]);
    const res = result('t1', 'a');
    const items = track([first, r1, res, prompt('次'), { ...first }]);
    expect(items.map((i) => i.label)).toEqual(expect.arrayContaining(['最初', 'a.ts', '次']));
  });

  it('発言の中に <task-notification> の文字があっても、知らせとして扱わない', () => {
    last = null;
    const items = track([prompt('このログを見て: <task-notification><summary>x</summary></task-notification>')]);
    expect(items[0].label.startsWith('このログを見て')).toBe(true);
  });

  it('発言に添付した画像は、発言の冒頭と何枚目かで名前を付ける', () => {
    last = null;
    const png = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==' } };
    const items = track([row({ type: 'user', message: { content: [{ type: 'text', text: 'この画面を直して' }, png, png] as never } })]);
    expect(items.filter((i) => i.kind === 'image').map((i) => i.label)).toEqual([
      '「この画面を直して」に添付した画像 1 枚目',
      '「この画面を直して」に添付した画像 2 枚目',
    ]);
  });

  it('同じ応答（message.id）の行は、出力トークン数を 1 回だけ数える', () => {
    last = null;
    const items = track([
      prompt('並べて'),
      reply('m1', 300, 20_000, [{ type: 'thinking', thinking: '' }]),
      reply('m1', 300, 20_000, [{ type: 'text', text: 'はい' }]),
    ]);
    expect(find(items, '並べて')!.tokens).toBeLessThan(320);
  });

  it('動作確認済の Claude Code の会話ログを読める', () => {
    const file = join('test', 'fixtures', 'claude-code', VERIFIED_CLAUDE_CODE_VERSION, 'transcript.jsonl');
    const tracker = new ContextTracker(CWD);
    for (const line of readFileSync(file, 'utf8').split('\n')) if (line.trim()) tracker.handle(JSON.parse(line) as TranscriptEntry);
    const items = tracker.current().items;
    expect(items.some((i) => i.kind === 'topic')).toBe(true);
    expect(items.every((i) => Number.isFinite(i.tokens) && i.tokens >= 0)).toBe(true);
  });
});

describe('estimateTokens', () => {
  it('日本語はおよそ 1 文字 1 トークン、英数字はおよそ 2.2 文字で 1 トークン', () => {
    expect(estimateTokens('あいうえお')).toBeCloseTo(5.35);
    expect(estimateTokens('a'.repeat(22))).toBeCloseTo(10);
  });
});

describe('compactInstructions', () => {
  afterEach(() => setLanguage('ja'));
  const at = (kind: ContextItem['kind'], label: string, order: number, extra: Partial<ContextItem> = {}): ContextItem => ({
    id: `${kind}:${label}`,
    kind,
    label,
    tokens: 100,
    order,
    compacted: false,
    ...extra,
  });
  const items = [
    at('file', 'src/main/session-manager.ts', 0),
    at('topic', '親子の記録の決めごと', 1),
    at('tool', 'npm install', 2, { tool: 'Bash' }),
    at('topic', 'ポートの衝突を調べて', 3),
    at('agent', '在庫の持ち方を調査', 4),
    at('image', '.menu', 5, { tool: 'mcp__tanacode-browser__screenshot' }),
    at('file', 'old.ts', 6, { compacted: true }),
  ];
  const marks = (entries: [string, CompactMark][]) => new Map(entries);

  it('残す・捨てるの印を、決まった形の文にする', () => {
    const text = compactInstructions(
      items,
      marks([
        ['file:src/main/session-manager.ts', 'keep'],
        ['topic:親子の記録の決めごと', 'keep'],
        ['tool:npm install', 'drop'],
        ['topic:ポートの衝突を調べて', 'drop'],
        ['image:.menu', 'drop'],
      ]),
    );
    expect(text).toBe(
      '`src/main/session-manager.ts` の内容と、「親子の記録の決めごと」から始まるやりとりは詳しく残す。' +
        '`npm install` の出力、「ポートの衝突を調べて」から始まるやりとり、tanacode-browser の screenshot の画像（.menu）は捨ててよい。',
    );
  });

  it('英語では、文の間に空白を入れ、3 つ以上は最後を and でつなぐ。発言に添付した画像の名前は、文の途中の形にする', () => {
    setLanguage('en');
    const english = [
      at('file', 'src/a.ts', 0),
      at('topic', 'Answered: Keep stock counts', 1),
      at('tool', 'npm install', 2, { tool: 'Bash' }),
      at('topic', 'Notice: Agent finished', 3),
      at('image', 'Image 2 attached to “Fix this screen”', 4),
    ];
    const text = compactInstructions(
      english,
      marks([
        ['file:src/a.ts', 'keep'],
        ['topic:Answered: Keep stock counts', 'keep'],
        ['tool:npm install', 'drop'],
        ['topic:Notice: Agent finished', 'drop'],
        ['image:Image 2 attached to “Fix this screen”', 'drop'],
      ]),
    );
    expect(text).toBe(
      'Keep the contents of `src/a.ts` and the exchange after I answered “Keep stock counts” in detail. ' +
        'You can drop the output of `npm install`, the exchange after the notification “Agent finished”, and image 2 attached to “Fix this screen”.',
    );
  });

  it('印が無ければ空。圧縮より前のものの印は使わない', () => {
    expect(compactInstructions(items, marks([]))).toBe('');
    expect(compactInstructions(items, marks([['file:old.ts', 'keep']]))).toBe('');
    expect(compactInstructions(items, marks([['agent:在庫の持ち方を調査', 'keep']]))).toBe('サブエージェント「在庫の持ち方を調査」の結果は詳しく残す。');
  });

  it('質問への答え・知らせで区切ったやりとりは、その出来事のあとのやりとりと書く', () => {
    const topics = [at('topic', '質問への答え: 在庫の数で持つ (推奨)', 0), at('topic', '知らせ: Agent "調査" finished', 1)];
    expect(compactInstructions(topics, marks(topics.map((t) => [t.id, 'keep'])))).toBe(
      '質問に「在庫の数で持つ (推奨)」と答えたあとのやりとりと、「Agent "調査" finished」の知らせのあとのやりとりは詳しく残す。',
    );
  });

  it('種類ごとの言い方: 書いたファイル・要約・区切りの出来事・ツールの種類・MCP のツール・画像', () => {
    const kinds = [
      at('file', 'src/a.ts', 0, { edited: true }),
      at('summary', '前回の要約', 1),
      at('topic', '別の Claude からの知らせ', 2),
      at('topic', '会話の始まり', 3),
      // 起動した行が分からないタスクの完了の知らせ（ツールの名前が無い）
      at('tool', 'タスク X が終わりました', 4),
      at('tool', 'TODO', 5, { tool: 'Grep' }),
      at('tool', 'tanacode 使い方', 6, { tool: 'WebSearch' }),
      at('tool', 'src/**/*.ts', 7, { tool: 'Glob' }),
      at('tool', 'https://example.com/', 8, { tool: 'WebFetch' }),
      at('tool', 'review', 9, { tool: 'Skill' }),
      at('tool', 'ui.tsx', 10, { tool: 'mcp__tanacode-browser__click' }),
      at('tool', '', 11, { tool: 'TodoWrite' }),
      at('image', '', 12, { tool: 'Read' }),
      // 発言に添付した画像（ツールが無い）は、名前をそのまま
      at('image', '「画面を見て」の画像 1', 13),
    ];
    expect(compactInstructions(kinds, marks(kinds.map((k) => [k.id, 'drop'])))).toBe(
      [
        '`src/a.ts` の内容と変更',
        '前回の圧縮の要約',
        '別の Claude からの知らせのやりとり',
        '会話の始まりのやりとり',
        '「タスク X が終わりました」の知らせ',
        '「TODO」の検索結果',
        '「tanacode 使い方」の検索結果',
        '「src/**/*.ts」に合うファイルの一覧',
        'https://example.com/ のページの内容',
        'スキル「review」の内容',
        'tanacode-browser の click（ui.tsx）の結果',
        'TodoWrite の結果',
        'Read の画像',
        '「画面を見て」の画像 1',
      ].join('、') + 'は捨ててよい。',
    );
  });

  it('印は会話の順に並べる。長い名前・複数行の名前は、1 行にして 60 文字で切る', () => {
    const long = at('topic', 'あ'.repeat(70), 2);
    const multi = at('topic', '複数\n行の   発言', 1);
    expect(compactInstructions([long, multi], marks([[long.id, 'keep'], [multi.id, 'keep']]))).toBe(
      `「複数 行の 発言」から始まるやりとりと、「${'あ'.repeat(59)}…」から始まるやりとりは詳しく残す。`,
    );
    expect(clip('  前後の空白  ', 10)).toBe('前後の空白');
    // 上限ちょうどは切らない
    expect(clip('あ'.repeat(60), 60)).toBe('あ'.repeat(60));
    expect(toolDisplayName('Bash')).toBe('Bash');
    // 先頭が mcp__ でなければ、MCP のツールとして読まない
    expect(toolDisplayName('x_mcp__a__b')).toBe('x_mcp__a__b');
    // 区切りの出来事の名前は、先頭にあるときだけ（発言の途中の「質問への答え:」「知らせ:」は、ふつうの発言）
    const quoted = [at('topic', 'メモ: 質問への答え: A', 0), at('topic', '次の知らせ: B', 1)];
    expect(compactInstructions(quoted, marks(quoted.map((t) => [t.id, 'keep'])))).toBe('「メモ: 質問への答え: A」から始まるやりとりと、「次の知らせ: B」から始まるやりとりは詳しく残す。');
    expect(toolDisplayName('mcp__tanacode-sessions__list_sessions')).toBe('tanacode-sessions の list_sessions');
  });
});

describe('promptKeys', () => {
  it('引数が複数行の /compact は、名前を打鍵して引数を貼り付ける', () => {
    expect(promptKeys('/compact 残す\n捨てる')).toBe('/compact \x1b[200~残す\n捨てる\x1b[201~');
    // 長い 1 行も、貼り付けとみなされる前に引数だけ貼り付ける
    const long = `/compact ${'あ'.repeat(900)}`;
    expect(promptKeys(long)).toBe(`/compact \x1b[200~${'あ'.repeat(900)}\x1b[201~`);
    expect(promptKeys('/compact 短い指示')).toBe('/compact 短い指示');
  });

  it('/compact 以外の「/単語」で始まる発言・パスで始まる発言・ふつうの発言は、今までどおり丸ごと貼り付ける', () => {
    // 名前を打鍵すると、Claude Code がコマンドとして実行してしまう（/clear など）
    expect(promptKeys('/api のエンドポイントを直して\n詳しく')).toBe('\x1b[200~/api のエンドポイントを直して\n詳しく\x1b[201~');
    expect(promptKeys('/clear は何をしますか?\n詳しく')).toBe('\x1b[200~/clear は何をしますか?\n詳しく\x1b[201~');
    expect(promptKeys('/Users/me/a.ts を見て\n直して')).toBe('\x1b[200~/Users/me/a.ts を見て\n直して\x1b[201~');
    expect(promptKeys('一行目\n二行目')).toBe('\x1b[200~一行目\n二行目\x1b[201~');
    expect(promptKeys('一行')).toBe('一行');
  });
});
