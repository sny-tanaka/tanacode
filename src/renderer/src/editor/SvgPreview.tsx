import { useEffect, useState } from 'react';
import { t } from '@shared/i18n';
import type { monaco } from './monaco';

// 入力のたびに描き直さないよう、少し待ってからまとめて描く（MarkdownPreview と同じ）
const RENDER_DELAY_MS = 150;

// SVG の見た目（画像）。エディタで編集中（未保存）の内容をそのまま映す。
// <img> に data URL で入れる。<img> に入れた SVG は、中のスクリプトが動かず、外のファイル・URL も読まない
// （SVG の中の <image href="https://…"> や <script> が、開いただけで外へ通信したり動いたりしない）。CSP の img-src は data: を通す
export function SvgPreview({ path, model }: { path: string; model: monaco.editor.ITextModel }) {
  const [text, setText] = useState(() => model.getValue());
  // 書きかけなどで SVG として読めないとき（<img> の読み込みの失敗）
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    setText(model.getValue());
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sub = model.onDidChangeContent(() => {
      timer ??= setTimeout(() => {
        timer = null;
        setText(model.getValue());
      }, RENDER_DELAY_MS);
    });
    return () => {
      sub.dispose();
      if (timer) clearTimeout(timer);
    };
  }, [model]);

  // 中身が替わったら、読み込めるかを確かめ直す
  useEffect(() => setInvalid(false), [text]);

  return (
    <div className="svg-preview">
      {invalid ? (
        <div className="svg-preview-invalid">{t('editor.svgPreview.invalid')}</div>
      ) : (
        <img
          src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`}
          alt={path}
          draggable={false}
          onError={() => setInvalid(true)}
        />
      )}
    </div>
  );
}
