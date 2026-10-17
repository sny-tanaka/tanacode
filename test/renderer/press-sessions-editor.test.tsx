// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef, type ComponentProps } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EditorPane, type EditorHandle, type OpenFile } from '../../src/renderer/src/editor/EditorPane';
import { MarkdownPreview } from '../../src/renderer/src/editor/MarkdownPreview';
import { UnsavedDialog } from '../../src/renderer/src/editor/UnsavedDialog';
import { LineComments } from '../../src/renderer/src/review/LineComments';
import { DiffPane } from '../../src/renderer/src/scm/DiffPane';
import './dom';
import { mockApi } from './mock-api';

// エディタと差分（editor/・scm/DiffPane）のボタンを、ひとつ残らず押して、押した結果まで確かめる。
// Monaco は jsdom では動かないので、エディタ・モデルの小さな偽物に差し替える（内容の読み書きと、知らせの受け手だけを持つ）。
// 対象（ファイル・セッション）を props で受け取るので、対象を変えて描き直した直後に押しても、変えた先に効くことも確かめる

const fake = vi.hoisted(() => {
  type Listener = () => void;
  const disposable = () => ({ dispose() {} });
  class FakeModel {
    readonly listeners = new Set<Listener>();
    disposed = false;
    constructor(
      public value: string,
      public readonly language: string,
    ) {}
    getValue() {
      return this.value;
    }
    // 打ち込んだとき・読み直したときと同じく、内容の変わった知らせを出す
    setValue(value: string) {
      this.value = value;
      this.listeners.forEach((listener) => listener());
    }
    onDidChangeContent(listener: Listener) {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    }
    getLineCount() {
      return this.value.split('\n').length;
    }
    getLineContent(line: number) {
      return this.value.split('\n')[line - 1] ?? '';
    }
    dispose() {
      this.disposed = true;
    }
  }
  // 偽物に無いもの（マウスの知らせ・右クリックのメニューなど）は、何もせず、外せるものを返す
  function lenient<T extends object>(base: T): T {
    return new Proxy(base, {
      get(target, key) {
        if (key in target) return target[key as keyof T];
        if (typeof key !== 'string' || key === 'then') return undefined;
        return () => disposable();
      },
    });
  }
  function codeEditor() {
    let model: FakeModel | null = null;
    const onModel = new Set<Listener>();
    return lenient({
      getModel: () => model,
      setModel(next: FakeModel | null) {
        model = next;
        onModel.forEach((listener) => listener());
      },
      onDidChangeModel(listener: Listener) {
        onModel.add(listener);
        return { dispose: () => onModel.delete(listener) };
      },
      getPosition: () => ({ lineNumber: 1, column: 1 }),
      getSelection: () => null,
      saveViewState: () => null,
      restoreViewState() {},
      getLayoutInfo: () => ({ contentWidth: 800 }),
      createDecorationsCollection: () => ({ set() {}, clear() {} }),
      changeViewZones: (change: (accessor: { addZone: () => string; removeZone: () => void; layoutZone: () => void }) => void) =>
        change({ addZone: () => 'zone', removeZone() {}, layoutZone() {} }),
      dispose() {},
    });
  }
  type Sides = { original: FakeModel; modified: FakeModel };
  function diffEditor() {
    let model: Sides | null = null;
    const modified = codeEditor();
    const options: Record<string, unknown>[] = [];
    return lenient({
      options,
      getModifiedEditor: () => modified,
      getModel: () => model,
      setModel(next: Sides) {
        model = next;
      },
      updateOptions(next: Record<string, unknown>) {
        options.push(next);
      },
      dispose() {},
    });
  }
  const made = { models: [] as FakeModel[], diffEditors: [] as ReturnType<typeof diffEditor>[] };
  const monaco = {
    editor: {
      create: () => codeEditor(),
      createDiffEditor: () => {
        const editor = diffEditor();
        made.diffEditors.push(editor);
        return editor;
      },
      createModel: (text: string, language: string) => {
        const model = new FakeModel(text, language);
        made.models.push(model);
        return model;
      },
      setTheme() {},
      colorize: (text: string) => Promise.resolve(text),
      ScrollType: { Smooth: 0, Immediate: 1 },
      OverviewRulerLane: { Left: 1 },
      MouseTargetType: { GUTTER_GLYPH_MARGIN: 2 },
      ContentWidgetPositionPreference: { EXACT: 0, ABOVE: 1, BELOW: 2 },
    },
    Range: class {
      constructor(
        public startLineNumber: number,
        public startColumn: number,
        public endLineNumber: number,
        public endColumn: number,
      ) {}
    },
    KeyMod: { CtrlCmd: 2048 },
    KeyCode: { KeyS: 49 },
    languages: { getLanguages: () => [] },
  };
  return { monaco, made, lenient };
});

