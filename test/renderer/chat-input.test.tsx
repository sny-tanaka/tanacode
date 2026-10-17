// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary, SlashCommand } from '@shared/ipc';
import { ChatInput, listCompletionFiles, submitToClaude, type CompletionSource } from '../../src/renderer/src/chat/ChatInput';
import './dom';
import { mockApi } from './mock-api';
import { deferred } from './press-checklist-fixtures';

// チャットの入力欄。送信のキー（⌘Enter。Enter は改行・変換確定では送らない）・@ と / の補完・画像の貼り付けとドロップ・添付とコメントの札

// ワークスペースに追加したフォルダのファイル
const FOLDER_FILES: Record<string, string[]> = {
  '/Users/me/lib': ['src/util.ts', 'README.md'],
  '/Users/me/My Projects/kit': ['notes.txt'],
};

let api: ReturnType<typeof mockApi>;
beforeEach(() => {
  api = mockApi({
    'folders.listFiles': (folder: never) => Promise.resolve(FOLDER_FILES[folder] ?? []),
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
// files: セッションのフォルダのファイル。added: ワークスペースに追加したフォルダ
function Harness({
  initial = '',
  onValue,
  onPastes,
  files = ['src/app.ts', 'src/components/Toolbar.tsx', 'docs/top.md', 'README.md'],
  added = [],
  ...props
}: Partial<Props> & { initial?: string; onValue?: (v: string) => void; onPastes?: (p: string[]) => void; files?: string[]; added?: string[] }) {
  const [value, setValue] = useState(initial);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [pastes, setPastes] = useState<string[]>([]);
  const completion: CompletionSource = {
    key: `k\0${added.join('\0')}`,
    listFiles: () => listCompletionFiles(Promise.resolve(files), added),
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
      pastes={pastes}
      onPastesChange={(next) => {
        setPastes(next);
        onPastes?.(next);
      }}
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
// 候補の下に出すパス
const details = () => [...document.querySelectorAll('.suggest-item .suggest-detail')].map((e) => e.textContent);

describe('送信のキー', () => {
  it('Claude Code へ送る（submitToClaude）: 本文・添付の画像・札（貼り付けた長い文）を、そのまま main に渡す', async () => {
    await submitToClaude('s1', '直して\n詳しく', ['/tmp/a.png']);
    await submitToClaude('s1', 'このログを見て', [], ['ログ\n2 行目']);
    expect(api.argsOf('sessions.submit')).toEqual([
      ['s1', '直して\n詳しく', ['/tmp/a.png'], []],
      ['s1', 'このログを見て', [], ['ログ\n2 行目']],
    ]);
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

describe('@ の補完（ワークスペースに追加したフォルダのファイル）', () => {
  it('追加したフォルダのファイルも候補に出し、パスはフォルダの名前から出す。選ぶと絶対パスを入れる', async () => {
    const values: string[] = [];
    render(<Harness added={['/Users/me/lib']} onValue={(v) => values.push(v)} />);
    type('@readme');
    // セッションのフォルダのファイルと混ぜて、同じ決まり（名前の前方一致・短いパスが先）で並べる
    await waitFor(() => expect(details()).toEqual(['README.md', 'lib/README.md']));
    // フォルダの名前でも絞れる
    type('@lib/');
    await waitFor(() => expect(details()).toEqual(['lib/README.md', 'lib/src/util.ts']));
    type('見て @util');
    await waitFor(() => expect(suggestions()).toEqual(['util.ts']));
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(values.at(-1)).toBe('見て @/Users/me/lib/src/util.ts ');
  });

  it('空白を含むパスは @"…" で囲んで入れる（Claude Code が、空白で切らずにひとつのパスとして読む）', async () => {
    const values: string[] = [];
    render(<Harness files={['docs/release notes.md']} added={['/Users/me/My Projects/kit']} onValue={(v) => values.push(v)} />);
    type('@notes');
    await waitFor(() => expect(details()).toEqual(['kit/notes.txt', 'docs/release notes.md']));
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(values.at(-1)).toBe('@"/Users/me/My Projects/kit/notes.txt" ');
    type('@release');
    await waitFor(() => expect(suggestions()).toEqual(['release notes.md']));
    fireEvent.keyDown(box(), { key: 'Tab' });
    expect(values.at(-1)).toBe('@"docs/release notes.md" ');
  });

  it('フォルダを足すと読み直して候補に出し、外すと出さない', async () => {
    const view = render(<Harness />);
    type('@util');
    await act(() => Promise.resolve());
    expect(suggestions()).toEqual([]);
    expect(api.argsOf('folders.listFiles')).toEqual([]);
    view.rerender(<Harness added={['/Users/me/lib']} />);
    await waitFor(() => expect(details()).toEqual(['lib/src/util.ts']));
    view.rerender(<Harness />);
    await waitFor(() => expect(suggestions()).toEqual([]));
  });

  it('読んでいる間にフォルダが変わったら、遅れて届いた前の一覧は使わない（外したフォルダのファイルを出さない）', async () => {
    const lists = new Map<string, ReturnType<typeof deferred<string[]>>>();
    mockApi({
      'folders.listFiles': (folder: never) => {
        const list = deferred<string[]>();
        lists.set(folder, list);
        return list.promise;
      },
    }).install();
    const view = render(<Harness added={['/Users/me/lib']} />);
    type('@notes');
    view.rerender(<Harness added={['/Users/me/My Projects/kit']} />);
    await act(async () => lists.get('/Users/me/My Projects/kit')!.resolve(['notes.txt']));
    await act(async () => lists.get('/Users/me/lib')!.resolve(['notes.md']));
    expect(details()).toEqual(['kit/notes.txt']);
  });
});

describe('貼り付けた長い文の札', () => {
  const LOG = Array.from({ length: 30 }, (_, i) => `ログの ${i + 1} 行目`).join('\n');
  const paste = (text: string) => fireEvent.paste(box(), { clipboardData: { files: [], getData: () => text } });

  it('長い貼り付け（4 行以上・800 文字より長い）は、文字として入れずに札にする。札には冒頭の文字と行数を出す', () => {
    const values: string[] = [];
    const pastes: string[][] = [];
    render(<Harness onValue={(v) => values.push(v)} onPastes={(p) => pastes.push(p)} />);
    // 貼り付けの既定の動き（文字として入る）を止めたか
    expect(paste(LOG)).toBe(false);
    expect(paste('a'.repeat(801))).toBe(false);
    expect(pastes.at(-1)).toEqual([LOG, 'a'.repeat(801)]);
    expect(values).toEqual([]);
    const chips = [...document.querySelectorAll('.chat-input .paste-chip')];
    expect(chips.map((c) => c.querySelector('.paste-chip-head')?.textContent)).toEqual(['ログの 1 行目', 'a'.repeat(60)]);
    expect(chips.map((c) => c.querySelector('.paste-chip-lines')?.textContent)).toEqual(['30 行', '1 行']);
  });

  it('短い貼り付けは、今までどおり文字のまま入る（札にしない）', () => {
    const pastes: string[][] = [];
    render(<Harness onPastes={(p) => pastes.push(p)} />);
    expect(paste('1 行目\n2 行目\n3 行目')).toBe(true);
    expect(paste('a'.repeat(800))).toBe(true);
    expect(pastes).toEqual([]);
    expect(document.querySelector('.paste-chip')).toBeNull();
  });

  it('貼り付けた文の制御文字は除く（ESC が残ると、送るときに貼り付けの外へ出る）', () => {
    const pastes: string[][] = [];
    render(<Harness onPastes={(p) => pastes.push(p)} />);
    paste('1\r\n2\x1b[201~\n3\n4');
    expect(pastes.at(-1)).toEqual(['1\n2[201~\n3\n4']);
  });

  it('札を押すと中身を確かめられ、Esc か、外を押すと閉じる。× でその札だけを外す', () => {
    const pastes: string[][] = [];
    render(<Harness onPastes={(p) => pastes.push(p)} />);
    paste(LOG);
    paste('a'.repeat(801));
    fireEvent.click(screen.getByText('ログの 1 行目'));
    const dialog = screen.getByRole('dialog', { name: '貼り付けた文' });
    expect(dialog.querySelector('pre')?.textContent).toBe(LOG);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    // 中を押しても閉じず、外（後ろの幕）を押すと閉じる
    fireEvent.click(screen.getByText('ログの 1 行目'));
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(screen.queryByRole('dialog')).not.toBeNull();
    fireEvent.mouseDown(document.querySelector('.overlay')!);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getAllByLabelText('外す')[0]);
    expect(pastes.at(-1)).toEqual(['a'.repeat(801)]);
    expect(screen.queryByText('ログの 1 行目')).toBeNull();
  });
});

describe('読んでいる・保存している間に変わったら、古い結果を使わない', () => {
  const source = (key: string, list: Promise<SlashCommand[]>): CompletionSource => ({
    key,
    listFiles: () => Promise.resolve([]),
    listCommands: () => list,
  });
  const image = (name: string) => new File([new Uint8Array([1])], name, { type: 'image/png' });
  const chips = () => [...document.querySelectorAll('.chat-input .attachment:not(.comment-chip)')].map((e) => e.textContent);

  it('/ の候補: 読んでいる間に読み込み元（セッション）が変わったら、遅れて届いた前の一覧は出さない', async () => {
    const first = deferred<SlashCommand[]>();
    const second = deferred<SlashCommand[]>();
    const { rerender } = render(<Harness completion={source('s1', first.promise)} />);
    type('/');
    rerender(<Harness completion={source('s2', second.promise)} />);
    await act(async () => second.resolve([{ name: 'deploy', description: 's2 のコマンド', source: 'skill' }]));
    await act(async () => first.resolve(COMMANDS));
    expect(suggestions()).toEqual(['/deploy']);
  });

  it('添付: 画像を保存している間に入力欄の持ち主（セッション）が変わったら、保存した画像もファイルのパスも、移った先の入力欄に入れない', async () => {
    const saving = deferred<string>();
    api = mockApi({ 'attachments.save': () => saving.promise, pathForFile: (file: never) => `/Users/me/${(file as File).name}` });
    api.install();
    const onAttachmentsChange = vi.fn();
    const onChange = vi.fn();
    const { rerender } = render(<Harness owner="s1" onAttachmentsChange={onAttachmentsChange} onChange={onChange} />);
    fireEvent.drop(document.querySelector('.chat-input')!, { dataTransfer: { files: [image('shot.png'), new File(['x'], 'notes.txt')], types: ['Files'] } });
    rerender(<Harness owner="s2" onAttachmentsChange={onAttachmentsChange} onChange={onChange} />);
    await act(async () => saving.resolve('/tmp/attachments/0123abcd-shot.png'));
    expect(onAttachmentsChange).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('添付: 保存している間に打った文字や、続けて足した画像を消さない', async () => {
    const saves = [deferred<string>(), deferred<string>()];
    let n = 0;
    api = mockApi({ 'attachments.save': () => saves[n++].promise, pathForFile: (file: never) => `/Users/me/${(file as File).name}` });
    api.install();
    render(<Harness owner="s1" initial="見て" />);
    fireEvent.paste(box(), { clipboardData: { files: [image('a.png')] } });
    fireEvent.drop(document.querySelector('.chat-input')!, { dataTransfer: { files: [image('b.png'), new File(['x'], 'notes.txt')], types: ['Files'] } });
    type('見てください');
    await act(async () => saves[1].resolve('/tmp/attachments/0123abcd-b.png'));
    await act(async () => saves[0].resolve('/tmp/attachments/0123abcd-a.png'));
    expect(chips()).toEqual(['画像 b.png', '画像 a.png']);
    expect(box().value).toBe('見てください /Users/me/notes.txt ');
  });

  it('添付: 2 つの保存の返事が、描き直す前に続けて届いても、あとのものが先のものを上書きしない', async () => {
    const saves = [deferred<string>(), deferred<string>()];
    let n = 0;
    api = mockApi({ 'attachments.save': () => saves[n++].promise, pathForFile: (file: never) => `/Users/me/${(file as File).name}` });
    api.install();
    render(<Harness owner="s1" />);
    const drop = (...files: File[]) => fireEvent.drop(document.querySelector('.chat-input')!, { dataTransfer: { files, types: ['Files'] } });
    drop(image('a.png'), new File(['x'], 'one.txt'));
    drop(image('b.png'), new File(['y'], 'two.txt'));
    await act(async () => {
      saves[0].resolve('/tmp/attachments/0123abcd-a.png');
      saves[1].resolve('/tmp/attachments/0123abcd-b.png');
    });
    expect(chips()).toEqual(['画像 a.png', '画像 b.png']);
    expect(box().value).toBe('/Users/me/one.txt /Users/me/two.txt ');
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
