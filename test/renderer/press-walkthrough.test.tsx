// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExportSource, SessionSummary } from '@shared/ipc';
import type { Walkthrough, WalkthroughStep } from '@shared/walkthrough';
import { MAX_COMMENT_CHARS, WALKTHROUGH_ATTRIBUTION, type WalkthroughCommentDraft } from '@shared/walkthrough-comment';
import { ExportDialog } from '../../src/renderer/src/export/ExportDialog';
import { SAMPLE_BRANCHES, SAMPLE_CWD, SAMPLE_EVENTS, SAMPLE_HOME, SAMPLE_IMAGES } from '../../src/renderer/src/export/sampleSession';
import { CommentDialog } from '../../src/renderer/src/walkthrough/CommentDialog';
import { WalkthroughList } from '../../src/renderer/src/walkthrough/WalkthroughList';
import { WalkthroughBox, type WalkthroughControls } from '../../src/renderer/src/walkthrough/WalkthroughZone';
import './dom';
import { mockApi } from './mock-api';

// ウォークスルーの吹き出しは Monaco エディタの中に出すが、中身（WalkthroughBox）は Monaco を使わない。
// jsdom では Monaco を読み込めないので、読み込む部品（WalkthroughZone のファイル）のためだけに空のものに差し替える
vi.mock('../../src/renderer/src/editor/monaco', () => ({ monaco: {} }));

// ウォークスルー（ソース管理の一覧・エディタの吹き出し・PR にコメントとして載せる下見）の、ボタンと入力欄。
// 押したら、どのステップへ動くか・何を Claude に送るか・どの PR に何を載せるかまで確かめる

let api: ReturnType<typeof mockApi>;
afterEach(cleanup);

const step = (path: string, startLine: number, endLine: number, title: string): WalkthroughStep => ({ path, startLine, endLine, title, body: `${title}の説明`, view: 'file' });
const walk = (over: Partial<Walkthrough> = {}): Walkthrough => ({
  id: 'w1',
  title: '税率を可変にした変更',
  steps: [step('src/settings.ts', 1, 7, '税率を設定に持たせる'), step('src/tax.ts', 6, 10, '品目で税率を選ぶ'), step('src/tax.ts', 12, 15, '1 円未満は切り捨てる')],
  open: true,
  current: 1,
  aside: null,
  visited: [0, 1],
  movedBy: 'human',
  seq: 1,
  startedAt: 0,
  ...over,
});
const OTHER = walk({
  id: 'w2',
  title: 'ログインの作り直し',
  steps: [step('src/login.ts', 3, 3, 'フォームを分ける'), step('src/session.ts', 10, 20, 'トークンを保存する'), step('src/api.ts', 5, 9, '失敗を伝える'), step('src/view.tsx', 1, 4, '画面に出す')],
  current: 2,
  visited: [2],
});

