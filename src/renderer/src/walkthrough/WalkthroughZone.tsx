import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from '@shared/i18n';
import { lineRange, shownStep, type Walkthrough } from '@shared/walkthrough';
import { Markdown } from '../chat/Markdown';
import { monaco } from '../editor/monaco';
import { ArrowLeftIcon, ArrowRightIcon, CloseIcon, ExportIcon, IconButton, ListViewIcon, SendIcon } from '../icons';

// エディタの画面で、ウォークスルーを動かすもの（App が作って EditorPane に渡す）。
// stale: 始めたあとで、示しているファイルがディスク側で変わった（位置がずれているかもしれない）
export type WalkthroughControls = {
  walkthrough: Walkthrough;
  stale: boolean;
  // 人が見るステップを変える（寄り道からも戻る）
  onGo: (index: number) => void;
  // 閉じる（手順は残り、ソース管理の一覧からもう一度開ける）
  onClose: () => void;
  // 「質問する」。見ている場所を添えて Claude に送る
  onAsk: (question: string) => void;
  // 「Claude に示し直してもらう」
  onRestart: () => void;
  // 「GitHub の PR に載せる」（下見のダイアログを開く）
  onPublish?: () => void;
  // ステップの一覧（ソース管理パネル）を見せる
  onShowList?: () => void;
};

type Props = WalkthroughControls & { editor: monaco.editor.IStandaloneCodeEditor };

// Claude が示している範囲に色を付け、その直下（view zone）に吹き出しを出す。中身は React から portal で描く。
// 示す場所が変わるたびに、範囲の頭が上の方に来るようにスクロールする
export function WalkthroughZone({ editor, ...controls }: Props) {
  const { walkthrough } = controls;
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

  // 吹き出しを描いたあとで、中身の高さに合わせて領域の高さを変える（質問の欄やコードが変わったときの知らせで変わる）
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
        <WalkthroughBox {...controls} />,
        dom,
      )
    : null;
}

// 吹き出しの中身。Storybook でもこれを直接描く
export function WalkthroughBox({ walkthrough, stale, onGo, onClose, onAsk, onRestart, onPublish, onShowList }: WalkthroughControls) {
  const { steps, current, aside } = walkthrough;
  const step = shownStep(walkthrough);
  const total = steps.length;
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState('');
  // 場所が変わったら、書きかけの質問の欄は閉じる（書いた文字は残す）
  useEffect(() => {
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
        <span className="walk-mark">{aside ? t('walkthrough.box.aside') : t('walkthrough.box.progress', { step: current + 1, total })}</span>
        <span className="walk-title">{aside ? `${aside.path}:${lineRange(aside)}` : step.title}</span>
        <div className="spacer" />
        {total > 0 && onShowList && <IconButton size="sm" icon={ListViewIcon} label={t('walkthrough.box.showList')} onClick={onShowList} />}
        {total > 0 && onPublish && <IconButton size="sm" icon={ExportIcon} label={t('walkthrough.actions.publish')} onClick={onPublish} />}
        <IconButton size="sm" icon={CloseIcon} label={t('walkthrough.actions.close')} onClick={onClose} />
      </div>
      {stale && (
        <div className="walk-stale">
          <span>{t('walkthrough.box.stale')}</span>
          <button className="ghost-button" onClick={onRestart}>
            {t('walkthrough.box.restart')}
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
            placeholder={t('walkthrough.box.askPlaceholder')}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              // 変換中のキー（変換の取り消しの Esc・確定の Enter）は、変換に任せる
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Escape') setAsking(false);
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="walk-actions">
            <div className="spacer" />
            <IconButton icon={CloseIcon} label={t('walkthrough.box.cancelAsk')} onClick={() => setAsking(false)} />
            <IconButton primary icon={SendIcon} label={t('walkthrough.box.send')} tip={t('walkthrough.box.sendTip')} disabled={!question.trim()} onClick={send} />
          </div>
        </div>
      ) : (
        <div className="walk-actions">
          {aside ? (
            total > 0 && (
              <button className="ghost-button" onClick={() => onGo(current)}>
                {t('walkthrough.box.backToWalkthrough', { step: current + 1, total })}
              </button>
            )
          ) : (
            <>
              <IconButton icon={ArrowLeftIcon} label={t('walkthrough.box.previous')} disabled={current === 0} onClick={() => onGo(current - 1)} />
              {last ? (
                <button className="send-button" onClick={onClose}>
                  {t('walkthrough.box.finish')}
                </button>
              ) : (
                <IconButton primary icon={ArrowRightIcon} label={t('walkthrough.box.next')} onClick={() => onGo(current + 1)} />
              )}
            </>
          )}
          <div className="spacer" />
          <button className="ghost-button" onClick={() => setAsking(true)}>
            {t('walkthrough.box.ask')}
          </button>
        </div>
      )}
    </div>
  );
}
