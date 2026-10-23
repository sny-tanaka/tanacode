// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { Profiler } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '@shared/ipc';
import { App } from '../../src/renderer/src/App';
import './dom';
import { mockApi } from './mock-api';
import { renderCounts, rendersOf } from './render-count';

// Claude の応答中やチャットの入力で、関係の無い部品まで描き直していないかを、描き直しの回数で確かめる。
// 部品を数えるものに包み（中身と memo のしかたは元のまま）、App 全体を描いてから、配信や打鍵の前後で数を比べる。
// エディタ（Monaco）は jsdom では動かないので、小さな偽物に差し替える

vi.mock('../../src/renderer/src/editor/monaco', () => {
  const disposable = () => ({ dispose() {} });
  // 偽物に無いもの（知らせの受け手など）は、何もせず、外せるものを返す
  const lenient = <T extends object>(base: T): T =>
    new Proxy(base, {
      get: (target, key) => (key in target ? target[key as keyof T] : typeof key !== 'string' || key === 'then' ? undefined : () => disposable()),
    });
  const model = (value: string) => lenient({ getValue: () => value, getLineCount: () => value.split('\n').length, dispose() {} });
  return {
    monaco: {
      editor: {
        create: () => lenient({ createDecorationsCollection: () => ({ set() {}, clear() {} }), getModel: () => null, setModel() {}, getPosition: () => ({ lineNumber: 1, column: 1 }), getLayoutInfo: () => ({ contentWidth: 800 }) }),
        createDiffEditor: () => lenient({}),
        createModel: (text: string) => model(text),
        setTheme() {},
        colorize: (text: string) => Promise.resolve(text),
        ScrollType: { Smooth: 0, Immediate: 1 },
        OverviewRulerLane: { Left: 1 },
        MouseTargetType: { GUTTER_GLYPH_MARGIN: 2 },
        ContentWidgetPositionPreference: { EXACT: 0, ABOVE: 1, BELOW: 2 },
      },
      Range: class {},
      KeyMod: { CtrlCmd: 2048 },
      KeyCode: { KeyS: 49 },
      languages: { getLanguages: () => [] },
    },
    editorTheme: () => 'tanacode-test',
    languageFor: () => 'typescript',
    languageLabel: (id: string) => id,
  };
});

// 数える部品（モジュールごとに、名前の書き出しを包む）
const counted = vi.hoisted(() => (names: string[]) => async (importOriginal: () => Promise<Record<string, unknown>>) => {
  const original = await importOriginal();
  const { countRenders } = await import('./render-count');
  return { ...original, ...Object.fromEntries(names.map((name) => [name, countRenders(name, original[name])])) };
});
vi.mock('../../src/renderer/src/layout/TitleBar', counted(['TitleBar']));
vi.mock('../../src/renderer/src/layout/columns', counted(['Resizer']));
vi.mock('../../src/renderer/src/sessions/Sidebar', counted(['Sidebar']));
vi.mock('../../src/renderer/src/StatusBar', counted(['StatusBar']));
vi.mock('../../src/renderer/src/editor/EditorPane', counted(['EditorPane']));
vi.mock('../../src/renderer/src/explorer/Explorer', counted(['Explorer']));
vi.mock('../../src/renderer/src/preview/PreviewPane', counted(['PreviewPane']));
vi.mock('../../src/renderer/src/terminal/TerminalPanel', counted(['TerminalPanel']));
vi.mock('../../src/renderer/src/knowledge/ContextPanel', counted(['SessionContextPanel']));
vi.mock('../../src/renderer/src/chat/ClaudePane', counted(['ClaudePane']));
vi.mock('../../src/renderer/src/chat/ChatRow', counted(['ChatRow', 'PartialRow']));
vi.mock('../../src/renderer/src/chat/ChatRows', counted(['ChatRows', 'PartialRows']));
vi.mock('../../src/renderer/src/chat/ChatInput', counted(['ChatInput']));

const SESSION: SessionSummary = {
  id: 's1',
  title: 'パンの話',
  cwd: '/repo',
  archived: false,
  createdAt: 0,
  updatedAt: 0,
  running: true,
  state: 'working',
  mode: 'manual',
  unread: false,
  attention: null,
  backgroundTasks: 0,
  model: null,
  effort: null,
  settingsFile: null,
  remoteControl: false,
  worktree: null,
};

