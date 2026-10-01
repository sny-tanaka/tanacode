import { useEffect, useMemo, useRef, useState } from 'react';
import type { SlashCommand } from '@shared/ipc';
import type { ReviewComment } from '../review/LineComments';
import { stripControlChars } from './sanitize';

const MAX_SUGGESTIONS = 40;
// コマンドは本家と同じく全部出す（一覧はスクロールする）
const MAX_COMMANDS = 200;
// ワークスペースのファイル一覧を読み直す間隔
const FILES_TTL_MS = 30_000;
// 送信してから、打ち込んだ文字が Claude Code の入力欄から消えるまでの目安
const SENDING_MS = 5000;

// @ と / の補完候補の読み込み元。key が変わったら読み直す（セッションか、新規セッションで選んだフォルダ）
export type CompletionSource = {
  key: string;
  listFiles(): Promise<string[]>;
  listCommands(): Promise<SlashCommand[]>;
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

type Suggestion = { value: string; label: string; detail: string };
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

// セッションごとの、直前に Claude Code の入力欄へ打ち込んだ文字（空白を除く）
const lastSent = new Map<string, { text: string; at: number }>();

// 打ち込んでいる途中で、まだ Claude Code の入力欄に残っているはずの文字（空白を除く）。無ければ null
export function recentlySent(sessionId: string): string | null {
  const sent = lastSent.get(sessionId);
  return sent && Date.now() - sent.at < SENDING_MS ? sent.text : null;
}

// 中断した（Esc を送った）ので、直前に打ち込んだ文字はもう打ち込んでいる途中ではない。
// 応答の前に中断すると Claude Code は発言を入力欄に戻すので、それを打ち込み途中の文字と取り違えず、チャットの入力欄に移す
export function forgetSent(sessionId: string): void {
  lastSent.delete(sessionId);
}

// Claude Code に送る。画像はパスを貼り付けとして送ると [Image #n] として添付される
export async function submitToClaude(sessionId: string, rawText: string, attachments: string[]): Promise<void> {
  const { pty } = window.tanacode;
  // ESC などが残ると、貼り付けの外に出てキー操作（Enter・Shift+Tab など）として届いてしまうので取り除く
  const text = stripControlChars(rawText);
  // 画面の折り返しで空白が変わるので、空白を除いて覚える
  lastSent.set(sessionId, { text: text.replace(/\s/g, ''), at: Date.now() });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (const path of attachments) {
    pty.write(sessionId, `\x1b[200~${stripControlChars(path)}\x1b[201~`);
    await sleep(300);
    pty.write(sessionId, ' ');
  }
  // 改行を含む入力はブラケットペーストで送り、途中の改行で送信されないようにする。
  // 1 行の入力は打鍵で送る（制御文字は除いてあるので、キー操作になる文字は残らない。/compact などのコマンドも今までどおり届く）
  if (text) pty.write(sessionId, text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text);
  await sleep(50);
  pty.write(sessionId, '\r');
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
      const scored = fileList
        .map((path) => {
          const lower = path.toLowerCase();
          const name = lower.slice(lower.lastIndexOf('/') + 1);
          const score = name.startsWith(q) ? 0 : name.includes(q) ? 1 : lower.includes(q) ? 2 : -1;
          return { path, score };
        })
        .filter((s) => s.score >= 0)
        .sort((a, b) => a.score - b.score || a.path.length - b.path.length);
      return scored.slice(0, MAX_SUGGESTIONS).map(({ path }) => ({
        value: `@${path} `,
        label: path.slice(path.lastIndexOf('/') + 1),
        detail: path,
      }));
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
  }, [open, tokenKind, tokenQuery, fileList, commands]);

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
              className={`suggest-item${i === selected ? ' selected' : ''}`}
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
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveComment(c.id);
                }}
                aria-label="外す"
                data-tip="外す"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {attachments.length > 0 && (
        <div className="attachments">
          {attachments.map((path) => (
            <span key={path} className="attachment" title={path}>
              画像 {path.split('/').pop()?.replace(/^[0-9a-f]{8}-/, '')}
              <button onClick={() => onAttachmentsChange(attachments.filter((p) => p !== path))} aria-label="外す" data-tip="外す">
                ×
              </button>
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
          <button className="send-button secondary" onClick={onInterrupt}>
            中断
          </button>
        ) : (
          <button className="send-button" onClick={onSend} disabled={blocked}>
            送信
          </button>
        )}
      </div>
    </div>
  );
}
