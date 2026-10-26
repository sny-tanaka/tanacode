// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createRef, type ComponentProps } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorPane, type EditorHandle, type OpenFile } from '../../src/renderer/src/editor/EditorPane';
import { MarkdownPreview } from '../../src/renderer/src/editor/MarkdownPreview';
import { saveForLeaving, UnsavedDialog } from '../../src/renderer/src/editor/UnsavedDialog';
import { LineComments } from '../../src/renderer/src/review/LineComments';
import { DiffPane } from '../../src/renderer/src/scm/DiffPane';
import { runShortcut } from '../../src/renderer/src/layout/shortcuts';
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
      // キーの割り当て（⌘S）は控えておき、テストから押す
      addCommand(keybinding: number, handler: () => void) {
        made.commands.push({ keybinding, handler });
        return null;
      },
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
  const made = {
    models: [] as FakeModel[],
    diffEditors: [] as ReturnType<typeof diffEditor>[],
    commands: [] as { keybinding: number; handler: () => void }[],
  };
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

// mermaid は jsdom では描けないので、渡された id を付けた SVG を返す偽物にする（mermaid の SVG は、その id で色と矢印の形を当てる）
const mermaidRender = vi.hoisted(() => vi.fn(async (id: string, text: string) => ({ svg: `<svg id="${id}"><desc>${text}</desc></svg>` })));
vi.mock('mermaid', () => ({ default: { initialize() {}, render: mermaidRender } }));

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
  fake.made.commands.length = 0;
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
    onSave: vi.fn(() => Promise.resolve(true)),
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
  const dirtyDot = (path: string) => tab(path).querySelector('.editor-tab-dot.dirty');
  // ⌘S を押す（保存の返事を受けたあとの処理まで進める）
  const pressSave = async () => {
    const save = fake.made.commands.find((c) => c.keybinding === (fake.monaco.KeyMod.CtrlCmd | fake.monaco.KeyCode.KeyS))!;
    await act(async () => save.handler());
    await settle();
  };
  const MINE = 'const total = 2; // 手で直した\n';
  const CLAUDE = 'const total = 3; // Claude が直した\n';
  // main の書き込み（App の onSave の先）の代わりのディスク。expected（エディタが読んだとき・最後に保存したときの中身）を
  // 渡されたら、今の中身と同じときだけ書き、違えば書かずに false を返す。渡されなければ（直す前の main と同じく）確かめずに書く
  function fakeDisk() {
    const files: Record<string, string> = { 'src/app.ts': APP, 'README.md': README };
    const onSave = vi.fn(async (path: string, text: string, expected?: string | null) => {
      if (typeof expected === 'string' && files[path] !== expected) return false;
      files[path] = text;
      return true;
    });
    return { files, onSave };
  }

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

  describe('PDF', () => {
    const pdf = (path: string, bytes: number[]): OpenFile => ({ path, content: { kind: 'pdf', data: new Uint8Array(bytes) } });
    const viewer = () => document.querySelector<HTMLIFrameElement>('.editor-pdf iframe');
    // jsdom には Blob の URL が無い。作った Blob と、解放した URL を控える
    let blobs: Blob[];
    let revoked: string[];
    beforeEach(() => {
      blobs = [];
      revoked = [];
      Object.assign(URL, {
        createObjectURL: vi.fn((blob: Blob) => `blob:pdf-${blobs.push(blob)}`),
        revokeObjectURL: vi.fn((url: string) => revoked.push(url)),
      });
    });
    afterEach(() => {
      delete (URL as unknown as Record<string, unknown>).createObjectURL;
      delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
    });

    it('組み込みの PDF ビューア（iframe）に、PDF の中身を入れた blob: の URL で出す。中身が替わったら開き直し、タブを移ったら URL を解放する', async () => {
      mockApi().install();
      const p = props({ files: [pdf('docs/spec.pdf', [0x25, 0x50, 0x44, 0x46]), text('src/app.ts', APP)], activePath: 'docs/spec.pdf' });
      const view = render(<EditorPane {...p} />);
      await settle();
      expect(viewer()?.getAttribute('src')).toBe('blob:pdf-1');
      expect(viewer()?.title).toBe('docs/spec.pdf');
      expect(blobs[0].type).toBe('application/pdf');
      expect(blobs[0].size).toBe(4);
      // ディスクで変わって読み直した（中身が替わった）
      view.rerender(<EditorPane {...p} files={[pdf('docs/spec.pdf', [0x25, 0x50, 0x44, 0x46, 0x2d]), text('src/app.ts', APP)]} />);
      await settle();
      expect(viewer()?.getAttribute('src')).toBe('blob:pdf-2');
      expect(revoked).toEqual(['blob:pdf-1']);
      // 別のファイルへ移る
      view.rerender(<EditorPane {...p} files={[pdf('docs/spec.pdf', [0x25, 0x50, 0x44, 0x46, 0x2d]), text('src/app.ts', APP)]} activePath="src/app.ts" />);
      await settle();
      expect(viewer()).toBeNull();
      expect(revoked).toEqual(['blob:pdf-1', 'blob:pdf-2']);
      // PDF を出している間は、文字のエディタの案内も、バイナリの案内も出さない
      view.rerender(<EditorPane {...p} />);
      await settle();
      expect(document.querySelector('.editor-placeholder')).toBeNull();
    });

    it('PDF のタブが 2 つあるとき、移ると別のビューアに替わる（前の PDF の URL を使い回さない）', async () => {
      mockApi().install();
      const files = [pdf('a.pdf', [1]), pdf('b.pdf', [2, 2])];
      const view = render(<EditorPane {...props({ files, activePath: 'a.pdf' })} />);
      await settle();
      expect(viewer()?.title).toBe('a.pdf');
      view.rerender(<EditorPane {...props({ files, activePath: 'b.pdf' })} />);
      await settle();
      expect(viewer()?.title).toBe('b.pdf');
      expect(blobs.map((b) => b.size)).toEqual([1, 2]);
    });
  });

  describe('Finder で開く', () => {
    // パンくずの右端のボタン（開けないファイルの案内にも、同じ名前のボタンが出る）
    const reveal = () => within(document.querySelector<HTMLElement>('.editor-crumb')!).queryByRole<HTMLButtonElement>('button', { name: 'Finder で開く' });

    it('開いているファイルを Finder で開くよう頼む（セッションとファイルのパスを渡す）。ファイルによらず出る（文字・画像・PDF・バイナリ）', async () => {
      const api = mockApi({ 'workspace.revealFile': () => Promise.resolve() });
      api.install();
      const files: OpenFile[] = [
        text('src/app.ts', APP),
        { path: 'design/logo.png', content: { kind: 'image', url: 'data:image/png;base64,AA==' } },
        { path: 'app.dmg', content: { kind: 'binary' } },
      ];
      const view = render(<EditorPane {...props({ files, activePath: 'src/app.ts' })} />);
      fireEvent.click(reveal()!);
      for (const path of ['design/logo.png', 'app.dmg']) {
        view.rerender(<EditorPane {...props({ files, activePath: path })} />);
        fireEvent.click(reveal()!);
      }
      expect(api.argsOf('workspace.revealFile')).toEqual([
        ['A', 'src/app.ts'],
        ['A', 'design/logo.png'],
        ['A', 'app.dmg'],
      ]);
    });

    // 表示できないとき: 嘘にならないよう「バイナリ」と決めつけず、対応していない形式と伝える（0 バイトを含むだけで、画像や PDF のように表示できるものもある）
    it('開けないファイル（対応していない形式・大きすぎる）は、案内の文と「Finder で開く」のボタンを出す。ボタンは、パンくずのものと同じく、開いているファイルを頼む', async () => {
      const api = mockApi({ 'workspace.revealFile': () => Promise.resolve() });
      api.install();
      const files: OpenFile[] = [
        { path: 'release/app.dmg', content: { kind: 'binary' } },
        { path: 'public/intro.mp4', content: { kind: 'too-large', size: 14 * 1024 * 1024 } },
        text('src/app.ts', APP),
      ];
      const placeholder = () => document.querySelector<HTMLElement>('.editor-placeholder.unopenable');
      const view = render(<EditorPane {...props({ files, activePath: 'release/app.dmg' })} />);
      expect(placeholder()?.querySelector('span')?.textContent).toBe('対応していないファイル形式です');
      expect(document.body.textContent).not.toContain('バイナリファイルは表示できません');
      fireEvent.click(within(placeholder()!).getByRole('button', { name: 'Finder で開く' }));
      view.rerender(<EditorPane {...props({ files, activePath: 'public/intro.mp4' })} />);
      expect(placeholder()?.querySelector('span')?.textContent).toBe('ファイルが大きすぎるため表示できません（14MB）');
      fireEvent.click(within(placeholder()!).getByRole('button', { name: 'Finder で開く' }));
      expect(api.argsOf('workspace.revealFile')).toEqual([['A', 'release/app.dmg'], ['A', 'public/intro.mp4']]);
      // 開けるファイルでは出さない（パンくずのボタンだけ）
      view.rerender(<EditorPane {...props({ files, activePath: 'src/app.ts' })} />);
      expect(placeholder()).toBeNull();
      expect(screen.getAllByRole('button', { name: 'Finder で開く' })).toHaveLength(1);
    });

    it('開いているファイルが無いときは出さない。頼んで失敗しても（ファイルが消えたなど）、何も出さない', async () => {
      const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
      const api = mockApi({ 'workspace.revealFile': () => Promise.reject(new Error('ENOENT')) });
      api.install();
      const view = render(<EditorPane {...props({ files: [], activePath: null })} />);
      expect(reveal()).toBeNull();
      view.rerender(<EditorPane {...props()} />);
      fireEvent.click(reveal()!);
      await settle();
      expect(api.argsOf('workspace.revealFile')).toEqual([['A', 'src/app.ts']]);
      expect(alert).not.toHaveBeenCalled();
    });
  });

  it('エディタにフォーカスがあるとき、⌃Tab・⌃⇧Tab でタブを順に送る（端から反対の端へ回る）。フォーカスが外にあれば送らない', () => {
    mockApi().install();
    const p = props({ files: [text('src/app.ts', APP), text('README.md', README), text('src/b.ts', 'b')] });
    render(<EditorPane {...p} />);
    act(() => tab('src/app.ts').querySelector<HTMLElement>('button')!.focus());
    act(() => runShortcut('nextTab'));
    act(() => runShortcut('previousTab'));
    expect(vi.mocked(p.onActivate).mock.calls).toEqual([['README.md'], ['src/b.ts']]);
    act(() => (document.activeElement as HTMLElement).blur());
    act(() => runShortcut('nextTab'));
    expect(p.onActivate).toHaveBeenCalledTimes(2);
  });

  it('⌘W は、エディタにフォーカスがある・どの欄にもフォーカスが無いときに、今のタブを閉じる（未保存なら確かめる）。ターミナルにフォーカスがある・ブラウザを出しているときは閉じない', async () => {
    mockApi().install();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const p = props();
    const view = render(
      <>
        <EditorPane {...p} />
        <div className="terminal-panel">
          <button>ターミナルの中</button>
        </div>
      </>,
    );
    act(() => screen.getByText('ターミナルの中').focus());
    act(() => runShortcut('closeTab'));
    expect(p.onClose).not.toHaveBeenCalled();
    act(() => tab('src/app.ts').querySelector<HTMLElement>('button')!.focus());
    act(() => runShortcut('closeTab'));
    expect(vi.mocked(p.onClose).mock.calls).toEqual([['src/app.ts']]);
    act(() => (document.activeElement as HTMLElement).blur());
    await edit(APP, 'const total = 2;\n');
    act(() => runShortcut('closeTab'));
    expect(confirm).toHaveBeenCalledWith('app.ts の変更を保存せずに閉じますか？');
    expect(p.onClose).toHaveBeenCalledTimes(1);
    view.rerender(
      <>
        <EditorPane {...p} />
        <div className="preview-pane" />
      </>,
    );
    confirm.mockReturnValue(true);
    act(() => runShortcut('closeTab'));
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });

  it('⌘4 で、エディタへ。エディタを隠している（差分を見ている）ときは何もしない', () => {
    mockApi().install();
    const view = render(<EditorPane {...props({ activePath: 'README.md' })} />);
    // Markdown はプレビューで出すので、欄そのものへ（移している間だけ tabindex を付ける）
    act(() => runShortcut('focusContent'));
    const section = document.querySelector<HTMLElement>('section.editor')!;
    expect(document.activeElement).toBe(section);
    act(() => section.blur());
    expect(section.hasAttribute('tabindex')).toBe(false);
    view.rerender(
      <div hidden>
        <EditorPane {...props({ activePath: 'README.md' })} />
      </div>,
    );
    act(() => runShortcut('focusContent'));
    expect(document.activeElement).toBe(document.body);
  });

  it('今のタブの × のツールチップに、⌘W を添える', () => {
    mockApi().install();
    render(<EditorPane {...props()} />);
    expect(tab('src/app.ts').querySelector('button')!.getAttribute('data-tip')).toBe('閉じる（⌘W）');
    expect(tab('README.md').querySelector('button')!.getAttribute('data-tip')).toBe('閉じる');
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

  describe('SVG', () => {
    const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/></svg>\n';
    const SVG_NEXT = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="20" height="20"/></svg>\n';
    const dataUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    const image = () => document.querySelector<HTMLImageElement>('.svg-preview img');
    const mode = (label: string) => screen.getByRole<HTMLButtonElement>('tab', { name: label });
    const files = [text('design/logo.svg', SVG), text('src/app.ts', APP)];

    it('はじめは画像（プレビュー）で出し、ボタンでソース・並べる・プレビューを切り替える。Markdown とは別の名前の切り替えで、ほかのファイルでは出さない', async () => {
      mockApi().install();
      const p = props({ files, activePath: 'design/logo.svg' });
      const view = render(<EditorPane {...p} />);
      await settle();
      expect(screen.queryByRole('tablist', { name: 'SVG の表示' })).not.toBeNull();
      expect(screen.queryByRole('tablist', { name: 'Markdown の表示' })).toBeNull();
      expect(mode('プレビュー').getAttribute('aria-selected')).toBe('true');
      expect(body().className).toContain('md-preview');
      expect(image()?.getAttribute('src')).toBe(dataUrl(SVG));
      expect(image()?.alt).toBe('design/logo.svg');
      expect(document.querySelector('.markdown-preview')).toBeNull();
      fireEvent.click(mode('ソース'));
      expect(body().className).toContain('md-source');
      expect(image()).toBeNull();
      fireEvent.click(mode('並べる'));
      expect(body().className).toContain('md-split');
      expect(image()).not.toBeNull();
      // ほかのファイルでは出さず、戻ると選んだ見せ方のまま
      view.rerender(<EditorPane {...p} activePath="src/app.ts" />);
      expect(screen.queryByRole('tablist')).toBeNull();
      expect(image()).toBeNull();
      view.rerender(<EditorPane {...p} activePath="design/logo.svg" />);
      expect(mode('並べる').getAttribute('aria-selected')).toBe('true');
    });

    it('編集中（未保存）の内容を映す。入力のたびではなく、少し待ってから描き直す', async () => {
      vi.useFakeTimers();
      try {
        mockApi().install();
        render(<EditorPane {...props({ files, activePath: 'design/logo.svg' })} />);
        await settle();
        act(() => modelOf(SVG).setValue(SVG_NEXT));
        expect(image()?.getAttribute('src')).toBe(dataUrl(SVG));
        act(() => vi.advanceTimersByTime(150));
        expect(image()?.getAttribute('src')).toBe(dataUrl(SVG_NEXT));
      } finally {
        vi.useRealTimers();
      }
    });

    it('SVG として読み込めないとき（書きかけなど）は、画像の代わりに案内を出し、中身が替わると読み直す', async () => {
      vi.useFakeTimers();
      try {
        mockApi().install();
        render(<EditorPane {...props({ files, activePath: 'design/logo.svg' })} />);
        await settle();
        act(() => modelOf(SVG).setValue('<svg'));
        act(() => vi.advanceTimersByTime(150));
        fireEvent.error(image()!);
        expect(image()).toBeNull();
        expect(document.querySelector('.svg-preview-invalid')?.textContent).toContain('SVG として読み込めません');
        act(() => modelOf('<svg').setValue(SVG_NEXT));
        act(() => vi.advanceTimersByTime(150));
        expect(document.querySelector('.svg-preview-invalid')).toBeNull();
        expect(image()?.getAttribute('src')).toBe(dataUrl(SVG_NEXT));
      } finally {
        vi.useRealTimers();
      }
    });

    it('行を指して開いたときは、その行が見えるようにソースを出す（Markdown と同じ）', async () => {
      mockApi().install();
      const p = props({ files, activePath: 'design/logo.svg', reveal: { path: 'design/logo.svg', line: 1, seq: 1 } });
      render(<EditorPane {...p} />);
      await settle();
      expect(mode('ソース').getAttribute('aria-selected')).toBe('true');
      expect(image()).toBeNull();
    });
  });

  describe('未保存の変更があるうちに、ディスク上のファイルが変わったとき', () => {
    // 書き換えたあと、ディスク側（Claude Code など）でも変わり、その知らせが届く
    async function conflict() {
      mockApi().install();
      const disk = fakeDisk();
      const p = props({ onSave: disk.onSave });
      const view = render(<EditorPane {...p} />);
      await edit(APP, MINE);
      disk.files['src/app.ts'] = CLAUDE;
      view.rerender(<EditorPane {...p} files={[text('src/app.ts', CLAUDE), text('README.md', README)]} />);
      expect(banner()).not.toBeNull();
      return { p, view, disk };
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

    it('「このまま保存」で、書き換えた内容をディスクに書く（ディスク側の変更を確かめずに上書きする）', async () => {
      const { p, disk } = await conflict();
      const model = fake.made.models.find((m) => m.language === 'typescript')!;
      fireEvent.click(button('このまま保存'));
      expect(p.onSave).toHaveBeenCalledWith('src/app.ts', MINE, null);
      await settle();
      expect(disk.files['src/app.ts']).toBe(MINE);
      expect(banner()).toBeNull();
      expect(model.value).toBe(MINE);
      expect(dirtyDot('src/app.ts')).toBeNull();
    });

    it('⌘S では書かない（Claude の変更を黙って消さない）。知らせを出したまま、どちらを残すか選ぶまで未保存のまま', async () => {
      const { disk } = await conflict();
      await pressSave();
      expect(disk.files['src/app.ts']).toBe(CLAUDE);
      expect(banner()).not.toBeNull();
      expect(dirtyDot('src/app.ts')).not.toBeNull();
      fireEvent.click(button('このまま保存'));
      await settle();
      expect(disk.files['src/app.ts']).toBe(MINE);
      expect(banner()).toBeNull();
    });

    it('変更の知らせが届く前（監視のまとめの間・監視しないフォルダのファイル）に ⌘S を押しても書かない。main が返した今の中身で、同じ知らせを出す', async () => {
      mockApi().install();
      const disk = fakeDisk();
      const p = props({ onSave: disk.onSave });
      const view = render(<EditorPane {...p} />);
      await edit(APP, MINE);
      disk.files['src/app.ts'] = CLAUDE;
      await pressSave();
      // 読んだときの中身を添えて頼み、main が今のディスクと違うので書かない
      expect(p.onSave).toHaveBeenCalledWith('src/app.ts', MINE, APP);
      expect(disk.files['src/app.ts']).toBe(CLAUDE);
      expect(dirtyDot('src/app.ts')).not.toBeNull();
      // App が、main の返した今の中身を files に入れる
      view.rerender(<EditorPane {...p} files={[text('src/app.ts', CLAUDE), text('README.md', README)]} />);
      expect(banner()).not.toBeNull();
      expect(fake.made.models.find((m) => m.language === 'typescript')!.value).toBe(MINE);
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
    async function twoEdited(over: Partial<Props> = {}) {
      mockApi().install();
      const handle = createRef<EditorHandle>();
      const p = props(over);
      const view = render(<EditorPane {...p} handle={handle} />);
      expect(handle.current!.unsaved()).toEqual([]);
      await edit(APP, 'const total = 2;\n');
      view.rerender(<EditorPane {...p} handle={handle} activePath="README.md" />);
      await edit(README, '# 直した使い方\n');
      return { handle, p, view };
    }

    it('ディスク側でも変わったファイル（衝突中）は分けて返し、まとめて保存しても書かない（今のタブでなく、衝突の帯が見えていなくても）', async () => {
      const { handle, p, view } = await twoEdited();
      // README を見ている間に、Claude が src/app.ts を書き換えた
      view.rerender(<EditorPane {...p} handle={handle} activePath="README.md" files={[text('src/app.ts', 'const total = 3; // Claude が直した\n'), text('README.md', README)]} />);
      expect(banner()).toBeNull();
      expect(handle.current!.unsaved()).toEqual(['src/app.ts', 'README.md']);
      expect(handle.current!.conflicts()).toEqual(['src/app.ts']);
      await act(() => handle.current!.saveAll());
      expect(p.onSave).toHaveBeenCalledTimes(1);
      expect(p.onSave).toHaveBeenCalledWith('README.md', '# 直した使い方\n', README);
      expect(handle.current!.unsaved()).toEqual(['src/app.ts']);
      expect(handle.current!.conflicts()).toEqual(['src/app.ts']);
      // 残ったものがあるので、「保存して移る」は失敗にして移らない
      await expect(act(() => saveForLeaving(handle.current))).rejects.toThrow('src/app.ts は、ディスク側（Claude など）でも変わっています');
    });

    it('まとめて保存したときに、ディスク側でも変わっていた（知らせがまだ届いていない）ファイルは書かず、「保存して移る」は失敗にして移らない', async () => {
      const disk = fakeDisk();
      const { handle } = await twoEdited({ onSave: disk.onSave });
      disk.files['src/app.ts'] = CLAUDE;
      await expect(act(() => saveForLeaving(handle.current))).rejects.toThrow('src/app.ts は、ディスク側（Claude など）でも変わっています');
      expect(disk.files).toEqual({ 'src/app.ts': CLAUDE, 'README.md': '# 直した使い方\n' });
      expect(handle.current!.unsaved()).toEqual(['src/app.ts']);
    });

    it('保存していないファイルをタブの順に返し、まとめて保存すると、すべて書いて未保存の印も消える', async () => {
      const { handle, p } = await twoEdited();
      expect(handle.current!.unsaved()).toEqual(['src/app.ts', 'README.md']);
      await act(() => handle.current!.saveAll());
      expect(p.onSave).toHaveBeenCalledWith('src/app.ts', 'const total = 2;\n', APP);
      expect(p.onSave).toHaveBeenCalledWith('README.md', '# 直した使い方\n', README);
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

  it('打って描き直しても、同じ画像は読み直さず、同じコードは色付けし直さない。ディスク上で何か変わったら、次に描くときに画像を読み直す', async () => {
    // 色付けできる言語（偽物の Monaco は言語を持たない。言語の印は覚えておくので、ほかのテストで使わない名前にする）
    vi.spyOn(fake.monaco.languages, 'getLanguages').mockReturnValue([{ id: 'cachedlang' }] as never);
    const colorize = vi.spyOn(fake.monaco.editor, 'colorize');
    const before = colorize.mock.calls.length;
    const text = ['# 見出し', '', '![ロゴ](../img/logo.png)', '', '```cachedlang', 'const cached = 1;', '```'].join('\n');
    const { api, doc } = preview(text);
    await settle();
    const model = fake.made.models.at(-1)!;
    // プレビューは少し待ってから描き直す（RENDER_DELAY_MS）
    const typed = async (next: string) => {
      act(() => model.setValue(next));
      await act(() => new Promise((resolve) => setTimeout(resolve, 200)));
    };
    await typed(`${text}\n\n本文`);
    expect(doc.textContent).toContain('本文');
    expect(api.argsOf('workspace.readImage')).toEqual([['A', 'img/logo.png']]);
    expect(colorize.mock.calls.length - before).toBe(1);
    await settle();
    expect(doc.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AA==');
    act(() => api.emit('workspace.onFilesChanged', { root: '/work/a', paths: ['img/logo.png'] }));
    await typed(`${text}\n\n本文の続き`);
    expect(api.argsOf('workspace.readImage')).toEqual([
      ['A', 'img/logo.png'],
      ['A', 'img/logo.png'],
    ]);
  });

  it('同じ mermaid の図が 2 回あっても、別の id で描く（id が重なると色や矢印が崩れる）。打って描き直しても、描き直さずに同じ id のまま', async () => {
    const diagram = ['```mermaid', 'flowchart LR', '  A[同じ図] --> B[2 回]', '```'].join('\n');
    const text = ['# 図', '', diagram, '', 'あいだ', '', diagram].join('\n');
    const before = mermaidRender.mock.calls.length;
    const { doc } = preview(text);
    const ids = () => [...doc.querySelectorAll('.markdown-mermaid > svg')].map((svg) => svg.id);
    await vi.waitFor(() => expect(ids()).toHaveLength(2));
    const first = ids();
    expect(new Set(first).size).toBe(2);
    expect(mermaidRender.mock.calls.length - before).toBe(2);
    act(() => fake.made.models.at(-1)!.setValue(`${text}\n\n本文`));
    await vi.waitFor(() => expect(doc.textContent).toContain('本文'));
    await vi.waitFor(() => expect(ids()).toEqual(first));
    expect(mermaidRender.mock.calls.length - before).toBe(2);
  });
});

describe('MarkdownPreview の目印へのリンク', () => {
  it('文書の中の目印（<a id>・<a name>）は、アプリの画面の id とぶつからないよう前置き（user-content-）を付けて残し、#目印 のリンクで移れる', async () => {
    mockApi().install();
    const model = fake.monaco.editor.createModel(
      ['[入れ方へ](#install) / [よくある質問へ](#faq) / [使い方へ](#使い方)', '', '<a id="install"></a>', '', '## 使い方', '', '<a name="faq"></a>', '', '本文'].join('\n'),
      'markdown',
    );
    render(<MarkdownPreview sessionId="A" path="README.md" model={model as never} onOpenFile={vi.fn()} />);
    await settle();
    const doc = document.querySelector<HTMLElement>('.markdown-doc')!;
    expect(doc.querySelector('[id="install"], [name="faq"]')).toBeNull();
    const install = doc.querySelector('[id="user-content-install"]');
    const faq = doc.querySelector('[name="user-content-faq"]');
    expect(install).not.toBeNull();
    expect(faq).not.toBeNull();
    const scrolled: Element[] = [];
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      scrolled.push(this);
    });
    fireEvent.click(screen.getByText('入れ方へ'));
    fireEvent.click(screen.getByText('よくある質問へ'));
    fireEvent.click(screen.getByText('使い方へ'));
    expect(scrolled).toEqual([install, faq, doc.querySelector('h2')]);
  });
});

describe('MarkdownPreview の見出しの id', () => {
  function previewOf(text: string) {
    mockApi().install();
    const model = fake.monaco.editor.createModel(text, 'markdown');
    render(<MarkdownPreview sessionId="A" path="README.md" model={model as never} onOpenFile={vi.fn()} />);
    return document.querySelector<HTMLElement>('.markdown-doc')!;
  }

  it('見出しの id にも前置きを付ける（mermaid の図を描くときの id「mermaid-1」などとぶつけない。ぶつかると mermaid が見出しを消す）。#見出し のリンクで移れる', async () => {
    const doc = previewOf(['[図の見出しへ](#mermaid-1)', '', '# mermaid 1', '', '## mermaid 1'].join('\n'));
    await settle();
    expect([...doc.querySelectorAll('h1, h2')].map((h) => h.id)).toEqual(['user-content-mermaid-1', 'user-content-mermaid-1-1']);
    expect(doc.querySelector('[id="mermaid-1"]')).toBeNull();
    const scrolled: Element[] = [];
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      scrolled.push(this);
    });
    fireEvent.click(screen.getByText('図の見出しへ'));
    expect(scrolled).toEqual([doc.querySelector('h1')]);
  });

  it('前置きまで書いた目印へのリンク（#user-content-install。GitHub では効く）でも移れる', async () => {
    const doc = previewOf(['[入れ方へ](#user-content-install)', '', '<a id="install"></a>', '', '本文'].join('\n'));
    await settle();
    const scrolled: Element[] = [];
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      scrolled.push(this);
    });
    fireEvent.click(screen.getByText('入れ方へ'));
    expect(scrolled).toEqual([doc.querySelector('[id="user-content-install"]')]);
  });

  it('% を含む目印（#100%）のように、URL として読めないリンクでも止まらず、書いたままの名前で探す', async () => {
    const doc = previewOf(['[全部へ](#100%)', '', '<a id="100%"></a>', '', '本文'].join('\n'));
    await settle();
    const scrolled: Element[] = [];
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      scrolled.push(this);
    });
    expect(() => fireEvent.click(screen.getByText('全部へ'))).not.toThrow();
    expect(scrolled).toEqual([doc.querySelector('[id="user-content-100%"]')]);
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

  it('ディスク側でも変わったファイル（衝突中）は分けて示し、「保存して移る」は押せない。「やめる」で戻ってエディタで選ばせる', () => {
    const p = props({ files: ['README.md'], conflicts: ['src/app.ts'] });
    render(<UnsavedDialog {...p} />);
    expect(dialog().querySelector('h2')?.textContent).toBe('保存していない変更があります（2 件）');
    const note = screen.getByText(/ディスク側（Claude など）でも変わっています/);
    expect(note.nextElementSibling?.textContent).toBe('src/app.ts');
    expect(button('保存して移る').disabled).toBe(true);
    expect(button('保存せずに移る').disabled).toBe(false);
    fireEvent.click(button('やめる'));
    expect(p.onCancel).toHaveBeenCalledTimes(1);
    expect(p.onSave).not.toHaveBeenCalled();
  });

  it('「保存して移る」の保存: エディタが閉じていたら（ダイアログを出している間に外れた）、保存せずに失敗にして移らない', async () => {
    await expect(saveForLeaving(null)).rejects.toThrow('エディタが閉じています');
    const saveAll = vi.fn(() => Promise.resolve());
    await saveForLeaving({ unsaved: () => [], conflicts: () => [], saveAll });
    expect(saveAll).toHaveBeenCalledTimes(1);
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
