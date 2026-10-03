import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { monaco } from '../editor/monaco';
import { CloseIcon, IconButton, TrashIcon } from '../icons';

// コードの行・範囲に付けたコメント。Claude への指示として送るまで持っておく
export type ReviewComment = { id: string; path: string; startLine: number; endLine: number; quote: string; text: string };

const MAX_QUOTE_LINES = 12;
let commentSeq = 0;

type Props = {
  editor: monaco.editor.IStandaloneCodeEditor;
  path: string;
  comments: ReviewComment[];
  onAdd: (comment: ReviewComment) => void;
  onRemove: (id: string) => void;
};

type Draft = { startLine: number; endLine: number };

// Monaco のエディタに、行番号の横の ＋ からコメントを付けられるようにする。
// コメントは該当行の下に差し込んだ領域（view zone）に出す
export function LineComments({ editor, path, comments, onAdd, onRemove }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [zones, setZones] = useState<Map<string, HTMLElement>>(new Map());
  // モデルを差し替えると差し込んだ領域が消えるので、作り直すきっかけにする
  const [modelSeq, setModelSeq] = useState(0);
  useEffect(() => {
    const sub = editor.onDidChangeModel(() => setModelSeq((n) => n + 1));
    return () => sub.dispose();
  }, [editor]);

  // ＋ の表示と、クリックでの下書き開始
  useEffect(() => {
    editor.updateOptions({ glyphMargin: true });
    const hover = editor.createDecorationsCollection();
    const lineOf = (e: monaco.editor.IEditorMouseEvent) => e.target.position?.lineNumber ?? null;
    const subs = [
      editor.onMouseMove((e) => {
        const line = lineOf(e);
        hover.set(line ? [{ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: 'comment-glyph' } }] : []);
      }),
      editor.onMouseLeave(() => hover.clear()),
      editor.onMouseDown((e) => {
        if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
        const line = lineOf(e);
        if (!line) return;
        e.event.preventDefault();
        setDraft(rangeFor(editor, line));
      }),
    ];
    const action = editor.addAction({
      id: 'tanacode.addComment',
      label: 'Claude へのコメントを追加',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 0,
      run: () => {
        const line = editor.getSelection()?.endLineNumber ?? editor.getPosition()?.lineNumber;
        if (line) setDraft(rangeFor(editor, line));
      },
    });
    return () => {
      subs.forEach((s) => s.dispose());
      action.dispose();
      hover.clear();
    };
  }, [editor]);

  // ファイルが変わったら下書きは捨てる
  useEffect(() => setDraft(null), [path]);

  // コメントと下書きの下に領域を作る。中身は React から portal で描く
  const items: { key: string; afterLine: number }[] = [
    ...comments.map((c) => ({ key: c.id, afterLine: c.endLine })),
    ...(draft ? [{ key: 'draft', afterLine: draft.endLine }] : []),
  ];
  const layoutKey = items.map((i) => `${i.key}@${i.afterLine}`).join(',');
  const zoneIds = useRef(new Map<string, string>());
  useEffect(() => {
    const nodes = new Map<string, HTMLElement>();
    const observers: ResizeObserver[] = [];
    // 領域はコードの幅いっぱいに広がる。コメントは見えている幅に収め、書き始めたときに横へスクロールしないようにする
    const fit = () => {
      const width = `${Math.max(240, editor.getLayoutInfo().contentWidth - 24)}px`;
      nodes.forEach((dom) => dom.style.setProperty('--comment-max-width', width));
    };
    const layout = editor.onDidLayoutChange(fit);
    editor.changeViewZones((accessor) => {
      zoneIds.current.forEach((id) => accessor.removeZone(id));
      zoneIds.current.clear();
      for (const item of items) {
        const dom = document.createElement('div');
        dom.className = 'comment-zone';
        // エディタにクリックやキー入力を取られないようにする
        for (const type of ['mousedown', 'mouseup', 'click', 'keydown', 'wheel'] as const) {
          dom.addEventListener(type, (e) => e.stopPropagation());
        }
        const zone: monaco.editor.IViewZone = { afterLineNumber: item.afterLine, heightInPx: 60, domNode: dom };
        const id = accessor.addZone(zone);
        zoneIds.current.set(item.key, id);
        nodes.set(item.key, dom);
        // 中身の高さに合わせて領域の高さを変える
        const observer = new ResizeObserver(() => {
          const height = (dom.firstElementChild as HTMLElement | null)?.offsetHeight;
          if (!height || zone.heightInPx === height + 8) return;
          zone.heightInPx = height + 8;
          editor.changeViewZones((a) => a.layoutZone(id));
        });
        observers.push(observer);
        requestAnimationFrame(() => dom.firstElementChild && observer.observe(dom.firstElementChild));
      }
    });
    fit();
    setZones(nodes);
    return () => {
      layout.dispose();
      observers.forEach((o) => o.disconnect());
      editor.changeViewZones((accessor) => {
        zoneIds.current.forEach((id) => accessor.removeZone(id));
        zoneIds.current.clear();
      });
    };
  }, [editor, layoutKey, modelSeq]);

  const label = (start: number, end: number) => (start === end ? `${start} 行目` : `${start}〜${end} 行目`);
  return (
    <>
      {comments.map((c) => {
        const dom = zones.get(c.id);
        return (
          dom &&
          createPortal(
            <div className="comment-box">
              <div className="comment-head">
                <span className="comment-mark">Claude へのコメント</span>
                <span className="comment-lines">{label(c.startLine, c.endLine)}</span>
                <div className="spacer" />
                <IconButton size="sm" danger icon={TrashIcon} label="削除" onClick={() => onRemove(c.id)} />
              </div>
              <div className="comment-text">{c.text}</div>
            </div>,
            dom,
            c.id,
          )
        );
      })}
      {draft &&
        zones.get('draft') &&
        createPortal(
          <CommentDraft
            label={label(draft.startLine, draft.endLine)}
            onCancel={() => setDraft(null)}
            onSubmit={(text) => {
              onAdd({ id: `c${++commentSeq}`, path, ...draft, quote: quoteOf(editor, draft), text });
              setDraft(null);
            }}
          />,
          zones.get('draft')!,
          'draft',
        )}
    </>
  );
}