vi.mock('../../src/renderer/src/editor/monaco', () => ({
  monaco: fake.monaco,
  editorTheme: () => 'tanacode-test',
  languageFor: (path: string) => (path.endsWith('.md') ? 'markdown' : 'typescript'),
  languageLabel: (id: string) => id,
}));

// 返事を受けたあとの処理（state の更新）まで進める
const settle = () => act(async () => {});
const button = (name: string | RegExp) => screen.getByRole<HTMLButtonElement>('button', { name });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  fake.made.models.length = 0;
  fake.made.diffEditors.length = 0;
});

describe('EditorPane（エディタ）', () => {
  const text = (path: string, value: string): OpenFile => ({ path, content: { kind: 'text', text: value } });
  const APP = 'const total = 1;\n';
  const README = '# 使い方\n\nはじめに読むところ\n';
  type Props = ComponentProps<typeof EditorPane>;
  const props = (over: Partial<Props> = {}): Props => ({
    sessionId: 'A',
    files: [text('src/app.ts', APP), text('README.md', README)],
    activePath: 'src/app.ts',
    changes: {},
    mergeBase: null,
    onShowDiff: vi.fn(),
    onOpenFile: vi.fn(),
    reveal: null,
    onActivate: vi.fn(),
    onClose: vi.fn(),
    onSave: vi.fn(() => Promise.resolve()),
    onCursor: vi.fn(),
    comments: [],
    onAddComment: vi.fn(),
    onRemoveComment: vi.fn(),
    ...over,
  });
  const tab = (path: string) => document.querySelector<HTMLElement>(`.editor-tab[title="${path}"]`)!;
  const modelOf = (value: string) => fake.made.models.find((m) => m.value === value)!;
  // エディタで書き換える（未保存の変更になる）
  const edit = (from: string, to: string) => act(() => modelOf(from).setValue(to));
  const banner = () => screen.queryByText('未保存の変更があるうちに、ディスク上のファイルが変更されました');
  const body = () => document.querySelector<HTMLElement>('.editor-body')!;

  it('タブを押すと、そのファイルに切り替える', () => {
    mockApi().install();
    const p = props();
    render(<EditorPane {...p} />);
    fireEvent.click(tab('README.md'));
    expect(p.onActivate).toHaveBeenCalledWith('README.md');
    expect(p.onClose).not.toHaveBeenCalled();
  });

  it('タブの閉じるボタンは、そのファイルを閉じる（タブの切り替えにはしない）', () => {
    mockApi().install();
    const confirm = vi.spyOn(window, 'confirm');
    const p = props();
    render(<EditorPane {...p} />);
    fireEvent.click(tab('README.md').querySelector('button')!);
    expect(p.onClose).toHaveBeenCalledWith('README.md');
    expect(p.onActivate).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('未保存の変更があるタブを閉じるときは確かめ、やめたら閉じない', async () => {
    mockApi().install();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const p = props();
    render(<EditorPane {...p} />);
    await edit(APP, 'const total = 2;\n');
    expect(tab('src/app.ts').querySelector('.editor-tab-dot.dirty')).not.toBeNull();
    const close = () => fireEvent.click(tab('src/app.ts').querySelector('button')!);
    close();
    expect(confirm).toHaveBeenCalledWith('app.ts の変更を保存せずに閉じますか？');
    expect(p.onClose).not.toHaveBeenCalled();
    expect(tab('src/app.ts').querySelector('.editor-tab-dot.dirty')).not.toBeNull();
    close();
    expect(p.onClose).toHaveBeenCalledWith('src/app.ts');
    expect(tab('src/app.ts').querySelector('.editor-tab-dot.dirty')).toBeNull();
  });

  it('Markdown は、はじめはプレビューで出し、ボタンでソース・並べる・プレビューを切り替える。ファイルを移っても覚えておく', async () => {
    mockApi().install();
    const p = props({ activePath: 'README.md' });
    const view = render(<EditorPane {...p} />);
    await settle();
    const mode = (label: string) => screen.getByRole<HTMLButtonElement>('tab', { name: label });
    expect(mode('プレビュー').getAttribute('aria-selected')).toBe('true');
    expect(body().className).toContain('md-preview');
    expect(screen.queryByRole('heading', { name: '使い方' })).not.toBeNull();
    fireEvent.click(mode('ソース'));
    expect(mode('ソース').getAttribute('aria-selected')).toBe('true');
    expect(mode('プレビュー').getAttribute('aria-selected')).toBe('false');
    expect(body().className).toContain('md-source');
    expect(document.querySelector('.markdown-preview')).toBeNull();
    fireEvent.click(mode('並べる'));
    expect(body().className).toContain('md-split');
    expect(screen.queryByRole('heading', { name: '使い方' })).not.toBeNull();
    // ほかのファイル（Markdown でない）では出さず、戻ると選んだ見せ方のまま
    view.rerender(<EditorPane {...p} activePath="src/app.ts" />);
    expect(screen.queryByRole('tablist', { name: 'Markdown の表示' })).toBeNull();
    expect(body().className).not.toContain('md-');
    view.rerender(<EditorPane {...p} activePath="README.md" />);
    expect(mode('並べる').getAttribute('aria-selected')).toBe('true');
    fireEvent.click(mode('プレビュー'));
    expect(body().className).toContain('md-preview');
  });

  describe('未保存の変更があるうちに、ディスク上のファイルが変わったとき', () => {
    // 書き換えたあと、ディスク側（Claude Code など）でも変わる
    async function conflict() {
      mockApi().install();
      const p = props();
      const view = render(<EditorPane {...p} />);
      await edit(APP, 'const total = 2; // 手で直した\n');
      view.rerender(<EditorPane {...p} files={[text('src/app.ts', 'const total = 3; // Claude が直した\n'), text('README.md', README)]} />);
      expect(banner()).not.toBeNull();
      return { p, view };
    }

    it('「ディスクの内容を読み込む」で、書き換えを捨ててディスクの内容にする', async () => {
      const { p } = await conflict();
      const model = fake.made.models.find((m) => m.language === 'typescript')!;
      expect(model.value).toBe('const total = 2; // 手で直した\n');
      fireEvent.click(button('ディスクの内容を読み込む'));
      expect(model.value).toBe('const total = 3; // Claude が直した\n');
      expect(banner()).toBeNull();
      expect(tab('src/app.ts').querySelector('.editor-tab-dot.dirty')).toBeNull();
      expect(p.onSave).not.toHaveBeenCalled();
    });

    it('「このまま保存」で、書き換えた内容をディスクに書く', async () => {
      const { p } = await conflict();
      const model = fake.made.models.find((m) => m.language === 'typescript')!;
      fireEvent.click(button('このまま保存'));
      expect(p.onSave).toHaveBeenCalledWith('src/app.ts', 'const total = 2; // 手で直した\n');
      await settle();
      expect(banner()).toBeNull();
      expect(model.value).toBe('const total = 2; // 手で直した\n');
      expect(tab('src/app.ts').querySelector('.editor-tab-dot.dirty')).toBeNull();
    });

    it('知らせは、変わったファイルを開いているときだけ出し、ほかのファイルに移った直後に押せるボタンは無い', async () => {
      const { p, view } = await conflict();
      view.rerender(<EditorPane {...p} files={[text('src/app.ts', 'const total = 3; // Claude が直した\n'), text('README.md', README)]} activePath="README.md" />);
      expect(banner()).toBeNull();
      expect(screen.queryByRole('button', { name: 'このまま保存' })).toBeNull();
    });
  });

  it('このブランチで変わったファイルでは、基点の内容を読み、「差分を見る」でブランチの差分を開く', async () => {
    const api = mockApi({ 'git.baseline': () => Promise.resolve({ exists: true, text: 'const total = 0;\n' }) });
    api.install();
    const p = props({ changes: { 'src/app.ts': { kind: 'modified', added: 1, removed: 1 } }, mergeBase: 'abc1234' });
    render(<EditorPane {...p} />);
    await settle();
    expect(api.argsOf('git.baseline')).toEqual([['A', 'abc1234', 'src/app.ts']]);
    expect(screen.queryByText('このブランチで変更')).not.toBeNull();
    fireEvent.click(button('差分を見る'));
    expect(p.onShowDiff).toHaveBeenCalledWith('src/app.ts');
  });

  it('ファイルやセッションを変えて描き直した直後に押すと、変えた先のファイルに効く', async () => {
    const api = mockApi({ 'git.baseline': () => Promise.resolve({ exists: false, text: '' }) });
    api.install();
    const changes = { 'src/app.ts': { kind: 'modified' as const, added: 1, removed: 1 }, 'README.md': { kind: 'added' as const, added: 3, removed: 0 } };
    const first = props({ changes, mergeBase: 'abc1234' });
    const view = render(<EditorPane {...first} />);
    const second = props({ changes, mergeBase: 'abc1234', sessionId: 'B', activePath: 'README.md' });
    view.rerender(<EditorPane {...second} />);
    fireEvent.click(button('差分を見る'));
    expect(second.onShowDiff).toHaveBeenCalledWith('README.md');
    expect(first.onShowDiff).not.toHaveBeenCalled();
    expect(screen.queryByText('このブランチで新規作成')).not.toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'ソース' }));
    expect(body().className).toContain('md-source');
    fireEvent.click(tab('src/app.ts'));
    expect(second.onActivate).toHaveBeenCalledWith('src/app.ts');
    fireEvent.click(tab('src/app.ts').querySelector('button')!);
    expect(second.onClose).toHaveBeenCalledWith('src/app.ts');
    await settle();
    expect(api.argsOf('git.baseline')).toEqual([
      ['A', 'abc1234', 'src/app.ts'],
      ['B', 'abc1234', 'README.md'],
    ]);
  });

  // 別のフォルダへ移る（App がエディタを作り直す）前に、App が保存していないファイルを聞き、まとめて保存する
  describe('保存していない変更を、App から聞いて保存する', () => {
    async function twoEdited() {
      mockApi().install();
      const handle = createRef<EditorHandle>();
      const p = props();
      const view = render(<EditorPane {...p} handle={handle} />);
      expect(handle.current!.unsaved()).toEqual([]);
      await edit(APP, 'const total = 2;\n');
      view.rerender(<EditorPane {...p} handle={handle} activePath="README.md" />);
      await edit(README, '# 直した使い方\n');
      return { handle, p };
    }

    it('保存していないファイルをタブの順に返し、まとめて保存すると、すべて書いて未保存の印も消える', async () => {
      const { handle, p } = await twoEdited();
      expect(handle.current!.unsaved()).toEqual(['src/app.ts', 'README.md']);
      await act(() => handle.current!.saveAll());
      expect(p.onSave).toHaveBeenCalledWith('src/app.ts', 'const total = 2;\n');
      expect(p.onSave).toHaveBeenCalledWith('README.md', '# 直した使い方\n');
      expect(handle.current!.unsaved()).toEqual([]);
      expect(document.querySelector('.editor-tab-dot.dirty')).toBeNull();
    });

    it('書けなかったら、そこで止めて投げる（書けなかったファイルは、保存していないまま）', async () => {
      const { handle, p } = await twoEdited();
      vi.mocked(p.onSave).mockImplementationOnce(() => Promise.reject(new Error('書き込めません')));
      await expect(act(() => handle.current!.saveAll())).rejects.toThrow('書き込めません');
      expect(handle.current!.unsaved()).toEqual(['src/app.ts', 'README.md']);
      expect(p.onSave).toHaveBeenCalledTimes(1);
    });
  });
});

