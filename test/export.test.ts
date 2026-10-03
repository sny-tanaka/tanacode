import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { toChatEvents, type ChatEvent } from '@shared/chat';
import { chatFromEvents, todoSteps, type ChatItem } from '../src/renderer/src/chat/chatState';
import { cssBlocks, usedCss } from '../src/renderer/src/export/exportCss';
import {
  applyOptions,
  changedFiles,
  countContents,
  DEFAULT_EXPORT_OPTIONS,
  exportFileName,
  formatPeriod,
  imageKeys,
  prepareExport,
  promptsOf,
  replaceHome,
  sliceRange,
} from '../src/renderer/src/export/exportContent';
import { ExportDocument } from '../src/renderer/src/export/ExportDocument';
import { SAMPLE_BRANCHES, SAMPLE_CWD, SAMPLE_EVENTS, SAMPLE_HOME } from '../src/renderer/src/export/sampleSession';

// 作業の書き出し（ヘッダーの「作業を書き出す…」）。会話ログから組み立てたチャットの行を、範囲と選んだものに合わせて 1 枚の HTML にする

const ITEMS = chatFromEvents(SAMPLE_EVENTS).items;
const PROMPTS = promptsOf(ITEMS);
const SESSION = { title: '季節限定のバッジ', cwd: SAMPLE_CWD, branches: SAMPLE_BRANCHES, home: SAMPLE_HOME };
const NOW = Date.parse('2026-10-03T15:00:00+09:00');
const STEPS = todoSteps(SAMPLE_EVENTS);

const tool = (items: ChatItem[], id: string) => items.find((i): i is Extract<ChatItem, { kind: 'tool' }> => i.kind === 'tool' && i.id === id);

describe('会話ログの時刻', () => {
  it('発言と応答に、会話ログの時刻が付く（期間と発言の時刻に使う）', () => {
    const timestamp = '2026-10-03T05:05:00.000Z';
    const user = toChatEvents({ type: 'user', uuid: 'u', timestamp, message: { content: 'こんにちは' } }, '/x');
    const reply = toChatEvents({ type: 'assistant', uuid: 'a', timestamp, message: { content: [{ type: 'text', text: 'はい' }] } }, '/x');
    expect(user).toEqual([expect.objectContaining({ type: 'user', at: Date.parse(timestamp) })]);
    expect(reply).toEqual([expect.objectContaining({ type: 'assistant-text', at: Date.parse(timestamp) })]);
  });
});

describe('範囲', () => {
  it('発言を選択肢にする（画像だけの発言も）', () => {
    expect(PROMPTS.map((p) => p.text)).toEqual(['メニューの商品に「季節限定」のバッジを付けて。色は相談させて', 'ありがとう。添付の画面のように、バッジと名前の間を少し空けて', '/commit']);
    expect(promptsOf([{ kind: 'user', id: 'u', text: '', images: ['k'] }])[0].text).toBe('（画像）');
  });

  it('全体は、最初の発言の前の行（起動時のお知らせ）から最後まで', () => {
    expect(sliceRange(ITEMS, PROMPTS, 0, 2)).toEqual(ITEMS);
    expect(sliceRange(ITEMS, PROMPTS, 0, 2)[0]).toEqual(expect.objectContaining({ kind: 'info' }));
  });

  it('途中の発言から途中の発言まで（その発言への応答の終わりまで）', () => {
    const range = sliceRange(ITEMS, PROMPTS, 1, 1);
    expect(range[0]).toEqual(expect.objectContaining({ kind: 'user', id: 'u2' }));
    expect(range.at(-1)).toEqual(expect.objectContaining({ kind: 'divider' }));
    expect(range.some((i) => i.kind === 'user' && i.id !== 'u2')).toBe(false);
  });
});

describe('入るものの数', () => {
  it('発言・応答・操作・ツールの結果（hooks の出力を含む）・差分・画像・思考を数える', () => {
    expect(countContents(ITEMS)).toEqual({ prompts: 3, replies: 5, tools: 15, outputs: 4, diffs: 3, images: 2, thinking: 1 });
  });
});

