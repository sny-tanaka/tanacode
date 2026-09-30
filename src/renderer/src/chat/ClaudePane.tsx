import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SessionSummary } from '@shared/ipc';
import type { StatusLineInfo } from '@shared/statusline';
import type { PermissionMode, ScreenInfo } from '@shared/screen';
import type { BashTask, TaskRef } from '@shared/task';
import { formatComments, type ReviewComment } from '../review/LineComments';
import { ContextMeter } from '../knowledge/ContextMeter';
import { contextWindow } from '../knowledge/useSessionKnowledge';
import { MenuCard } from '../screen/MenuCard';
import type { TaskEntry } from '../tasks/taskList';
import { TaskTray } from '../tasks/TaskTray';
import { runInTerminal } from '../terminal/runInTerminal';
import type { WorkflowRuns } from '../workflow/useSessionWorkflows';
import { ChatInput, recentlySent, type CompletionSource } from './ChatInput';
import { ChatRow } from './ChatRow';
import { HookGroupRow } from './HookGroupRow';
import { ToolGroupRow } from './ToolGroupRow';
import { groupTools, reuseGroups, type ChatRowItem } from './toolGroups';
import { TodoPanel } from './TodoPanel';
import { useInsertInput } from './insertInput';
import { DoneNote, useJustFinished, WorkingNote } from './WorkingNote';
import type { SubagentRuns } from './useSessionSubagents';
import type { ChatState } from './chatState';
import type { PendingSend } from './pendingSends';
import { RemoteControlToggle } from './RemoteControlToggle';
import { EFFORTS, MODES, refreshTitle, useModelCatalog } from './sessionOptions';
import { Busy } from '../layout/Busy';

// 起動がこれより長くかかったら、Claude Code の画面を確かめるよう促す
const SLOW_START_MS = 10_000;

type Props = {
  session: SessionSummary;
  chat: ChatState;
  screen: ScreenInfo | null;
  workflows: WorkflowRuns;
  subagents: SubagentRuns;
  bashTasks: ReadonlyMap<string, BashTask>;
  // 直近の応答で使ったコンテキストのトークン数（statusLine がまだ無いときに使う）
  contextTokens: number | null;
  // statusLine から読んだモデル・コンテキスト（応答のたびに更新）
  statusLine: StatusLineInfo | null;
  // このセッションのタスク（入力欄の上のトレイには、実行中のものと終わったばかりのものを出す）
  tasks: TaskEntry[];
  activeTaskKey: string | null;
  onOpenTask: (ref: TaskRef) => void;
  terminalOpen: boolean;
  // コードに付けたコメント。送信するとき本文に付ける
  comments: ReviewComment[];
  onCommentsChange: (comments: ReviewComment[]) => void;
  onShowComment: (comment: ReviewComment) => void;
  onOpenTerminal: () => void;
  onToggleTerminal: () => void;
  onOpenFile: (absPath: string, line?: number) => void;
  onResume: () => void;
  onUnarchive: () => void;
  // 送る。起動中なら、入力を受け付けられるようになるまで預かる
  onSend: (text: string, attachments: string[]) => void;
  // 起動を待っている発言
  pending: PendingSend | null;
  // 送ったが、まだ会話ログに出ていない発言
  sending: PendingSend[];
  // 起動を待っている発言を取り下げる（入力欄に戻す）
  onTakePending: () => PendingSend | null;
};

