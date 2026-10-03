import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionSummary, SlashCommand } from '@shared/ipc';
import { projectRootOf, sessionRef } from '@shared/session-tools';
import { CloseIcon, IconButton, SendIcon, StopIcon } from '../icons';
import type { ReviewComment } from '../review/LineComments';
import { sessionName } from '../sessions/sessionLinks';

const MAX_SUGGESTIONS = 40;
// @ の候補に、ファイルより先に出すセッションの数
const MAX_SESSIONS = 6;
// コマンドは本家と同じく全部出す（一覧はスクロールする）
const MAX_COMMANDS = 200;
// ワークスペースのファイル一覧を読み直す間隔
const FILES_TTL_MS = 30_000;

// @ と / の補完候補の読み込み元。key が変わったら読み直す（セッションか、新規セッションで選んだフォルダ）
export type CompletionSource = {
  key: string;
  listFiles(): Promise<string[]>;
  listCommands(): Promise<SlashCommand[]>;
  // @ の候補に出すセッション（自分は除き、見えるものだけ）。無ければセッションは出さない
  listSessions?(): SessionSummary[];
};

type Props = {
  completion: CompletionSource;
  value: string;
  onChange: (value: string) => void;
  attachments: string[];
  onAttachmentsChange: (paths: string[]) => void;
  placeholder: string;
  // 送れない状態（選択メニューが出ている間など）。入力が空なだけなら false（ボタンはふだんの色のまま、押しても何もしない）
  blocked: boolean;
  onSend: () => void;
  // 送信できないときに中断ボタンを出す
  showInterrupt: boolean;
  onInterrupt: () => void;
  // 送信時に一緒に送るコードへのコメント
  comments: ReviewComment[];
  onRemoveComment: (id: string) => void;
  onShowComment: (comment: ReviewComment) => void;
  autoFocus?: boolean;
  // Claude Code が作業中（枠のグラデーションを流す）
  working?: boolean;
};

// session: @ で選ぶセッション（ファイルと見分けて出す）
type Suggestion = { value: string; label: string; detail: string; session?: boolean };
// 補完している語: @ファイル名、または先頭の /コマンド
type Token = { kind: 'file' | 'command'; start: number; query: string };

function tokenAt(text: string, caret: number): Token | null {
  const before = text.slice(0, caret);
  const file = before.match(/(^|\s)@([^\s@]*)$/);
  if (file) return { kind: 'file', start: caret - file[2].length - 1, query: file[2] };
  const command = before.match(/^\/([^\s]*)$/);
  if (command) return { kind: 'command', start: 0, query: command[1] };
  return null;
}

// Claude Code に送る。打ち込みは main が行う（同じセッションへの送信が混ざらないよう、親セッションからの指示と同じ順番待ちに並ぶ）
export function submitToClaude(sessionId: string, text: string, attachments: string[]): Promise<void> {
  return window.tanacode.sessions.submit(sessionId, text, attachments);
}

