import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { t, type MessageKey } from '@shared/i18n';
import type { RewindChoice, RewindPreview, SessionSummary } from '@shared/ipc';
import type { ScheduledMessage } from '@shared/scheduled';
import { canSee } from '@shared/session-tools';
import type { StatusLineInfo } from '@shared/statusline';
import type { PermissionMode } from '@shared/screen';
import type { PendingPermission, PendingQuestion } from '@shared/questions';
import type { PendingElicitation } from '@shared/elicitation';
import type { BashTask, TaskRef } from '@shared/task';
import { errorMessage } from '../errorMessage';
import { ArrowDownIcon, CloseIcon, ExportIcon, IconButton, MonitorIcon, ReloadIcon } from '../icons';
import { formatComments, type ReviewComment } from '../review/LineComments';
import { ExportDialog } from '../export/ExportDialog';
import { ContextMeter } from '../knowledge/ContextMeter';
import { contextUsage } from '../knowledge/useSessionKnowledge';
import { MenuCard } from '../screen/MenuCard';
import { QuestionCard } from '../screen/QuestionCard';
import { ElicitationCard } from '../screen/ElicitationCard';
import type { TaskEntry } from '../tasks/taskList';
import { TaskTray } from '../tasks/TaskTray';
import { ClaudeScreen, pasteIntoClaudeScreen } from '../terminal/ClaudeScreen';
import { runInTerminal } from '../terminal/runInTerminal';
import type { WorkflowRuns } from '../workflow/useSessionWorkflows';
import { ChatInput, CommentChips, listCompletionFiles, type CompletionSource } from './ChatInput';
import { ChatRow, PartialRow } from './ChatRow';
import { HookGroupRow } from './HookGroupRow';
import { ToolGroupRow } from './ToolGroupRow';
import { groupTools, reuseGroups, type ChatRowItem } from './toolGroups';
import { TodoPanel } from './TodoPanel';
import type { UnsentPrompt } from '@shared/chat';
import { isLongPaste } from '@shared/paste';
import { useInsertInput } from './insertInput';
import { DoneNote, StartingNote, useJustFinished, WorkingNote } from './WorkingNote';
import type { SubagentRuns } from './useSessionSubagents';
import { acceptsInput, type ChatState } from './chatState';
import type { PendingSend } from './pendingSends';
import { PastedChips } from './PastedChips';
import { RewindCard } from './RewindCard';
import { ParentHeading } from './SessionRefs';
import { ScheduledRow } from './ScheduledRow';
import { RemoteControlToggle } from './RemoteControlToggle';
import { useCanCompact } from './compactState';
import { CompactButton, useCompactStatus } from './CompactButton';
import { EFFORTS, modeChoices, refreshTitle, useModelCatalog, useSessionModels, withSessionModels } from './sessionOptions';
import { SettingsFileSelect, useSettingsFiles } from './settingsFiles';
import { Busy } from '../layout/Busy';
import { sessionName, useSessionLinks, type SessionLink } from '../sessions/sessionLinks';
import { pendingFolder, preparingLabel } from '../sessions/worktree';

// チャットの一覧を上・下へ送るキー（Space は、Shift と一緒なら上へ）
const SCROLL_UP_KEYS = new Set(['ArrowUp', 'PageUp', 'Home']);
const SCROLL_DOWN_KEYS = new Set(['ArrowDown', 'PageDown', 'End']);
// 押して離す間、画面の上の位置を保つ要素（押すと click で動くもの。カードの選択肢はどれも button）
const PRESSABLE = 'button, a[href], [role="button"], summary, label';
// 押した点からこれより動いたら、押したのではなく動かした（ドラッグ）とみなす（手のぶれは数えない）
const PRESS_SLOP_PX = 4;

