import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { t, type MessageKey } from '@shared/i18n';
import type { SessionSummary } from '@shared/ipc';
import type { ScheduledMessage } from '@shared/scheduled';
import { canSee } from '@shared/session-tools';
import type { StatusLineInfo } from '@shared/statusline';
import type { PermissionMode } from '@shared/screen';
import type { PendingQuestion } from '@shared/questions';
import type { BashTask, TaskRef } from '@shared/task';
import { errorMessage } from '../errorMessage';
import { ArrowDownIcon, CloseIcon, ExportIcon, IconButton, MonitorIcon, ReloadIcon } from '../icons';
import { formatComments, type ReviewComment } from '../review/LineComments';
import { ExportDialog } from '../export/ExportDialog';
import { ContextMeter } from '../knowledge/ContextMeter';
import { contextUsage } from '../knowledge/useSessionKnowledge';
import { QuestionCard } from '../screen/QuestionCard';
import type { TaskEntry } from '../tasks/taskList';
import { TaskTray } from '../tasks/TaskTray';
import { ClaudeScreen, pasteIntoClaudeScreen } from '../terminal/ClaudeScreen';
import { runInTerminal } from '../terminal/runInTerminal';
import type { WorkflowRuns } from '../workflow/useSessionWorkflows';
import { ChatInput, CommentChips, listCompletionFiles, type CompletionSource } from './ChatInput';
import { ChatRow } from './ChatRow';
import { HookGroupRow } from './HookGroupRow';
import { ToolGroupRow } from './ToolGroupRow';
import { groupTools, reuseGroups, type ChatRowItem } from './toolGroups';
import { TodoPanel } from './TodoPanel';
import type { UnsentPrompt } from '@shared/chat';
import { isLongPaste } from '@shared/prompt-keys';
import { useInsertInput } from './insertInput';
import { DoneNote, StartingNote, useJustFinished, WorkingNote } from './WorkingNote';
import type { SubagentRuns } from './useSessionSubagents';
import { acceptsInput, type ChatState } from './chatState';
import type { PendingSend } from './pendingSends';
import { PastedChips } from './PastedChips';
import { ParentHeading } from './SessionRefs';
import { ScheduledRow } from './ScheduledRow';
import { RemoteControlToggle } from './RemoteControlToggle';
import { stripControlChars } from './sanitize';
import { useCanCompact } from './compactState';
import { CompactButton, useCompactStatus } from './CompactButton';
import { EFFORTS, modeChoices, refreshTitle, useModelCatalog } from './sessionOptions';
import { SettingsFileSelect, useSettingsFiles } from './settingsFiles';
import { Busy } from '../layout/Busy';
import { useSessionLinks, type SessionLink } from '../sessions/sessionLinks';
import { pendingFolder, preparingLabel } from '../sessions/worktree';

// チャットの一覧を上・下へ送るキー（Space は、Shift と一緒なら上へ）
const SCROLL_UP_KEYS = new Set(['ArrowUp', 'PageUp', 'Home']);
const SCROLL_DOWN_KEYS = new Set(['ArrowDown', 'PageDown', 'End']);