describe('MarkdownPreview（Markdown のプレビュー）', () => {
  function preview(text: string) {
    const api = mockApi({ 'workspace.readImage': () => Promise.resolve('data:image/png;base64,AA==') });
    api.install();
    const model = fake.monaco.editor.createModel(text, 'markdown');
    render(<MarkdownPreview sessionId="A" path="docs/guide.md" model={model as never} onOpenFile={vi.fn()} />);
    return { api, doc: document.querySelector<HTMLElement>('.markdown-doc')! };
  }

  it('文書に混ざった HTML は、プレビューに要るタグと属性だけを残す（見た目を偽る style・class や、フォーム・ボタン・埋め込みは消す）', async () => {
    const { api, doc } = preview(
      [
        '<div align="center" style="position:fixed;inset:0" class="overlay" id="main" onclick="alert(1)">中央の段落</div>',
        '',
        '<form action="https://example.com"><input type="text" name="q"><button>送る</button><select><option>a</option></select></form>',
        '',
        '<iframe src="https://example.com"></iframe><style>body{display:none}</style><video src="a.mp4"></video>',
        '',
        '<details open><summary>くわしく</summary>中身</details>',
        '',
        '<p><kbd>⌘</kbd>+<kbd>S</kbd>で保存<sup>1</sup></p>',
        '',
        '<img src="../img/logo.png" width="120" height="40" alt="ロゴ" style="width:9999px" class="hero">',
        '',
        '- [x] 済んだこと',
        '- [ ] まだのこと',
        '',
        '```ts',
        'const a = 1;',
        '```',
      ].join('\n'),
    );
    await settle();
    expect(doc.querySelector('[style], [onclick], [id="main"]')).toBeNull();
    // class は、コードの言語の印（色付け・mermaid の図に使う）だけ
    expect([...doc.querySelectorAll('[class]')].map((e) => `${e.tagName.toLowerCase()}.${e.getAttribute('class')}`)).toEqual(['code.language-ts']);
    expect(doc.querySelector('form, button, select, iframe, style, video')).toBeNull();
    expect(doc.querySelector('div[align="center"]')?.textContent).toBe('中央の段落');
    expect(doc.querySelector('details[open] > summary')?.textContent).toBe('くわしく');
    expect([...doc.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['⌘', 'S']);
    expect(doc.querySelector('sup')?.textContent).toBe('1');
    // 画像は、Markdown ファイルからの相対パスを、ワークスペースのパスにして読む。大きさと代わりの文字は残す
    const img = doc.querySelector('img')!;
    expect(img.dataset.path).toBe('img/logo.png');
    expect([img.getAttribute('width'), img.getAttribute('height'), img.getAttribute('alt')]).toEqual(['120', '40', 'ロゴ']);
    expect(api.argsOf('workspace.readImage')).toEqual([['A', 'img/logo.png']]);
    // 入力欄は、タスクリストのチェックボックスだけ（押しても変わらない）
    const boxes = [...doc.querySelectorAll<HTMLInputElement>('input')];
    expect(boxes.map((b) => [b.type, b.checked, b.disabled])).toEqual([
      ['checkbox', true, true],
      ['checkbox', false, true],
    ]);
  });
});

describe('UnsavedDialog（別のフォルダへ移る前の、保存していない変更の確認）', () => {
  type Props = ComponentProps<typeof UnsavedDialog>;
  const props = (over: Partial<Props> = {}): Props => ({
    files: ['src/app.ts', 'README.md'],
    onSave: vi.fn(() => Promise.resolve()),
    onDiscard: vi.fn(),
    onCancel: vi.fn(),
    ...over,
  });
  const dialog = () => screen.getByRole('dialog', { name: '保存していない変更' });

  it('保存していないファイルを並べ、「保存して移る」で保存を頼む。保存している間は、ほかのボタンを押せない', async () => {
    let finish!: () => void;
    const p = props({ onSave: vi.fn(() => new Promise<void>((resolve) => (finish = resolve))) });
    render(<UnsavedDialog {...p} />);
    expect(dialog().textContent).toContain('src/app.ts');
    expect(dialog().textContent).toContain('README.md');
    fireEvent.click(button('保存して移る'));
    expect(p.onSave).toHaveBeenCalledTimes(1);
    expect(button('保存しています…').disabled).toBe(true);
    expect(button('保存せずに移る').disabled).toBe(true);
    expect(button('やめる').disabled).toBe(true);
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    expect(p.onCancel).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(p.onDiscard).not.toHaveBeenCalled();
  });

  it('保存できなかったら理由を出し、もう一度選べる', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const p = props({ onSave: vi.fn(() => Promise.reject(new Error('書き込めません'))) });
    render(<UnsavedDialog {...p} />);
    fireEvent.click(button('保存して移る'));
    await settle();
    expect(alert).toHaveBeenCalledWith('保存できませんでした: 書き込めません');
    expect(button('保存して移る').disabled).toBe(false);
    fireEvent.click(button('やめる'));
    expect(p.onCancel).toHaveBeenCalledTimes(1);
  });

  it('「保存せずに移る」は保存を頼まずに移る', () => {
    const p = props();
    render(<UnsavedDialog {...p} />);
    fireEvent.click(button('保存せずに移る'));
    expect(p.onDiscard).toHaveBeenCalledTimes(1);
    expect(p.onSave).not.toHaveBeenCalled();
    expect(p.onCancel).not.toHaveBeenCalled();
  });

  it('「やめる」・Esc・外側を押すと、移らない（変換中の Esc では閉じない）', () => {
    const p = props();
    render(<UnsavedDialog {...p} />);
    fireEvent.click(button('やめる'));
    fireEvent.keyDown(dialog(), { key: 'Escape', isComposing: true });
    expect(p.onCancel).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    fireEvent.mouseDown(document.querySelector('.overlay')!);
    fireEvent.mouseDown(dialog());
    expect(p.onCancel).toHaveBeenCalledTimes(3);
    expect(p.onSave).not.toHaveBeenCalled();
    expect(p.onDiscard).not.toHaveBeenCalled();
  });
});

