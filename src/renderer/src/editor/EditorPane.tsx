import { memo, useEffect, useRef, useState } from 'react';
import type { FileBaseline, FileChange, FileContent } from '@shared/ipc';
import { LineComments, type ReviewComment } from '../review/LineComments';
import { DiffDecorations } from './diffDecorations';
import { MarkdownPreview } from './MarkdownPreview';
import { editorTheme, languageFor, monaco } from './monaco';

export type OpenFile = { path: string; content: FileContent };
// seq が変わるたびに、その行を表示してカーソルを置く
export type RevealRequest = { path: string; line: number; seq: number };
// Markdown ファイルの表示のしかた
type MarkdownMode = 'preview' | 'split' | 'source';
const MARKDOWN_MODES: { mode: MarkdownMode; label: string }[] = [
  { mode: 'preview', label: 'プレビュー' },
  { mode: 'split', label: '並べる' },
  { mode: 'source', label: 'ソース' },
];
const isMarkdown = (path: string) => /\.(md|markdown|mdx)$/i.test(path);

type Props = {
  sessionId: string;
  files: OpenFile[];
  activePath: string | null;
  // このブランチで変わったファイルと、その基点（分岐点のコミット）。変わった行に色を付ける
  changes: Record<string, FileChange>;
  mergeBase: string | null;
  // ブランチの差分（基点 ↔ 作業ツリー）を開く
  onShowDiff: (path: string) => void;
  // Markdown プレビューのリンクから、リポジトリ内のファイルを開く
  onOpenFile: (path: string, line?: number) => void;
  reveal: RevealRequest | null;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
  // 保存した内容をディスクに書く（書き終えたら files の内容も更新される）
  onSave: (path: string, text: string) => Promise<void>;
  onCursor: (pos: { line: number; column: number } | null) => void;
  // Claude へのコメント（このセッションのもの。ファイルで絞り込んで出す）
  comments: ReviewComment[];
  onAddComment: (comment: ReviewComment) => void;
  onRemoveComment: (id: string) => void;
};

