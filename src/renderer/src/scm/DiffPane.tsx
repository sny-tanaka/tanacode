import { useEffect, useRef, useState } from 'react';
import type { GitDiffSides } from '@shared/ipc';
import { editorTheme, languageFor, monaco } from '../editor/monaco';
import { LineComments, type ReviewComment } from '../review/LineComments';
import { ArrowDownIcon, ArrowUpIcon, CloseIcon, ColumnsIcon, FileIcon, IconButton, RowsIcon } from '../icons';

type Props = {
  path: string;
  // 何と何の差分か
  subtitle: string;
  // 差分の両側を読む。reloadKey が変わるたびに読み直す
  load: () => Promise<GitDiffSides>;
  reloadKey: string;
  onClose: () => void;
  // 削除されたファイルなど、開けないときは null
  onOpenFile: ((path: string) => void) | null;
  // 一覧の前後のファイルへ移る（レビュー用）
  nav?: { position: string; onPrev: (() => void) | null; onNext: (() => void) | null };
  // 変更後の側に付ける Claude へのコメント（このファイルのもの）
  comments?: { list: ReviewComment[]; onAdd: (comment: ReviewComment) => void; onRemove: (id: string) => void };
};

// 左右（またはインライン）の差分表示。ソース管理とレビューから開く
export function DiffPane({ path, subtitle, load, reloadKey, onClose, onOpenFile, nav, comments }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [inline, setInline] = useState(false);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const [modified, setModified] = useState<monaco.editor.IStandaloneCodeEditor | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const loadedPath = useRef<string | null>(null);

  useEffect(() => {
    const editor = monaco.editor.createDiffEditor(containerRef.current!, {
      theme: editorTheme(),
      readOnly: true,
      originalEditable: false,
      automaticLayout: true,
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 13,
      lineHeight: 21,
      minimap: { enabled: false },
      renderSideBySide: true,
      scrollBeyondLastLine: false,
    });
    editorRef.current = editor;
    // 単体の差分エディタの両側は IStandaloneCodeEditor（右クリックメニューに項目を足せる）
    setModified(editor.getModifiedEditor() as monaco.editor.IStandaloneCodeEditor);
    return () => {
      const model = editor.getModel();
      editor.dispose();
      model?.original.dispose();
      model?.modified.dispose();
    };
  }, []);

  useEffect(() => {
    editorRef.current?.updateOptions({ renderSideBySide: !inline });
  }, [inline]);

  useEffect(() => {
    let cancelled = false;
    void loadRef.current().then((sides) => {
      const editor = editorRef.current;
      if (cancelled || !editor) return;
      const old = editor.getModel();
      // 同じファイルを読み直すときは、内容だけ差し替えてスクロール位置を保つ
      if (old && loadedPath.current === path) {
        if (old.original.getValue() !== sides.original) old.original.setValue(sides.original);
        if (old.modified.getValue() !== sides.modified) old.modified.setValue(sides.modified);
        return;
      }
      loadedPath.current = path;
      const language = languageFor(path);
      editor.setModel({
        original: monaco.editor.createModel(sides.original, language),
        modified: monaco.editor.createModel(sides.modified, language),
      });
      old?.original.dispose();
      old?.modified.dispose();
    });
    return () => {
      cancelled = true;
    };
  }, [path, reloadKey]);

  return (
    <section className="editor diff-pane">
      <div className="diff-pane-head">
        {/* 列が狭いときは、フォルダの部分から省略してファイル名を残す */}
        <span className="diff-pane-title" data-tip={path}>
          <span className="diff-pane-dir">{path.slice(0, path.lastIndexOf('/') + 1)}</span>
          <span>{path.slice(path.lastIndexOf('/') + 1)}</span>
        </span>
        <span className="diff-pane-kind">{subtitle}</span>
        <div className="spacer" />
        {nav && (
          <>
            <IconButton icon={ArrowUpIcon} label="前のファイル" disabled={!nav.onPrev} onClick={() => nav.onPrev?.()} />
            <span className="diff-pane-kind">{nav.position}</span>
            <IconButton icon={ArrowDownIcon} label="次のファイル" disabled={!nav.onNext} onClick={() => nav.onNext?.()} />
          </>
        )}
        {/* 押すと切り替わる先のアイコンと名前を出す */}
        <IconButton icon={inline ? ColumnsIcon : RowsIcon} label={inline ? '左右に並べる' : 'インライン'} onClick={() => setInline((v) => !v)} />
        {onOpenFile && <IconButton icon={FileIcon} label="ファイルを開く" onClick={() => onOpenFile(path)} />}
        <IconButton icon={CloseIcon} label="差分を閉じる" onClick={onClose} />
      </div>
      <div className="editor-body">
        <div className="editor-monaco" ref={containerRef} />
      </div>
      {modified && comments && (
        <LineComments editor={modified} path={path} comments={comments.list} onAdd={comments.onAdd} onRemove={comments.onRemove} />
      )}
    </section>
  );
}