export function ChatInput({
  completion,
  value,
  onChange,
  attachments,
  onAttachmentsChange,
  placeholder,
  blocked,
  onSend,
  showInterrupt,
  onInterrupt,
  comments,
  onRemoveComment,
  onShowComment,
  autoFocus,
  working = false,
}: Props) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const files = useRef<{ key: string; list: string[]; at: number } | null>(null);
  const [fileList, setFileList] = useState<string[]>([]);
  const [sessionList, setSessionList] = useState<SessionSummary[]>([]);
  const [commands, setCommands] = useState<SlashCommand[]>([]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  const token = tokenAt(value, caret);
  const open = token !== null && dismissed !== token.start;

  // 補完が必要になったときだけ一覧を読む
  useEffect(() => {
    if (!open || !token) return;
    if (token.kind === 'file') {
      // セッションは手元の一覧から選ぶので、開くたびに読み直す
      setSessionList(completion.listSessions?.() ?? []);
      const cached = files.current;
      if (cached?.key === completion.key && Date.now() - cached.at < FILES_TTL_MS) {
        setFileList(cached.list);
        return;
      }
      const key = completion.key;
      void completion.listFiles().then((list) => {
        files.current = { key, list, at: Date.now() };
        setFileList(list);
      });
    } else {
      void completion.listCommands().then(setCommands);
    }
    // completion は key が同じなら同じ読み込み元
  }, [open, token?.kind, completion.key]);

  // token は描き直しのたびに新しいオブジェクトになるので、中身（種類と文字）で計算し直すかを決める
  const tokenKind = token?.kind ?? null;
  const tokenQuery = token?.query ?? '';
  const suggestions = useMemo<Suggestion[]>(() => {
    if (!open || !tokenKind) return [];
    const q = tokenQuery.toLowerCase();
    if (tokenKind === 'file') {
      // 名前に打った文字を含むセッション。アクティブを先に、その中で前方一致を先に（同じなら一覧の並び＝最終更新の新しい順）
      const sessions = sessionList
        .map((s) => {
          const name = (s.title ?? '').toLowerCase();
          return { s, score: name.startsWith(q) ? 0 : name.includes(q) ? 1 : -1 };
        })
        .filter(({ score }) => score >= 0)
        .sort((a, b) => Number(a.s.archived) - Number(b.s.archived) || a.score - b.score)
        .slice(0, MAX_SESSIONS)
        .map(({ s }) => ({
          value: `${sessionRef(s.id, s.title)} `,
          label: sessionName(s),
          detail: ['セッション', projectRootOf(s).split('/').pop(), s.worktree?.name, s.archived && 'アーカイブ済み'].filter(Boolean).join(' · '),
          session: true,
        }));
      const scored = fileList
        .map((path) => {
          const lower = path.toLowerCase();
          const name = lower.slice(lower.lastIndexOf('/') + 1);
          const score = name.startsWith(q) ? 0 : name.includes(q) ? 1 : lower.includes(q) ? 2 : -1;
          return { path, score };
        })
        .filter((s) => s.score >= 0)
        .sort((a, b) => a.score - b.score || a.path.length - b.path.length);
      return [
        ...sessions,
        ...scored.slice(0, MAX_SUGGESTIONS).map(({ path }) => ({
          value: `@${path} `,
          label: path.slice(path.lastIndexOf('/') + 1),
          detail: path,
        })),
      ];
    }
    // 名前が前方一致 → 別名が前方一致 → 名前の途中に含む の順
    const rank = (c: SlashCommand) => {
      const name = c.name.toLowerCase();
      if (name.startsWith(q)) return 0;
      if (c.aliases?.some((a) => a.startsWith(q))) return 1;
      return name.includes(q) ? 2 : -1;
    };
    return commands
      .map((c) => ({ c, r: rank(c) }))
      .filter(({ r }) => r >= 0)
      .sort((a, b) => a.r - b.r)
      .slice(0, MAX_COMMANDS)
      .map(({ c }) => ({
        value: `/${c.name} `,
        label: `/${c.name}${c.aliases?.length ? ` (${c.aliases.join(', ')})` : ''}`,
        detail: c.description,
      }));
  }, [open, tokenKind, tokenQuery, fileList, sessionList, commands]);

  useEffect(() => setSelected(0), [token?.kind, token?.query]);

  // ↑↓ で選んだ候補が見えるようにスクロールする
  const suggestRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    suggestRef.current?.querySelector('.suggest-item.selected')?.scrollIntoView({ block: 'nearest' });
  }, [selected, suggestions]);

  const accept = (s: Suggestion) => {
    if (!token) return;
    const next = value.slice(0, token.start) + s.value + value.slice(caret);
    const nextCaret = token.start + s.value.length;
    onChange(next);
    setCaret(nextCaret);
    requestAnimationFrame(() => inputRef.current?.setSelectionRange(nextCaret, nextCaret));
  };

  const addFiles = async (list: FileList | File[]) => {
    const paths: string[] = [];
    const texts: string[] = [];
    for (const file of Array.from(list)) {
      if (file.type.startsWith('image/')) {
        paths.push(await window.tanacode.attachments.save(file.name || 'image.png', new Uint8Array(await file.arrayBuffer())));
      } else {
        // 画像以外はパスをそのまま入れる（Claude が必要なら読む）
        const path = window.tanacode.pathForFile(file);
        if (path) texts.push(path);
      }
    }
    if (paths.length > 0) onAttachmentsChange([...attachments, ...paths]);
    if (texts.length > 0) onChange(`${value}${value && !value.endsWith(' ') ? ' ' : ''}${texts.join(' ')} `);
  };

  return (
    <div
      className={`chat-input${dragging ? ' dragging' : ''}${working ? ' working' : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        setDragging(false);
        if (e.dataTransfer.files.length === 0) return;
        e.preventDefault();
        void addFiles(e.dataTransfer.files);
      }}
    >
      {suggestions.length > 0 && (
        <div className="suggest" ref={suggestRef}>
          {suggestions.map((s, i) => (
            <button
              key={s.value}
              className={`suggest-item${s.session ? ' session' : ''}${i === selected ? ' selected' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                accept(s);
              }}
              onMouseEnter={() => setSelected(i)}
            >
              <span className="suggest-label">{s.label}</span>
              <span className="suggest-detail">{s.detail}</span>
            </button>
          ))}
        </div>
      )}
      {comments.length > 0 && (
        <div className="attachments">
          {comments.map((c) => (
            <span key={c.id} className="attachment comment-chip" title={`${c.path}:${c.startLine}\n${c.text}`} onClick={() => onShowComment(c)}>
              <span className="comment-chip-where">
                {c.path.split('/').pop()}:{c.startLine}
                {c.endLine !== c.startLine ? `-${c.endLine}` : ''}
              </span>
              <span className="comment-chip-text">{c.text}</span>
              <IconButton
                size="sm"
                icon={CloseIcon}
                label="外す"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveComment(c.id);
                }}
              />
            </span>
          ))}
        </div>
      )}
      {attachments.length > 0 && (
        <div className="attachments">
          {attachments.map((path) => (
            <span key={path} className="attachment" title={path}>
              画像 {path.split('/').pop()?.replace(/^[0-9a-f]{8}-/, '')}
              <IconButton size="sm" icon={CloseIcon} label="外す" onClick={() => onAttachmentsChange(attachments.filter((p) => p !== path))} />
            </span>
          ))}
        </div>
      )}
      <div className="chat-input-row">
        <span className="chat-prompt">›</span>
        <textarea
          ref={inputRef}
          autoFocus={autoFocus}
          rows={1}
          value={value}
          placeholder={placeholder}
          onChange={(e) => {
            onChange(e.target.value);
            setCaret(e.target.selectionStart);
            setDismissed(null);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onPaste={(e) => {
            const images = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'));
            if (images.length === 0) return;
            e.preventDefault();
            void addFiles(images);
          }}
          onKeyDown={(e) => {
            const composing = e.nativeEvent.isComposing || e.keyCode === 229;
            if (suggestions.length > 0 && !composing) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const step = e.key === 'ArrowDown' ? 1 : -1;
                setSelected((i) => (i + step + suggestions.length) % suggestions.length);
                return;
              }
              if ((e.key === 'Enter' && !(e.metaKey || e.ctrlKey)) || e.key === 'Tab') {
                e.preventDefault();
                accept(suggestions[selected]);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setDismissed(token?.start ?? null);
                return;
              }
            }
            // Enter は改行。変換確定の Enter（isComposing / keyCode 229）では送信しない
            if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || composing) return;
            e.preventDefault();
            onSend();
          }}
        />
        {showInterrupt ? (
          <IconButton icon={StopIcon} danger label="中断" onClick={onInterrupt} />
        ) : (
          <IconButton primary icon={SendIcon} label="送信" tip="送信（⌘Enter）" onClick={onSend} disabled={blocked} />
        )}
      </div>
    </div>
  );
}
