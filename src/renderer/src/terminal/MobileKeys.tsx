import { useCallback, useRef, useState } from 'react';
import { t } from '@shared/i18n';

// スマホの画面のターミナルの補助キーと、1 行の入力欄（Issue #464）。スマホのキーボードに無いキー（Esc・Tab・Ctrl・矢印）を打てるようにする。
// 1 行の入力欄は、日本語の変換・音声入力・貼り付けで書いて、Enter で送る（xterm に直に打つと、スマホでは変換が崩れやすいため）
const KEYS: { label: string; data: string }[] = [
  { label: 'Esc', data: '\x1b' },
  { label: 'Tab', data: '\t' },
  { label: '←', data: '\x1b[D' },
  { label: '↑', data: '\x1b[A' },
  { label: '↓', data: '\x1b[B' },
  { label: '→', data: '\x1b[C' },
  { label: '|', data: '|' },
  { label: '~', data: '~' },
  { label: '/', data: '/' },
  { label: '-', data: '-' },
  { label: '^C', data: '\x03' },
];

// Ctrl を押したまま打った文字にする（a〜z と @ [ \\ ] ^ _ だけ。ほかはそのまま）
export function withCtrl(data: string): string {
  if (data.length !== 1) return data;
  const code = data.toUpperCase().charCodeAt(0);
  return code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : data;
}

// 補助キーの Ctrl（押したら、次に打った 1 文字を Ctrl を押したまま打ったものにする）。typed: 打ったものを、Ctrl を押していれば Ctrl 付きにして返す。
// xterm の onData からも読むので、入り・切りは ref にも写す
export function useCtrlKey(): { ctrl: boolean; setCtrl: (on: boolean) => void; typed: (data: string) => string } {
  const [ctrl, setState] = useState(false);
  const armed = useRef(false);
  const setCtrl = useCallback((on: boolean) => {
    armed.current = on;
    setState(on);
  }, []);
  const typed = useCallback(
    (data: string) => {
      if (!armed.current) return data;
      setCtrl(false);
      return withCtrl(data);
    },
    [setCtrl],
  );
  return { ctrl, setCtrl, typed };
}

// write: 打ったものを送る（Ctrl を押していれば、ターミナルの部品が Ctrl 付きにする）/ ctrl・onCtrl: Ctrl のボタンの入り・切り
export function MobileKeys({ write, ctrl, onCtrl }: { write: (data: string) => void; ctrl: boolean; onCtrl: (on: boolean) => void }) {
  const [line, setLine] = useState('');
  const [lineMode, setLineMode] = useState(false);
  return (
    <div className="mobile-keys" aria-label={t('mobile.keys.label')}>
      {lineMode && (
        <form
          className="mobile-keys-line"
          onSubmit={(e) => {
            e.preventDefault();
            write(`${line}\r`);
            setLine('');
          }}
        >
          <input value={line} placeholder={t('mobile.keys.linePlaceholder')} autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => setLine(e.target.value)} />
          <button type="submit" className="send-button">
            {t('mobile.keys.send')}
          </button>
        </form>
      )}
      <div className="mobile-keys-row">
        <button className={ctrl ? 'on' : ''} aria-pressed={ctrl} onClick={() => onCtrl(!ctrl)}>
          {t('mobile.keys.ctrl')}
        </button>
        {KEYS.map((key) => (
          <button key={key.label} onClick={() => write(key.data)}>
            {key.label}
          </button>
        ))}
        <button className={lineMode ? 'on' : ''} aria-pressed={lineMode} onClick={() => setLineMode(!lineMode)}>
          {t('mobile.keys.line')}
        </button>
      </div>
    </div>
  );
}
