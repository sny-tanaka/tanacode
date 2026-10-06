import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { lineRange, shownStep, type Walkthrough } from '@shared/walkthrough';
import { Markdown } from '../chat/Markdown';
import { monaco } from '../editor/monaco';
import { ArrowLeftIcon, ArrowRightIcon, CloseIcon, IconButton, ListViewIcon, SendIcon } from '../icons';

// エディタの画面で、ウォークスルーを動かすもの（App が作って EditorPane に渡す）。
// stale: 始めたあとで、示しているファイルがディスク側で変わった（位置がずれているかもしれない）
export type WalkthroughControls = {
  walkthrough: Walkthrough;
  stale: boolean;
  // 人が見るステップを変える（寄り道からも戻る）
  onGo: (index: number) => void;
  onEnd: () => void;
  // 「質問する」。見ている場所を添えて Claude に送る
  onAsk: (question: string) => void;
  // 「Claude に示し直してもらう」
  onRestart: () => void;
};

type Props = WalkthroughControls & { editor: monaco.editor.IStandaloneCodeEditor };

// Claude が示している範囲に色を付け、その直下（view zone）に吹き出しを出す。中身は React から portal で描く。
// 示す場所が変わるたびに、範囲の頭が上の方に来るようにスクロールする
export function WalkthroughZone({ editor, walkthrough, stale, onGo, onEnd, onAsk, onRestart }: Props) {
  const step = shownStep(walkthrough);
  const [dom, setDom] = useState<HTMLElement | null>(null);
  // モデルを差し替えると差し込んだ領域と色が消えるので、作り直すきっかけにする
  const [modelSeq, setModelSeq] = useState(0);
  useEffect(() => {
    const sub = editor.onDidChangeModel(() => setModelSeq((n) => n + 1));
    return () => sub.dispose();
  }, [editor]);

  const model = editor.getModel();
  const lineCount = model?.getLineCount() ?? 1;
  const start = Math.min(step.startLine, lineCount);
  const end = Math.min(Math.max(step.endLine, start), lineCount);

  // 範囲の色と、行番号の横の帯
  useEffect(() => {
    const decorations = editor.createDecorationsCollection([
      { range: new monaco.Range(start, 1, end, 1), options: { isWholeLine: true, className: 'walk-line', linesDecorationsClassName: 'walk-gutter' } },
    ]);
    return () => decorations.clear();
  }, [editor, start, end, modelSeq]);

  // 範囲の下の吹き出しの領域
  const zoneRef = useRef<{ zone: monaco.editor.IViewZone; id: string } | null>(null);
  useEffect(() => {
    const node = document.createElement('div');
    node.className = 'walk-zone';
    // エディタにクリックやキー入力を取られないようにする
    for (const type of ['mousedown', 'mouseup', 'click', 'keydown', 'wheel'] as const) node.addEventListener(type, (e) => e.stopPropagation());
    const zone: monaco.editor.IViewZone = { afterLineNumber: end, heightInPx: 120, domNode: node };
    let id = '';
    editor.changeViewZones((accessor) => {
      id = accessor.addZone(zone);
    });
    zoneRef.current = { zone, id };
    // 吹き出しは見えている幅に収める（領域はコードの幅いっぱいに広がる）
    const fit = () => node.style.setProperty('--walk-max-width', `${Math.max(280, editor.getLayoutInfo().contentWidth - 24)}px`);
    const layout = editor.onDidLayoutChange(fit);
    fit();
    setDom(node);
    return () => {
      layout.dispose();
      editor.changeViewZones((accessor) => accessor.removeZone(id));
      zoneRef.current = null;
      setDom(null);
    };
  }, [editor, end, modelSeq]);

  // 吹き出しを描いたあとで、中身の高さに合わせて領域の高さを変える（目次や質問の欄を開くと変わる）
  useEffect(() => {
    const box = dom?.firstElementChild as HTMLElement | null | undefined;
    if (!box) return;
    const observer = new ResizeObserver(() => {
      const current = zoneRef.current;
      const height = box.offsetHeight + 12;
      if (!current || current.zone.heightInPx === height) return;
      current.zone.heightInPx = height;
      editor.changeViewZones((a) => a.layoutZone(current.id));
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [editor, dom]);

  // 示す場所が変わったら、範囲の頭を上の方に出し、カーソルを置く
  const revealKey = `${walkthrough.id}:${walkthrough.seq}`;
  const revealed = useRef<string | null>(null);
  useEffect(() => {
    if (revealed.current === revealKey || !editor.getModel()) return;
    revealed.current = revealKey;
    editor.setPosition({ lineNumber: start, column: 1 });
    editor.revealLineNearTop(Math.max(1, start - 2), monaco.editor.ScrollType.Smooth);
  }, [editor, revealKey, start, modelSeq]);

  return dom
    ? createPortal(
        <WalkthroughBox walkthrough={walkthrough} stale={stale} onGo={onGo} onEnd={onEnd} onAsk={onAsk} onRestart={onRestart} />,
        dom,
      )
    : null;
}

// 吹き出しの中身。Storybook でもこれを直接描く
export function WalkthroughBox({ walkthrough, stale, onGo, onEnd, onAsk, onRestart }: WalkthroughControls) {
  const { steps, current, aside } = walkthrough;
  const step = shownStep(walkthrough);
  const total = steps.length;
  const [toc, setToc] = useState(false);
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState('');
  // 場所が変わったら、目次と書きかけの質問の欄は閉じる（書いた文字は残す）
  useEffect(() => {
    setToc(false);
    setAsking(false);
  }, [walkthrough.id, current, aside]);
  const send = () => {
    if (!question.trim()) return;
    onAsk(question.trim());
    setQuestion('');
    setAsking(false);
  };
  const last = current === total - 1;

  return (
    <div className="walk-box">
      <div className="walk-head">
        <span className="walk-mark">{aside ? '寄り道' : `ウォークスルー ${current + 1}/${total}`}</span>
        <span className="walk-title">{aside ? `${aside.path}:${lineRange(aside)}` : step.title}</span>
        <div className="spacer" />
        {total > 0 && <IconButton size="sm" icon={ListViewIcon} label="目次" pressed={toc} onClick={() => setToc((v) => !v)} />}
        <IconButton size="sm" icon={CloseIcon} label="ウォークスルーを終える" onClick={onEnd} />
      </div>
      {toc && (
        <ol className="walk-toc">
          {steps.map((s, i) => (
            <li key={i}>
              <button className={i === current && !aside ? 'active' : ''} onClick={() => onGo(i)}>
                <span className="walk-toc-number">{i + 1}</span>
                <span className="walk-toc-title">{s.title}</span>
                {walkthrough.visited.includes(i) && i !== current && <span className="walk-toc-seen">見た</span>}
              </button>
            </li>
          ))}
        </ol>
      )}
      {stale && (
        <div className="walk-stale">
          <span>コードが変わりました（位置がずれているかもしれません）</span>
          <button className="ghost-button" onClick={onRestart}>
            Claude に示し直してもらう
          </button>
        </div>
      )}
      <div className="walk-body">
        <Markdown text={step.body} />
      </div>
      {asking ? (
        <div className="walk-ask">
          <textarea
            autoFocus
            rows={3}
            value={question}
            placeholder="ここについて Claude に聞きたいこと（⌘Enter で送る）"
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setAsking(false);
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="walk-actions">
            <div className="spacer" />
            <IconButton icon={CloseIcon} label="やめる" onClick={() => setAsking(false)} />
            <IconButton primary icon={SendIcon} label="送る" tip="Claude に送る（⌘Enter）" disabled={!question.trim()} onClick={send} />
          </div>
        </div>
      ) : (
        <div className="walk-actions">
          {aside ? (
            total > 0 && (
              <button className="ghost-button" onClick={() => onGo(current)}>
                ウォークスルーに戻る（{current + 1}/{total}）
              </button>
            )
          ) : (
            <>
              <IconButton icon={ArrowLeftIcon} label="戻る" disabled={current === 0} onClick={() => onGo(current - 1)} />
              {last ? (
                <button className="send-button" onClick={onEnd}>
                  終える
                </button>
              ) : (
                <IconButton primary icon={ArrowRightIcon} label="次へ" onClick={() => onGo(current + 1)} />
              )}
            </>
          )}
          <div className="spacer" />
          <button className="ghost-button" onClick={() => setAsking(true)}>
            質問する
          </button>
        </div>
      )}
    </div>
  );
}
