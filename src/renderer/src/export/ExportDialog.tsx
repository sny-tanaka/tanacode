import { useEffect, useMemo, useRef, useState } from 'react';
import type { TodoItem } from '@shared/chat';
import type { SessionSummary } from '@shared/ipc';
import { chatFromEvents, todoSteps, type ChatItem } from '../chat/chatState';
import { errorMessage } from '../errorMessage';
import {
  countContents,
  DEFAULT_EXPORT_OPTIONS,
  exportFileName,
  formatDateTime,
  prepareExport,
  promptsOf,
  replaceHome,
  sliceRange,
  type ExportOptions,
} from './exportContent';

// 会話ログから読んだ材料
type Source = { items: ChatItem[]; todoSteps: Map<string, TodoItem[]>; branches: string[]; home: string };

type Phase = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved'; path: string; bytes: number };

// 作業を書き出す前の確認。範囲と、入れるもの（ツールの結果・差分・画像・思考）を選び、HTML を保存のダイアログで保存する。
// 会話には社内の情報や API キーが入ることがあるので、人に渡す前に中身を確かめるよう促す
export function ExportDialog({ session, onClose }: { session: SessionSummary; onClose: () => void }) {
  // undefined: 読んでいる / null: 読めなかった
  const [source, setSource] = useState<Source | null | undefined>(undefined);
  const [loadError, setLoadError] = useState('');
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(Number.MAX_SAFE_INTEGER);
  const [options, setOptions] = useState<ExportOptions>(DEFAULT_EXPORT_OPTIONS);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const title = session.title ?? '新しいセッション';

  // Escape で閉じるには、ダイアログの中にフォーカスが要る。閉じたら、開く前にいた場所に戻す
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement;
    dialog.current?.focus();
    return () => {
      if (before instanceof HTMLElement) before.focus();
    };
  }, []);

  useEffect(() => {
    let alive = true;
    window.tanacode.sessions
      .exportSource(session.id)
      .then(({ events, branches, home }) => {
        const loaded = { items: chatFromEvents(events).items, todoSteps: todoSteps(events), branches, home };
        if (alive) setSource(loaded);
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setLoadError(errorMessage(error));
        setSource(null);
      });
    return () => {
      alive = false;
    };
  }, [session.id]);

  const prompts = useMemo(() => (source ? promptsOf(source.items) : []), [source]);
  const last = prompts.length - 1;
  const end = Math.min(to, last);
  const start = Math.min(from, end);
  const range = useMemo(() => (source ? sliceRange(source.items, prompts, start, end) : []), [source, prompts, start, end]);
  const counts = useMemo(() => countContents(range), [range]);

  const close = () => {
    if (phase.kind !== 'saving') onClose();
  };

  const save = async () => {
    if (!source) return;
    setPhase({ kind: 'saving' });
    try {
      const { items, todoSteps, meta } = prepareExport(
        range,
        source.todoSteps,
        { title, cwd: session.cwd, branches: source.branches, home: source.home },
        options,
        { start, end, total: prompts.length },
        Date.now(),
      );
      // HTML を作る部品（react-dom/server・画面の CSS の文字）は大きいので、書き出すときに読む
      const { buildExportHtml } = await import('./exportHtml');
      const html = await buildExportHtml({ meta, items, todoSteps, withImages: options.images });
      const path = await window.tanacode.sessions.saveExport(html, exportFileName(session.title, new Date()));
      if (!path) {
        setPhase({ kind: 'idle' });
        return;
      }
      setPhase({ kind: 'saved', path, bytes: new Blob([html]).size });
    } catch (error) {
      window.alert(`書き出せませんでした: ${errorMessage(error)}`);
      setPhase({ kind: 'idle' });
    }
  };

  const toggle = (key: keyof ExportOptions) => setOptions((prev) => ({ ...prev, [key]: !prev[key] }));
  const busy = phase.kind === 'saving';

  return (
    <div className="overlay" onMouseDown={close}>
      <div
        className="quick-open export-dialog"
        ref={dialog}
        role="dialog"
        aria-label="作業を書き出す"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Escape') close();
        }}
      >
        <div className="export-dialog-head">
          <h2>作業を書き出す</h2>
          <p>「{title}」の流れ（指示・応答・ツールの呼び出し・差分・画像）を、1 枚の HTML ファイルに保存します。ブラウザで開くだけで読めます。</p>
        </div>
        {phase.kind === 'saved' ? (
          <>
            <div className="export-dialog-body">
              <p className="export-dialog-status ok">保存しました（{formatBytes(phase.bytes)}）</p>
              <p className="export-dialog-path">{replaceHome(phase.path, source?.home ?? '')}</p>
              <p className="export-dialog-note">人に渡す前に、ブラウザで開いて中身を確かめてください。</p>
            </div>
            <div className="export-dialog-foot">
              <div className="spacer" />
              <button className="ghost-button" onClick={() => window.tanacode.sessions.revealExport(phase.path)}>
                Finder で表示
              </button>
              <button className="send-button" onClick={onClose} autoFocus>
                閉じる
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="export-dialog-body">
              {source === undefined && <p className="export-dialog-status">会話ログを読んでいます…</p>}
              {source === null && <p className="export-dialog-status error">会話ログを読めませんでした: {loadError}</p>}
              {source && prompts.length === 0 && <p className="export-dialog-status">書き出す会話がまだありません</p>}
              {source && prompts.length > 0 && (
                <>
                  <div className="export-range">
                    <span className="export-dialog-label">範囲</span>
                    <select value={start} disabled={busy} onChange={(e) => setFrom(Number(e.target.value))} aria-label="最初の発言">
                      {prompts.map((p, i) => (
                        <option key={p.index} value={i} disabled={i > end}>
                          {promptLabel(i, p.text, p.at)}
                        </option>
                      ))}
                    </select>
                    <span className="export-range-sep">から</span>
                    <select value={end} disabled={busy} onChange={(e) => setTo(Number(e.target.value))} aria-label="最後の発言">
                      {prompts.map((p, i) => (
                        <option key={p.index} value={i} disabled={i < start}>
                          {promptLabel(i, p.text, p.at)}
                        </option>
                      ))}
                    </select>
                    <span className="export-range-sep">まで</span>
                  </div>
                  <p className="export-dialog-summary">
                    発言 {counts.prompts} · 応答 {counts.replies} · 操作 {counts.tools}
                    {counts.images > 0 && ` · 画像 ${counts.images} 枚`}
                  </p>
                  <div className="export-options">
                    <Option checked={options.toolOutput} count={counts.outputs} disabled={busy} onChange={() => toggle('toolOutput')}>
                      ツールの結果（コマンドの出力・読んだファイルの中身・検索の結果など）
                    </Option>
                    <Option checked={options.diffs} count={counts.diffs} disabled={busy} onChange={() => toggle('diffs')}>
                      編集の差分
                    </Option>
                    <Option checked={options.images} count={counts.images} unit="枚" disabled={busy} onChange={() => toggle('images')}>
                      画像（添付・スクリーンショット）
                    </Option>
                    <Option checked={options.thinking} count={counts.thinking} disabled={busy} onChange={() => toggle('thinking')}>
                      思考
                    </Option>
                    <label className="export-option">
                      <input type="checkbox" checked={options.homeToTilde} disabled={busy} onChange={() => toggle('homeToTilde')} />
                      <span>
                        ホームフォルダのパス（<code>{source.home}</code>）を <code>~</code> に置き換える
                      </span>
                    </label>
                  </div>
                </>
              )}
              <div className="export-dialog-warning">
                会話には、社内の情報・API キー・パスワードなどが入っていることがあります。書き出したファイルを人に渡す前に、ブラウザで開いて中身を確かめてください。tanacode
                はファイルを保存するだけで、どこにも送りません。
              </div>
            </div>
            <div className="export-dialog-foot">
              <button className="ghost-button" disabled={busy} onClick={close}>
                キャンセル
              </button>
              <div className="spacer" />
              <button className="send-button" disabled={busy || !source || prompts.length === 0} onClick={() => void save()}>
                {busy ? '書き出しています…' : '書き出す…'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Option({
  checked,
  count,
  unit = '件',
  disabled,
  onChange,
  children,
}: {
  checked: boolean;
  count: number;
  unit?: string;
  disabled: boolean;
  onChange: () => void;
  children: React.ReactNode;
}) {
  // 入るものが無ければ、選んでも変わらないので押せなくする
  return (
    <label className={`export-option${count === 0 ? ' empty' : ''}`}>
      <input type="checkbox" checked={checked && count > 0} disabled={disabled || count === 0} onChange={onChange} />
      <span>{children}</span>
      <span className="export-option-count">
        {count} {unit}
      </span>
    </label>
  );
}

// 範囲の選択肢の文字。例: 3. テストを足して（10/03 14:05）
function promptLabel(index: number, text: string, at: number | undefined): string {
  const line = text.split('\n')[0].trim();
  const head = line.length > 40 ? `${line.slice(0, 39)}…` : line;
  return `${index + 1}. ${head}${at !== undefined ? `（${formatDateTime(at).slice(5)}）` : ''}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
