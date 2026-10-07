// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorPane, type OpenFile } from '../../src/renderer/src/editor/EditorPane';
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
  return { monaco, made };
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