type Props = {
  session: SessionSummary;
  // 一覧のすべてのセッション。チャットに出るほかのセッション（親・子・@ の参照）の名前と、入力欄の @ の候補に使う
  sessions: SessionSummary[];
  // ほかのセッションへ移る（チャットの親からの指示・子からの知らせ・@ の参照・セッションのツールのカードから）
  onSelectSession: (id: string) => void;
  chat: ChatState;
  // フックが答えを待っている AskUserQuestion（無ければ null）
  question?: PendingQuestion | null;
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
  // サイドパネルにコンテキストの中身を出す（ヘッダーのメーターを押したとき）
  onShowContext: () => void;
  // ターミナルパネルのシェルのタブを出す（worktree の npm install などの進み具合を見る）
  onShowShell: () => void;
  // ターミナルモードとチャットを切り替える（ヘッダーのボタン）
  onToggleTerminal: () => void;
  onOpenFile: (absPath: string, line?: number) => void;
  onResume: () => void;
  onUnarchive: () => void;
  // 送る。起動中なら、入力を受け付けられるようになるまで預かる。pastes: 入力欄の札（貼り付けた長い文）
  onSend: (text: string, attachments: string[], pastes?: string[]) => void;
  // 起動を待っている発言
  pending: PendingSend | null;
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
  question = null,
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
  onShowContext,
  onShowShell,
  onToggleTerminal,
  onOpenFile,
  onResume,
  onUnarchive,
  onSend,
  pending,
  onTakePending,
  scheduled,
}: Props) {
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<string[]>([]);
  // 貼り付けた長い文（札）
  const [pastes, setPastes] = useState<string[]>([]);
  // 作業の書き出しの確認を出している
  const [exporting, setExporting] = useState(false);
  const drafts = useRef(new Map<string, { text: string; attachments: string[]; pastes: string[] }>());
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
  // 前に読んだ（か、送った）スクロールの位置。上へ動いたか（上を読み始めたか）を見分ける
  const lastScrollTop = useRef(0);
  // 人が上へスクロールしようとしている（ホイール・トラックパッドで上へ・上へ送るキー・スクロールバーを押した）。スクロールが止まるまで立てておく。
  // 最下部を追いかけるのをやめるのは、人が上へ動かしたときだけ。一覧が縮んで位置が押し戻された（位置を保つ調整も）知らせが、
  // そのあと伸びてから届くと（CPU が忙しいと起きる）、上へ動いて最下部から離れたように見える。これで追いかけをやめると、
  // カードの選択肢が見えている範囲の下に隠れ、その上に「最新のメッセージへ」が出る（選択肢の代わりにボタンを押してしまう）
  const userScrollingUp = useRef(false);
  // 最下部へ送る。送った位置を覚えておく（送ったスクロールの知らせを、上へ動いたと取り違えない）
  const toBottom = (list: HTMLElement) => {
    list.scrollTop = list.scrollHeight;
    lastScrollTop.current = list.scrollTop;
  };

  // キーでのスクロール。一覧の中を押したあとは、入力欄の外で押したキーが一覧を動かす（キーの知らせは一覧に届かないので、ウインドウで聞く）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (SCROLL_UP_KEYS.has(e.key) || (e.key === ' ' && e.shiftKey)) userScrollingUp.current = true;
      else if (SCROLL_DOWN_KEYS.has(e.key) || e.key === ' ') userScrollingUp.current = false;
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const [draftSessionId, setDraftSessionId] = useState(session.id);
  if (draftSessionId !== session.id) {
    drafts.current.set(draftSessionId, { text: input, attachments, pastes });
    setDraftSessionId(session.id);
    const draft = drafts.current.get(session.id);
    setInput(draft?.text ?? '');
    setAttachments(draft?.attachments ?? []);
    setPastes(draft?.pastes ?? []);
    stickToBottom.current = true;
    setAwayFromBottom(false);
    jumping.current = false;
    // 書き出しの確認は、開いたセッションのもの。切り替えたら閉じる
    setExporting(false);
  }

  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && stickToBottom.current) toBottom(list);
  }, [chat.items, chat.status, chat.unsent, scheduled, session.id]);

  // 行の中身や一覧の高さが、上の追いかけと関係なく変わったときも、最下部にいれば追いかける
  // （カードや行があとから描き足されて伸びる・下の欄が出て一覧が縮むなど）。追いかけないと、カードの選択肢が見えている範囲の下に隠れる
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const resize = new ResizeObserver(() => {
      if (stickToBottom.current) toBottom(list);
    });
    resize.observe(list);
    for (const row of list.children) resize.observe(row);
    const rows = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) if (node instanceof Element) resize.observe(node);
        for (const node of record.removedNodes) if (node instanceof Element) resize.unobserve(node);
      }
    });
    rows.observe(list, { childList: true });
    return () => {
      resize.disconnect();
      rows.disconnect();
    };
  }, []);

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
  const live = !session.archived && chat.status !== 'exited' && chat.status !== 'not-started';
  // ターミナルモード。チャット・入力欄の代わりに、Claude Code の画面を出す。アーカイブ済みのセッションには画面が無いので、チャットのまま
  const screenMode = terminalOpen && !session.archived;
  // ターミナルモードで、Claude Code の入力欄に貼れる（起動の途中に貼った文字は、Claude Code が取りこぼす）
  const canPaste = screenMode && acceptsInput(chat.status);
  // ターミナルで選んだ出力やアプリ内ブラウザで選んだ要素などを、入力欄の末尾に足す。
  // ターミナルモードでは、見えていないチャットの入力欄ではなく、Claude Code の入力欄に貼る（貼れない間は、チャットの入力欄に取っておく）。
  // 外から来た文なので、長ければ札にする（入力欄に貼り付けたときと同じ）
  useInsertInput(session.id, (text, added) => {
    if (canPaste) {
      void pasteIntoClaudeScreen(session.id, text, added);
      return;
    }
    if (isLongPaste(text)) setPastes((prev) => [...prev, text]);
    else setInput((prev) => (prev.trim() ? `${prev.trimEnd()}\n${text}` : text));
    if (added.length > 0) setAttachments((prev) => [...prev, ...added]);
  });
  // ターミナルモードから戻ったら、最新のメッセージから見せる（隠している間に、スクロールの位置は失われる）
  useLayoutEffect(() => {
    if (screenMode) return;
    stickToBottom.current = true;
    setAwayFromBottom(false);
    const list = listRef.current;
    if (list) toBottom(list);
  }, [screenMode]);
  // フックが答えを待っている質問
  const asked = live ? question : null;
  // 質問や確認のカードが出ている
  const waiting = !!asked;
  // 質問や確認のカードが出ている間は、答えをカードで選ぶ
  const blocked = waiting || !(chat.status === 'idle' || chat.status === 'running' || chat.status === 'starting');
  const hasContent = input.trim().length > 0 || attachments.length > 0 || pastes.length > 0 || comments.length > 0;
  const canSend = !blocked && hasContent;
  // 質問や確認のカードが出たときも、最下部にいれば追いかける。カードは会話ログから来ないので、上の追いかけ
  // （chat.items など）では動かない。追いかけないと、カードの選択肢が見えている範囲の下に出て、スクロールすると
  // 「最新のメッセージへ」のボタンが選択肢の上に重なる（選択肢を押したつもりが、ボタンを押してしまう）
  const cardKey = asked ? `question:${asked.id}` : '';
  useLayoutEffect(() => {
    const list = listRef.current;
    if (cardKey && list && stickToBottom.current) toBottom(list);
  }, [cardKey]);
  const canConfigure = !running && !waiting;
  const canRewind = live && chat.status === 'idle';
  const canCompact = useCanCompact(session, chat);
  const compactStatus = useCompactStatus(live ? session.id : null);

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
  const runningModel = statusLine?.model?.name ?? null;
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
  const effortValue = session.effort ?? (efforts.find((e) => e === statusLine?.effort) ?? '');

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
  // worktree のフォルダができる前に読んだファイルの候補（空）は、できたら読み直す（鍵を変える）
  const folderPending = pendingFolder(session) !== null;
  // ワークスペースに追加したフォルダのファイルも @ の候補に出す。足したり外したりしたら読み直す
  const addedKey = (session.addedFolders ?? []).join('\0');
  const completion = useMemo<CompletionSource>(
    () => ({
      key: `${folderPending ? `${session.id}:pending` : session.id}\0${addedKey}`,
      listFiles: () => listCompletionFiles(window.tanacode.workspace.listFiles(session.id), addedKey ? addedKey.split('\0') : []),
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
    [session.id, folderPending, addedKey],
  );

  // 送る本文（コードへのコメントを添える）
  const composed = () => (comments.length > 0 ? [input.trim(), formatComments(comments)].filter(Boolean).join('\n\n') : input);
  const clearInput = () => {
    onCommentsChange([]);
    setInput('');
    setAttachments([]);
    setPastes([]);
    stickToBottom.current = true;
    setAwayFromBottom(false);
  };

  const send = () => {
    if (!canSend) return;
    onSend(composed(), attachments, pastes);
    clearInput();
  };

  // 時刻を指定して送信（予約）。選択メニューが出ている間や、止まっているセッションにも予約できる（時刻になったら main が起動し直して送る）
  const schedule = (at: number) => {
    if (!hasContent) return;
    void window.tanacode.scheduled.add(session.id, composed(), attachments, at, pastes).then(
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
      // Claude が自分に入れた予約は、人が書いたものではないので、入力欄に戻さない（取り消すだけ）
      if (!taken || taken.by === 'claude') return;
      if (sessionIdRef.current !== owner) {
        const draft = drafts.current.get(owner) ?? { text: '', attachments: [], pastes: [] };
        drafts.current.set(owner, {
          text: [taken.text, draft.text].filter((t) => t.trim()).join('\n'),
          attachments: [...taken.attachments, ...draft.attachments],
          pastes: [...taken.pastes, ...draft.pastes],
        });
        return;
      }
      setInput((prev) => [taken.text, prev].filter((t) => t.trim()).join('\n'));
      setAttachments((prev) => [...taken.attachments, ...prev]);
      setPastes((prev) => [...taken.pastes, ...prev]);
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
        <ContextMeter {...contextUsage(session.model, null, statusLine, contextTokens)} onClick={onShowContext} />
        {!session.archived && (
          <RemoteControlToggle
            on={session.remoteControl}
            connected={live ? !!chat.remoteControlUrl : null}
            busy={switchingRemote.has(session.id)}
            onChange={(on) => void setRemoteControl(on)}
          />
        )}
        {live && (
          <CompactButton
            canStart={canCompact}
            status={compactStatus}
            auto={session.autoCompact !== false}
            onStart={() => void window.tanacode.compact.start(session.id)}
            onAutoChange={(on) => void window.tanacode.sessions.setAutoCompact(session.id, on)}
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
            const movedUp = el.scrollTop < lastScrollTop.current - 1;
            lastScrollTop.current = el.scrollTop;
            // ボタンで送っている途中は、着くまで（か、送り終わるまで）追いかける状態のままにする
            if (jumping.current && el.scrollHeight - el.scrollTop - el.clientHeight >= 40) return;
            jumping.current = false;
            // 最下部を追いかけている間は、人が上へスクロールしたときだけやめる。それ以外（下に隠れた選択肢を見ようと下へスクロールした・
            // 追いかけたスクロールの知らせが、そのあと伸びてから届いた・一覧が縮んで押し戻された知らせが、そのあと伸びてから届いた）では、
            // 最下部へ送り直す。最下部から離れたことにすると、「最新のメッセージへ」のボタンが、見ようとした選択肢の上に出る
            if (stickToBottom.current && !(movedUp && userScrollingUp.current)) {
              toBottom(el);
              return;
            }
            updateBottom(el);
          }}
          onWheel={(e) => {
            if (e.deltaY !== 0) userScrollingUp.current = e.deltaY < 0;
          }}
          onPointerDown={(e) => {
            // スクロールバー（一覧そのもの）を押したとき。行の中（カードの選択肢など）を押したときは数えない
            // （選択肢を押して離す間に、ほかのわけで上へ動いたのを、人のスクロールと取り違えない）
            if (e.target === e.currentTarget) userScrollingUp.current = true;
          }}
          onScrollEnd={(e) => {
            userScrollingUp.current = false;
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
                parentId={session.parentId}
              />
            ),
          )}
          {running && !waiting && <WorkingNote sessionId={session.id} label={currentTodo?.activeForm ?? currentTodo?.content} />}
          {justFinished && !running && !waiting && <DoneNote />}
          {chat.unsent.map((prompt) => (
            <UnsentUser key={prompt.id} prompt={prompt} parentId={session.parentId} sessions={sessionLinks} onSelectSession={onSelectSession} />
          ))}
          {pending && (
            <div className="chat-user pending">
              <span className="chat-prompt">›</span>
              <span className="chat-user-text">
                {pending.text}
                <PastedChips pastes={pending.pastes} />
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
                  setPastes((prev) => [...taken.pastes, ...prev]);
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
          {/* 起動中（npm install などの準備の間は、準備の知らせを出す）。時間がかかっていれば、経過と標準エラーの末尾 */}
          {starting && !preparing && !waiting && <StartingNote sessionId={session.id} busy={!pending && chat.items.length === 0} />}
          {/* 同じ質問でも、セッションが変われば作り直す（打ちかけの答えを、移った先のセッションに持ち越さない） */}
          {/* 待っている質問が変われば作り直す（打ちかけの答えを、次の質問やほかのセッションに持ち越さない） */}
          {asked && <QuestionCard key={`${session.id}|${asked.id}`} sessionId={session.id} question={asked} />}
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
            pastes={pastes}
            onPastesChange={setPastes}
            placeholder={waiting ? t('chat.pane.chooseAbove') : t('chat.pane.placeholder')}
            blocked={blocked}
            onSend={send}
            onSchedule={schedule}
            canSchedule={hasContent}
            showInterrupt={running && !canSend && !waiting}
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
              value={session.mode ?? ''}
              disabled={!live || waiting}
              onChange={(e) => void window.tanacode.screen.setMode(session.id, e.target.value as PermissionMode)}
              title={t('chat.pane.modeTitle')}
            >
              {!session.mode && <option value="">{t('chat.pane.mode')}</option>}
              {modeChoices().map(([mode, label]) => (
                <option key={mode} value={mode}>
                  {label}
                </option>
              ))}
              {session.mode === 'bypassPermissions' && <option value="bypassPermissions">{t('chat.pane.bypassPermissions')}</option>}
            </select>
          </div>
        </div>
      )}
    </section>
  );
});