describe('DiffPane（差分）', () => {
  type Props = ComponentProps<typeof DiffPane>;
  const props = (over: Partial<Props> = {}): Props => ({
    path: 'src/app.ts',
    subtitle: '変更（インデックス ↔ 作業ツリー）',
    load: vi.fn(() => Promise.resolve({ original: 'const total = 1;\n', modified: 'const total = 2;\n' })),
    reloadKey: '1',
    onClose: vi.fn(),
    onOpenFile: vi.fn(),
    nav: { position: '2 / 3', onPrev: vi.fn(), onNext: vi.fn() },
    ...over,
  });
  const editor = () => fake.made.diffEditors[0];
  const sides = () => {
    const model = editor().getModel()!;
    return { original: model.original.value, modified: model.modified.value };
  };

  it('前のファイル・次のファイルへ移る。端では押せない', async () => {
    mockApi().install();
    const p = props();
    const view = render(<DiffPane {...p} />);
    await settle();
    expect(screen.queryByText('2 / 3')).not.toBeNull();
    fireEvent.click(button('前のファイル'));
    expect(p.nav!.onPrev).toHaveBeenCalledTimes(1);
    fireEvent.click(button('次のファイル'));
    expect(p.nav!.onNext).toHaveBeenCalledTimes(1);
    view.rerender(<DiffPane {...p} nav={{ position: '3 / 3', onPrev: p.nav!.onPrev, onNext: null }} />);
    expect(button('次のファイル').disabled).toBe(true);
    expect(button('前のファイル').disabled).toBe(false);
  });

  it('インラインと左右に並べるを切り替える', async () => {
    mockApi().install();
    render(<DiffPane {...props()} />);
    await settle();
    fireEvent.click(button('インライン'));
    expect(editor().options.at(-1)).toEqual({ renderSideBySide: false });
    fireEvent.click(button('左右に並べる'));
    expect(editor().options.at(-1)).toEqual({ renderSideBySide: true });
    expect(screen.queryByRole('button', { name: 'インライン' })).not.toBeNull();
  });

  it('「ファイルを開く」で、そのファイルを開く。開けないファイルではボタンを出さない', async () => {
    mockApi().install();
    const p = props();
    const view = render(<DiffPane {...p} />);
    await settle();
    expect(sides()).toEqual({ original: 'const total = 1;\n', modified: 'const total = 2;\n' });
    fireEvent.click(button('ファイルを開く'));
    expect(p.onOpenFile).toHaveBeenCalledWith('src/app.ts');
    fireEvent.click(button('差分を閉じる'));
    expect(p.onClose).toHaveBeenCalledTimes(1);
    view.rerender(<DiffPane {...p} onOpenFile={null} />);
    expect(screen.queryByRole('button', { name: 'ファイルを開く' })).toBeNull();
  });

  it('別のファイルの差分に変えて描き直した直後に押すと、変えた先のファイルに効く', async () => {
    mockApi().install();
    const first = props();
    const view = render(<DiffPane {...first} />);
    await settle();
    const second = props({
      path: 'docs/guide.md',
      load: vi.fn(() => Promise.resolve({ original: '', modified: '# ガイド\n' })),
      nav: { position: '3 / 3', onPrev: vi.fn(), onNext: null },
    });
    view.rerender(<DiffPane {...second} />);
    fireEvent.click(button('ファイルを開く'));
    expect(second.onOpenFile).toHaveBeenCalledWith('docs/guide.md');
    fireEvent.click(button('前のファイル'));
    expect(second.nav!.onPrev).toHaveBeenCalledTimes(1);
    expect(first.nav!.onPrev).not.toHaveBeenCalled();
    expect(first.onOpenFile).not.toHaveBeenCalled();
    await settle();
    expect(second.load).toHaveBeenCalledTimes(1);
    expect(sides()).toEqual({ original: '', modified: '# ガイド\n' });
    expect(screen.queryByText('guide.md')).not.toBeNull();
  });
});

