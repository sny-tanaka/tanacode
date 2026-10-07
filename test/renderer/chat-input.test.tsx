// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary, SlashCommand } from '@shared/ipc';
import { ChatInput, submitToClaude, type CompletionSource } from '../../src/renderer/src/chat/ChatInput';
import './dom';
import { mockApi } from './mock-api';

// チャットの入力欄。送信のキー（⌘Enter。Enter は改行・変換確定では送らない）・@ と / の補完・画像の貼り付けとドロップ・添付とコメントの札

let api: ReturnType<typeof mockApi>;
beforeEach(() => {
  api = mockApi({
    'attachments.save': (name: never) => Promise.resolve(`/tmp/attachments/0123abcd-${name as string}`),
    pathForFile: (file: never) => `/Users/me/${(file as File).name}`,
  });
  api.install();
});
afterEach(cleanup);

const COMMANDS: SlashCommand[] = [
  { name: 'compact', description: '会話を圧縮', source: 'builtin' },
  { name: 'clear', description: '会話を消す', source: 'builtin', aliases: ['reset', 'new'] },
  { name: 'review-code', description: 'レビュー', source: 'skill' },
];
const session = (id: string, title: string, archived = false) => ({ id, title, archived, cwd: '/work/shop', worktree: null, parentId: null }) as unknown as SessionSummary;

type Props = ComponentProps<typeof ChatInput>;
function Harness({ initial = '', onValue, ...props }: Partial<Props> & { initial?: string; onValue?: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  const [attachments, setAttachments] = useState<string[]>([]);
  const completion: CompletionSource = {
    key: 'k',
    listFiles: () => Promise.resolve(['src/app.ts', 'src/components/Toolbar.tsx', 'docs/top.md', 'README.md']),
    listCommands: () => Promise.resolve(COMMANDS),
    listSessions: () => [session('s2', 'ログインの改修'), session('s3', 'today の作業', true)],
  };
  return (
    <ChatInput
      completion={completion}
      value={value}
      onChange={(v) => {
        setValue(v);
        onValue?.(v);
      }}
      attachments={attachments}
      onAttachmentsChange={setAttachments}
      placeholder="指示を入力"
      blocked={false}
      onSend={() => {}}
      showInterrupt={false}
      onInterrupt={() => {}}
      comments={[]}
      onRemoveComment={() => {}}
      onShowComment={() => {}}
      {...props}
    />
  );
}

const box = () => screen.getByPlaceholderText('指示を入力') as HTMLTextAreaElement;
// 打った文字（カーソルは末尾）
const type = (text: string) => {
  fireEvent.change(box(), { target: { value: text, selectionStart: text.length } });
  fireEvent.select(box(), { target: { selectionStart: text.length } });
};
const suggestions = () => [...document.querySelectorAll('.suggest-item .suggest-label')].map((e) => e.textContent);

describe('送信のキー', () => {
  it('Claude Code へ送る（submitToClaude）: 本文と添付の画像を、そのまま main に渡す', async () => {
    await submitToClaude('s1', '直して\n詳しく', ['/tmp/a.png']);
    expect(api.argsOf('sessions.submit')).toEqual([['s1', '直して\n詳しく', ['/tmp/a.png']]]);
  });

  it('⌘Enter・Ctrl+Enter で送り、Enter は改行のまま。変換確定の Enter では送らない', () => {
    const onSend = vi.fn();
    render(<Harness initial="直して" onSend={onSend} />);
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box(), { key: 'Enter', metaKey: true, isComposing: true });
    fireEvent.keyDown(box(), { key: 'Enter', metaKey: true, keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box(), { key: 'Enter', metaKey: true });
    fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true });
    expect(onSend).toHaveBeenCalledTimes(2);
  });

  it('送信のボタン。送れない状態では押せず、作業中は中断のボタンに変わる', () => {
    const onSend = vi.fn();
    const onInterrupt = vi.fn();
    const { rerender } = render(<Harness onSend={onSend} />);
    fireEvent.click(screen.getByLabelText('送信'));
    expect(onSend).toHaveBeenCalledTimes(1);
    rerender(<Harness onSend={onSend} blocked />);
    expect((screen.getByLabelText('送信') as HTMLButtonElement).disabled).toBe(true);
    rerender(<Harness onSend={onSend} showInterrupt onInterrupt={onInterrupt} />);
    fireEvent.click(screen.getByLabelText('中断'));
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });
});