// 会話ログにまだ発言として出ていない、送った発言（送信中・順番待ち）
// 送信中のものは、すぐに本物の発言に置き換わるので、見た目は発言と同じにする（点線にすると置き換わるときにちらつく）。
// 親セッションからの指示は、会話に出たとき（ChatRow）と同じく、見出しを付けて人の発言と見分ける
function UnsentUser({
  prompt,
  parentId,
  sessions,
  onSelectSession,
}: {
  prompt: UnsentPrompt;
  parentId: string | null | undefined;
  sessions: readonly SessionLink[];
  onSelectSession: (id: string) => void;
}) {
  const queued = prompt.state === 'queued';
  const text = (
    <span className="chat-user-text">
      {prompt.text}
      <PastedChips pastes={prompt.pastes} />
      {prompt.images > 0 && <span className="chat-user-meta">{t('chat.pane.imageCount', { count: prompt.images })}</span>}
      <span className="chat-user-meta">{t(queued ? 'chat.pane.queued' : 'chat.pane.sending')}</span>
    </span>
  );
  return (
    <div className={`chat-user${queued ? ' pending' : ''}${prompt.parent ? ' from-parent' : ''}`}>
      <span className="chat-prompt">{prompt.parent ? '»' : '›'}</span>
      {prompt.parent ? (
        <div className="chat-user-body">
          <ParentHeading parentId={prompt.parent} isParent={prompt.parent === parentId} sessions={sessions} onSelectSession={onSelectSession} />
          {text}
        </div>
      ) : (
        text
      )}
    </div>
  );
}