describe('WalkthroughList（ソース管理の一覧）', () => {
  beforeEach(() => {
    api = mockApi();
    api.install();
  });

  it('ステップを押すと、そのステップの番号で開く。PR に載せるボタンは下見を開く', () => {
    const onGo = vi.fn();
    const onPublish = vi.fn();
    render(<WalkthroughList walkthrough={walk()} onGo={onGo} onPublish={onPublish} />);
    // 見ているステップ（2 番目）には印、見たステップには「見た」
    expect(screen.getByText('品目で税率を選ぶ').closest('button')!.getAttribute('aria-current')).toBe('step');
    expect(screen.getByText('税率を設定に持たせる').closest('button')!.textContent).toContain('見た');
    fireEvent.click(screen.getByText('1 円未満は切り捨てる'));
    fireEvent.click(screen.getByText('税率を設定に持たせる'));
    expect(onGo.mock.calls).toEqual([[2], [0]]);
    fireEvent.click(screen.getByLabelText('GitHub の PR にコメントとして載せる'));
    expect(onPublish).toHaveBeenCalledTimes(1);
  });

  it('閉じたウォークスルーでも、押したステップからもう一度開ける', () => {
    const onGo = vi.fn();
    render(<WalkthroughList walkthrough={walk({ open: false })} onGo={onGo} onPublish={() => {}} />);
    expect(screen.getByText(/閉じています。押すと、そのステップからもう一度見られます/)).toBeTruthy();
    // 閉じているときは、どのステップにも「見ている」の印は付けない
    expect(screen.getByText('品目で税率を選ぶ').closest('button')!.getAttribute('aria-current')).toBeNull();
    fireEvent.click(screen.getByText('品目で税率を選ぶ'));
    expect(onGo).toHaveBeenCalledWith(1);
  });

  it('別のウォークスルーに描き直した直後に押しても、新しいウォークスルーのステップを開く', () => {
    const onGo = vi.fn();
    const { rerender } = render(<WalkthroughList walkthrough={walk()} onGo={onGo} onPublish={() => {}} />);
    rerender(<WalkthroughList walkthrough={OTHER} onGo={onGo} onPublish={() => {}} />);
    expect(screen.queryByText('品目で税率を選ぶ')).toBeNull();
    fireEvent.click(screen.getByText('画面に出す'));
    expect(onGo).toHaveBeenCalledWith(3);
    expect(screen.getByText('src/view.tsx:1-4')).toBeTruthy();
  });
});

