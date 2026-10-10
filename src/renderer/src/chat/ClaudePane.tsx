import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { t, type MessageKey } from '@shared/i18n';
import type { SessionSummary } from '@shared/ipc';
import type { ScheduledMessage } from '@shared/scheduled';
import { canSee } from '@shared/session-tools';
import type { StatusLineInfo } from '@shared/statusline';
import type { PermissionMode, ScreenInfo } from '@shared/screen';
import type { BashTask, TaskRef } from '@shared/task';
import { errorMessage } from '../errorMessage';
import { ArrowDownIcon, CloseIcon, CompressIcon, ExportIcon, IconButton, MonitorIcon, ReloadIcon } from '../icons';
import { formatComments, type ReviewComment } from '../review/LineComments';
import { ExportDialog } from '../export/ExportDialog';
import { ContextMeter } from '../knowledge/ContextMeter';
import { contextUsage } from '../knowledge/useSessionKnowledge';
import { MenuCard } from '../screen/MenuCard';
import type { TaskEntry } from '../tasks/taskList';
import { TaskTray } from '../tasks/TaskTray';
import { ClaudeScreen, pasteIntoClaudeScreen } from '../terminal/ClaudeScreen';
import { runInTerminal } from '../terminal/runInTerminal';
import type { WorkflowRuns } from '../workflow/useSessionWorkflows';
import { ChatInput, CommentChips, type CompletionSource } from './ChatInput';
import { ChatRow } from './ChatRow';
import { useTakeClaudeDraft } from './claudeDraft';
import { HookGroupRow } from './HookGroupRow';
import { ToolGroupRow } from './ToolGroupRow';
import { groupTools, reuseGroups, type ChatRowItem } from './toolGroups';
import { TodoPanel } from './TodoPanel';
import { useInsertInput } from './insertInput';
import { DoneNote, useJustFinished, WorkingNote } from './WorkingNote';
import type { SubagentRuns } from './useSessionSubagents';
import { acceptsInput, type ChatState } from './chatState';
import type { PendingSend } from './pendingSends';
import { ScheduledRow } from './ScheduledRow';
import { RemoteControlToggle } from './RemoteControlToggle';
import { stripControlChars } from './sanitize';
import { useCompactState } from './compactState';
import { EFFORTS, modeChoices, refreshTitle, useModelCatalog } from './sessionOptions';
import { SettingsFileSelect, useSettingsFiles } from './settingsFiles';
import { Busy } from '../layout/Busy';
import { useSessionLinks } from '../sessions/sessionLinks';
import { preparingLabel } from '../sessions/worktree';

// 起動がこれより長くかかったら、Claude Code の画面を確かめるよう促す
const SLOW_START_MS = 10_000;

type Props = {
  session: SessionSummary;
  // 一覧のすべてのセッション。チャットに出るほかのセッション（親・子・@ の参照）の名前と、入力欄の @ の候補に使う
  sessions: SessionSummary[];
  // ほかのセッションへ移る（チャットの親からの指示・子からの知らせ・@ の参照・セッションのツールのカードから）
  onSelectSession: (id: string) => void;
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
  // 動いているバックグラウンドのタスクを止める。stoppingTasks: 止めている途中のもの（key）
  onStopTask: (task: TaskEntry) => void;
  stoppingTasks: ReadonlySet<string>;
  // ターミナルモード（チャットの代わりに、Claude Code そのものの画面を出す）にしている
  terminalOpen: boolean;
  // コードに付けたコメント。送信するとき本文に付ける
  comments: ReviewComment[];
  onCommentsChange: (comments: ReviewComment[]) => void;
  onShowComment: (comment: ReviewComment) => void;
  // ターミナルモードにする（チャットで操作できない画面が出たときなど）
  onOpenTerminal: () => void;
  // サイドパネルにコンテキストの中身を出す（ヘッダーのメーターを押したとき）
  onShowContext: () => void;
  // ターミナルパネルのシェルのタブを出す（worktree の npm install などの進み具合を見る）
  onShowShell: () => void;
  // ターミナルモードとチャットを切り替える（ヘッダーのボタン）
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
  // このセッションに予約したメッセージ（時刻の早い順）
  scheduled: ScheduledMessage[];
};