describe('選んだものを外す', () => {
  const none = { toolOutput: false, diffs: false, images: false, thinking: false, homeToTilde: false };

  it('ツールの結果・差分・画像・思考を外す（変えた行の数と、ツールの入力は残す）', () => {
    const items = applyOptions(ITEMS, none, SAMPLE_HOME);
    expect(countContents(items)).toEqual(expect.objectContaining({ outputs: 0, diffs: 0, images: 0, thinking: 0 }));
    expect(tool(items, 't6')).toEqual(expect.objectContaining({ added: 1, removed: 0, patch: undefined }));
    expect(tool(items, 't6')?.hooks?.[0]).toEqual(expect.objectContaining({ outcome: 'success', stdout: '' }));
    expect(tool(items, 't9')?.input).toContain('npm test');
  });

  it('hooks が Claude に渡した内容・止めた理由も、ツールの結果として数えて外す', () => {
    const run = { event: 'SessionStart', name: 'SessionStart', command: 'cat notes.md', outcome: 'context' as const, exitCode: 0, durationMs: 10, stdout: '', stderr: '', message: '社内のメモ', toolUseId: null };
    const items: ChatItem[] = [{ kind: 'hook', id: 'h', runs: [run] }];
    expect(countContents(items).outputs).toBe(1);
    expect(applyOptions(items, none, SAMPLE_HOME)).toEqual([{ kind: 'hook', id: 'h', runs: [{ ...run, message: '' }] }]);
  });

  it('差分を外すときは、ノートブックの編集の入力（書いた中身）も外す', () => {
    const items: ChatItem[] = [
      { kind: 'tool', id: 'n', name: 'NotebookEdit', target: 'a.ipynb', status: 'done', input: '{"new_source": "秘密"}' },
      { kind: 'tool', id: 'b', name: 'Bash', target: 'ls', status: 'done', input: 'ls' },
    ];
    expect(applyOptions(items, { ...DEFAULT_EXPORT_OPTIONS, diffs: false, homeToTilde: false }, SAMPLE_HOME).map((i) => i.kind === 'tool' && i.input)).toEqual(['', 'ls']);
  });

  it('すべて入れるときは、そのまま', () => {
    expect(applyOptions(ITEMS, { ...DEFAULT_EXPORT_OPTIONS, homeToTilde: false }, SAMPLE_HOME)).toEqual(ITEMS);
  });

  it('ホームフォルダのパスを ~ にする（画像の鍵は変えない）', () => {
    const items = applyOptions(ITEMS, DEFAULT_EXPORT_OPTIONS, SAMPLE_HOME);
    expect(JSON.stringify(items)).not.toContain('/Users/me');
    expect(tool(items, 't3')?.filePath).toBe('~/work/cafe-menu/src/MenuItem.tsx');
    expect(imageKeys(items)).toEqual(['sample:shot', 'sample:attach']);
  });

  it('~ にするのは、ホームフォルダそのものと、その中だけ', () => {
    expect(replaceHome('/Users/me と /Users/me/a と /Users/me2/b と /Users/me.old', '/Users/me')).toBe('~ と ~/a と /Users/me2/b と /Users/me.old');
    expect(replaceHome('cd /Users/me/', '/Users/me/')).toBe('cd ~/');
    expect(replaceHome('/a/b', '/')).toBe('/a/b');
  });

  it('文の終わりの「.」の前は置き換え、パスの途中や URL の中は置き換えない', () => {
    expect(replaceHome('ホームは /Users/me. です', '/Users/me')).toBe('ホームは ~. です');
    expect(replaceHome('/System/Volumes/Data/Users/me/x と https://example.com/Users/me/a', '/Users/me')).toBe('/System/Volumes/Data/Users/me/x と https://example.com/Users/me/a');
  });

  it('Claude Code の会話ログのフォルダ名（/ を - にしたもの）の中の名前も残さない', () => {
    expect(replaceHome('/Users/me.k/.claude/projects/-Users-me-k-work-app/x.jsonl', '/Users/me.k')).toBe('~/.claude/projects/-~-work-app/x.jsonl');
    expect(replaceHome('-Users-me-k2-work', '/Users/me.k')).toBe('-Users-me-k2-work');
  });

  it('ToDo の一覧とセッション名も ~ にする', () => {
    const steps = new Map([['t', [{ content: '/Users/me/notes.md を読む', status: 'pending' }]]]);
    const result = prepareExport([], steps, { ...SESSION, title: '/Users/me/app の修正' }, DEFAULT_EXPORT_OPTIONS, { start: 0, end: 0, total: 1 }, NOW);
    expect(result.meta.title).toBe('~/app の修正');
    expect(result.todoSteps.get('t')?.[0].content).toBe('~/notes.md を読む');
  });
});