type Props = {
  session: SessionSummary;
  // 一覧のすべてのセッション。チャットに出るほかのセッション（親・子・@ の参照）の名前と、入力欄の @ の候補に使う
  sessions: SessionSummary[];
  // ほかのセッションへ移る（チャットの親からの指示・子からの知らせ・@ の参照・セッションのツールのカードから）
  onSelectSession: (id: string) => void;
  chat: ChatState;
  // Claude Code が答えを待っている AskUserQuestion（無ければ null）
  question?: PendingQuestion | null;
  // Claude Code が答えを待っている、質問でない要求（許可の確認・プランの承認。無ければ null）
  permission?: PendingPermission | null;
  // MCP サーバーから人への質問（答えを待っているもの。無ければ、完了を待っている URL の形の質問。どちらも無ければ null）
  elicitation?: PendingElicitation | null;
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
  permission = null,
  elicitation = null,
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
  // 人が上へスクロールしようとしている（ホイール・トラックパッドで上へ・上へ送るキー・スクロールバーを押した・Tab で上の要素へフォーカスを
  // 移して一覧が上へ動いた）。スクロールが止まるまで立てておく。
  // 最下部を追いかけるのをやめるのは、人が上へ動かしたときだけ。一覧が縮んで位置が押し戻された（位置を保つ調整も）知らせが、
  // そのあと伸びてから届くと（CPU が忙しいと起きる）、上へ動いて最下部から離れたように見える。これで追いかけをやめると、
  // カードの選択肢が見えている範囲の下に隠れ、その上に「最新のメッセージへ」が出る（選択肢の代わりにボタンを押してしまう）
  const userScrollingUp = useRef(false);
  // Tab（Shift+Tab）を押している間（押してから離すまで）。フォーカスを移した先を見せるために、ブラウザが一覧を動かすことがある
  const tabbing = useRef(false);
  // 一覧の中の押せる要素を押している間（押してから、離して click が届くまで）。押した要素と、押したときの画面の上の位置（top）、
  // 位置を保つために一覧の上と下に足した余白（pad。base は CSS で決まっている余白）、離したときに外す聞き手（stop）
  const pressed = useRef<{
    element: Element;
    top: number;
    base: { top: number; bottom: number };
    pad: { top: number; bottom: number };
    stop: () => void;
  } | null>(null);
  // 最下部へ送る。送った位置を覚えておく（送ったスクロールの知らせを、上へ動いたと取り違えない）。
  // 押している間は送らずに、押した要素の位置を保つ（離したあとで送る）
  const toBottom = (list: HTMLElement) => {
    if (pressed.current) {
      keepPressed(list);
      return;
    }
    list.scrollTop = list.scrollHeight;
    lastScrollTop.current = list.scrollTop;
  };
  // 押している間は、押した要素を画面の上で動かさない。押して離す間に、上の行が縮む・伸びる・増える・消える（終わったツールの行が
  // 消える動き・会話ログからあとで届く行）か、最下部を追いかけて、押した要素が動くと、離した所が要素から外れ、click が要素に届かない
  // （カードの選択肢を押しても効かない。E2E では Playwright の click が成功で返ったまま、カードが閉じるのを待って止まる）。
  // ずれた分はスクロールで戻す。下へずれた（上の行が伸びた・増えた）分は、上に足した余白があればそこから引き、スクロールの余地が
  // 足りなければ（一覧がスクロールしない・下の端に着いた）一覧の下に余白を足してから戻す。上へずれた（上の行が縮んだ・消えた）分で、
  // スクロールで戻しきれないもの（上の端に着いた）は、一覧の上の余白で戻す
  const keepPressed = (list: HTMLElement) => {
    const hold = pressed.current;
    if (!hold || !hold.element.isConnected) return;
    const drift = () => hold.element.getBoundingClientRect().top - hold.top;
    const applyPad = () => {
      list.style.paddingTop = hold.pad.top > 0 ? `${hold.base.top + hold.pad.top}px` : '';
      list.style.paddingBottom = hold.pad.bottom > 0 ? `${hold.base.bottom + hold.pad.bottom}px` : '';
    };
    let d = drift();
    if (Math.abs(d) < 0.5) return;
    if (d > 0 && hold.pad.top > 0) {
      hold.pad.top = Math.max(0, hold.pad.top - d);
      applyPad();
      d = drift();
    }
    if (d > 0) {
      const room = list.scrollHeight - list.clientHeight - list.scrollTop;
      if (room < d) {
        hold.pad.bottom += d - room;
        applyPad();
      }
    }
    list.scrollTop += d;
    lastScrollTop.current = list.scrollTop;
    d = drift();
    if (d < -0.5) {
      hold.pad.top -= d;
      applyPad();
    }
  };
  // 離した。余白を外し、押している間に止めていた最下部の追いかけをする
  const releasePressed = (list: HTMLElement) => {
    const hold = pressed.current;
    if (!hold) return;
    pressed.current = null;
    hold.stop();
    if (hold.pad.top > 0) list.style.paddingTop = '';
    if (hold.pad.bottom > 0) list.style.paddingBottom = '';
    if (stickToBottom.current) toBottom(list);
    else lastScrollTop.current = list.scrollTop;
  };
  // 一覧の行の中の、押せる要素（カードの選択肢など）を押し始めた。離した（pointerup・pointercancel）あと、そのときの click が
  // 届いてから離したことにする（pointerup・mouseup・click は、同じ入力の中で続けて届く。その途中で余白を外すと、mouseup の位置がずれる）。
  // 人が自分で一覧を動かしたら、やめる: 押した点から動かした（ドラッグで文字を選ぶ。端を越えると選ぶためのスクロールが動く）・
  // ホイールを回した・キーを押した・ウインドウから離れた（離した知らせが来ないことがある）
  const holdPressed = (list: HTMLElement, element: Element, x: number, y: number) => {
    releasePressed(list);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const up = () => {
      clearTimeout(timer);
      timer = setTimeout(() => releasePressed(list));
    };
    const leave = () => releasePressed(list);
    const move = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - x, e.clientY - y) > PRESS_SLOP_PX) leave();
    };
    const listeners: [string, EventListener][] = [
      ['pointerup', up],
      ['pointercancel', up],
      ['pointermove', move as EventListener],
      ['wheel', leave],
      ['keydown', leave],
      ['blur', leave],
    ];
    for (const [type, listener] of listeners) window.addEventListener(type, listener, true);
    // 一覧の中のどこかが変わったら（行が増える・消える。行の中で、閉じたまとまりの下の終わったツールの行が消える・本文が描き直されるなど）、
    // 変わった直後に（描く前に）位置を戻す。大きさの変化の知らせは次に描くときにしか来ないので、それを待つと、その前に離したときに
    // ずれた所で離すことになり、click が届かない（Playwright の click は押してから離すまでが短く、CI でツールのまとまりが開かなかった）
    // 位置を保つために一覧に足した余白（一覧の style）の変化は数えない（数えると、戻すたびにまた呼ばれる）
    const changes = new MutationObserver((records) => {
      if (records.some((r) => !(r.target === list && r.attributeName === 'style'))) keepPressed(list);
    });
    changes.observe(list, { subtree: true, childList: true, attributes: true, characterData: true });
    pressed.current = {
      element,
      top: element.getBoundingClientRect().top,
      base: { top: Number.parseFloat(getComputedStyle(list).paddingTop) || 0, bottom: Number.parseFloat(getComputedStyle(list).paddingBottom) || 0 },
      pad: { top: 0, bottom: 0 },
      stop: () => {
        clearTimeout(timer);
        changes.disconnect();
        for (const [type, listener] of listeners) window.removeEventListener(type, listener, true);
      },
    };
  };
  useEffect(() => () => pressed.current?.stop(), []);

  // キーでのスクロール。一覧の中を押したあとは、入力欄の外で押したキーが一覧を動かす（キーの知らせは一覧に届かないので、ウインドウで聞く）
  // Tab は、入力欄の中で押しても、一覧の中へフォーカスを移す（離したら、または離した知らせが来ないままウインドウから離れたら、下ろす）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab') tabbing.current = true;
      if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (SCROLL_UP_KEYS.has(e.key) || (e.key === ' ' && e.shiftKey)) userScrollingUp.current = true;
      else if (SCROLL_DOWN_KEYS.has(e.key) || e.key === ' ') userScrollingUp.current = false;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Tab') tabbing.current = false;
    };
    const onBlur = () => {
      tabbing.current = false;
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
    };
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
  }, [chat.items, chat.partial, chat.status, chat.unsent, scheduled, session.id]);

  // 行の中身や一覧の高さが、上の追いかけと関係なく変わったときも、最下部にいれば追いかける
  // （カードや行があとから描き足されて伸びる・下の欄が出て一覧が縮むなど）。追いかけないと、カードの選択肢が見えている範囲の下に隠れる。
  // 押せる要素を押している間は、最下部にいなくても（上を読んでいても）、押した要素の位置を保つ
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const resize = new ResizeObserver(() => {
      if (pressed.current) keepPressed(list);
      else if (stickToBottom.current) toBottom(list);
    });
    // 一覧そのものは外側の大きさ（border-box）で見張る。押している間に位置を保つため、この知らせの中で一覧に余白を足す（keepPressed）。
    // 中身の大きさ（content-box）で見張ると、足した余白で一覧の大きさが変わったことになる。一覧は行より浅いので、その知らせは
    // 同じ回のうちに届けられず、ブラウザが「ResizeObserver loop completed with undelivered notifications.」のエラーを出す
    resize.observe(list, { box: 'border-box' });
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
  // 答えを待っている質問と、許可の確認・プランの承認
  const asked = live ? question : null;
  const prompt = live ? permission : null;
  const elicited = live ? elicitation : null;
  // 質問や確認のカードが出ている（完了を待っている URL の形の質問は、Claude Code が答えを待っていないので数えない）
  const waiting = !!asked || !!prompt || (!!elicited && !elicited.opened);
  // 質問や確認のカードが出ている間は、答えをカードで選ぶ
  const blocked = waiting || !(chat.status === 'idle' || chat.status === 'running' || chat.status === 'starting');
  const hasContent = input.trim().length > 0 || attachments.length > 0 || pastes.length > 0 || comments.length > 0;
  const canSend = !blocked && hasContent;
  // 質問や確認のカードが出たときも、最下部にいれば追いかける。カードは会話ログから来ないので、上の追いかけ
  // （chat.items など）では動かない。追いかけないと、カードの選択肢が見えている範囲の下に出て、スクロールすると
  // 「最新のメッセージへ」のボタンが選択肢の上に重なる（選択肢を押したつもりが、ボタンを押してしまう）
  const cardKey = asked ? `question:${asked.id}` : prompt ? `permission:${prompt.id}` : elicited ? `elicitation:${elicited.id}` : '';
  useLayoutEffect(() => {
    const list = listRef.current;
    if (cardKey && list && stickToBottom.current) toBottom(list);
  }, [cardKey]);
  const canConfigure = !running && !waiting;
  const canRewind = live && chat.status === 'idle';
  const canCompact = useCanCompact(session, chat);
  const compactStatus = useCompactStatus(live ? session.id : null);

  // 巻き戻しの確かめ（選んだ発言と、コードを戻すと変わるファイル）。ほかのセッションへ移ったら閉じる
  const [rewinding, setRewinding] = useState<{ messageId: string; preview: RewindPreview } | null>(null);
  // 巻き戻している途中のセッション（移った先のカードを、戻している途中にしない）
  const [rewindingIn, setRewindingIn] = useState<ReadonlySet<string>>(new Set());
  const rewindBusy = rewindingIn.has(session.id);
  useEffect(() => setRewinding(null), [session.id]);
  // 見ているセッション（返事が来るまでにほかのセッションへ移ったかを、呼んだときのセッションと比べる）
  const sessionIdRef = useRef(session.id);
  sessionIdRef.current = session.id;
  const rewindTo = useCallback(
    (messageId: string) => {
      const owner = session.id;
      void window.tanacode.screen.rewindPreview(owner, messageId).then((preview) => {
        // 調べている間に移ったら、移った先には出さない（そのセッションの発言ではない）
        if (sessionIdRef.current !== owner) return;
        if (!preview) window.alert(t('chat.pane.rewindNotFound'));
        else setRewinding({ messageId, preview });
      });
    },
    [session.id],
  );

  // Claude Code が持っているモデル一覧の控え。更新のボタンで読み直す
  const models = useModelCatalog();
  const { labelOf } = models;
  // 動いている間は、Claude Code がその場で切り替えられるモデルと、そのモデルで選べるエフォートにする
  const liveModels = useSessionModels(live && chat.status !== 'starting' ? session.id : null);
  const choices = useMemo(() => withSessionModels(models.choices, liveModels), [models.choices, liveModels]);
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
  // 権限モードを変える。Claude Code に断られたら知らせる（モード欄は、Claude Code が知らせた今のモードのまま）
  const changeMode = (mode: PermissionMode) =>
    void window.tanacode.screen.setMode(session.id, mode).then(
      (ok) => ok || window.alert(t('chat.pane.modeFailed', { mode: modeChoices().find(([value]) => value === mode)?.[1] ?? mode })),
      reportError('chat.pane.modeFailedError'),
    );
  // モデルを変える。今のエフォートを新しいモデルで選べなければ、エフォートの指定を外す（そのモデルの既定にする）
  const changeModel = (value: string) => {
    const next = choices.find((c) => c.value === value);
    const keepEffort = !session.effort || !next || next.efforts.includes(session.effort);
    configure({ model: value || null, ...(keepEffort ? {} : { effort: null }) });
  };

  // Remote Control の切り替え。動いていれば remote_control の要求でその場でつなぐ・切るので、終わるまでぐるぐるを出す
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
  const takeScheduled = (id: string) => {
    const owner = session.id;
    void window.tanacode.scheduled.cancel(id).then((taken) => {
      // Claude が自分に入れた予約と、利用枠の再開の予約は、人が書いたものではないので、入力欄に戻さない（取り消すだけ）
      if (!taken || taken.by === 'claude' || taken.by === 'usage-limit') return;
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
  // 巻き戻す。会話を戻したら、戻した発言の文を入力欄に戻す（打ちかけの文字の前に）。
  // 返事が来るまでにほかのセッションへ移っていたら、移った先のカードと入力欄には触らず、戻した文は元のセッションの書きかけに戻す
  const applyRewind = (messageId: string, choice: RewindChoice) => {
    const owner = session.id;
    const title = sessionName(session);
    const here = () => sessionIdRef.current === owner;
    const done = () =>
      setRewindingIn((busy) => {
        const next = new Set(busy);
        next.delete(owner);
        return next;
      });
    // 断られたわけ。ほかのセッションへ移っていたら、どのセッションの話かを添える
    const failed = (codeRewound: boolean, error: string) => {
      if (here()) window.alert(t(codeRewound ? 'chat.rewind.codeOnly' : 'chat.rewind.failed', { error }));
      else window.alert(t(codeRewound ? 'chat.rewind.codeOnlyIn' : 'chat.rewind.failedIn', { title, error }));
    };
    setRewindingIn((busy) => new Set(busy).add(owner));
    void window.tanacode.screen.rewind(owner, messageId, choice).then(
      (outcome) => {
        done();
        if (!outcome.ok) {
          // コードだけ戻せたときは、確かめのカードを閉じる（もう一度押すと、同じ時点へコードを戻し直すことになる）
          if (outcome.codeRewound && here()) setRewinding(null);
          failed(!!outcome.codeRewound, outcome.error ?? '');
          return;
        }
        const prefill = outcome.prefillText;
        if (!here()) {
          if (!prefill) return;
          const draft = drafts.current.get(owner) ?? { text: '', attachments: [], pastes: [] };
          drafts.current.set(owner, { ...draft, text: [prefill, draft.text].filter((text) => text.trim()).join('\n') });
          return;
        }
        setRewinding(null);
        if (prefill) setInput((prev) => [prefill, prev].filter((text) => text.trim()).join('\n'));
      },
      (error: unknown) => {
        done();
        failed(false, errorMessage(error));
      },
    );
  };
  const removeComment = (id: string) => onCommentsChange(comments.filter((c) => c.id !== id));
  // コードへのコメントを、Claude Code の入力欄に貼る（ターミナルモード。送るのは、人が画面で Enter を押したとき）
  const pasteComments = () => {
    void pasteIntoClaudeScreen(session.id, formatComments(comments));
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
      <span>{chat.exitReason ?? t('chat.pane.exited', { code: chat.exitCode ?? '' })}</span>
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
        <ContextMeter {...contextUsage(session.model, statusLine, contextTokens)} onClick={onShowContext} />
        {!session.archived && (
          <RemoteControlToggle
            on={session.remoteControl}
            connected={live ? !!chat.remoteControlUrl : null}
            busy={switchingRemote.has(session.id)}
            locked={terminalOpen}
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
            // 切り替えは、動いている Claude Code を止めて開き直す。止まっていれば、もう片方で起動する（ターミナルモードで止まったセッションを
            // チャットに戻す）。起動・切り替えの途中は押せない
            disabled={chat.status === 'not-started' || chat.status === 'starting'}
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
              {/* ターミナルモードで Claude Code が終わっても、チャットには戻さず、ここに終了と「再開」を出す（再開もターミナルモードで起動する） */}
              {exitedCallout}
              {comments.length > 0 && (
                <div className="claude-screen-comments">
                  <CommentChips comments={comments} onRemove={removeComment} onShow={onShowComment} />
                  <button className="send-button" disabled={!canPaste} onClick={pasteComments} data-tip={t('chat.pane.pasteCommentsTip')}>
                    {t('chat.pane.pasteComments')}
                  </button>
                </div>
              )}
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
            // 押している間は、押した要素の位置を保つだけにする（追いかける・やめるは、離したあとで決める）
            if (pressed.current) {
              keepPressed(el);
              return;
            }
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
          onFocus={(e) => {
            // Tab で一覧の中の要素へフォーカスを移すと、ブラウザは focusin より先に、その要素が見えるよう一覧を動かす。上へ動いていれば、
            // 人が上へスクロールしたものとして扱う（最下部へ送り直すと、フォーカスした要素が見えなくなる）。アプリが動かしたフォーカスは数えない
            if (tabbing.current && e.currentTarget.scrollTop < lastScrollTop.current - 1) userScrollingUp.current = true;
          }}
          onPointerDown={(e) => {
            // スクロールバー（一覧そのもの）を押したとき。行の中（カードの選択肢など）を押したときは数えない
            // （選択肢を押して離す間に、ほかのわけで上へ動いたのを、人のスクロールと取り違えない）
            if (e.target === e.currentTarget) userScrollingUp.current = true;
            // 行の中の押せる要素を押したら、離すまで、その要素を動かさない（文字などは、ドラッグで選ぶので保たない）
            else if (e.button === 0 && e.target instanceof Element) {
              const pressable = e.target.closest(PRESSABLE);
              if (pressable && e.currentTarget.contains(pressable)) holdPressed(e.currentTarget, pressable, e.clientX, e.clientY);
            }
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
          {chat.partial.map((block) => (
            <PartialRow key={`partial:${block.id}`} block={block} />
          ))}
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
          {/* 待っている要求が変われば作り直す（書きかけの理由を、次の確認やほかのセッションに持ち越さない） */}
          {prompt && <MenuCard key={`${session.id}|${prompt.id}`} sessionId={session.id} permission={prompt} />}
          {/* 待っている質問が変われば作り直す（入れかけの答えを、次の質問やほかのセッションに持ち越さない） */}
          {elicited && <ElicitationCard key={`${session.id}|${elicited.id}`} sessionId={session.id} elicitation={elicited} />}
          {rewinding && (
            <RewindCard
              preview={rewinding.preview}
              cwd={session.cwd}
              busy={rewindBusy}
              onCancel={() => setRewinding(null)}
              onChoose={(choice) => applyRewind(rewinding.messageId, choice)}
            />
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
            owner={session.id}
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
              onChange={(e) => changeModel(e.target.value)}
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
              onChange={(e) => changeMode(e.target.value as PermissionMode)}
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