describe('LineComments（エディタの行に付けるコメントの書きかけの欄）', () => {
  beforeAll(() => {
    // 欄の高さの変化を見張るもの。jsdom には無く、大きさも測らないので、知らせない
    if (!window.ResizeObserver) {
      window.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }
  });

  // 右クリックのメニューの項目を覚え、行の下に差し込む領域（view zone）を画面に置く偽物のエディタ
  function commentEditor() {
    const actions = new Map<string, () => void>();
    let seq = 0;
    const zones = new Map<string, HTMLElement>();
    const editor = fake.lenient({
      getModel: () => ({ getLineCount: () => 1, getLineContent: () => 'export const TAX_RATE = 0.1;' }),
      getSelection: () => null,
      getPosition: () => ({ lineNumber: 1, column: 1 }),
      getLayoutInfo: () => ({ contentWidth: 800 }),
      createDecorationsCollection: () => ({ set() {}, clear() {} }),
      addAction(action: { id: string; run: () => void }) {
        actions.set(action.id, action.run);
        return { dispose: () => actions.delete(action.id) };
      },
      changeViewZones(change: (accessor: { addZone: (zone: { domNode: HTMLElement }) => string; removeZone: (id: string) => void; layoutZone: () => void }) => void) {
        change({
          addZone(zone) {
            const id = `zone${++seq}`;
            document.body.appendChild(zone.domNode);
            zones.set(id, zone.domNode);
            return id;
          },
          removeZone(id) {
            zones.get(id)?.remove();
            zones.delete(id);
          },
          layoutZone() {},
        });
      },
    });
    return { editor: editor as unknown as ComponentProps<typeof LineComments>['editor'], run: (id: string) => act(() => actions.get(id)!()) };
  }
  const draft = () => screen.queryByPlaceholderText('直してほしいこと・気になること（⌘Enter で追加）');

  it('日本語の変換中に Esc（変換の取り消し）を押しても、書きかけの欄は閉じない。変換していない Esc では、何も付けずに閉じる', () => {
    // macOS の Chromium では、変換中の Esc も key が Escape の keydown として届き、isComposing が付く
    const { editor, run } = commentEditor();
    const onAdd = vi.fn();
    render(<LineComments editor={editor} path="src/tax.ts" comments={[]} onAdd={onAdd} onRemove={vi.fn()} />);
    run('tanacode.addComment');
    fireEvent.change(draft()!, { target: { value: 'ぜいりつを' } });
    fireEvent.keyDown(draft()!, { key: 'Escape', isComposing: true });
    expect(draft()).not.toBeNull();
    expect((draft() as HTMLTextAreaElement).value).toBe('ぜいりつを');
    fireEvent.keyDown(draft()!, { key: 'Escape' });
    expect(draft()).toBeNull();
    expect(onAdd).not.toHaveBeenCalled();
  });
});