// App はチャットのイベントなどで頻繁に描き直されるので、props が変わったときだけ描き直す
export const ClaudePane = memo(function ClaudePane({
  session,
  sessions,
  onSelectSession,
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
  onStopTask,
  stoppingTasks,
  terminalOpen,
  comments,
  onCommentsChange,
  onShowComment,
  onOpenTerminal,
  onShowContext,
  onShowShell,
  onToggleTerminal,
  onOpenFile,
  onResume,
  onUnarchive,
  onSend,
  pending,
  sending,
  onTakePending,
  scheduled,
}: Props) {
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<string[]>([]);
  // 作業の書き出しの確認を出している
  const [exporting, setExporting] = useState(false);
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
    // 書き出しの確認は、開いたセッションのもの。切り替えたら閉じる
    setExporting(false);
  }

  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && stickToBottom.current) list.scrollTop = list.scrollHeight;
  }, [chat.items, chat.status, chat.queued, sending, scheduled, session.id]);

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
  // worktree の準備の途中（終わるまで最初の指示を送らない）
  const preparing = session.archived ? null : (session.worktree?.preparing ?? null);
  const [slowStart, setSlowStart] = useState(false);
  useEffect(() => {
    setSlowStart(false);
    // npm install などは時間がかかるので、準備が終わってから測る
    if (!starting || preparing) return;
    const timer = setTimeout(() => setSlowStart(true), SLOW_START_MS);
    return () => clearTimeout(timer);
  }, [starting, preparing, session.id]);
  const live = !session.archived && chat.status !== 'exited' && chat.status !== 'not-started';
  // ターミナルモード。チャット・入力欄の代わりに、Claude Code の画面を出す。アーカイブ済みのセッションには画面が無いので、チャットのまま
  const screenMode = terminalOpen && !session.archived;
  // ターミナルモードで、Claude Code の入力欄に貼れる（起動の途中に貼った文字は、Claude Code が取りこぼす）
  const canPaste = screenMode && acceptsInput(chat.status);
  // ターミナルで選んだ出力やアプリ内ブラウザで選んだ要素などを、入力欄の末尾に足す。
  // ターミナルモードでは、見えていないチャットの入力欄ではなく、Claude Code の入力欄に貼る（貼れない間は、チャットの入力欄に取っておく）
  useInsertInput(session.id, (text, added) => {
    if (canPaste) {
      void pasteIntoClaudeScreen(session.id, text, added);
      return;
    }
    setInput((prev) => (prev.trim() ? `${prev.trimEnd()}\n${text}` : text));
    if (added.length > 0) setAttachments((prev) => [...prev, ...added]);
  });
  // ターミナルモードから戻ったら、最新のメッセージから見せる（隠している間に、スクロールの位置は失われる）
  useLayoutEffect(() => {
    if (screenMode) return;
    stickToBottom.current = true;
    setAwayFromBottom(false);
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [screenMode]);
  const menu = live && screen?.state.kind === 'menu' ? screen.state.menu : null;
  const unknownScreen = live && screen?.state.kind === 'unknown';
  const rewinding = live && screen?.state.kind === 'rewind';
  // 選択メニューが出ている間に文字を送ると、メニューへのキー入力になってしまう
  const blocked = !!menu || rewinding || !(chat.status === 'idle' || chat.status === 'running' || chat.status === 'starting');
  const hasContent = input.trim().length > 0 || attachments.length > 0 || comments.length > 0;
  const canSend = !blocked && hasContent;
  const canConfigure = !running && !menu && !rewinding;
  const canRewind = live && chat.status === 'idle' && screen?.state.kind === 'prompt';
  const { canCompact, compacting } = useCompactState(session, chat, screen);

  // Claude Code の入力欄に残った文字（巻き戻し・中断で戻った発言など）は、こちらの入力欄に移して向こうは消す
  useTakeClaudeDraft(session.id, live && screen?.state.kind === 'prompt' ? screen.draft : '', (draft) =>
    setInput((prev) => (prev ? `${prev}\n${draft}` : draft)),
  );

  const rewindTo = useCallback(
    (text: string) => {
      void window.tanacode.screen.rewind(session.id, text).then((ok) => {
        if (!ok) window.alert(t('chat.pane.rewindNotFound'));
      });
    },
    [session.id],
  );

  // Claude Code が持っているモデル一覧の控え。更新のボタンで読み直す
  const models = useModelCatalog();
  const { choices, labelOf } = models;
  // 既定のまま（--model・--effort を渡していない）ときは、実際に動いているものを選択中として出す
  const runningModel = statusLine?.model?.name ?? screen?.model?.replace(' (1M context)', '') ?? null;
  const modelValue = session.model ?? choices.find((c) => !c.disabled && c.name === runningModel)?.value ?? '';
  const modelOptions: { value: string; label: string; disabled: boolean; detail: string }[] = [
    ...(modelValue === '' ? [{ value: '', label: runningModel ?? t('chat.pane.model'), disabled: false, detail: '' }] : []),
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
  const [switchingRemote, setSwitchingRemote] = useState<ReadonlySet<string>>(() => new Set());
  const setRemoteControl = async (on: boolean) => {
    const id = session.id;
    setSwitchingRemote((prev) => new Set(prev).add(id));
    const error = await window.tanacode.sessions.setRemoteControl(id, on);
    setSwitchingRemote((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    if (error) window.alert(error);
  };

  const settingsFiles = useSettingsFiles();
  const configure = (patch: { model?: string | null; effort?: string | null; settingsFile?: string | null }) =>
    void window.tanacode.sessions
      .configure(session.id, {
        model: session.model,
        effort: session.effort,
        settingsFile: session.settingsFile,
        ...patch,
      })
      .catch((error: unknown) => window.alert(t('chat.pane.configureFailed', { error: errorMessage(error) })));
  // 設定ファイルを変えると、これまでの会話の内容が新しい設定の接続先に送られる（別の契約・別のアカウントに渡ることがある）ので、会話があれば確かめる
  const changeSettingsFile = (settingsFile: string | null) => {
    const name = settingsFile === null ? t('chat.pane.settingsFileDefault') : (settingsFiles.find((f) => f.id === settingsFile)?.name ?? t('chat.pane.settingsFileMissing'));
    if (chat.items.length > 0 && !window.confirm(t('chat.pane.confirmSettingsFile', { name }))) return;
    configure({ settingsFile });
  };

  // チャットの行に渡す、ほかのセッションの名前（顔ぶれか名前が変わったときだけ新しくなる）
  const sessionLinks = useSessionLinks(sessions);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const completion = useMemo<CompletionSource>(
    () => ({
      key: session.id,
      listFiles: () => window.tanacode.workspace.listFiles(session.id),
      listCommands: () => window.tanacode.commands.list(session.id),
      // @ の候補に出すセッション。このセッションから見えるもの（Claude が read_session で読めるもの）だけ。
      // ホームのフォルダは画面からは分からないので渡さない（候補が少し広くなるだけで、読めるかは main が改めて決める）
      listSessions: () => {
        const self = sessionsRef.current.find((s) => s.id === session.id) ?? session;
        return sessionsRef.current.filter((s) => s.id !== self.id && canSee(self, s));
      },
    }),
    // session は id が同じなら、フォルダも親も同じ
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.id],
  );

  // 送る本文（コードへのコメントを添える）
  const composed = () => (comments.length > 0 ? [input.trim(), formatComments(comments)].filter(Boolean).join('\n\n') : input);
  const clearInput = () => {
    onCommentsChange([]);
    setInput('');
    setAttachments([]);
    stickToBottom.current = true;
    setAwayFromBottom(false);
  };

  const send = () => {
    if (!canSend) return;
    onSend(composed(), attachments);
    clearInput();
  };

  // 時刻を指定して送信（予約）。選択メニューが出ている間や、止まっているセッションにも予約できる（時刻になったら main が起動し直して送る）
  const schedule = (at: number) => {
    if (!hasContent) return;
    void window.tanacode.scheduled.add(session.id, composed(), attachments, at).then(
      () => clearInput(),
      (error: unknown) => window.alert(t('chat.pane.scheduleFailed', { error: errorMessage(error) })),
    );
  };
  // 予約をやめて、入力欄に戻す。戻るまでにほかのセッションへ移っていたら、そのセッションの書きかけに戻す
  const sessionIdRef = useRef(session.id);
  sessionIdRef.current = session.id;
  const takeScheduled = (id: string) => {
    const owner = session.id;
    void window.tanacode.scheduled.cancel(id).then((taken) => {
      if (!taken) return;
      if (sessionIdRef.current !== owner) {
        const draft = drafts.current.get(owner) ?? { text: '', attachments: [] };
        drafts.current.set(owner, { text: [taken.text, draft.text].filter((t) => t.trim()).join('\n'), attachments: [...taken.attachments, ...draft.attachments] });
        return;
      }
      setInput((prev) => [taken.text, prev].filter((t) => t.trim()).join('\n'));
      setAttachments((prev) => [...taken.attachments, ...prev]);
    });
  };
  const reportError = (key: MessageKey) => (error: unknown) => window.alert(t(key, { error: errorMessage(error) }));
  const removeComment = (id: string) => onCommentsChange(comments.filter((c) => c.id !== id));
  // コードへのコメントを、Claude Code の入力欄に貼る（ターミナルモード。送るのは、人が画面で Enter を押したとき）
  const pasteComments = () => {
    void pasteIntoClaudeScreen(session.id, stripControlChars(formatComments(comments)));
    onCommentsChange([]);
  };

  // worktree の準備の途中と、Claude Code の終了。チャットにも、ターミナルモードの画面の下にも出す
  const preparingNote = preparing && (
    <div className="chat-note worktree-preparing">
      <Busy>{preparingLabel(preparing)}…</Busy>
      {preparing === 'installing' && <IconButton icon={MonitorIcon} label={t('chat.pane.showInTerminal')} onClick={onShowShell} />}
    </div>
  );
  const exitedCallout = !session.archived && chat.status === 'exited' && (
    <div className="chat-callout">
      <span>{t('chat.pane.exited', { code: chat.exitCode ?? '' })}</span>
      <button className="send-button" onClick={onResume}>
        {t('chat.pane.resume')}
      </button>
    </div>
  );

  return (
    <section className="claude">
      <header className="claude-header">
        <span className={`claude-mark${running ? ' working' : ''}`} />
        <span className="claude-title">{session.title ?? 'Claude Code'}</span>
        <div className="spacer" />
        <ContextMeter {...contextUsage(session.model, screen?.model ?? null, statusLine, contextTokens)} onClick={onShowContext} />
        {!session.archived && (
          <RemoteControlToggle
            on={session.remoteControl}
            connected={live ? !!chat.remoteControlUrl : null}
            busy={switchingRemote.has(session.id)}
            onChange={(on) => void setRemoteControl(on)}
          />
        )}
        {live && (
          <IconButton
            size="md"
            icon={CompressIcon}
            label={t('chat.pane.compact')}
            tip={t('chat.pane.compactTip')}
            busy={compacting}
            disabled={!canCompact}
            onClick={() => onSend('/compact', [])}
          />
        )}
        {live && (
          <IconButton
            size="md"
            icon={ReloadIcon}
            label={t('chat.pane.restart')}
            tip={t('chat.pane.restartTip')}
            onClick={() => {
              const busy = running || tasks.some((t) => t.state === 'running');
              if (busy && !window.confirm(t('chat.pane.confirmRestart'))) return;
              void window.tanacode.sessions
                .restart(session.id)
                .catch((error: unknown) => window.alert(t('chat.pane.restartFailed', { error: errorMessage(error) })));
            }}
          />
        )}
        <IconButton
          size="md"
          icon={ExportIcon}
          label={t('chat.pane.export')}
          tip={t('chat.pane.exportTip')}
          onClick={() => setExporting(true)}
        />
        {!session.archived && (
          <IconButton
            size="md"
            icon={MonitorIcon}
            label={t('chat.pane.terminal')}
            tip={t('chat.pane.terminalTip')}
            pressed={terminalOpen}
            onClick={onToggleTerminal}
          />
        )}
      </header>

      {screenMode && (
        <>
          <ClaudeScreen sessionId={session.id} />
          {(preparingNote || exitedCallout || comments.length > 0) && (
            <div className="claude-screen-notes">
              {preparingNote}
              {comments.length > 0 && (
                <div className="claude-screen-comments">
                  <CommentChips comments={comments} onRemove={removeComment} onShow={onShowComment} />
                  <button className="send-button" disabled={!canPaste} onClick={pasteComments} data-tip={t('chat.pane.pasteCommentsTip')}>
                    {t('chat.pane.pasteComments')}
                  </button>
                </div>
              )}
              {exitedCallout}
            </div>
          )}
        </>
      )}
      {/* セッションごとに作り直す（前のセッションで終わっていた項目を、移った先で「終わったばかり」と見なさない） */}
      {showTodos && !screenMode && <TodoPanel key={session.id} todos={chat.todos!} />}
      {/* ターミナルモードの間も、チャットと入力欄は隠して残す（打ちかけの答え・入力欄の状態を保つ） */}
      <div className="chat-list-wrap" hidden={screenMode}>
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
          {starting && !preparing && !pending && chat.items.length === 0 && !slowStart && (
            <div className="chat-note">
              <Busy>{t('chat.pane.starting')}</Busy>
            </div>
          )}
          {preparingNote}
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
                sessions={sessionLinks}
                onSelectSession={onSelectSession}
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
                sessions={sessionLinks}
                onSelectSession={onSelectSession}
              />
            ),
          )}
          {running && !menu && !unknownScreen && <WorkingNote sessionId={session.id} label={currentTodo?.activeForm ?? currentTodo?.content} />}
          {justFinished && !running && !menu && <DoneNote />}
          {chat.queued.map((text, i) => (
            <UnsentUser key={`queued:${i}`} text={text} attachments={0} note={t('chat.pane.queued')} queued />
          ))}
          {sending.map((item, i) => (
            <UnsentUser key={`sending:${i}`} text={item.text} attachments={item.attachments.length} note={t('chat.pane.sending')} />
          ))}
          {pending && (
            <div className="chat-user pending">
              <span className="chat-prompt">›</span>
              <span className="chat-user-text">
                {pending.text}
                {pending.attachments.length > 0 && <span className="chat-user-meta">{t('chat.pane.imageCount', { count: pending.attachments.length })}</span>}
                <span className="chat-user-meta">
                  {chat.status === 'exited'
                    ? t('chat.pane.sendOnResume')
                    : preparing
                      ? t('chat.pane.sendAfterWorktree')
                      : t('chat.pane.sendAfterStart')}
                </span>
              </span>
              {/* 待っている発言の取り消しは、ホバーしなくても見えるようにする（reveal にしない） */}
              <IconButton
                size="sm"
                icon={CloseIcon}
                label={t('chat.pane.takeBack')}
                tip={t('chat.pane.takeBackTip')}
                className="chat-rewind"
                onClick={() => {
                  const taken = onTakePending();
                  if (!taken) return;
                  setInput((prev) => [taken.text, prev].filter((t) => t.trim()).join('\n'));
                  setAttachments((prev) => [...taken.attachments, ...prev]);
                }}
              />
            </div>
          )}
          {scheduled.map((message) => (
            <ScheduledRow
              key={message.id}
              message={message}
              onSendNow={() => void window.tanacode.scheduled.sendNow(message.id).catch(reportError('chat.pane.sendNowFailed'))}
              onReschedule={(at) => void window.tanacode.scheduled.reschedule(message.id, at).catch(reportError('chat.pane.rescheduleFailed'))}
              onTake={() => takeScheduled(message.id)}
            />
          ))}
          {starting && slowStart && !preparing && !menu && (
            <div className="chat-callout">
              <span>{t('chat.pane.slowStart')}</span>
              <IconButton icon={MonitorIcon} label={t('chat.pane.showInTerminal')} onClick={onOpenTerminal} />
            </div>
          )}
          {/* 同じ質問でも、セッションが変われば作り直す（打ちかけの答えを、移った先のセッションに持ち越さない） */}
          {menu && <MenuCard key={`${session.id}|${menu.title}|${menu.options.map((o) => o.label).join('|')}`} sessionId={session.id} menu={menu} />}
          {rewinding && (
            <div className="chat-callout">
              <span>{t('chat.pane.rewinding')}</span>
              <IconButton icon={CloseIcon} size="md" label={t('common.cancel')} tip={t('chat.pane.cancelEsc')} onClick={() => window.tanacode.pty.write(session.id, '\x1b')} />
            </div>
          )}
          {unknownScreen && (
            <div className="chat-callout">
              <span>{t('chat.pane.unknownScreen')}</span>
              <div className="chat-callout-actions">
                <IconButton icon={CloseIcon} size="md" label={t('common.close')} tip={t('chat.pane.closeEsc')} onClick={() => window.tanacode.pty.write(session.id, '\x1b')} />
                <button className="send-button" onClick={onOpenTerminal}>
                  {t('chat.pane.operateInTerminal')}
                </button>
              </div>
            </div>
          )}
          {session.archived && (
            <div className="chat-callout">
              <span>{t('chat.pane.archived')}</span>
              <button className="send-button" onClick={onUnarchive}>
                {t('chat.pane.unarchive')}
              </button>
            </div>
          )}
          {exitedCallout}
        </div>
        {awayFromBottom && (
          <button
            className="chat-jump-bottom"
            onClick={jumpToBottom}
            data-tip={t('chat.pane.jumpToLatest')}
            data-tip-side="top"
            aria-label={t('chat.pane.jumpToLatest')}
          >
            <ArrowDownIcon size={14} />
          </button>
        )}
      </div>

      {exporting && <ExportDialog key={session.id} session={session} onClose={() => setExporting(false)} />}
      {!screenMode && <TaskTray tasks={tasks} activeKey={activeTaskKey} onOpen={(t) => onOpenTask(t.ref)} onStop={onStopTask} stopping={stoppingTasks} />}
      {!session.archived && (
        <div className="chat-input-wrap" hidden={screenMode}>
          <ChatInput
            working={running}
            comments={comments}
            onRemoveComment={removeComment}
            onShowComment={onShowComment}
            completion={completion}
            value={input}
            onChange={setInput}
            attachments={attachments}
            onAttachmentsChange={setAttachments}
            placeholder={menu ? t('chat.pane.chooseAbove') : t('chat.pane.placeholder')}
            blocked={blocked}
            onSend={send}
            onSchedule={schedule}
            canSchedule={hasContent}
            showInterrupt={running && !canSend && !menu}
            onInterrupt={() => window.tanacode.sessions.interrupt(session.id)}
          />
          <div className="chat-options">
            <SettingsFileSelect
              value={session.settingsFile}
              files={settingsFiles}
              disabled={!canConfigure}
              onChange={changeSettingsFile}
              title={t('chat.pane.settingsFileTitle')}
            />
            <select
              value={modelValue}
              disabled={!canConfigure}
              onChange={(e) => configure({ model: e.target.value || null })}
              title={t('chat.pane.modelTitle')}
            >
              {modelOptions.map((o) => (
                <option key={o.value} value={o.value} disabled={o.disabled} title={o.detail}>
                  {o.label}
                </option>
              ))}
            </select>
            <IconButton
              size="md"
              icon={ReloadIcon}
              label={t('chat.pane.refreshModels')}
              tip={refreshTitle(models.catalog)}
              busy={models.refreshing}
              className="model-refresh"
              onClick={() => void models.refresh()}
            />
            <select
              value={efforts.length === 0 ? '' : effortValue}
              disabled={!canConfigure || efforts.length === 0}
              onChange={(e) => configure({ effort: e.target.value || null })}
              title={t('chat.pane.effortTitle')}
            >
              {(effortValue === '' || efforts.length === 0) && <option value="">{efforts.length === 0 ? t('chat.pane.noEffort') : t('chat.pane.effort')}</option>}
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
              title={t('chat.pane.modeTitle')}
            >
              {!screen?.mode && <option value="">{t('chat.pane.mode')}</option>}
              {modeChoices().map(([mode, label]) => (
                <option key={mode} value={mode}>
                  {label}
                </option>
              ))}
              {screen?.mode === 'bypassPermissions' && <option value="bypassPermissions">{t('chat.pane.bypassPermissions')}</option>}
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
        {attachments > 0 && <span className="chat-user-meta">{t('chat.pane.imageCount', { count: attachments })}</span>}
        <span className="chat-user-meta">{note}</span>
      </span>
    </div>
  );
}