// App はチャットのイベントなどで頻繁に描き直されるので、props が変わったときだけ描き直す
export const ClaudePane = memo(function ClaudePane({
  session,
  chat,
  screen,
  workflows,
  subagents,
  bashTasks,
  contextTokens,
  statusLine,
  tasks,
  activeTaskKey,
  onOpenTask,
  terminalOpen,
  comments,
  onCommentsChange,
  onShowComment,
  onOpenTerminal,
  onToggleTerminal,
  onOpenFile,
  onResume,
  onUnarchive,
  onSend,
  pending,
  sending,
  onTakePending,
}: Props) {
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<string[]>([]);
  // ターミナルで選んだ出力やプレビューで選んだ要素などを、入力欄の末尾に足す
  useInsertInput(session.id, (text, added) => {
    setInput((prev) => (prev.trim() ? `${prev.trimEnd()}\n${text}` : text));
    if (added.length > 0) setAttachments((prev) => [...prev, ...added]);
  });
  const drafts = useRef(new Map<string, { text: string; attachments: string[] }>());
  const listRef = useRef<HTMLDivElement>(null);
  // 開いているツール・hooks のまとまり（自動では開かない）
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(new Set());
  const toggleGroup = useCallback(
    (id: string) =>
      setOpenGroups((prev) => {
        const next = new Set(prev);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    [],
  );
  const previousRows = useRef<ChatRowItem[]>([]);
  const rows = useMemo(() => (previousRows.current = reuseGroups(previousRows.current, groupTools(chat.items))), [chat.items]);
  const runCommand = useCallback((command: string) => runInTerminal(session.id, command), [session.id]);
  const stickToBottom = useRef(true);
  // 最下部から離れている（「最新のメッセージへ」のボタンを出す）
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  // ボタンで最下部へなめらかに送っている途中。途中の位置では、最下部から離れたと見なさない
  const jumping = useRef(false);

  const [draftSessionId, setDraftSessionId] = useState(session.id);
  if (draftSessionId !== session.id) {
    drafts.current.set(draftSessionId, { text: input, attachments });
    setDraftSessionId(session.id);
    const draft = drafts.current.get(session.id);
    setInput(draft?.text ?? '');
    setAttachments(draft?.attachments ?? []);
    stickToBottom.current = true;
    setAwayFromBottom(false);
    jumping.current = false;
  }

  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && stickToBottom.current) list.scrollTop = list.scrollHeight;
  }, [chat.items, chat.status, chat.queued, sending, session.id]);

  // 最下部にいるか（40px 以内）を読み直す。最下部にいれば、新しい行を追いかける
  const updateBottom = (el: HTMLElement) => {
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    stickToBottom.current = atBottom;
    setAwayFromBottom(!atBottom);
  };
  const jumpToBottom = () => {
    const list = listRef.current;
    if (!list) return;
    // 押したら、着く前から最下部を追いかける状態に戻す
    jumping.current = true;
    stickToBottom.current = true;
    setAwayFromBottom(false);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    list.scrollTo({ top: list.scrollHeight, behavior: reduce ? 'auto' : 'smooth' });
  };

  const running = chat.status === 'running';
  const justFinished = useJustFinished(running, chat.status === 'idle', session.id);
  // TaskCreate の ToDo は終わっても一覧に残るので、すべて終わったらターンの外では欄を出さない
  const showTodos = !!chat.todos && chat.todos.length > 0 && (running || chat.todos.some((t) => t.status !== 'completed'));
  // 作業中の ToDo（ターミナルのスピナーの行と同じく、進行形の名前を「作業中…」の代わりに出す）
  const currentTodo = chat.todos?.find((t) => t.status === 'in_progress');
  const starting = chat.status === 'starting';
  const [slowStart, setSlowStart] = useState(false);
  useEffect(() => {
    setSlowStart(false);
    if (!starting) return;
    const timer = setTimeout(() => setSlowStart(true), SLOW_START_MS);
    return () => clearTimeout(timer);
  }, [starting, session.id]);
  const live = !session.archived && chat.status !== 'exited' && chat.status !== 'not-started';
  const menu = live && screen?.state.kind === 'menu' ? screen.state.menu : null;
  const unknownScreen = live && screen?.state.kind === 'unknown';
  const rewinding = live && screen?.state.kind === 'rewind';
  // 選択メニューが出ている間に文字を送ると、メニューへのキー入力になってしまう
  const blocked = !!menu || rewinding || !(chat.status === 'idle' || chat.status === 'running' || chat.status === 'starting');
  const canSend = !blocked && (input.trim().length > 0 || attachments.length > 0 || comments.length > 0);
  const canConfigure = !running && !menu && !rewinding;
  const canRewind = live && chat.status === 'idle' && screen?.state.kind === 'prompt';
  // /compact は発言として会話ログに残り、圧縮が終わるまで作業中になる
  // 入力欄に打つたびに描き直されるので、会話が変わったときだけ探す
  const lastUser = useMemo(() => chat.items.findLast((i) => i.kind === 'user'), [chat.items]);
  const compacting = running && lastUser?.text === '/compact';
  const canCompact = live && chat.status === 'idle' && !menu && !rewinding && !!lastUser;

  // Claude Code の入力欄に文字が残っていたら（巻き戻し直後は戻した発言が入る）、こちらの入力欄に移して向こうは消す。
  // 残したまま送ると、送った文字がその後ろにつながってしまう
  const draft = live && screen?.state.kind === 'prompt' ? screen.draft : '';
  const movedDraft = useRef<string | null>(null);
  useEffect(() => {
    if (!draft || movedDraft.current === draft) return;
    // 送信中の文字は Claude Code の入力欄に打ち込んでいる途中なので、残った文字として扱わない。
    // 貼り付けた文字や画像は入力欄では [Pasted text #1 +6 lines]・[Image #1] の目印になるので、除いて比べる
    const sent = recentlySent(session.id);
    const typed = draft.replace(/\[(?:Pasted text #\d+[^\]]*|Image #\d+)\]/g, '').replace(/\s/g, '');
    if (sent !== null && (typed === '' || sent.includes(typed))) return;
    movedDraft.current = draft;
    setInput((prev) => (prev ? `${prev}\n${draft}` : draft));
    window.tanacode.pty.write(session.id, '\x15'.repeat(draft.split('\n').length + 1));
  }, [draft, session.id]);

  const rewindTo = useCallback(
    (text: string) => {
      void window.tanacode.screen.rewind(session.id, text).then((ok) => {
        if (!ok) window.alert('巻き戻し先の発言が見つかりませんでした。ターミナルで /rewind を操作してください。');
      });
    },
    [session.id],
  );

  // Claude Code が持っているモデル一覧の控え。↻ で読み直す
  const models = useModelCatalog();
  const { choices, labelOf } = models;
  // 既定のまま（--model・--effort を渡していない）ときは、実際に動いているものを選択中として出す
  const runningModel = statusLine?.model?.name ?? screen?.model?.replace(' (1M context)', '') ?? null;
  const modelValue = session.model ?? choices.find((c) => !c.disabled && c.name === runningModel)?.value ?? '';
  const modelOptions: { value: string; label: string; disabled: boolean; detail: string }[] = [
    ...(modelValue === '' ? [{ value: '', label: runningModel ?? 'モデル', disabled: false, detail: '' }] : []),
    ...(session.model && !choices.some((c) => c.value === session.model)
      ? [{ value: session.model, label: runningModel ?? session.model, disabled: false, detail: '' }]
      : []),
    ...choices.map((c) => ({ value: c.value, label: labelOf(c), disabled: c.disabled, detail: c.detail })),
  ];
  // 選んでいる（動いている）モデルで選べるエフォート。空ならエフォートを選べないモデル
  const currentChoice = choices.find((c) => c.value === modelValue) ?? choices.find((c) => c.name === runningModel);
  const efforts = currentChoice?.efforts ?? EFFORTS;
  const effortValue = session.effort ?? (efforts.find((e) => e === screen?.effort) ?? '');

  // Remote Control の切り替え。動いていれば /remote-control でその場でつなぐ・切るので、終わるまでぐるぐるを出す
  const [switchingRemote, setSwitchingRemote] = useState(false);
  const setRemoteControl = async (on: boolean) => {
    setSwitchingRemote(true);
    const error = await window.tanacode.sessions.setRemoteControl(session.id, on);
    setSwitchingRemote(false);
    if (error) window.alert(error);
  };

  const configure = (patch: { model?: string | null; effort?: string | null }) =>
    void window.tanacode.sessions.configure(session.id, {
      model: session.model,
      effort: session.effort,
      ...patch,
    });

  const completion = useMemo<CompletionSource>(
    () => ({
      key: session.id,
      listFiles: () => window.tanacode.workspace.listFiles(session.id),
      listCommands: () => window.tanacode.commands.list(session.id),
    }),
    [session.id],
  );

  const send = () => {
    if (!canSend) return;
    const text = comments.length > 0 ? [input.trim(), formatComments(comments)].filter(Boolean).join('\n\n') : input;
    onSend(text, attachments);
    onCommentsChange([]);
    setInput('');
    setAttachments([]);
    stickToBottom.current = true;
    setAwayFromBottom(false);
  };

  return (
    <section className="claude">
      <header className="claude-header">
        <span className={`claude-mark${running ? ' working' : ''}`} />
        <span className="claude-title">{session.title ?? 'Claude Code'}</span>
        <div className="spacer" />
        {statusLine?.context ? (
          <ContextMeter tokens={statusLine.context.tokens} limit={statusLine.context.size} />
        ) : (
          <ContextMeter tokens={contextTokens} limit={contextWindow(session.model, screen?.model ?? null, contextTokens)} />
        )}
        {!session.archived && (
          <RemoteControlToggle
            on={session.remoteControl}
            connected={live ? !!chat.remoteControlUrl : null}
            busy={switchingRemote}
            onChange={(on) => void setRemoteControl(on)}
          />
        )}
        {live && (
          <button
            className="ghost-button"
            disabled={!canCompact}
            onClick={() => onSend('/compact', [])}
            title="会話を要約してコンテキストを空ける（/compact）。作業中は押せません"
          >
            {compacting ? <span className="flow-text">圧縮中…</span> : '圧縮'}
          </button>
        )}
        {live && (
          <button
            className="ghost-button"
            onClick={() => {
              const busy = running || tasks.some((t) => t.state === 'running');
              if (busy && !window.confirm('作業中のターンやバックグラウンドのタスクは止まります。Claude Code を再起動しますか？')) return;
              void window.tanacode.sessions.restart(session.id);
            }}
            title="Claude Code を起動し直して、同じ会話を続けます。スキル・CLAUDE.md・設定・MCP などの変更が反映されます"
          >
            再起動
          </button>
        )}
        {!session.archived && (
          <button
            className={`ghost-button${terminalOpen ? ' on' : ''}`}
            onClick={onToggleTerminal}
            title="Claude Code をターミナルの画面のまま表示して操作する（エディタの下のパネル）"
          >
            ターミナル
          </button>
        )}
      </header>

      {showTodos && <TodoPanel todos={chat.todos!} />}
      <div className="chat-list-wrap">
        <div
          className="chat-list"
          ref={listRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            // ボタンで送っている途中は、着くまで（か、送り終わるまで）追いかける状態のままにする
            if (jumping.current && el.scrollHeight - el.scrollTop - el.clientHeight >= 40) return;
            jumping.current = false;
            updateBottom(el);
          }}
          onScrollEnd={(e) => {
            // 送っている途中に上へスクロールして止めたときは、止まった位置で読み直す
            if (!jumping.current) return;
            jumping.current = false;
            updateBottom(e.currentTarget);
          }}
          onClick={(e) => {
            const anchor = (e.target as HTMLElement).closest('a');
            if (anchor?.href) {
              e.preventDefault();
              window.open(anchor.href);
            }
          }}
        >
          {starting && !pending && chat.items.length === 0 && !slowStart && (
            <div className="chat-note">
              <Busy>Claude Code を起動しています…</Busy>
            </div>
          )}
          {rows.map((row) =>
            row.kind === 'tool-group' ? (
              <ToolGroupRow
                key={row.id}
                group={row}
                open={openGroups.has(row.id)}
                onToggle={toggleGroup}
                workflows={workflows}
                subagents={subagents}
                bashTasks={bashTasks}
                onOpenFile={onOpenFile}
                onOpenTask={onOpenTask}
              />
            ) : row.kind === 'hook-group' ? (
              <HookGroupRow key={row.id} group={row} open={openGroups.has(row.id)} onToggle={toggleGroup} />
            ) : (
              <ChatRow
                key={`${row.kind}:${row.id}`}
                item={row}
                onRewind={canRewind ? rewindTo : null}
                onRunCommand={session.archived ? undefined : runCommand}
                workflows={workflows}
                subagents={subagents}
                bashTasks={bashTasks}
                onOpenFile={onOpenFile}
                onOpenTask={onOpenTask}
              />
            ),
          )}
          {running && !menu && !unknownScreen && <WorkingNote sessionId={session.id} label={currentTodo?.activeForm ?? currentTodo?.content} />}
          {justFinished && !running && !menu && <DoneNote />}
          {chat.queued.map((text, i) => (
            <UnsentUser key={`queued:${i}`} text={text} attachments={0} note="順番待ち — 今の作業が一区切りしたら Claude Code に渡されます" queued />
          ))}
          {sending.map((item, i) => (
            <UnsentUser key={`sending:${i}`} text={item.text} attachments={item.attachments.length} note="送信中…" />
          ))}
          {pending && (
            <div className="chat-user pending">
              <span className="chat-prompt">›</span>
              <span className="chat-user-text">
                {pending.text}
                {pending.attachments.length > 0 && <span className="chat-user-meta">画像 {pending.attachments.length} 枚</span>}
                <span className="chat-user-meta">
                  {chat.status === 'exited' ? 'Claude Code を再開すると送ります' : 'Claude Code の起動を待って送ります…'}
                </span>
              </span>
              <button
                className="chat-rewind"
                onClick={() => {
                  const taken = onTakePending();
                  if (!taken) return;
                  setInput((prev) => [taken.text, prev].filter((t) => t.trim()).join('\n'));
                  setAttachments((prev) => [...taken.attachments, ...prev]);
                }}
                title="送るのをやめて入力欄に戻す"
              >
                取り消す
              </button>
            </div>
          )}
          {starting && slowStart && !menu && (
            <div className="chat-callout">
              <span>Claude Code の起動に時間がかかっています。確認の画面などで止まっていないか、ターミナルで見てください</span>
              <button className="send-button" onClick={onOpenTerminal}>
                ターミナルで見る
              </button>
            </div>
          )}
          {menu && <MenuCard key={`${menu.title}|${menu.options.map((o) => o.label).join('|')}`} sessionId={session.id} menu={menu} />}
          {rewinding && (
            <div className="chat-callout">
              <span>巻き戻し先を選んでいます…</span>
              <button className="ghost-button" onClick={() => window.tanacode.pty.write(session.id, '\x1b')}>
                キャンセル（Esc）
              </button>
            </div>
          )}
          {unknownScreen && (
            <div className="chat-callout">
              <span>Claude Code がチャットでは操作できない画面を表示しています</span>
              <div className="chat-callout-actions">
                <button className="ghost-button" onClick={() => window.tanacode.pty.write(session.id, '\x1b')}>
                  閉じる（Esc）
                </button>
                <button className="send-button" onClick={onOpenTerminal}>
                  ターミナルで操作
                </button>
              </div>
            </div>
          )}
          {session.archived ? (
            <div className="chat-callout">
              <span>このセッションはアーカイブされています</span>
              <button className="send-button" onClick={onUnarchive}>
                アクティブに戻す
              </button>
            </div>
          ) : (
            chat.status === 'exited' && (
              <div className="chat-callout">
                <span>Claude Code が終了しました（code {chat.exitCode}）</span>
                <button className="send-button" onClick={onResume}>
                  再開
                </button>
              </div>
            )
          )}
        </div>
        {awayFromBottom && (
          <button
            className="chat-jump-bottom"
            onClick={jumpToBottom}
            data-tip="最新のメッセージへ"
            data-tip-side="top"
            aria-label="最新のメッセージへ"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M8 3v10M3.5 8.5 8 13l4.5-4.5" />
            </svg>
          </button>
        )}
      </div>

      <TaskTray tasks={tasks} activeKey={activeTaskKey} onOpen={(t) => onOpenTask(t.ref)} />
      {!session.archived && (
        <div className="chat-input-wrap">
          <ChatInput
            working={running}
            comments={comments}
            onRemoveComment={(id) => onCommentsChange(comments.filter((c) => c.id !== id))}
            onShowComment={onShowComment}
            completion={completion}
            value={input}
            onChange={setInput}
            attachments={attachments}
            onAttachmentsChange={setAttachments}
            placeholder={menu ? '上の選択肢から選んでください' : 'Claude Codeに指示する（⌘Enter で送信 · @ でファイル · / でコマンド）'}
            blocked={blocked}
            onSend={send}
            showInterrupt={running && !canSend && !menu}
            onInterrupt={() => window.tanacode.pty.write(session.id, '\x1b')}
          />
          <div className="chat-options">
            <select
              value={modelValue}
              disabled={!canConfigure}
              onChange={(e) => configure({ model: e.target.value || null })}
              title="モデル（変更すると Claude Code を起動し直して会話を再開します）"
            >
              {modelOptions.map((o) => (
                <option key={o.value} value={o.value} disabled={o.disabled} title={o.detail}>
                  {o.label}
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
              value={efforts.length === 0 ? '' : effortValue}
              disabled={!canConfigure || efforts.length === 0}
              onChange={(e) => configure({ effort: e.target.value || null })}
              title="エフォート（変更すると Claude Code を起動し直して会話を再開します）"
            >
              {(effortValue === '' || efforts.length === 0) && <option value="">{efforts.length === 0 ? 'エフォートなし' : 'エフォート'}</option>}
              {efforts.map((effort) => (
                <option key={effort} value={effort}>
                  {effort}
                </option>
              ))}
            </select>
            <select
              value={screen?.mode ?? ''}
              disabled={!live || screen?.state.kind !== 'prompt'}
              onChange={(e) => void window.tanacode.screen.setMode(session.id, e.target.value as PermissionMode)}
              title="権限モード（このセッションだけ。Shift+Tab と同じ）"
            >
              {!screen?.mode && <option value="">モード</option>}
              {MODES.map(([mode, label]) => (
                <option key={mode} value={mode}>
                  {label}
                </option>
              ))}
              {screen?.mode === 'bypassPermissions' && <option value="bypassPermissions">すべて許可</option>}
            </select>
          </div>
        </div>
      )}
    </section>
  );
});

// 会話ログにまだ発言として出ていない、送った発言（送信中・順番待ち）
// 送信中のものは、すぐに本物の発言に置き換わるので、見た目は発言と同じにする（点線にすると置き換わるときにちらつく）
function UnsentUser({ text, attachments, note, queued = false }: { text: string; attachments: number; note: string; queued?: boolean }) {
  return (
    <div className={`chat-user${queued ? ' pending' : ''}`}>
      <span className="chat-prompt">›</span>
      <span className="chat-user-text">
        {text}
        {attachments > 0 && <span className="chat-user-meta">画像 {attachments} 枚</span>}
        <span className="chat-user-meta">{note}</span>
      </span>
    </div>
  );
}