describe('先頭に出すもの', () => {
  it('フォルダ・ブランチ・期間・範囲・変えたファイル', () => {
    const { meta } = prepareExport(ITEMS, STEPS, SESSION, DEFAULT_EXPORT_OPTIONS, { start: 0, end: 2, total: 3 }, NOW);
    expect(meta).toEqual({
      title: '季節限定のバッジ',
      cwd: '~/work/cafe-menu',
      branches: ['main'],
      period: { start: Date.parse('2026-10-03T14:05:00+09:00'), end: Date.parse('2026-10-03T14:35:30+09:00') },
      range: '全体（発言 3 件）',
      omitted: [],
      files: [
        { path: 'src/SeasonBadge.tsx', added: 5, removed: 0 },
        { path: 'src/MenuItem.tsx', added: 1, removed: 0 },
        { path: 'src/menu.css', added: 1, removed: 1 },
      ],
      exportedAt: NOW,
    });
  });

  it('発言の範囲と、入れなかったもの（範囲に無いものは書かない）', () => {
    const range = sliceRange(ITEMS, PROMPTS, 2, 2);
    const { meta } = prepareExport(range, STEPS, SESSION, { ...DEFAULT_EXPORT_OPTIONS, toolOutput: false, images: false }, { start: 2, end: 2, total: 3 }, NOW);
    expect(meta.range).toBe('発言 3〜3（全 3 件のうち 1 件）');
    expect(meta.omitted).toEqual(['ツールの結果']);
    expect(meta.files).toEqual([]);
  });

  it('失敗した編集は、変えたファイルに数えない', () => {
    const items: ChatItem[] = [{ kind: 'tool', id: 'e', name: 'Edit', target: 'a.ts', filePath: '/w/a.ts', status: 'error', input: '', added: 3 }];
    expect(changedFiles(items, '/w')).toEqual([]);
  });

  it('期間は、同じ日なら終わりを時刻だけにする', () => {
    const start = new Date(2026, 9, 3, 14, 5).getTime();
    expect(formatPeriod({ start, end: new Date(2026, 9, 3, 16, 40).getTime() })).toBe('2026/10/03 14:05 〜 16:40');
    expect(formatPeriod({ start, end: new Date(2026, 9, 4, 9, 0).getTime() })).toBe('2026/10/03 14:05 〜 2026/10/04 09:00');
  });

  it('ファイル名は、セッション名と日付（使えない文字は空白）', () => {
    expect(exportFileName('API: v2/リトライ', new Date(2026, 9, 3))).toBe('API v2 リトライ 2026-10-03.html');
    expect(exportFileName(null, new Date(2026, 9, 3))).toBe('作業 2026-10-03.html');
  });
});

describe('ToDo の進み具合', () => {
  it('ToDo を変えたツールごとに、変えたあとの一覧を持つ（TaskCreate は結果で番号が分かってから）', () => {
    const steps = todoSteps(SAMPLE_EVENTS);
    expect([...steps.keys()]).toEqual(['t1', 't2', 't4', 't7', 't8', 't12']);
    expect(steps.get('t8')?.map((t) => t.status)).toEqual(['completed', 'in_progress']);
    expect(steps.get('t12')?.map((t) => t.status)).toEqual(['completed', 'completed']);
  });
});

