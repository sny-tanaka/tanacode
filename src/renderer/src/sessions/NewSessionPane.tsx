import { useEffect, useMemo, useRef, useState } from 'react';
import type { NewSessionOptions, WorkspaceInfo } from '@shared/ipc';
import type { PermissionMode } from '@shared/screen';
import icon from '../assets/icon.png';
import { errorMessage } from '../errorMessage';
import { ChatInput, type CompletionSource } from '../chat/ChatInput';
import { RemoteControlToggle } from '../chat/RemoteControlToggle';
import { EFFORTS, MODES, refreshTitle, useModelCatalog } from '../chat/sessionOptions';
import { SettingsFileSelect, useSettingsFiles } from '../chat/settingsFiles';
import { BranchIcon, DefaultBranchIcon, FolderIcon } from '../layout/icons';
import { formatComments, type ReviewComment } from '../review/LineComments';

// 最後に選んだ設定ファイル・モデル・エフォート・モード・Remote Control・worktree（このマシンだけの好みなので localStorage に置く）
const OPTIONS_KEY = 'tanacode.newSessionOptions';
const DEFAULT_OPTIONS: NewSessionOptions = { model: null, effort: null, settingsFile: null, mode: null, remoteControl: true, worktree: false };

function loadOptions(): NewSessionOptions {
  try {
    return { ...DEFAULT_OPTIONS, ...(JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? '{}') as Partial<NewSessionOptions>) };
  } catch {
    return DEFAULT_OPTIONS;
  }
}

function saveOptions(options: NewSessionOptions): void {
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify(options));
  } catch {
    // 覚えられなくても今回の指定には影響しない
  }
}

type Props = {
  // 最近使ったフォルダ（新しい順）
  folders: string[];
  // 最近のフォルダから外す。セッションは消えない
  onForgetFolder: (dir: string) => void;
  // 選んでいるフォルダ。右パネル（エクスプローラー・ソース管理など）とエディタでも、このフォルダを開く
  cwd: string | null;
  onCwdChange: (cwd: string) => void;
  // 右パネルのソース管理が読んだ今のブランチ（切り替えるとすぐ変わる）。まだ読んでいなければ undefined
  branch: string | null | undefined;
  // ブランチを押したとき。右パネルのソース管理を開く
  onOpenScm: () => void;
  // 選んでいるフォルダを git の操作に使うときの id（フォルダを開き終えるまでは null）と、操作のあとに git の状態を読み直す関数
  gitId: string | null;
  onGitChanged: () => void;
  // エディタ・差分で付けたコメント。最初の指示と一緒に送る
  comments: ReviewComment[];
  onCommentsChange: (comments: ReviewComment[]) => void;
  onShowComment: (comment: ReviewComment) => void;
  // フォルダで Claude Code を起動し、最初の発言を送る（起動が終わるのを待って送られる）
  onStart: (cwd: string, text: string, attachments: string[], options: NewSessionOptions) => Promise<void>;
  // 前に見ていたセッションに戻る。戻る先が無ければ null
  onCancel: (() => void) | null;
};

