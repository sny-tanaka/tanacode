// @vitest-environment jsdom
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HookRun } from '@shared/chat';
import { ChatRow } from '../../src/renderer/src/chat/ChatRow';
import type { ChatItem } from '../../src/renderer/src/chat/chatState';
import { HookGroupRow } from '../../src/renderer/src/chat/HookGroupRow';
import { TodoPanel } from '../../src/renderer/src/chat/TodoPanel';
import { ToolCard } from '../../src/renderer/src/chat/ToolCard';
import type { HookGroup } from '../../src/renderer/src/chat/toolGroups';
import { useOpenChecklistCard, type CardTarget } from '../../src/renderer/src/checklist/openCard';
import { resetBlockTranslation } from '../../src/renderer/src/translate/BlockTranslation';
import { useOpenWalkthroughTarget } from '../../src/renderer/src/walkthrough/openWalkthrough';
import type { WalkthroughToolTarget } from '@shared/walkthrough-tools';
import './dom';
import { mockApi } from './mock-api';

// チャットの行（発言・応答・思考・知らせ・ツールのカード・hooks・Todo）のボタンを押して、押した先に効くかを確かめる。
// 開く先（ファイル・セッション・チェックリストのカード・ウォークスルー）を受け取る行は、描き直して先を変えた直後に押しても、新しい先に効くか

