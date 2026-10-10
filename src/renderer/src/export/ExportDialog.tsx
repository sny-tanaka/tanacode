import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { TodoItem } from '@shared/chat';
import { message, t } from '@shared/i18n';
import type { SessionSummary } from '@shared/ipc';
import { chatFromEvents, todoSteps, type ChatItem } from '../chat/chatState';
import { errorMessage } from '../errorMessage';
import { tx } from '../i18n';
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
  const title = session.title ?? t('export.dialog.untitled');

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
      window.alert(t('export.dialog.saveFailed', { error: errorMessage(error) }));
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
        aria-label={t('export.dialog.title')}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Escape') close();
        }}
      >
        <div className="export-dialog-head">
          <h2>{t('export.dialog.title')}</h2>
          <p>{t('export.dialog.description', { title })}</p>
        </div>
        {phase.kind === 'saved' ? (
          <>
            <div className="export-dialog-body">
              <p className="export-dialog-status ok">{t('export.dialog.saved', { size: formatBytes(phase.bytes) })}</p>
              <p className="export-dialog-path">{replaceHome(phase.path, source?.home ?? '')}</p>
              <p className="export-dialog-note">{t('export.dialog.savedNote')}</p>
            </div>
            <div className="export-dialog-foot">
              <div className="spacer" />
              <button className="ghost-button" onClick={() => window.tanacode.sessions.revealExport(phase.path)}>
                {t('export.dialog.revealInFinder')}
              </button>
              <button className="send-button" onClick={onClose} autoFocus>
                {t('common.close')}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="export-dialog-body">
              {source === undefined && <p className="export-dialog-status">{t('export.dialog.loading')}</p>}
              {source === null && <p className="export-dialog-status error">{t('export.dialog.loadFailed', { error: loadError })}</p>}
              {source && prompts.length === 0 && <p className="export-dialog-status">{t('export.dialog.empty')}</p>}
              {source && prompts.length > 0 && (
                <>
                  <div className="export-range">
                    <span className="export-dialog-label">{t('export.dialog.rangeLabel')}</span>
                    {rangeParts({
                      from: (
                        <select value={start} disabled={busy} onChange={(e) => setFrom(Number(e.target.value))} aria-label={t('export.dialog.firstPrompt')}>
                          {prompts.map((p, i) => (
                            <option key={p.index} value={i} disabled={i > end}>
                              {promptLabel(i, p.text, p.at)}
                            </option>
                          ))}
                        </select>
                      ),
                      to: (
                        <select value={end} disabled={busy} onChange={(e) => setTo(Number(e.target.value))} aria-label={t('export.dialog.lastPrompt')}>
                          {prompts.map((p, i) => (
                            <option key={p.index} value={i} disabled={i < start}>
                              {promptLabel(i, p.text, p.at)}
                            </option>
                          ))}
                        </select>
                      ),
                    })}
                  </div>
                  <p className="export-dialog-summary">
                    {[
                      t('export.dialog.summaryPrompts', { count: counts.prompts }),
                      t('export.dialog.summaryReplies', { count: counts.replies }),
                      t('export.dialog.summaryTools', { count: counts.tools }),
                      ...(counts.images > 0 ? [t('export.dialog.summaryImages', { count: counts.images })] : []),
                    ].join(' · ')}
                  </p>
                  <div className="export-options">
                    <Option checked={options.toolOutput} count={counts.outputs} disabled={busy} onChange={() => toggle('toolOutput')}>
                      {t('export.dialog.toolOutput')}
                    </Option>
                    <Option checked={options.diffs} count={counts.diffs} disabled={busy} onChange={() => toggle('diffs')}>
                      {t('export.dialog.diffs')}
                    </Option>
                    <Option checked={options.images} count={counts.images} unit="image" disabled={busy} onChange={() => toggle('images')}>
                      {t('export.dialog.images')}
                    </Option>
                    <Option checked={options.thinking} count={counts.thinking} disabled={busy} onChange={() => toggle('thinking')}>
                      {t('export.dialog.thinking')}
                    </Option>
                    <label className="export-option">
                      <input type="checkbox" checked={options.homeToTilde} disabled={busy} onChange={() => toggle('homeToTilde')} />
                      <span>{tx('export.dialog.homeToTilde', { home: <code>{source.home}</code>, tilde: <code>~</code> })}</span>
                    </label>
                  </div>
                </>
              )}
              <div className="export-dialog-warning">{t('export.dialog.warning')}</div>
            </div>
            <div className="export-dialog-foot">
              <button className="ghost-button" disabled={busy} onClick={close}>
                {t('common.cancel')}
              </button>
              <div className="spacer" />
              <button className="send-button" disabled={busy || !source || prompts.length === 0} onClick={() => void save()}>
                {busy ? t('export.dialog.saving') : t('export.dialog.save')}
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
  unit = 'item',
  disabled,
  onChange,
  children,
}: {
  checked: boolean;
  count: number;
  // 数の単位（件・枚）
  unit?: 'item' | 'image';
  disabled: boolean;
  onChange: () => void;
  children: React.ReactNode;
}) {
  // 入るものが無ければ、選んでも変わらないので押せなくする
  return (
    <label className={`export-option${count === 0 ? ' empty' : ''}`}>
      <input type="checkbox" checked={checked && count > 0} disabled={disabled || count === 0} onChange={onChange} />
      <span>{children}</span>
      <span className="export-option-count">{t(unit === 'image' ? 'export.dialog.imageCount' : 'export.dialog.itemCount', { count })}</span>
    </label>
  );
}

// 範囲の選択肢の文字。例: 3. テストを足して（10/03 14:05）
function promptLabel(index: number, text: string, at: number | undefined): string {
  const line = text.split('\n')[0].trim();
  const head = line.length > 40 ? `${line.slice(0, 39)}…` : line;
  return at !== undefined
    ? t('export.dialog.promptLabelWithTime', { number: index + 1, text: head, time: formatDateTime(at).slice(5) })
    : t('export.dialog.promptLabel', { number: index + 1, text: head });
}

// 範囲の行（「{from} から {to} まで」）。from・to に選択肢を入れ、間の文字は span に入れて色を変える（語順は言語ごとの文言に任せる）
function rangeParts(parts: { from: ReactNode; to: ReactNode }): ReactNode[] {
  return message('export.dialog.range')
    .split(/(\{\w+\})/)
    .flatMap((piece, i) => {
      const name = /^\{(\w+)\}$/.exec(piece)?.[1];
      if (name === 'from' || name === 'to') return [<Fragment key={i}>{parts[name]}</Fragment>];
      const text = piece.trim();
      return text ? [<span key={i} className="export-range-sep">{text}</span>] : [];
    });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