function CommentDraft({ label, onCancel, onSubmit }: { label: string; onCancel: () => void; onSubmit: (text: string) => void }) {
  const [text, setText] = useState('');
  const submit = () => text.trim() && onSubmit(text.trim());
  return (
    <div className="comment-box draft">
      <div className="comment-head">
        <span className="comment-mark">Claude へのコメント</span>
        <span className="comment-lines">{label}</span>
      </div>
      <textarea
        autoFocus
        rows={3}
        value={text}
        placeholder="直してほしいこと・気になること（⌘Enter で追加）"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="comment-actions">
        <IconButton icon={CloseIcon} label="キャンセル" onClick={onCancel} />
        <button className="send-button" disabled={!text.trim()} onClick={submit}>
          コメントを追加
        </button>
      </div>
    </div>
  );
}

// 複数行を選んでいて、その中の行で ＋ を押したら選択範囲に付ける
function rangeFor(editor: monaco.editor.ICodeEditor, line: number): Draft {
  const sel = editor.getSelection();
  if (sel && !sel.isEmpty() && sel.startLineNumber <= line && line <= sel.endLineNumber) {
    // 行頭で終わる選択（行を丸ごと選んだとき）は、その行を含めない
    const end = sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber ? sel.endLineNumber - 1 : sel.endLineNumber;
    return { startLine: sel.startLineNumber, endLine: end };
  }
  return { startLine: line, endLine: line };
}

function quoteOf(editor: monaco.editor.ICodeEditor, { startLine, endLine }: Draft): string {
  const model = editor.getModel();
  if (!model) return '';
  const last = Math.min(endLine, startLine + MAX_QUOTE_LINES - 1, model.getLineCount());
  const lines = [];
  for (let i = startLine; i <= last; i++) lines.push(model.getLineContent(i));
  if (last < endLine) lines.push('…');
  return lines.join('\n');
}

// 送信する本文に付ける、コメントの一覧
export function formatComments(comments: ReviewComment[]): string {
  const blocks = comments.map((c, i) => {
    const lines = c.startLine === c.endLine ? `${c.startLine}` : `${c.startLine}-${c.endLine}`;
    return `[${i + 1}] ${c.path}:${lines}\n\`\`\`\n${c.quote}\n\`\`\`\n${c.text}`;
  });
  return `以下はコードへのレビューコメントです。それぞれ対応してください。\n\n${blocks.join('\n\n')}`;
}