// App はチャットのイベントなどで頻繁に描き直されるので、props が変わったときだけ描き直す
export const EditorPane = memo(function EditorPane({
  sessionId,
  files,
  activePath,
  changes,
  mergeBase,
  onShowDiff,
  onOpenFile,
  reveal,
  onActivate,
  onClose,
  onSave,
  onCursor,
  comments,
  onAddComment,
  onRemoveComment,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [editorInstance, setEditorInstance] = useState<monaco.editor.IStandaloneCodeEditor | null>(null);
  const diffRef = useRef<DiffDecorations | null>(null);
  const modelsRef = useRef(new Map<string, monaco.editor.ITextModel>());
  const revealedSeq = useRef<number | null>(null);
  // 最後に読み込んだ・保存したディスクの内容。モデルの内容と違えば未保存
  const savedRef = useRef(new Map<string, string>());
  const [dirty, setDirty] = useState<ReadonlySet<string>>(new Set());
  // 未保存の変更があるのにディスク側（Claude Code など）でも変わったファイル
  const [conflicts, setConflicts] = useState<ReadonlySet<string>>(new Set());
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onCursorRef = useRef(onCursor);
  onCursorRef.current = onCursor;
  const [baseline, setBaseline] = useState<{ path: string; value: FileBaseline } | null>(null);
  // 表示中のモデル（Markdown プレビューが内容を読む）。モデルは描画のあとで作るので state で持つ
  const [activeModel, setActiveModel] = useState<monaco.editor.ITextModel | null>(null);
  // 開いた Markdown は読むことが多いので、はじめはプレビューにする
  const [markdownModes, setMarkdownModes] = useState<ReadonlyMap<string, MarkdownMode>>(new Map());
  const setMarkdownMode = (path: string, mode: MarkdownMode) =>
    setMarkdownModes((prev) => new Map(prev).set(path, mode));

  useEffect(() => {
    const editor = monaco.editor.create(containerRef.current!, {
      theme: editorTheme(),
      automaticLayout: true,
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 13,
      lineHeight: 21,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: 'line',
      // 上端に固定表示される行が、差し込んだ削除行を隠してしまう
      stickyScroll: { enabled: false },
      padding: { top: 4 },
      model: null,
    });
    editor.onDidChangeCursorPosition((e) =>
      onCursorRef.current({ line: e.position.lineNumber, column: e.position.column }),
    );
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save());
    editorRef.current = editor;
    setEditorInstance(editor);
    diffRef.current = new DiffDecorations(editor);
    const models = modelsRef.current;
    return () => {
      editor.dispose();
      models.forEach((m) => m.dispose());
      models.clear();
    };
  }, []);

  const active = files.find((f) => f.path === activePath);
  const activeText = active?.content.kind === 'text' ? active.content.text : null;
  const markdownMode = activePath && activeText !== null && isMarkdown(activePath) ? (markdownModes.get(activePath) ?? 'preview') : null;
  const change = activePath ? changes[activePath] : undefined;

  useEffect(() => {
    const models = modelsRef.current;
    const openPaths = new Set(files.map((f) => f.path));
    for (const [path, model] of models) {
      if (!openPaths.has(path)) {
        model.dispose();
        models.delete(path);
      }
    }
    const editor = editorRef.current!;
    const saved = savedRef.current;
    for (const path of [...saved.keys()]) if (!openPaths.has(path)) saved.delete(path);
    // 開いているファイルがディスク上で変わったら読み直した内容に差し替える。未保存の変更があれば上書きせず知らせる
    const found = new Set<string>();
    for (const file of files) {
      const model = models.get(file.path);
      if (!model || file.content.kind !== 'text') continue;
      const disk = file.content.text;
      if (saved.get(file.path) === disk) continue;
      if (model.getValue() !== saved.get(file.path) && model.getValue() !== disk) {
        found.add(file.path);
        continue;
      }
      saved.set(file.path, disk);
      if (model.getValue() === disk) continue;
      const viewState = editor.getModel() === model ? editor.saveViewState() : null;
      model.setValue(disk);
      if (viewState) editor.restoreViewState(viewState);
    }
    setConflicts((prev) => {
      const next = new Set([...prev].filter((p) => openPaths.has(p)));
      found.forEach((p) => next.add(p));
      return next.size === prev.size && [...next].every((p) => prev.has(p)) ? prev : next;
    });
    const current = files.find((f) => f.path === activePath);
    if (!current || current.content.kind !== 'text') {
      editor.setModel(null);
      setActiveModel(null);
      onCursorRef.current(null);
      return;
    }
    let model = models.get(current.path);
    if (!model) {
      const created = monaco.editor.createModel(current.content.text, languageFor(current.path));
      const path = current.path;
      saved.set(path, current.content.text);
      created.onDidChangeContent(() => updateDirty(path, created));
      models.set(path, created);
      model = created;
    }
    setActiveModel(model);
    if (editor.getModel() !== model) {
      editor.setModel(model);
      const pos = editor.getPosition();
      onCursorRef.current(pos ? { line: pos.lineNumber, column: pos.column } : null);
    }
  }, [files, activePath]);

  function updateDirty(path: string, model: monaco.editor.ITextModel) {
    const isDirty = model.getValue() !== savedRef.current.get(path);
    setDirty((prev) => {
      if (prev.has(path) === isDirty) return prev;
      const next = new Set(prev);
      if (isDirty) next.add(path);
      else next.delete(path);
      return next;
    });
  }

  async function save(path = activePathRef.current) {
    const model = path ? modelsRef.current.get(path) : undefined;
    if (!path || !model) return;
    const text = model.getValue();
    await onSaveRef.current(path, text);
    savedRef.current.set(path, text);
    updateDirty(path, model);
    setConflicts((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
  }

  // ディスクの内容で置き換える（未保存の変更は捨てる）
  function reloadFromDisk(path: string) {
    const file = files.find((f) => f.path === path);
    const model = modelsRef.current.get(path);
    if (!file || file.content.kind !== 'text' || !model) return;
    savedRef.current.set(path, file.content.text);
    model.setValue(file.content.text);
    setConflicts((prev) => {
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
  }

  const close = (path: string) => {
    if (dirty.has(path) && !window.confirm(`${path.split('/').pop()} の変更を保存せずに閉じますか？`)) return;
    setDirty((prev) => {
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
    onClose(path);
  };

  useEffect(() => {
    const editor = editorRef.current!;
    const model = editor.getModel();
    if (!reveal || reveal.seq === revealedSeq.current || reveal.path !== activePath || !model) return;
    revealedSeq.current = reveal.seq;
    // 行を指して開いたときは、その行が見えるようにソースを出す
    if (isMarkdown(reveal.path) && (markdownModes.get(reveal.path) ?? 'preview') === 'preview') setMarkdownMode(reveal.path, 'source');
    const line = Math.min(reveal.line, model.getLineCount());
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.revealLineInCenterIfOutsideViewport(line, monaco.editor.ScrollType.Smooth);
  }, [reveal, activePath, activeText]);

  // 基点での内容を読む（基点が変わる・コミットするなどで変わりうる）
  useEffect(() => {
    if (!activePath || !change || !mergeBase) return;
    let cancelled = false;
    void window.tanacode.git.baseline(sessionId, mergeBase, activePath).then((value) => {
      if (!cancelled) setBaseline({ path: activePath, value });
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, activePath, change, mergeBase]);

  useEffect(() => {
    const diff = diffRef.current!;
    const model = editorRef.current!.getModel();
    if (!change || activeText === null || !model || baseline?.path !== activePath) {
      diff.clear();
      return;
    }
    diff.show(baseline.value.text, model.getValue());
  }, [change, activeText, activePath, baseline]);

  return (
    <section className="editor">
      <div className="editor-tabs">
        {files.map((f) => (
          <div
            key={f.path}
            className={`editor-tab${f.path === activePath ? ' active' : ''}`}
            onClick={() => onActivate(f.path)}
            title={f.path}
          >
            <span>{f.path.split('/').pop()}</span>
            {dirty.has(f.path) ? (
              <span className="editor-tab-dot dirty" title="未保存の変更があります（⌘S で保存）" />
            ) : (
              changes[f.path] && <span className="editor-tab-dot" title="このブランチで変わったファイル" />
            )}
            <button
              className="editor-tab-close"
              onClick={(e) => {
                e.stopPropagation();
                close(f.path);
              }}
              aria-label="閉じる"
              data-tip="閉じる"
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="editor-crumb">
        <span className="editor-crumb-path">{active ? active.path.split('/').join('  ›  ') : ''}</span>
        {markdownMode && activePath && (
          <div className="segmented" role="tablist" aria-label="Markdown の表示">
            {MARKDOWN_MODES.map(({ mode, label }) => (
              <button
                key={mode}
                role="tab"
                aria-selected={markdownMode === mode}
                className={markdownMode === mode ? 'active' : ''}
                onClick={() => setMarkdownMode(activePath, mode)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
      {activePath && conflicts.has(activePath) && (
        <div className="pending-banner">
          <span className="pending-dot" />
          <span className="pending-text">未保存の変更があるうちに、ディスク上のファイルが変更されました</span>
          <button className="ghost-button" onClick={() => reloadFromDisk(activePath)}>
            ディスクの内容を読み込む
          </button>
          <button className="send-button" onClick={() => void save(activePath)}>
            このまま保存
          </button>
        </div>
      )}
      {change && activePath && (
        <div className="change-bar">
          <span>このブランチで{change.kind === 'added' ? '新規作成' : '変更'}</span>
          <span className="diff-add">+{change.added}</span>
          <span className="diff-del">−{change.removed}</span>
          <div className="spacer" />
          <button className="ghost-button" onClick={() => onShowDiff(activePath)}>
            差分を見る
          </button>
        </div>
      )}
      <div className={`editor-body${markdownMode ? ` md-${markdownMode}` : ''}`}>
        <div className="editor-monaco" ref={containerRef} />
        {markdownMode && markdownMode !== 'source' && activePath && activeModel && (
          <MarkdownPreview sessionId={sessionId} path={activePath} model={activeModel} onOpenFile={onOpenFile} />
        )}
        {editorInstance && activePath && activeText !== null && (
          <LineComments
            editor={editorInstance}
            path={activePath}
            comments={comments.filter((c) => c.path === activePath)}
            onAdd={onAddComment}
            onRemove={onRemoveComment}
          />
        )}
        {!active && <div className="editor-placeholder">エクスプローラーからファイルを開いてください</div>}
        {active?.content.kind === 'binary' && <div className="editor-placeholder">バイナリファイルは表示できません</div>}
        {active?.content.kind === 'too-large' && (
          <div className="editor-placeholder">
            ファイルが大きすぎるため表示できません（{Math.round(active.content.size / 1024 / 1024)}MB）
          </div>
        )}
      </div>
    </section>
  );
});