describe('@ と / の補完', () => {
  it('@ のあとの文字で、セッションを先に、ファイルは名前の前方一致・途中に含む・パスに含むの順に出し、Enter で入れる', async () => {
    const values: string[] = [];
    render(<Harness onValue={(v) => values.push(v)} />);
    type('見て @to');
    await waitFor(() => expect(suggestions()).toEqual(['today の作業', 'top.md', 'Toolbar.tsx']));
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    fireEvent.keyDown(box(), { key: 'Enter' });
    // 1 つ目（セッション）から ↓ で 2 つ目（ファイル）
    expect(values.at(-1)).toBe('見て @docs/top.md ');
  });

  it('@ でセッションを選ぶと、セッションの参照（@session:<ID の頭>）を入れる。アーカイブ済みはあとに出す', async () => {
    const values: string[] = [];
    render(<Harness onValue={(v) => values.push(v)} />);
    type('@');
    await waitFor(() => expect(suggestions().slice(0, 2)).toEqual(['ログインの改修', 'today の作業']));
    fireEvent.keyDown(box(), { key: 'Tab' });
    expect(values.at(-1)).toMatch(/^@session:s2/);
  });

  it('Esc で候補を閉じ、そのあとの Enter は補完しない', async () => {
    const values: string[] = [];
    render(<Harness onValue={(v) => values.push(v)} />);
    type('@app');
    await waitFor(() => expect(suggestions()).toEqual(['app.ts']));
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(suggestions()).toEqual([]);
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(values.at(-1)).toBe('@app');
  });

  it('先頭の / で、名前の前方一致・別名の前方一致・名前の途中に含むの順にコマンドを出す', async () => {
    const values: string[] = [];
    render(<Harness onValue={(v) => values.push(v)} />);
    type('/re');
    await waitFor(() => expect(suggestions()).toEqual(['/review-code', '/clear (reset, new)']));
    type('/c');
    await waitFor(() => expect(suggestions()).toEqual(['/compact', '/clear (reset, new)', '/review-code']));
    fireEvent.mouseDown(screen.getByText('/clear (reset, new)'));
    expect(values.at(-1)).toBe('/clear ');
  });

  it('文の途中の / はコマンドの補完にしない', async () => {
    render(<Harness />);
    type('a/b を直して');
    await act(() => Promise.resolve());
    expect(suggestions()).toEqual([]);
  });
});

describe('画像とファイル', () => {
  it('貼り付けた画像は一時ファイルに保存して添付し、札の × で外す', async () => {
    render(<Harness />);
    const image = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' });
    fireEvent.paste(box(), { clipboardData: { files: [image] } });
    await waitFor(() => expect(screen.getByText('画像 shot.png')).toBeTruthy());
    const [[name, data]] = api.argsOf('attachments.save') as [string, Uint8Array][];
    expect(name).toBe('shot.png');
    expect([...data]).toEqual([1, 2, 3]);
    fireEvent.click(screen.getByLabelText('外す'));
    expect(screen.queryByText('画像 shot.png')).toBeNull();
  });

  it('画像でないファイルをドロップしたら、パスを本文に入れる', async () => {
    const values: string[] = [];
    render(<Harness initial="これを見て" onValue={(v) => values.push(v)} />);
    const file = new File(['x'], 'notes.txt', { type: 'text/plain' });
    fireEvent.drop(document.querySelector('.chat-input')!, { dataTransfer: { files: [file], types: ['Files'] } });
    await waitFor(() => expect(values.at(-1)).toBe('これを見て /Users/me/notes.txt '));
  });
});