describe('WalkthroughBox（エディタの吹き出し）', () => {
  beforeEach(() => {
    api = mockApi();
    api.install();
  });

  const controls = (over: Partial<WalkthroughControls> = {}): WalkthroughControls => ({
    walkthrough: walk(),
    stale: false,
    onGo: vi.fn(),
    onClose: vi.fn(),
    onAsk: vi.fn(),
    onRestart: vi.fn(),
    onPublish: vi.fn(),
    onShowList: vi.fn(),
    ...over,
  });
  const question = () => screen.getByPlaceholderText('ここについて Claude に聞きたいこと（⌘Enter で送る）') as HTMLTextAreaElement;

  it('「戻る」「次へ」で前後のステップへ動く。最初のステップでは「戻る」は押せない', () => {
    const c = controls();
    const { rerender } = render(<WalkthroughBox {...c} />);
    expect(screen.getByText('ウォークスルー 2/3')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('戻る'));
    fireEvent.click(screen.getByLabelText('次へ'));
    expect(vi.mocked(c.onGo).mock.calls).toEqual([[0], [2]]);
    rerender(<WalkthroughBox {...c} walkthrough={walk({ current: 0 })} />);
    expect((screen.getByLabelText('戻る') as HTMLButtonElement).disabled).toBe(true);
  });

  it('最後のステップでは「次へ」の代わりに「終える」が出て、押すと閉じる', () => {
    const c = controls({ walkthrough: walk({ current: 2 }) });
    render(<WalkthroughBox {...c} />);
    expect(screen.queryByLabelText('次へ')).toBeNull();
    fireEvent.click(screen.getByText('終える'));
    expect(c.onClose).toHaveBeenCalledTimes(1);
    expect(c.onGo).not.toHaveBeenCalled();
  });

  it('見出しのボタン: ステップの一覧・PR に載せる・閉じる', () => {
    const c = controls();
    render(<WalkthroughBox {...c} />);
    fireEvent.click(screen.getByLabelText('ステップの一覧（ソース管理）'));
    fireEvent.click(screen.getByLabelText('GitHub の PR にコメントとして載せる'));
    fireEvent.click(screen.getByLabelText('閉じる（ソース管理の一覧から、もう一度開けます）'));
    expect(c.onShowList).toHaveBeenCalledTimes(1);
    expect(c.onPublish).toHaveBeenCalledTimes(1);
    expect(c.onClose).toHaveBeenCalledTimes(1);
  });

  it('寄り道を見ているときは「ウォークスルーに戻る」で、人が見ていたステップへ戻る', () => {
    const c = controls({ walkthrough: walk({ current: 1, aside: step('src/util.ts', 30, 34, '寄り道') }) });
    render(<WalkthroughBox {...c} />);
    expect(screen.getByText('寄り道')).toBeTruthy();
    expect(screen.getByText('src/util.ts:30-34')).toBeTruthy();
    expect(screen.queryByLabelText('次へ')).toBeNull();
    fireEvent.click(screen.getByText('ウォークスルーに戻る（2/3）'));
    expect(c.onGo).toHaveBeenCalledWith(1);
  });

  it('コードが変わったときは「Claude に示し直してもらう」を出し、押すと頼む', () => {
    const c = controls({ stale: true });
    render(<WalkthroughBox {...c} />);
    fireEvent.click(screen.getByText('Claude に示し直してもらう'));
    expect(c.onRestart).toHaveBeenCalledTimes(1);
  });

  it('「質問する」で欄を開き、打った質問を前後の空白を除いて「送る」で送る。送ったら欄を閉じて空にする', () => {
    const c = controls();
    render(<WalkthroughBox {...c} />);
    fireEvent.click(screen.getByText('質問する'));
    const send = screen.getByLabelText('送る') as HTMLButtonElement;
    // 空白だけでは送れない
    fireEvent.change(question(), { target: { value: '   ' } });
    expect(send.disabled).toBe(true);
    fireEvent.change(question(), { target: { value: '  なぜ切り捨てなのか  ' } });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(c.onAsk).toHaveBeenCalledWith('なぜ切り捨てなのか');
    expect(screen.queryByPlaceholderText('ここについて Claude に聞きたいこと（⌘Enter で送る）')).toBeNull();
    fireEvent.click(screen.getByText('質問する'));
    expect(question().value).toBe('');
  });

  it('⌘Enter・Ctrl+Enter で送る。Enter だけ・変換の確定・空白だけでは送らない', () => {
    const c = controls();
    render(<WalkthroughBox {...c} />);
    fireEvent.click(screen.getByText('質問する'));
    fireEvent.change(question(), { target: { value: '   ' } });
    fireEvent.keyDown(question(), { key: 'Enter', metaKey: true });
    fireEvent.change(question(), { target: { value: '税率はどこで決まる？' } });
    fireEvent.keyDown(question(), { key: 'Enter' });
    fireEvent.keyDown(question(), { key: 'Enter', metaKey: true, isComposing: true });
    expect(c.onAsk).not.toHaveBeenCalled();
    fireEvent.keyDown(question(), { key: 'Enter', metaKey: true });
    expect(c.onAsk).toHaveBeenCalledWith('税率はどこで決まる？');
    fireEvent.click(screen.getByText('質問する'));
    fireEvent.change(question(), { target: { value: '設定はどこに保存する？' } });
    fireEvent.keyDown(question(), { key: 'Enter', ctrlKey: true });
    expect(vi.mocked(c.onAsk).mock.calls).toEqual([['税率はどこで決まる？'], ['設定はどこに保存する？']]);
  });

  it('「やめる」・Esc で欄を閉じても、書きかけの質問は残る', () => {
    const c = controls();
    render(<WalkthroughBox {...c} />);
    fireEvent.click(screen.getByText('質問する'));
    fireEvent.change(question(), { target: { value: '書きかけ' } });
    fireEvent.click(screen.getByLabelText('やめる'));
    expect(screen.queryByLabelText('送る')).toBeNull();
    fireEvent.click(screen.getByText('質問する'));
    expect(question().value).toBe('書きかけ');
    fireEvent.keyDown(question(), { key: 'Escape' });
    expect(screen.queryByLabelText('送る')).toBeNull();
    // 閉じている間は「戻る」「次へ」が出て、Claude には何も送っていない
    expect(screen.getByLabelText('次へ')).toBeTruthy();
    expect(c.onAsk).not.toHaveBeenCalled();
  });

  it('日本語の変換中に Esc（変換の取り消し）を押しても、質問の欄は閉じない', () => {
    // macOS の Chromium では、変換中の Esc も key が Escape の keydown として届き、isComposing が付く
    // （PR に載せる下見・書き出しの確認・チェックリストの欄は、変換中の Esc では閉じない）
    const onAsk = vi.fn();
    render(<WalkthroughBox walkthrough={walk()} stale={false} onGo={() => {}} onClose={() => {}} onAsk={onAsk} onRestart={() => {}} />);
    fireEvent.click(screen.getByText('質問する'));
    const box = screen.getByPlaceholderText('ここについて Claude に聞きたいこと（⌘Enter で送る）');
    fireEvent.change(box, { target: { value: 'ぜいりつは' } });
    fireEvent.keyDown(box, { key: 'Escape', isComposing: true });
    expect(screen.queryByPlaceholderText('ここについて Claude に聞きたいこと（⌘Enter で送る）')).toBeTruthy();
    expect(onAsk).not.toHaveBeenCalled();
  });

  it('別のウォークスルーに描き直した直後に押しても、新しいウォークスルーの前後のステップへ動く。開いていた質問の欄は閉じる', () => {
    const c = controls();
    const { rerender } = render(<WalkthroughBox {...c} />);
    fireEvent.click(screen.getByText('質問する'));
    rerender(<WalkthroughBox {...c} walkthrough={OTHER} />);
    expect(screen.queryByLabelText('送る')).toBeNull();
    expect(screen.getByText('ウォークスルー 3/4')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('戻る'));
    fireEvent.click(screen.getByLabelText('次へ'));
    expect(vi.mocked(c.onGo).mock.calls).toEqual([[1], [3]]);
    // 新しいウォークスルーでも、質問は送れる
    fireEvent.click(screen.getByText('質問する'));
    fireEvent.change(question(), { target: { value: '保存先は？' } });
    fireEvent.click(screen.getByLabelText('送る'));
    expect(c.onAsk).toHaveBeenCalledWith('保存先は？');
  });
});