describe('書き出した HTML の中身', () => {
  const render = (items: ChatItem[], images: Map<string, string | null> = new Map()) => {
    const prepared = prepareExport(items, STEPS, SESSION, DEFAULT_EXPORT_OPTIONS, { start: 0, end: 2, total: 3 }, NOW);
    // Markdown の整形は DOM が要るので、ここでは文字をそのまま出す
    const markdown = (text: string) => `<p>${text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)}</p>`;
    return renderToStaticMarkup(createElement(ExportDocument, { meta: prepared.meta, items: prepared.items, todoSteps: prepared.todoSteps, images, markdown }));
  };

  it('ツールの呼び出しは「N件の操作」に畳み、カードも hooks も <details> で開く（JavaScript を使わない）', () => {
    const html = render(ITEMS);
    expect(html).toContain('<details class="tool-group export-group"><summary class="tool-group-head">');
    expect(html).toContain('9件の操作');
    expect(html).toContain('<details class="export-tool">');
    expect(html).toContain('<details class="hook-run export-hook success">');
    expect(html).not.toMatch(/<script|<button|\son[a-z]+=/i);
  });

  it('差分・質問と答え・ToDo の進み具合・届いたファイル・発言の時刻が入る', () => {
    const html = render(ITEMS);
    expect(html).toContain('<span class="add">+      {item.seasonal &amp;&amp; &lt;SeasonBadge /&gt;}');
    expect(html).toContain('バッジの色はどれにしますか？');
    expect(html).toContain('→ 桜色（推奨）');
    expect(html).toContain('<span class="todo-count">1/2</span>');
    expect(html).toContain('直す前と後の比較です');
    expect(html).toContain('<time class="export-time" dateTime="2026-10-03T05:05:00.000Z">10/03 14:05</time>');
  });

  it('画像は中に入れ、読めなかったものはそう書く', () => {
    const html = render(ITEMS, new Map([['sample:shot', 'data:image/png;base64,AAAA'], ['sample:attach', null]]));
    expect(html).toContain('<summary class="chat-image" aria-label="画像を拡大"><img src="data:image/png;base64,AAAA" alt=""/></summary>');
    expect(html).toContain('画像（読み込めません）');
  });

  it('発言や結果に混ざった HTML は、文字として出す', () => {
    const items: ChatEvent[] = [
      { type: 'user', id: 'u', text: '<img src=x onerror=alert(1)>' },
      { type: 'tool-use', id: 't', name: 'Bash', target: 'echo', input: 'echo "<script>alert(1)</script>"' },
      { type: 'tool-result', id: 't', isError: false, output: '<script>alert(1)</script>' },
      { type: 'turn-end' },
    ];
    const html = render(chatFromEvents(items).items);
    expect(html).not.toMatch(/<script|<img src=x/);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('書き出しに入れる CSS', () => {
  const CSS = `
/* コメントは捨てる */
:root { --bg: #111; }
.used { background: var(--grad) 0 0 / 200% 100%; -webkit-background-clip: text; }
.unused { color: red; }
.used:hover, .other { color: blue; }
@media (prefers-reduced-motion: reduce) { .used { transition: none; } .unused { transition: none; } }
@media print { .unused { display: none; } }
@font-face { font-family: X; src: url(x.woff2); }
@keyframes spin { to { transform: rotate(1turn); } }
.nested { transition: opacity 0.2s; @starting-style { opacity: 0; } }
.quote::before { content: '{'; }
`;

  it('当たる規則だけを、元の文字のまま抜き出す（var() の一括指定の後ろの個別の指定も消えない）', () => {
    const used = new Set([':root', '.used', '.used:hover, .other', '.nested', '.quote::before']);
    const css = usedCss(CSS, (selector) => used.has(selector));
    expect(css).toContain('.used { background: var(--grad) 0 0 / 200% 100%; -webkit-background-clip: text; }');
    expect(css).toContain(':root { --bg: #111; }');
    expect(css).toContain('.used:hover, .other { color: blue; }');
    expect(css).toContain('@media (prefers-reduced-motion: reduce) {\n.used { transition: none; }\n}');
    expect(css).toContain('@starting-style { opacity: 0; }');
    expect(css).toContain("content: '{';");
    expect(css).not.toMatch(/unused|@font-face|@keyframes|@media print|コメント/);
  });

  it('いちばん外側の規則ごとに分ける', () => {
    expect(cssBlocks('a { b: c; } @media x { d { e: f; } }').map((b) => b.prelude)).toEqual(['a', '@media x']);
  });
});