let api: ReturnType<typeof mockApi>;
beforeEach(() => {
  api = mockApi({
    'sessions.list': () => Promise.resolve([SESSION]),
    'sessions.snapshot': () => Promise.resolve({ sessionId: 's1', fromSeq: 0, events: [] }),
    'workspace.info': () => Promise.resolve({ root: '/repo', name: 'repo', branch: 'main' }),
    'workspace.watchOpenFiles': () => () => {},
    'walkthrough.viewing': () => () => {},
    'walkthrough.list': () => Promise.resolve([]),
    'browser.asks': () => Promise.resolve([]),
    'workflows.get': () => Promise.resolve([]),
    'subagents.get': () => Promise.resolve([]),
    'tasks.bash': () => Promise.resolve([]),
    'checklist.get': () => Promise.resolve([]),
    'checklist.unread': () => Promise.resolve({}),
  });
  api.install();
  vi.stubGlobal('__APP_VERSION__', '1.0.0');
  renderCounts.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const settle = () => act(async () => {});

// 名前ごとの、count を呼んだときからの描き直しの回数
function count(): () => Record<string, number> {
  const before = new Map(renderCounts);
  return () => Object.fromEntries([...renderCounts].map(([name, n]) => [name, n - (before.get(name) ?? 0)]).filter(([, n]) => n !== 0));
}
// 画面に書き出した回数（React の commit）
let commits = 0;

// 会話（発言・本文・ツールを 60 行）を出したところまで進める。次の配信の通し番号を返す
async function open(): Promise<number> {
  render(
    <Profiler id="app" onRender={() => (commits += 1)}>
      <App />
    </Profiler>,
  );
  for (let i = 0; i < 3; i++) await settle();
  const events = Array.from({ length: 60 }, (_, n) =>
    n % 3 === 0
      ? { type: 'user', id: `u${n}`, text: `質問 ${n}` }
      : n % 3 === 1
        ? { type: 'assistant-text', id: `a${n}`, text: `答え ${n}` }
        : { type: 'tool-use', id: `t${n}`, name: 'Read', target: `src/f${n}.ts`, input: '{}' },
  );
  act(() => api.emit('sessions.onChat', { sessionId: 's1', fromSeq: 0, events, live: true }));
  await settle();
  expect(rendersOf('ClaudePane')).toBeGreaterThan(0);
  return events.length;
}

const partialOf = (text: string) => [{ id: 'm:0', kind: 'text', text }];

describe('Claude の応答中の描き直し', () => {
  it('書いている途中の文だけの配信では、途中の文の行だけを描き直す（App・チャットの画面・ほかの部品は描き直さない）', async () => {
    const seq = await open();
    const counted = count();
    for (let i = 1; i <= 20; i++) act(() => api.emit('sessions.onChat', { sessionId: 's1', fromSeq: seq, events: [], live: true, partial: partialOf('パン'.repeat(i)) }));
    await settle();
    expect(document.querySelector('.chat-partial-text')?.textContent).toBe('パン'.repeat(20));
    expect(counted()).toEqual({ PartialRows: 20, PartialRow: 20 });
  });

  it('途中の文が外れて本文になる配信では、1 回の書き出しで入れ替える（途中の文も本文も無い画面を挟まない）。チャットの外の部品は描き直さない', async () => {
    const seq = await open();
    act(() => api.emit('sessions.onChat', { sessionId: 's1', fromSeq: seq, events: [], live: true, partial: partialOf('パンは小麦から') }));
    await settle();
    const counted = count();
    const before = commits;
    act(() => api.emit('sessions.onChat', { sessionId: 's1', fromSeq: seq, events: [{ type: 'assistant-text', id: 'done', text: 'パンは小麦から' }], live: true, partial: [] }));
    await settle();
    // jsdom の act の中では優先度の違う描き直しもまとめて流れるので、ちらつきそのものは見分けられない。書き出しが 1 回であることだけを確かめる
    expect(commits - before).toBe(1);
    expect(document.querySelector('.chat-partial-text')).toBeNull();
    expect([...document.querySelectorAll('.chat-response')].at(-1)?.textContent).toContain('パンは小麦から');
    // コンテキストの欄は、会話の行の数で読み直す
    expect(counted()).toEqual({ ClaudePane: 1, ChatRows: 1, ChatRow: 1, PartialRows: 1, ChatInput: 1, SessionContextPanel: 1 });
  });

  it('チャット欄で打っても、会話の行の一覧とチャットの外の部品は描き直さない', async () => {
    await open();
    const textarea = document.querySelector<HTMLTextAreaElement>('.chat-input-wrap textarea')!;
    const counted = count();
    for (let i = 1; i <= 10; i++) fireEvent.change(textarea, { target: { value: 'あ'.repeat(i) } });
    await settle();
    expect(textarea.value).toBe('あ'.repeat(10));
    expect(counted()).toEqual({ ClaudePane: 10, ChatInput: 10 });
  });

  it('statusLine・knowledge が、画面に出すものは同じまま届いても、描き直さない', async () => {
    await open();
    const info = (at: number) => ({
      model: { id: 'opus', name: 'Opus' },
      effort: null,
      version: '2',
      context: { size: 200000, usedPercent: 10, tokens: 20000 },
      rateLimits: null,
      costUsd: at,
      transcriptPath: null,
      updatedAt: at,
    });
    act(() => api.emit('statusLine.onChanged', { sessionId: 's1', info: info(0) }));
    act(() => api.emit('knowledge.onChanged', { sessionId: 's1', knowledge: { files: {}, contextTokens: 100 } }));
    await settle();
    let counted = count();
    for (let i = 1; i <= 5; i++) act(() => api.emit('statusLine.onChanged', { sessionId: 's1', info: info(i) }));
    await settle();
    expect(counted()).toEqual({});
    counted = count();
    for (let i = 1; i <= 5; i++) act(() => api.emit('knowledge.onChanged', { sessionId: 's1', knowledge: { files: {}, contextTokens: 100 } }));
    await settle();
    // コンテキストの欄は、knowledge の知らせで自分で読み直す（App が描き直したのではない）
    expect(counted()).toEqual({ SessionContextPanel: 5 });
    // 画面に出すもの（コンテキストの量）が変わったら描き直す
    counted = count();
    act(() => api.emit('statusLine.onChanged', { sessionId: 's1', info: { ...info(9), context: { size: 200000, usedPercent: 20, tokens: 40000 } } }));
    await settle();
    expect(counted()).toMatchObject({ ClaudePane: 1, SessionContextPanel: 1 });
  });

  it('チャットに関係の無いもので App を描き直しても、チャットの画面は描き直さない', async () => {
    await open();
    const counted = count();
    act(() => api.emit('checklist.onChanged', { sessionId: 's1', lists: [] }));
    await settle();
    expect(counted()).toEqual({});
  });
});