describe('CommentDialog（PR にコメントとして載せる下見）', () => {
  const DRAFT: WalkthroughCommentDraft = { ok: true, prNumber: 12, prUrl: 'https://github.com/me/shop/pull/12', sha: 'abc1234', body: '## ウォークスルー: 税率', postedUrl: null };
  const POSTED = 'https://github.com/me/shop/pull/12#issuecomment-1';
  let drafts: Record<string, WalkthroughCommentDraft>;
  let post: (sessionId: string, body: string, attribution: boolean) => Promise<string>;
  beforeEach(() => {
    drafts = { s1: DRAFT };
    post = () => Promise.resolve(POSTED);
    api = mockApi({
      'walkthrough.draftComment': ((sessionId: string) => Promise.resolve(drafts[sessionId])) as never,
      'walkthrough.postComment': ((...args: [string, string, boolean]) => post(...args)) as never,
    });
    api.install();
  });
  const body = () => document.querySelector('.walk-comment-body') as HTMLTextAreaElement;
  const postButton = () => screen.getByText('載せる') as HTMLButtonElement;

  it('直した本文と、添える一言を外した選択のまま、このセッションの PR に載せる。載せたら GitHub で開ける', async () => {
    const onClose = vi.fn();
    render(<CommentDialog sessionId="s1" onClose={onClose} />);
    await screen.findByText('PR #12 にコメントとして載せる');
    expect(api.argsOf('walkthrough.draftComment')).toEqual([['s1']]);
    expect(body().value).toBe('## ウォークスルー: 税率');
    fireEvent.change(body(), { target: { value: '## ウォークスルー: 税率（直した）' } });
    const check = screen.getByRole('checkbox') as HTMLInputElement;
    expect(check.checked).toBe(true);
    fireEvent.click(check);
    expect(check.checked).toBe(false);
    fireEvent.click(postButton());
    expect(api.argsOf('walkthrough.postComment')).toEqual([['s1', '## ウォークスルー: 税率（直した）', false]]);
    await screen.findByText('載せました。');
    expect(screen.queryByText('載せる')).toBeNull();
    fireEvent.click(screen.getByText('GitHub で開く'));
    expect(api.argsOf('browser.openExternal')).toEqual([[POSTED]]);
    fireEvent.click(screen.getByText('閉じる'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('本文を空にすると載せられず、長すぎると文字数を出して載せられない。一言を添えるかで長さが変わる', async () => {
    render(<CommentDialog sessionId="s1" onClose={() => {}} />);
    await screen.findByText('PR #12 にコメントとして載せる');
    fireEvent.change(body(), { target: { value: '  \n ' } });
    expect(postButton().disabled).toBe(true);
    // 一言（区切りの行を含む）を添えると上限をちょうど超える長さ
    const text = 'あ'.repeat(MAX_COMMENT_CHARS - `\n\n---\n${WALKTHROUGH_ATTRIBUTION}`.length + 1);
    fireEvent.change(body(), { target: { value: text } });
    expect(postButton().disabled).toBe(true);
    expect(screen.getByText(/長すぎます（65537 文字。GitHub のコメントは 65536 文字まで）/)).toBeTruthy();
    // 一言を外すと収まる
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.queryByText(/長すぎます/)).toBeNull();
    expect(postButton().disabled).toBe(false);
    fireEvent.click(postButton());
    expect(api.argsOf('walkthrough.postComment')).toEqual([['s1', text, false]]);
  });

  it('もう載せているときは知らせて、前のコメントを開ける', async () => {
    drafts.s1 = { ...DRAFT, postedUrl: 'https://github.com/me/shop/pull/12#issuecomment-0' };
    render(<CommentDialog sessionId="s1" onClose={() => {}} />);
    await screen.findByText(/このウォークスルーは、もう載せています/);
    fireEvent.click(screen.getByText('前のコメントを開く'));
    expect(api.argsOf('browser.openExternal')).toEqual([['https://github.com/me/shop/pull/12#issuecomment-0']]);
  });

  it('載せられなかったときは理由を出し、もう一度押せる', async () => {
    let fail = true;
    post = () => (fail ? Promise.reject(new Error('GitHub に繋がりません')) : Promise.resolve(POSTED));
    render(<CommentDialog sessionId="s1" onClose={() => {}} />);
    await screen.findByText('PR #12 にコメントとして載せる');
    fireEvent.click(postButton());
    expect(screen.getByText('載せています…')).toBeTruthy();
    await screen.findByText('GitHub に繋がりません');
    fail = false;
    fireEvent.click(postButton());
    await screen.findByText('載せました。');
    expect(api.argsOf('walkthrough.postComment')).toHaveLength(2);
  });

  it('Esc・幕を押すと閉じる。変換中の Esc・ダイアログの中を押したときは閉じない', async () => {
    const onClose = vi.fn();
    render(<CommentDialog sessionId="s1" onClose={onClose} />);
    await screen.findByText('PR #12 にコメントとして載せる');
    const dialog = screen.getByRole('dialog');
    fireEvent.mouseDown(body());
    fireEvent.mouseDown(dialog);
    fireEvent.keyDown(body(), { key: 'Escape', isComposing: true });
    fireEvent.keyDown(body(), { key: 'a' });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(body(), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(dialog.parentElement!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('載せられないとき（PR が無いなど）は理由だけを出し、載せるボタンは出さない', async () => {
    drafts.s1 = { ok: false, reason: 'このブランチの PR がありません' };
    render(<CommentDialog sessionId="s1" onClose={() => {}} />);
    await screen.findByText('このブランチの PR がありません');
    expect(screen.queryByText('載せる')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('別のセッションに描き直すと、そのセッションの下見を読み、押すとそのセッションの PR に載せる', async () => {
    drafts.s2 = { ...DRAFT, prNumber: 34, prUrl: 'https://github.com/me/shop/pull/34', body: '## ウォークスルー: ログイン' };
    const { rerender } = render(<CommentDialog sessionId="s1" onClose={() => {}} />);
    await screen.findByText('PR #12 にコメントとして載せる');
    rerender(<CommentDialog sessionId="s2" onClose={() => {}} />);
    await screen.findByText('PR #34 にコメントとして載せる');
    expect(api.argsOf('walkthrough.draftComment')).toEqual([['s1'], ['s2']]);
    expect(body().value).toBe('## ウォークスルー: ログイン');
    await act(async () => fireEvent.click(postButton()));
    expect(api.argsOf('walkthrough.postComment')).toEqual([['s2', '## ウォークスルー: ログイン', true]]);
    await waitFor(() => expect(screen.getByText('載せました。')).toBeTruthy());
  });
});

describe('ExportDialog（作業を書き出す前の確認）', () => {
  const session = (id: string, title: string): SessionSummary => ({
    id,
    title,
    cwd: SAMPLE_CWD,
    archived: false,
    createdAt: 0,
    updatedAt: 0,
    running: false,
    unread: false,
    attention: null,
    backgroundTasks: 0,
    model: null,
    effort: null,
    settingsFile: null,
    remoteControl: false,
    worktree: null,
  });
  const S1 = session('s1', '季節限定のバッジ');
  const SAVED = `${SAMPLE_HOME}/Downloads/季節限定のバッジ.html`;
  let sources: Record<string, ExportSource>;
  let save: () => Promise<string | null>;
  beforeEach(() => {
    sources = { s1: { events: SAMPLE_EVENTS, branches: SAMPLE_BRANCHES, home: SAMPLE_HOME } };
    save = () => Promise.resolve(SAVED);
    api = mockApi({
      'sessions.exportSource': ((id: string) => (sources[id] ? Promise.resolve(sources[id]) : Promise.reject(new Error('会話ログが見つかりません')))) as never,
      'sessions.image': ((key: string) => Promise.resolve(SAMPLE_IMAGES[key] ?? null)) as never,
      'sessions.saveExport': (() => save()) as never,
    });
    api.install();
  });
  const select = (label: string) => screen.getByLabelText(label) as HTMLSelectElement;
  const option = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement;
  const exportButton = () => screen.getByText(/^書き出(す…|しています…)$/) as HTMLButtonElement;
  // 書き出す…を押して、保存した HTML（saveExport に渡したもの）を返す。
  // HTML を組み立てる間は重く、テストを並べて流して手が詰まっていると 1 秒（findBy の既定）を超えることがあるので、長めに待つ。
  // 待ち切れずにテストが終わると、書き出しの続きが次のテストの API の呼び出しに混ざる（読みにいく画像など）
  async function exportHtml(): Promise<string> {
    fireEvent.click(exportButton());
    await screen.findByText(/保存しました/, undefined, { timeout: 10_000 });
    const [[html]] = api.argsOf('sessions.saveExport') as [string, string][];
    return html;
  }
  // 会話ログの中身（書き出した HTML に入るか確かめる目印）
  const TOOL_OUTPUT = 'src/MenuItem.test.tsx (3 tests)';
  const THINKING = 'バッジと商品名の間がおよそ 8px 空いている';
  const DIFF = '季節限定の商品に付けるバッジ';
  const IMAGE = 'data:image/svg+xml;base64,';

  it('既定では、ツールの結果・差分・画像・思考を入れ、ホームフォルダのパスを ~ にして書き出す', async () => {
    render(<ExportDialog session={S1} onClose={() => {}} />);
    await screen.findByText(/発言 3 · 応答/);
    const html = await exportHtml();
    expect(api.argsOf('sessions.exportSource')).toEqual([['s1']]);
    for (const text of [TOOL_OUTPUT, THINKING, DIFF, IMAGE, '~/work/cafe-menu']) expect(html).toContain(text);
    expect(html).not.toContain(SAMPLE_CWD);
    expect(api.argsOf('sessions.image').map(([key]) => key)).toEqual(['sample:shot', 'sample:attach']);
  });

  it('入れるものの印を外すと、書き出した HTML から外れる（画像は読みにもいかない）', async () => {
    render(<ExportDialog session={S1} onClose={() => {}} />);
    await screen.findByText(/発言 3 · 応答/);
    for (const label of [/ツールの結果/, /編集の差分/, /画像（添付・スクリーンショット）/, /思考/, /ホームフォルダのパス/]) {
      expect(option(label).checked).toBe(true);
      fireEvent.click(option(label));
      expect(option(label).checked).toBe(false);
    }
    const html = await exportHtml();
    for (const text of [TOOL_OUTPUT, THINKING, DIFF, IMAGE, '~/work/cafe-menu']) expect(html).not.toContain(text);
    expect(html).toContain(SAMPLE_CWD);
    expect(api.argsOf('sessions.image')).toEqual([]);
  });

  it('外した印をもう一度押すと、また入る', async () => {
    render(<ExportDialog session={S1} onClose={() => {}} />);
    await screen.findByText(/発言 3 · 応答/);
    fireEvent.click(option(/思考/));
    fireEvent.click(option(/思考/));
    expect(option(/思考/).checked).toBe(true);
    expect(await exportHtml()).toContain(THINKING);
  });

  it('範囲を選ぶと、選べる発言を絞り、数え直して、その範囲だけを書き出す', async () => {
    render(<ExportDialog session={S1} onClose={() => {}} />);
    await screen.findByText(/発言 3 · 応答/);
    fireEvent.change(select('最後の発言'), { target: { value: '1' } });
    expect(select('最後の発言').value).toBe('1');
    // 最初の発言は、最後の発言より後ろを選べない
    expect([...select('最初の発言').options].map((o) => o.disabled)).toEqual([false, false, true]);
    fireEvent.change(select('最初の発言'), { target: { value: '1' } });
    expect(select('最初の発言').value).toBe('1');
    expect([...select('最後の発言').options].map((o) => o.disabled)).toEqual([true, false, false]);
    expect(screen.getByText(/^発言 1 · 応答 1 · 操作 2/)).toBeTruthy();
    const html = await exportHtml();
    expect(html).toContain('ありがとう。添付の画面のように、バッジと名前の間を少し空けて');
    expect(html).toContain('発言 2〜2（全 3 件のうち 1 件）');
    expect(html).not.toContain('メニューの商品に「季節限定」のバッジを付けて');
    expect(html).not.toContain('git commit -am');
  });

  it('保存したら場所を出し、「Finder で表示」でその場所を開く。「閉じる」で閉じる', async () => {
    const onClose = vi.fn();
    render(<ExportDialog session={S1} onClose={onClose} />);
    await screen.findByText(/発言 3 · 応答/);
    await exportHtml();
    expect(api.argsOf('sessions.saveExport')[0][1]).toMatch(/^季節限定のバッジ/);
    expect(screen.getByText('~/Downloads/季節限定のバッジ.html')).toBeTruthy();
    fireEvent.click(screen.getByText('Finder で表示'));
    expect(api.argsOf('sessions.revealExport')).toEqual([[SAVED]]);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('閉じる'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('「キャンセル」・Esc・幕を押すと閉じる。変換中の Esc・ダイアログの中を押したときは閉じない', async () => {
    const onClose = vi.fn();
    render(<ExportDialog session={S1} onClose={onClose} />);
    await screen.findByText(/発言 3 · 応答/);
    const dialog = screen.getByRole('dialog');
    fireEvent.mouseDown(dialog);
    fireEvent.mouseDown(select('最初の発言'));
    fireEvent.keyDown(dialog, { key: 'Escape', isComposing: true });
    fireEvent.keyDown(dialog, { key: 'Enter' });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('キャンセル'));
    fireEvent.keyDown(select('最初の発言'), { key: 'Escape' });
    fireEvent.mouseDown(dialog.parentElement!);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('書き出している間は、閉じる操作も範囲・入れるものも効かない', async () => {
    let finish: (path: string | null) => void = () => {};
    save = () => new Promise((resolve) => (finish = resolve));
    const onClose = vi.fn();
    render(<ExportDialog session={S1} onClose={onClose} />);
    await screen.findByText(/発言 3 · 応答/);
    fireEvent.click(exportButton());
    await screen.findByText('書き出しています…');
    expect((screen.getByText('キャンセル') as HTMLButtonElement).disabled).toBe(true);
    expect(select('最初の発言').disabled).toBe(true);
    expect(select('最後の発言').disabled).toBe(true);
    expect(option(/思考/).disabled).toBe(true);
    expect(option(/ホームフォルダのパス/).disabled).toBe(true);
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.mouseDown(dialog.parentElement!);
    fireEvent.click(screen.getByText('キャンセル'));
    expect(onClose).not.toHaveBeenCalled();
    // 保存のダイアログで取り消したら、元に戻ってまた選べる
    await act(async () => finish(null));
    expect(exportButton().disabled).toBe(false);
    expect(select('最初の発言').disabled).toBe(false);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('入るものが無い欄は押せない', async () => {
    sources.s1 = { events: SAMPLE_EVENTS.filter((e) => e.type !== 'thinking'), branches: [], home: SAMPLE_HOME };
    render(<ExportDialog session={S1} onClose={() => {}} />);
    await screen.findByText(/発言 3 · 応答/);
    expect(option(/思考/).disabled).toBe(true);
    expect(option(/思考/).checked).toBe(false);
    expect(option(/ツールの結果/).disabled).toBe(false);
  });

  it('会話ログを読めないときは理由を出し、書き出せない', async () => {
    render(<ExportDialog session={session('gone', '消えたセッション')} onClose={() => {}} />);
    await screen.findByText('会話ログを読めませんでした: 会話ログが見つかりません');
    expect(exportButton().disabled).toBe(true);
  });

  it('別のセッションに描き直す（チャットの画面と同じく key で作り直す）と、そのセッションの会話を読み、そのセッションの作業を書き出す', async () => {
    sources.s2 = {
      events: [
        { type: 'user', id: 'v1', text: 'ログインの画面を作り直して', at: Date.parse('2026-10-05T10:00:00+09:00') },
        { type: 'assistant-text', id: 'b1', text: 'フォームを分けました。', at: Date.parse('2026-10-05T10:01:00+09:00') },
        { type: 'turn-end' },
      ],
      branches: ['login'],
      home: SAMPLE_HOME,
    };
    const { rerender } = render(<ExportDialog key="s1" session={S1} onClose={() => {}} />);
    await screen.findByText(/発言 3 · 応答/);
    rerender(<ExportDialog key="s2" session={session('s2', 'ログインの作り直し')} onClose={() => {}} />);
    await screen.findByText(/^発言 1 · 応答 1 · 操作 0/);
    expect(api.argsOf('sessions.exportSource')).toEqual([['s1'], ['s2']]);
    const html = await exportHtml();
    expect(html).toContain('フォームを分けました。');
    expect(html).not.toContain('メニューの商品に「季節限定」のバッジを付けて');
    expect(api.argsOf('sessions.saveExport')[0][1]).toMatch(/^ログインの作り直し/);
  });
});