let api: ReturnType<typeof mockApi>;
beforeEach(() => {
  api = mockApi({
    // 画像の鍵から data URL を返す（鍵ごとに違うので、どの画像を出したか分かる）
    'sessions.image': (key: never) => Promise.resolve(`data:image/png;base64,${key as string}`),
  });
  api.install();
  resetBlockTranslation();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type RowProps = ComponentProps<typeof ChatRow>;
const noop = () => {};
function rowProps(item: ChatItem, over: Partial<RowProps> = {}): RowProps {
  return { item, workflows: new Map(), subagents: new Map(), bashTasks: new Map(), onRewind: null, onOpenFile: noop, onOpenTask: null, ...over };
}

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;
const tool = (over: Partial<ToolItem>): ToolItem => ({ kind: 'tool', id: 'toolu_1', name: 'Bash', target: 'npm test', status: 'done', input: '', ...over });
type ToolProps = ComponentProps<typeof ToolCard>;
const toolProps = (item: ToolItem, over: Partial<ToolProps> = {}): ToolProps => ({ item, subagent: undefined, bash: undefined, onOpenFile: noop, onOpenTask: null, ...over });

const hookRun = (over: Partial<HookRun>): HookRun => ({
  event: 'PreToolUse',
  name: 'PreToolUse:Bash',
  command: 'check.sh',
  outcome: 'success',
  exitCode: 0,
  durationMs: 120,
  stdout: '',
  stderr: '',
  message: '',
  toolUseId: null,
  ...over,
});

// セッションの ID（参照は先頭の 8 文字で指す）
const LOGIN = 'aaaaaaaa-1111-4111-8111-111111111111';
const PARENT = 'bbbbbbbb-2222-4222-8222-222222222222';
const CHILD = 'cccccccc-3333-4333-8333-333333333333';

// 押して、既定の動きを止めたか（jsdom は summary を押したときの details の開閉を持たないので、開閉を止めたかはこれで確かめる）
function clickPrevented(element: Element): boolean {
  const event = createEvent.click(element);
  fireEvent(element, event);
  return event.defaultPrevented;
}

describe('会話の画像（ChatImages）', () => {
  it('画像を押すと大きく出し、大きい画像を押すと閉じる。押しても、画像を載せたツールのカードのクリック（ファイルを開く）にはならない', async () => {
    const onOpenFile = vi.fn();
    render(<ToolCard {...toolProps(tool({ name: 'Read', target: 'shot.png', filePath: '/w/shot.png', images: ['img-zoom'] }), { onOpenFile })} />);
    const thumb = await screen.findByTitle('クリックで拡大');
    expect(api.argsOf('sessions.image')).toEqual([['img-zoom']]);
    fireEvent.click(thumb);
    const zoom = screen.getByRole('dialog', { name: '画像を閉じる' });
    expect(zoom.querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,img-zoom');
    fireEvent.click(zoom);
    expect(screen.queryByRole('dialog', { name: '画像を閉じる' })).toBeNull();
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it('大きく出した画像は Esc でも閉じる。読み込めない画像は、押せない札にする', async () => {
    render(<ChatRow {...rowProps({ kind: 'user', id: 'u1', text: 'この画面です', images: ['img-esc'] })} />);
    fireEvent.click(await screen.findByTitle('クリックで拡大'));
    expect(screen.getByRole('dialog', { name: '画像を閉じる' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '画像を閉じる' })).toBeNull();

    cleanup();
    api = mockApi({ 'sessions.image': () => Promise.resolve(null) });
    api.install();
    render(<ChatRow {...rowProps({ kind: 'user', id: 'u2', text: '壊れた画像', images: ['img-missing'] })} />);
    expect(await screen.findByText('画像（読み込めません）')).toBeTruthy();
    expect(document.querySelector('button.chat-image')).toBeNull();
  });
});

describe('hooks（HookGroupRow・HookRuns）', () => {
  const group = (id: string, runs: HookRun[]): HookGroup => ({ kind: 'hook-group', id, runs });

  it('まとまりの見出しを押すと、そのまとまりの ID で開閉を頼む。描き直してまとまりが変わったら、新しい ID で頼む', () => {
    const onToggle = vi.fn();
    const runs = [hookRun({ event: 'Stop', name: 'Stop', command: 'notify.sh' }), hookRun({ event: 'Stop', name: 'Stop', command: 'lint.sh', outcome: 'error', exitCode: 1 })];
    const { rerender } = render(<HookGroupRow group={group('hooks:1', runs)} open={false} onToggle={onToggle} />);
    const head = screen.getByRole('button', { expanded: false });
    expect(head.textContent).toContain('フック 2件');
    expect(head.textContent).toContain('失敗 1');
    fireEvent.click(head);
    expect(onToggle).toHaveBeenLastCalledWith('hooks:1');
    // 開くと 1 件ずつ並ぶ
    rerender(<HookGroupRow group={group('hooks:1', runs)} open onToggle={onToggle} />);
    expect([...document.querySelectorAll('.hook-chip .hook-command')].map((e) => e.textContent)).toEqual(['notify.sh', 'lint.sh']);
    rerender(<HookGroupRow group={group('hooks:2', runs)} open={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(onToggle).toHaveBeenLastCalledWith('hooks:2');
  });

  it('1 件を押すとコマンド・理由・出力を開き、もう一度押すと閉じ、別の 1 件を押すとそちらに替える。ツールのカードの中で押しても、カードのクリックにはならない', () => {
    const onOpenFile = vi.fn();
    const blocked = hookRun({ outcome: 'blocked', exitCode: 2, command: 'guard.sh', message: 'main への push は止めます', stdout: 'checked', stderr: 'denied' });
    const context = hookRun({ event: 'PostToolUse', name: 'PostToolUse', outcome: 'context', command: null, exitCode: null, durationMs: 1500, message: 'テストは通っています' });
    render(<ToolCard {...toolProps(tool({ name: 'Edit', target: 'a.ts', filePath: '/w/a.ts', hooks: [blocked, context] }), { onOpenFile })} />);
    const [first, second] = [...document.querySelectorAll<HTMLButtonElement>('.hook-chip')];
    fireEvent.click(first);
    const detail = () => document.querySelector('.hook-detail');
    expect(detail()!.querySelector('.hook-facts')!.textContent).toBe('止めた · 終了コード 2 · 120ms · PreToolUse:Bash');
    expect([...detail()!.querySelectorAll('.tool-section-label')].map((e) => e.textContent)).toEqual(['理由', '標準出力', '標準エラー']);
    expect(detail()!.textContent).toContain('main への push は止めます');
    fireEvent.click(first);
    expect(detail()).toBeNull();
    fireEvent.click(first);
    fireEvent.click(second);
    expect(document.querySelectorAll('.hook-detail')).toHaveLength(1);
    expect(detail()!.querySelector('.hook-facts')!.textContent).toBe('Claude に情報を渡した · 1.5秒');
    expect(detail()!.querySelector('.tool-section-label')!.textContent).toBe('Claude に渡した内容');
    expect(onOpenFile).not.toHaveBeenCalled();
  });
});

describe('Claude から届いたファイル（SentFilesCard）', () => {
  it('ファイルを押すと、その絶対パスでエディタに開く。描き直して届いたファイルが変わったら、新しいファイルを開く', () => {
    const onOpenFile = vi.fn();
    const sent = (paths: string[]) => tool({ id: 'toolu_send', name: 'SendUserFile', target: '', sentFiles: { paths, caption: 'まとめました' }, status: 'error' });
    const { rerender } = render(<ChatRow {...rowProps(sent(['/Users/me/out/report.pdf', '/tmp/log.txt']), { onOpenFile })} />);
    expect(screen.getByText('送れませんでした')).toBeTruthy();
    expect(screen.getByText('まとめました')).toBeTruthy();
    fireEvent.click(screen.getByText('report.pdf'));
    expect(onOpenFile).toHaveBeenLastCalledWith('/Users/me/out/report.pdf');
    rerender(<ChatRow {...rowProps(sent(['/Users/me/out/summary.md']), { onOpenFile })} />);
    fireEvent.click(screen.getByText('summary.md'));
    expect(onOpenFile).toHaveBeenLastCalledWith('/Users/me/out/summary.md');
    expect(onOpenFile).toHaveBeenCalledTimes(2);
  });
});

describe('ほかのセッションへのリンク（SessionRefs）', () => {
  const sessions = [
    { id: LOGIN, title: 'ログインの改修' },
    { id: PARENT, title: '全体の計画' },
    { id: CHILD, title: null },
  ];

  it('発言の中の @ の参照は今の名前の札になり、押すとそのセッションの ID で移る。描き直して参照先が変わったら、新しいセッションへ移る', () => {
    const onSelectSession = vi.fn();
    const user = (text: string): ChatItem => ({ kind: 'user', id: 'u1', text });
    const { rerender } = render(<ChatRow {...rowProps(user('@session:aaaaaaaa（古い名前） と比べてください'), { sessions, onSelectSession })} />);
    fireEvent.click(screen.getByRole('button', { name: '@ログインの改修' }));
    expect(onSelectSession).toHaveBeenLastCalledWith(LOGIN);
    rerender(<ChatRow {...rowProps(user('@session:cccccccc を見てください'), { sessions, onSelectSession })} />);
    fireEvent.click(screen.getByRole('button', { name: '@新しいセッション' }));
    expect(onSelectSession).toHaveBeenLastCalledWith(CHILD);
    // 一覧に無いセッションは押せない
    rerender(<ChatRow {...rowProps(user('@session:dddddddd（消した）'), { sessions, onSelectSession })} />);
    expect(screen.queryByRole('button', { name: '@消した' })).toBeNull();
    expect(onSelectSession).toHaveBeenCalledTimes(2);
  });

  it('親セッションからの指示の見出しを押すと、親セッションへ移る。移る先を受け取らないときは押せない', () => {
    const onSelectSession = vi.fn();
    const item: ChatItem = { kind: 'user', id: 'u1', text: 'テストを足してください', parent: PARENT };
    const { rerender } = render(<ChatRow {...rowProps(item, { sessions, onSelectSession, parentId: PARENT })} />);
    fireEvent.click(screen.getByRole('button', { name: /親セッション「全体の計画」からの指示/ }));
    expect(onSelectSession).toHaveBeenCalledWith(PARENT);
    rerender(<ChatRow {...rowProps(item, { sessions, parentId: PARENT })} />);
    expect(screen.queryByRole('button', { name: /親セッション/ })).toBeNull();
    expect(screen.getByText('親セッション「全体の計画」からの指示')).toBeTruthy();
  });

  it('親でないセッションからの指示（独立したセッションの最初の指示）は、親と書かずに出し、押すとそのセッションへ移る', () => {
    const onSelectSession = vi.fn();
    const item: ChatItem = { kind: 'user', id: 'u1', text: 'テストを足してください', parent: PARENT };
    const { rerender } = render(<ChatRow {...rowProps(item, { sessions, onSelectSession })} />);
    expect(screen.queryByText(/親セッション/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^セッション「全体の計画」からの指示/ }));
    expect(onSelectSession).toHaveBeenCalledWith(PARENT);
    rerender(<ChatRow {...rowProps(item, { sessions: [] })} />);
    expect(screen.getByText('ほかのセッションからの指示')).toBeTruthy();
  });

  it('子セッションからの知らせのリンクを押すと、その子へ移り、知らせの詳細は開閉しない', () => {
    const onSelectSession = vi.fn();
    const outer = vi.fn();
    const item: ChatItem = { kind: 'notice', id: 'n1', text: '子セッションが終わりました', detail: '結果の全文', sessions: [LOGIN, 'eeeeeeee-0000'] };
    const { container } = render(
      <div onClick={outer}>
        <ChatRow {...rowProps(item, { sessions, onSelectSession })} />
      </div>,
    );
    // 詳細のある知らせは、見出し（summary）の中にリンクを置く
    expect(container.querySelector('details > summary .chat-session-link')).not.toBeNull();
    // 一覧に無い子（eeeeeeee）のリンクは出さない
    expect([...container.querySelectorAll('.chat-session-link')].map((e) => e.textContent)).toEqual(['ログインの改修']);
    expect(clickPrevented(screen.getByRole('button', { name: 'ログインの改修' }))).toBe(true);
    expect(onSelectSession).toHaveBeenCalledWith(LOGIN);
    expect(outer).not.toHaveBeenCalled();
  });
});

describe('巻き戻しとチェックリストのカード（ChatRow）', () => {
  it('発言の「ここまで戻す」は、その発言の文字で巻き戻しを頼む。描き直して発言が変わったら、新しい発言の文字で頼む', () => {
    const onRewind = vi.fn();
    const user = (id: string, text: string): ChatItem => ({ kind: 'user', id, text });
    const { rerender } = render(<ChatRow {...rowProps(user('u1', 'ログインを直して'), { onRewind })} />);
    fireEvent.click(screen.getByLabelText('ここまで戻す'));
    expect(onRewind).toHaveBeenLastCalledWith('ログインを直して');
    rerender(<ChatRow {...rowProps(user('u2', 'テストも足して'), { onRewind })} />);
    fireEvent.click(screen.getByLabelText('ここまで戻す'));
    expect(onRewind).toHaveBeenLastCalledWith('テストも足して');
    // コマンド（/ で始まる発言）には出さない
    rerender(<ChatRow {...rowProps(user('u3', '/compact'), { onRewind })} />);
    expect(screen.queryByLabelText('ここまで戻す')).toBeNull();
  });

  it('チェックリストの知らせの「カードを開く」は、知らせの元のカードを開く。詳細のある知らせでも、詳細は開閉しない', () => {
    const opened: CardTarget[] = [];
    function Opener() {
      useOpenChecklistCard((target) => opened.push(target));
      return null;
    }
    const notice = (cardId: string, detail?: string): ChatItem => ({ kind: 'notice', id: `n-${cardId}`, text: 'カードが更新されました', detail, cards: [{ listId: 'list1', cardId }, { listId: 'list1', cardId: 'other' }] });
    const { rerender, container } = render(
      <>
        <Opener />
        <ChatRow {...rowProps(notice('card1'))} />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'カードを開く' }));
    expect(opened).toEqual([{ listId: 'list1', cardId: 'card1' }]);
    rerender(
      <>
        <Opener />
        <ChatRow {...rowProps(notice('card2', '変わったところ'))} />
      </>,
    );
    expect(container.querySelector('details > summary [data-tip="チェックリストのカードを開く"]')).not.toBeNull();
    expect(clickPrevented(screen.getByRole('button', { name: 'カードを開く' }))).toBe(true);
    expect(opened.at(-1)).toEqual({ listId: 'list1', cardId: 'card2' });
  });
});

describe('Todo（TodoPanel）', () => {
  it('見出しを押すと一覧を畳み、作業中の項目を見出しに出す。もう一度押すと開く', () => {
    const todos = [
      { content: '読む', status: 'completed' },
      { content: '直す', status: 'in_progress', activeForm: '直しています' },
      { content: '試す', status: 'pending' },
    ];
    render(<TodoPanel todos={todos} />);
    const head = screen.getByRole('button', { name: /Todo/ });
    expect(head.textContent).toContain('1/3');
    expect([...document.querySelectorAll('.todo-text')].map((e) => e.textContent)).toEqual(['読む', '直しています', '試す']);
    fireEvent.click(head);
    expect(document.querySelector('.todo-list')).toBeNull();
    expect(head.querySelector('.todo-current')!.textContent).toBe('直しています');
    fireEvent.click(head);
    expect(document.querySelectorAll('.todo-item')).toHaveLength(3);
    expect(head.querySelector('.todo-current')).toBeNull();
  });
});

describe('ツールのカード（ToolCard）', () => {
  it('ファイルを扱うツールは、カードを押すとそのファイルの最初に変えた行を開く。描き直してファイルが変わったら、新しいファイルを開く', () => {
    const onOpenFile = vi.fn();
    const edit = (filePath: string, line: number) => tool({ name: 'Edit', target: filePath, filePath, line, input: '{"old_string":"a"}', added: 2, removed: 1 });
    const { rerender, container } = render(<ToolCard {...toolProps(edit('/w/src/a.ts', 12), { onOpenFile })} />);
    fireEvent.click(container.querySelector('.tool-card')!);
    expect(onOpenFile).toHaveBeenLastCalledWith('/w/src/a.ts', 12);
    // 開くのはファイルで、詳細は開かない
    expect(container.querySelector('.tool-detail')).toBeNull();
    rerender(<ToolCard {...toolProps(edit('/w/src/b.ts', 3), { onOpenFile })} />);
    fireEvent.click(container.querySelector('.tool-card')!);
    expect(onOpenFile).toHaveBeenLastCalledWith('/w/src/b.ts', 3);
  });

  it('開けるものが無いツールは、カードを押すと詳細（入力・結果）を開閉する', () => {
    const { container } = render(<ToolCard {...toolProps(tool({ input: '{"command":"npm test"}', output: 'ok', status: 'error' }))} />);
    const card = container.querySelector('.tool-card')!;
    fireEvent.click(card);
    expect([...container.querySelectorAll('.tool-detail .tool-section-label')].map((e) => e.textContent)).toEqual(['入力', 'エラー']);
    fireEvent.click(card);
    expect(container.querySelector('.tool-detail')).toBeNull();
  });

  it('中身を開けるツール（サブエージェントなど）は、カードを押すと中身を開く', () => {
    const onOpenTask = vi.fn();
    const { container } = render(<ToolCard {...toolProps(tool({ name: 'Agent', input: 'しらべて' }), { onOpenTask })} />);
    fireEvent.click(container.querySelector('.tool-card')!);
    expect(onOpenTask).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.tool-detail')).toBeNull();
  });

  it('セッションのツールは、カードを押すと対象のセッションへ移る。描き直して対象が変わったら、新しいセッションへ移る', () => {
    const onSelectSession = vi.fn();
    const sessions = [
      { id: LOGIN, title: 'ログインの改修' },
      { id: CHILD, title: '画面の直し' },
    ];
    const send = (prefix: string) => tool({ name: 'mcp__tanacode-sessions__send_message', target: prefix, input: `{"session_id":"${prefix}","message":"続けて"}` });
    const { rerender, container } = render(<ToolCard {...toolProps(send('aaaaaaaa'), { sessions, onSelectSession })} />);
    // ID の代わりに名前を出す
    expect(container.querySelector('.tool-target')!.textContent).toBe('ログインの改修');
    fireEvent.click(container.querySelector('.tool-card')!);
    expect(onSelectSession).toHaveBeenLastCalledWith(LOGIN);
    rerender(<ToolCard {...toolProps(send('cccccccc'), { sessions, onSelectSession })} />);
    fireEvent.click(container.querySelector('.tool-card')!);
    expect(onSelectSession).toHaveBeenLastCalledWith(CHILD);
  });

  it('チェックリストのツールは対象のカードを、ウォークスルーのツールは示した場所を、カードを押して開く', () => {
    const cards: CardTarget[] = [];
    const walks: WalkthroughToolTarget[] = [];
    function Openers() {
      useOpenChecklistCard((target) => cards.push(target));
      useOpenWalkthroughTarget((target) => walks.push(target));
      return null;
    }
    const checklist = tool({ name: 'mcp__tanacode-checklist__cards_update', target: 'やること #3', input: '{"list":"やること","number":3}' });
    const { rerender, container } = render(
      <>
        <Openers />
        <ToolCard {...toolProps(checklist)} />
      </>,
    );
    fireEvent.click(container.querySelector('.tool-card')!);
    expect(cards).toEqual([{ list: 'やること', number: 3 }]);
    const show = tool({ name: 'mcp__tanacode-walkthrough__show_code', target: 'src/a.ts', input: '{"path":"src/a.ts","start_line":5}' });
    rerender(
      <>
        <Openers />
        <ToolCard {...toolProps(show)} />
      </>,
    );
    fireEvent.click(container.querySelector('.tool-card')!);
    expect(walks).toEqual([{ kind: 'code', path: 'src/a.ts', line: 5 }]);
    // 別のセッションへのコピーは、このセッションのカードではないので開かない（詳細の開閉になる）
    const copy = tool({ name: 'mcp__tanacode-checklist__cards_copy', target: 'やること #1', input: '{"from_list":"やること","numbers":"1"}' });
    rerender(
      <>
        <Openers />
        <ToolCard {...toolProps(copy)} />
      </>,
    );
    fireEvent.click(container.querySelector('.tool-card')!);
    expect(cards).toHaveLength(1);
    expect(container.querySelector('.tool-detail')).not.toBeNull();
  });

  it('右の矢印で詳細を開閉する。矢印と開いた詳細の中を押しても、カードのクリック（ファイルを開く）にはならない', () => {
    const onOpenFile = vi.fn();
    const item = tool({ name: 'Edit', target: 'a.ts', filePath: '/w/a.ts', line: 1, input: '{}', patch: ['@@ -1 +1 @@', '-a', '+b'] });
    const { container } = render(<ToolCard {...toolProps(item, { onOpenFile })} />);
    fireEvent.click(screen.getByRole('button', { name: '詳細を開く' }));
    expect([...container.querySelectorAll('.tool-detail .diff span')].map((e) => [e.className, e.textContent])).toEqual([
      ['hunk', '@@ -1 +1 @@\n'],
      ['del', '-a\n'],
      ['add', '+b\n'],
    ]);
    fireEvent.click(container.querySelector('.tool-detail .tool-pre')!);
    expect(container.querySelector('.tool-detail')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '詳細を閉じる' }));
    expect(container.querySelector('.tool-detail')).toBeNull();
    expect(onOpenFile).not.toHaveBeenCalled();
  });
});

describe('応答と思考の日本語訳（BlockTranslation）', () => {
  const ENGLISH = 'This function reads the configuration file and returns the parsed settings for the application.';
  const translated = (texts: string[]) => ({ ok: true, texts: texts.map((t) => `訳: ${t}`) });

  it('応答の「日本語訳」を押すと、Mac の中で訳して下に出し、もう一度押すと閉じる。訳した文は覚えておき、開き直しでは訳し直さない', async () => {
    let finish: (value: unknown) => void = noop;
    api = mockApi({
      'translate.available': () => Promise.resolve(true),
      'translate.run': () => new Promise((resolve) => (finish = resolve)),
    });
    api.install();
    const { container } = render(<ChatRow {...rowProps({ kind: 'text', id: 't1', text: ENGLISH })} />);
    const button = await screen.findByRole('button', { name: '日本語訳' });
    fireEvent.click(button);
    expect(api.argsOf('translate.run')).toEqual([[[ENGLISH]]]);
    expect(container.querySelector('.chat-translation-note')!.textContent).toContain('訳しています');
    // 訳している途中に押しても、頼み直さない
    fireEvent.click(button);
    expect(api.argsOf('translate.run')).toHaveLength(1);
    await act(async () => finish(translated([ENGLISH])));
    expect(container.querySelector('.chat-translation')!.textContent).toContain(`訳: ${ENGLISH}`);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(button);
    expect(container.querySelector('.chat-translation')).toBeNull();
    fireEvent.click(button);
    expect(container.querySelector('.chat-translation')!.textContent).toContain(`訳: ${ENGLISH}`);
    expect(api.argsOf('translate.run')).toHaveLength(1);
  });

  it('畳んだ思考で「日本語訳」を押すと、思考を開いて訳文を出す（押しても見出しの開閉にはならない）', async () => {
    api = mockApi({ 'translate.available': () => Promise.resolve(true), 'translate.run': (texts: never) => Promise.resolve(translated(texts)) });
    api.install();
    const { container } = render(<ChatRow {...rowProps({ kind: 'thinking', id: 'th1', text: ENGLISH })} />);
    const details = container.querySelector('details')!;
    details.open = false;
    fireEvent.click(await screen.findByRole('button', { name: '日本語訳' }));
    expect(details.open).toBe(true);
    await waitFor(() => expect(container.querySelector('.chat-translation .chat-thinking-text')!.textContent).toBe(`訳: ${ENGLISH}`));
  });

  it('翻訳データが無くて訳せなかったら、わけと「システム設定を開く」を出す。押すとシステム設定を開き、もう一度「日本語訳」を押すと訳し直す', async () => {
    api = mockApi({ 'translate.available': () => Promise.resolve(true), 'translate.run': () => Promise.resolve({ ok: false, error: 'not-installed', source: 'en' }) });
    api.install();
    const { container } = render(<ChatRow {...rowProps({ kind: 'text', id: 't2', text: ENGLISH })} />);
    fireEvent.click(await screen.findByRole('button', { name: '日本語訳' }));
    await waitFor(() => expect(container.querySelector('.chat-translation-note.failed')!.textContent).toContain('翻訳データ（英語・日本語）が入っていません'));
    fireEvent.click(screen.getByRole('button', { name: 'システム設定を開く' }));
    expect(api.argsOf('translate.openSettings')).toEqual([[]]);
    fireEvent.click(screen.getByRole('button', { name: '日本語訳' }));
    expect(api.argsOf('translate.run')).toHaveLength(2);
  });

  it('訳せないわけが言語のほかのとき（失敗）は、「システム設定を開く」を出さない', async () => {
    api = mockApi({ 'translate.available': () => Promise.resolve(true), 'translate.run': () => Promise.reject(new Error('補助プログラムが落ちました')) });
    api.install();
    const { container } = render(<ChatRow {...rowProps({ kind: 'text', id: 't3', text: ENGLISH })} />);
    fireEvent.click(await screen.findByRole('button', { name: '日本語訳' }));
    await waitFor(() => expect(container.querySelector('.chat-translation-note.failed')!.textContent).toBe('訳せませんでした（補助プログラムが落ちました）。'));
    expect(within(container).queryByRole('button', { name: 'システム設定を開く' })).toBeNull();
  });
});