// 新規セッション。フォルダを選んで最初の指示を送ると、そのフォルダで Claude Code を起動する
export function NewSessionPane({
  folders,
  onForgetFolder,
  cwd,
  onCwdChange,
  branch,
  onOpenScm,
  gitId,
  onGitChanged,
  comments,
  onCommentsChange,
  onShowComment,
  onStart,
  onCancel,
}: Props) {
  const [info, setInfo] = useState<WorkspaceInfo | null | undefined>(undefined);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);
  // 最新のデフォルトブランチへ切り替えている間と、うまくいかなかったときの理由
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [options, setOptions] = useState<NewSessionOptions>(loadOptions);
  const models = useModelCatalog();
  const settingsFiles = useSettingsFiles();
  // 前に選んだ設定ファイルを登録から外していても、黙って標準に戻さない（選択欄に「（登録なし）」と出し、送ると理由つきで断られる）
  const settingsFile = settingsFiles.find((f) => f.id === options.settingsFile) ?? null;
  // 選んだモデルで選べるエフォート。空ならエフォートを選べないモデル（既定のモデルなら全部）
  const efforts = models.choices.find((c) => c.value === options.model)?.efforts ?? EFFORTS;
  const change = (patch: Partial<NewSessionOptions>) => {
    // 設定ファイルを変えたら、モデルとエフォートは新しい設定ファイルの既定に戻す（前の設定のモデルが、新しい設定で使えるとは限らない）
    const next = { ...options, ...patch, ...('settingsFile' in patch ? { model: null, effort: null } : {}) };
    // エフォートを選べないモデルに変えたら、エフォートの指定は外す
    const allowed = models.choices.find((c) => c.value === next.model)?.efforts ?? EFFORTS;
    if (next.effort && !allowed.includes(next.effort)) next.effort = null;
    setOptions(next);
    saveOptions(next);
  };

  useEffect(() => {
    setInfo(undefined);
    setSwitchError(null);
    if (!cwd) return;
    let alive = true;
    void window.tanacode.folders.info(cwd).then((value) => alive && setInfo(value));
    return () => {
      alive = false;
    };
  }, [cwd]);

  const completion = useMemo<CompletionSource>(
    () => ({
      key: `folder:${cwd ?? ''}`,
      listFiles: () => (cwd ? window.tanacode.folders.listFiles(cwd) : Promise.resolve([])),
      listCommands: () => (cwd ? window.tanacode.folders.commands(cwd) : Promise.resolve([])),
    }),
    [cwd],
  );

  const missing = !!cwd && info === null;
  // ブランチを切り替えている間は送らない（切り替え前のブランチで始まらないように）
  const blocked = !cwd || missing || starting || switching;
  const canSend = !blocked && (input.trim().length > 0 || attachments.length > 0 || comments.length > 0);
  const currentBranch = branch === undefined ? info?.branch : branch;

  // フェッチしてデフォルトブランチへ切り替え、リモートの最新まで進める（ソース管理のブランチ選択と同じ操作）
  const switchDefault = async () => {
    if (!gitId || switching) return;
    setSwitching(true);
    setSwitchError(null);
    try {
      setSwitchError(await window.tanacode.git.run(gitId, { kind: 'switch-default' }));
    } catch (err) {
      setSwitchError(errorMessage(err));
    } finally {
      setSwitching(false);
      onGitChanged();
    }
  };

  const send = async () => {
    if (!canSend || !cwd) return;
    setStarting(true);
    const text = comments.length > 0 ? [input.trim(), formatComments(comments)].filter(Boolean).join('\n\n') : input;
    try {
      await onStart(cwd, text, attachments, options);
      onCommentsChange([]);
    } catch (err) {
      window.alert(`セッションを始められませんでした: ${errorMessage(err)}`);
      setStarting(false);
    }
  };

  return (
    <section className="claude">
      <header className="claude-header">
        <span className="claude-mark" />
        <span className="claude-title">新規セッション</span>
        <div className="spacer" />
        <RemoteControlToggle on={options.remoteControl} connected={null} onChange={(remoteControl) => change({ remoteControl })} />
        {onCancel && (
          <button className="ghost-button" onClick={onCancel} title="前に見ていたセッションに戻る">
            キャンセル
          </button>
        )}
      </header>
      <div className="new-session-body">
        <span className="new-session-hero">
          <img className="new-session-icon" src={icon} alt="" draggable={false} />
        </span>
        <p className="new-session-title">何から始めますか？</p>
        <p className="new-session-sub">
          <span>フォルダを選んで最初の指示を送ると、そのフォルダで Claude Code が起動します。</span>
          <span>起動が終わるのを待ってから送るので、スラッシュコマンドもそのまま使えます。</span>
        </p>
      </div>
      <div className="chat-input-wrap">
        <div className="new-session-chips">
          <FolderPicker cwd={cwd} folders={folders} onChange={onCwdChange} onForget={onForgetFolder} />
          {currentBranch && (
            <button className="new-session-chip branch" onClick={onOpenScm} title="今のブランチ。押すとソース管理を開き、ブランチを切り替えられる">
              <BranchIcon />
              {currentBranch}
            </button>
          )}
          {currentBranch && gitId && (
            <button
              className={`new-session-chip icon${switching ? ' busy' : ''}`}
              disabled={switching}
              onClick={() => void switchDefault()}
              data-tip="最新のデフォルトブランチへ切り替える（フェッチして、リモートの最新まで進めます）"
              aria-label="最新のデフォルトブランチへ切り替える"
            >
              <DefaultBranchIcon size={14} />
            </button>
          )}
          <label className="new-session-check" data-tip={WORKTREE_ABOUT}>
            <input type="checkbox" checked={options.worktree} onChange={(e) => change({ worktree: e.target.checked })} />
            worktree を使う
          </label>
          {missing && <span className="new-session-warning">フォルダが見つかりません</span>}
          {switchError && <span className="new-session-warning">{switchError}</span>}
        </div>
        <ChatInput
          completion={completion}
          value={input}
          onChange={setInput}
          attachments={attachments}
          onAttachmentsChange={setAttachments}
          placeholder={
            cwd ? '最初の指示（⌘Enter で送信 · @ でファイル · / でコマンド）' : '先に作業するフォルダを選んでください'
          }
          blocked={blocked}
          onSend={() => void send()}
          showInterrupt={false}
          onInterrupt={() => {}}
          comments={comments}
          onRemoveComment={(id) => onCommentsChange(comments.filter((c) => c.id !== id))}
          onShowComment={onShowComment}
          autoFocus
        />
        <div className="chat-options">
          <SettingsFileSelect
            value={options.settingsFile}
            files={settingsFiles}
            onChange={(value) => change({ settingsFile: value })}
            title="設定ファイル（標準の設定に重ねて起動します。このセッションだけで、始めたあとも切り替えられます）"
          />
          <select
            value={options.model ?? ''}
            onChange={(e) => change({ model: e.target.value || null })}
            title="モデル（--model。このセッションだけで、既定値は変わりません）"
          >
            <option value="">{settingsFile?.model ? `既定（${settingsFile.model}）` : '既定のモデル'}</option>
            {options.model && !models.choices.some((c) => c.value === options.model) && (
              <option value={options.model}>{options.model}</option>
            )}
            {models.choices.map((c) => (
              <option key={c.value} value={c.value} disabled={c.disabled} title={c.detail}>
                {models.labelOf(c)}
              </option>
            ))}
          </select>
          <button
            className="model-refresh"
            disabled={models.refreshing}
            onClick={() => void models.refresh()}
            data-tip={refreshTitle(models.catalog)}
            aria-label="モデル一覧を更新"
          >
            {models.refreshing ? '…' : '↻'}
          </button>
          <select
            value={efforts.length === 0 ? '' : (options.effort ?? '')}
            disabled={efforts.length === 0}
            onChange={(e) => change({ effort: e.target.value || null })}
            title="エフォート（--effort。このセッションだけで、既定値は変わりません）"
          >
            <option value="">{efforts.length === 0 ? 'エフォートなし' : '既定のエフォート'}</option>
            {efforts.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
          <select
            value={options.mode ?? ''}
            onChange={(e) => change({ mode: (e.target.value || null) as PermissionMode | null })}
            title="権限モード（--permission-mode。このセッションだけで、既定値は変わりません）"
          >
            <option value="">既定のモード</option>
            {MODES.map(([mode, label]) => (
              <option key={mode} value={mode}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </section>
  );
}

const WORKTREE_ABOUT =
  'claude --worktree で、このセッション用の worktree（別の作業フォルダとブランチ）を作って始めます。\n同じフォルダで並行して動かしても、変更がぶつかりません。\n場所はフォルダの .claude/worktrees/、ブランチは worktree-<名前>';

// 作業フォルダの選択。最近使ったフォルダか、ダイアログで選んだフォルダ。使わなくなった最近のフォルダは、一覧から外せる
function FolderPicker({
  cwd,
  folders,
  onChange,
  onForget,
}: {
  cwd: string | null;
  folders: string[];
  onChange: (cwd: string) => void;
  onForget: (dir: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = async () => {
    setOpen(false);
    const dir = await window.tanacode.folders.pick();
    if (dir) onChange(dir);
  };

  return (
    <div className="folder-picker" ref={ref}>
      <button
        className={`new-session-chip${cwd ? '' : ' empty'}`}
        onClick={() => (folders.length > 0 ? setOpen((v) => !v) : void pick())}
        title={cwd ?? '作業するフォルダを選ぶ'}
      >
        <FolderIcon />
        {cwd ? baseName(cwd) : 'フォルダを選ぶ'}
        {folders.length > 0 && <span className="new-session-chevron">▾</span>}
      </button>
      {open && (
        <div className="folder-menu">
          {folders.length > 0 && (
            <>
              <div className="folder-menu-heading">最近のフォルダ</div>
              {folders.map((dir) => (
                <div key={dir} className="folder-menu-row">
                  <button
                    className={`folder-menu-item${dir === cwd ? ' selected' : ''}`}
                    onClick={() => {
                      onChange(dir);
                      setOpen(false);
                    }}
                    title={dir}
                  >
                    <span className="folder-menu-name">{baseName(dir)}</span>
                    <span className="folder-menu-path">{dir.replace(/^\/Users\/[^/]+/, '~')}</span>
                  </button>
                  <button
                    className="folder-menu-forget"
                    onClick={() => onForget(dir)}
                    title="最近のフォルダから外す（セッションは消えません。このフォルダで新しいセッションを作ると、また出ます）"
                    aria-label={`${baseName(dir)} を最近のフォルダから外す`}
                  >
                    外す
                  </button>
                </div>
              ))}
              <div className="folder-menu-sep" />
            </>
          )}
          <button className="folder-menu-item" onClick={() => void pick()}>
            <span className="folder-menu-name">別のフォルダを選ぶ…</span>
          </button>
        </div>
      )}
    </div>
  );
}

function baseName(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path;
}
