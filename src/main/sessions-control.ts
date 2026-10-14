import { createHash } from 'node:crypto';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, isAbsolute, join, normalize, relative, sep } from 'node:path';
import type { ChatEvent } from '@shared/chat';
import { autoPercentOf, carriedMessages, compactMidTurn, lastReplyIn } from '@shared/optimized-compact';
import { t } from '@shared/i18n';
import type { ArchiveOptions, NewSessionOptions, ScreenChoice, SessionSummary, WorktreeLeftovers, WorktreeRemoval } from '@shared/ipc';
import { stripControlChars } from '@shared/prompt-keys';
import type { AskQuestion, Menu, MenuOption, PermissionMode, ScreenInfo } from '@shared/screen';
import type { SubagentRun } from '@shared/subagent';
import type { BashTask } from '@shared/task';
import type { WorkflowRun } from '@shared/workflow';
import {
  canSee,
  EFFORTS,
  isBusy,
  modeWithin,
  parentMessageText,
  PERMISSION_MODES,
  projectRootOf,
  SESSION_STATE_LABEL,
  sessionEventText,
  sessionTool,
  type PermissionRequest,
  type SessionState,
} from '@shared/session-tools';
import { branchBase, branchFiles, git, repoInfo } from './git';
import { textResult, type ToolResult } from './mcp-bridge';
import { SessionNotices } from './session-notices';
import { WAIT_MAX_SECONDS } from './sessions-bridge';

// Claude による、ほかのセッションの扱い（MCP サーバー tanacode-sessions のツールの実行）。中継からの呼び出しを、ソケットで受けて答える。
// 呼び出し元のセッションは中継の env で渡ってくるので、親子の関係や見えるセッションは、アプリの記録（SessionSummary.parentId）で判断する。
// 読むだけのツールは、同じリポジトリのセッションと親子・兄弟だけを見せる（別のリポジトリの会話は読ませない）。
// 指示・中断・質問への答え・許可の確認への答えは、自分の子セッションにだけ。
// 許可の確認（answer_permission）は、「今回だけ許す」と「断る」だけ。許せるのは、親が読んだ確認（permission_id）がそのまま出ていて、
// ツールの入力の全文を親に渡せていて、親の権限モードが acceptEdits 以上のときだけ（manual・plan の親は、断ることだけ）。
// start_session は、子セッションのほかに、独立したセッション（親のない、人が動かすセッション）も始められる。こちらには最初の指示を送るだけ。
// end_session は、役目を終えた自分の子を片付ける（アーカイブして、worktree も消す）。画面からのアーカイブと同じ処理を通す

// SessionManager のうち、ツールが使うもの
export type SessionsHost = {
  list(): SessionSummary[];
  // 親セッションの ID（無ければ null）。状態の変化のたびに呼ぶので、一覧を作らずに引く
  parentOf(id: string): string | null;
  stateOf(id: string): SessionState | null;
  modeOf(id: string): PermissionMode | null;
  // 今のモデル（--model に渡せる値）とエフォート。分からなければ null
  currentModel(id: string): string | null;
  currentEffort(id: string): string | null;
  conversation(id: string): Promise<ChatEvent[]>;
  screen(id: string): ScreenInfo | null;
  create(cwd: string, options: NewSessionOptions, parentId: string | null): string;
  createInWorktree(cwd: string, options: NewSessionOptions, parentId: string | null): Promise<string>;
  rename(id: string, title: string): void;
  open(id: string): Promise<void>;
  submitWhenReady(id: string, text: string, timeoutMs: number): Promise<void>;
  interrupt(id: string): void;
  withdrawParentDraft(id: string): Promise<void>;
  askedQuestions(id: string): AskQuestion[] | null;
  // expect を満たすメニューのあいだだけ選ぶ。押せたら true
  chooseIf(id: string, choice: ScreenChoice, expect: (menu: Menu) => boolean): Promise<boolean>;
  watchState(listener: (id: string) => void): () => void;
  // 今出ている許可の確認の、ツールの名前と入力の全文（フックが書いたもの。今の確認のものと言えなければ null）
  pendingPermission(id: string): PermissionRequest | null;
  // バックグラウンドで動かしたもの（終わったものも入っている）。end_session で、Claude Code と一緒に止まるものを伝えるために読む
  subagents(id: string): SubagentRun[];
  bashTasks(id: string): BashTask[];
  workflows(id: string): WorkflowRun[];
  // worktree を消す前に、残っているもの（worktree のセッションでなければ null）
  worktreeLeftovers(id: string): Promise<WorktreeLeftovers | null>;
};

type Deps = {
  host: SessionsHost;
  // メニューの「Claude にほかのセッションを扱わせる」
  enabled: () => boolean;
  // セッションをアーカイブする。画面からのアーカイブと同じ処理（アプリ内ブラウザ・シェルの後始末も）。worktree を消せなければ、
  // アーカイブはしたうえで、理由を添えて失敗する
  archive: (id: string, options: ArchiveOptions) => Promise<WorktreeRemoval | null>;
  // ホームのフォルダ（ここを開いたセッションに、ホームの下のすべてのセッションを見せないため）
  home: string;
  // 親への知らせをまとめるまでの待ち（テストでは短くする）
  notifyDelayMs?: number;
  // そのセッションで、最適化圧縮の流れが進んでいるか（host の stateOf は、その間「作業中」を返す。outward-state.ts）。
  // 流れで作業中に見えているだけの子では、親への知らせを取り下げない
  compacting?: (id: string) => boolean;
  // 質問に答えたあと、子の次の質問を待つ上限（テストでは短くする）
  followUpMs?: number;
};

// 質問に答えたあと、子が続けて出す次の質問を待つ上限。子は、答えを受け取ってから数秒で次の質問を出す
const FOLLOW_UP_MS = 20_000;
// 子セッションの最初の指示を、起動（worktree の準備も含む）が終わるまで待つ上限
const FIRST_PROMPT_TIMEOUT_MS = 30 * 60_000;
// 子セッションへの指示を、子の手が空くまで預かる上限（作業中の子には、ターンが終わってから打つ）
const SEND_TIMEOUT_MS = 3 * 60 * 60_000;
// 手の空いている子に打つときの待ちの上限（すぐ打てるはず）
const SEND_IDLE_TIMEOUT_MS = 30_000;
// get_session_diff で、未追跡のファイルを読む数と、1 つのファイルから読む大きさの上限
const MAX_UNTRACKED_FILES = 100;
const MAX_UNTRACKED_BYTES = 256 * 1024;
// 1 回の結果の文字数の上限（親のコンテキストを食いつぶさないため）
const MAX_RESULT_CHARS = 60_000;
// 許可の確認で、親に渡すツールの入力（JSON）の文字数の上限。超えるものは全文を渡せないので、親には許させない
const MAX_PERMISSION_INPUT_CHARS = 30_000;
// 親が子の許可の確認を許せる、親の権限モード（manual・plan の親は、自分の操作も人が毎回許すので、子の操作も許せない）
const MODES_ALLOWING_PERMISSION = new Set<PermissionMode>(['acceptEdits', 'auto', 'bypassPermissions']);
const WAIT_DEFAULT_SECONDS = 300;
// list_sessions で返す、セッションを始められるフォルダの数の上限
const MAX_START_FOLDERS = 30;

// 編集したファイルとして数えるツール
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

// 親に知らせる、子の手が空いた状態。バックグラウンドのタスクの完了待ちも、ターンは終わっているので知らせる。
// 子セッションは人に通知しないので、人が答える許可の確認・ターミナルでの操作の待ちも、親に知らせて人に伝えさせる
const NOTIFY_STATES = new Set<SessionState>(['idle', 'background', 'question', 'permission', 'waiting', 'exited']);

// end_session で終えられる状態。手が空いている・Claude Code が動いていない・裏のタスクの完了待ち（ターンは終わっている）・アーカイブ済み（残った worktree を消す）
const ENDABLE_STATES = new Set<SessionState>(['idle', 'exited', 'background', 'archived']);
// 終えられない状態ごとの、断る理由と次にできること（子の名前に続ける）
const END_REFUSAL: Partial<Record<SessionState, string>> = {
  starting: 'is still starting up, so it cannot be ended yet. Wait until it is idle (check with get_session), then call end_session again.',
  working:
    'is working, so it was not ended. Wait for it to finish (check with get_session), or, if its work is no longer needed, interrupt it with stop_session first and then call end_session again. If you are not sure whether its work is still needed, ask the user.',
  question:
    'is waiting for an answer to a question, so its work is not finished and it was not ended. Answer the question with answer_question (get_session shows it) and let it finish, or ask the user whether to end it.',
  permission:
    'is waiting for an answer to a permission prompt, so its work is not finished and it was not ended. Answer the prompt with answer_permission (get_session shows it) or ask the user, and call end_session again once the child is idle.',
  waiting:
    'is waiting for the user to act in its terminal, so it was not ended. Only the user can do that: tell the user, and call end_session again once the child is idle.',
};

class ToolError extends Error {}

export class SessionsControl {
  // 子セッションの、前に見た状態（作業中から手が空いたことを知るため）
  private readonly lastState = new Map<string, SessionState | null>();
  // 親に知らせる子の出来事（親の ID → 子の ID → 状態と時刻）。親の手が空いたら送る
  private readonly notices: SessionNotices<{ state: SessionState; at: number }>;
  // 親が子の状態を読んだ時刻（`親:子`）。読んだあとの知らせは送らない
  private readonly observedAt = new Map<string, number>();
  // 最適化圧縮の流れが進んだ子（流れが始まってから、再開の文のターンが終わるまで）
  private readonly compacted = new Set<string>();
  // 親が止めた子。止めてターンが終わったことは、親に知らせない
  private readonly stopped = new Set<string>();
  private readonly unwatch: () => void;

  constructor(private readonly deps: Deps) {
    for (const s of deps.host.list()) this.lastState.set(s.id, deps.host.stateOf(s.id));
    this.unwatch = deps.host.watchState((id) => this.stateChanged(id));
    this.notices = new SessionNotices({
      host: deps.host,
      enabled: deps.enabled,
      compose: (parentId, queue) => this.noticeFor(parentId, queue),
      delayMs: deps.notifyDelayMs,
    });
  }

  dispose(): void {
    this.unwatch();
    this.notices.dispose();
  }

  // signal: Claude Code が呼び出しを取り消した（Esc で中断した）。待っている wait_sessions をやめる
  async handle(callerId: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    if (!sessionTool(name)) return textResult(`Unknown tool: ${name}`, true);
    if (!this.deps.enabled()) {
      return textResult(`The user has turned off "${t('main.menu.sessionsControl')}" in the tanacode menu. Ask the user to turn it on.`, true);
    }
    const caller = this.summary(callerId);
    if (!caller) return textResult('This session is not in tanacode.', true);
    try {
      switch (name) {
        case 'list_sessions':
          return await this.listSessions(caller, args);
        case 'read_session':
          return await this.readSession(caller, args);
        case 'get_session_diff':
          return await this.sessionDiff(caller, args);
        case 'get_session':
          return await this.getSession(caller, args);
        case 'wait_sessions':
          return await this.waitSessions(caller, args, signal);
        case 'start_session':
          return await this.startSession(caller, args);
        case 'send_message':
          return await this.sendMessage(caller, args);
        case 'answer_question':
          return await this.answerQuestion(caller, args);
        case 'answer_permission':
          return await this.answerPermission(caller, args);
        case 'stop_session':
          return await this.stopSession(caller, args);
        case 'end_session':
          return await this.endSession(caller, args);
        default:
          return textResult(`Unknown tool: ${name}`, true);
      }
    } catch (error) {
      return textResult(error instanceof Error ? error.message : String(error), true);
    }
  }

  // --- 読むだけのツール ---

  private async listSessions(caller: SessionSummary, args: Record<string, unknown>): Promise<ToolResult> {
    const all = this.visible(caller);
    const list = all.filter((s) => args.include_archived === true || !s.archived);
    const branches = await Promise.all(list.map((s) => branchOf(s)));
    return json({
      self: caller.id,
      // start_session の folder に選べる、ほかのフォルダ（子は始められないので出さない）
      ...(caller.parentId ? {} : { start_folders: this.knownFolders().slice(0, MAX_START_FOLDERS) }),
      sessions: list.map((s, i) => ({
        ...this.describe(s, caller),
        branch: branches[i],
        children: all.filter((c) => c.parentId === s.id).map((c) => c.id),
        updated_at: new Date(s.updatedAt).toISOString(),
      })),
    });
  }

  private async readSession(caller: SessionSummary, args: Record<string, unknown>): Promise<ToolResult> {
    const target = this.resolve(caller, args.session_id);
    const turns = intArg(args.turns, 1, 20, 3);
    const events = await this.deps.host.conversation(target.id);
    this.observe(caller.id, target.id);
    const all = this.visible(caller);
    const titleOf = (id: string) => nameOf(all.find((s) => s.id === id));
    const lines = [`# Session "${nameOf(target)}"`, ...this.headerLines(target, caller, all), ''];
    lines.push(...conversationLines(events, turns, titleOf, target.parentId ?? null), '');
    const edited = editedFiles(events, target.cwd);
    lines.push("## Files edited in this session's conversation", ...(edited.length > 0 ? edited.map((f) => `- ${f}`) : ['(none)']));
    return textResult(clip(lines.join('\n'), MAX_RESULT_CHARS));
  }

  private async sessionDiff(caller: SessionSummary, args: Record<string, unknown>): Promise<ToolResult> {
    const target = this.resolve(caller, args.session_id);
    this.observe(caller.id, target.id);
    const cwd = target.cwd;
    if (!existsSync(cwd)) throw new ToolError(`The folder of "${nameOf(target)}" does not exist (for example, its worktree was removed).`);
    const path = typeof args.path === 'string' && args.path.trim() ? safeRelative(args.path.trim()) : null;
    const info = await repoInfo(cwd).catch(() => null);
    const inRepo = await git(cwd, ['rev-parse', '--is-inside-work-tree']).then(
      () => true,
      () => false,
    );
    if (!info || !inRepo) throw new ToolError(`The folder of "${nameOf(target)}" is not a git repository.`);
    if (info.empty) throw new ToolError(`The repository of "${nameOf(target)}" has no commits yet.`);
    const base = await branchBase(cwd, info).catch(() => null);
    // 基点が決まらなければ、未コミットの変更だけを見せる
    const ref = base?.mergeBase ?? 'HEAD';
    const inPath = (file: string) => !path || file === path || file.startsWith(`${path}/`);
    const files = (await branchFiles(cwd, ref)).filter((f) => inPath(f.path));
    const tracked = await git(cwd, ['diff', '--relative', '--no-renames', '--no-color', ref, '--', ...(path ? [path] : [])]);
    const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...(path ? [path] : [])])).split('\0').filter(Boolean);
    // 未追跡のファイルは 1 つずつ、結果の上限に達したら読むのをやめる
    const added: string[] = [];
    let size = tracked.length;
    for (const file of untracked.slice(0, MAX_UNTRACKED_FILES)) {
      if (size > MAX_RESULT_CHARS) break;
      const part = await untrackedDiff(cwd, file);
      added.push(part);
      size += part.length;
    }
    const rest = untracked.length - added.length;
    if (rest > 0) added.push(`(${rest} more untracked ${rest === 1 ? 'file' : 'files'}. Narrow it down with path.)`);
    const diff = [tracked.trimEnd(), ...added].filter(Boolean).join('\n');
    const lines = [
      `# Branch changes of session "${nameOf(target)}"`,
      `- Branch: ${info.branch ?? '(no branch)'}`,
      base ? `- Base: ${base.ref} (merge base ${base.mergeBase.slice(0, 8)})` : '- Base: unknown, so only uncommitted changes (diff against HEAD)',
      `- Files: ${files.length}${path ? ` (only in ${path})` : ''}`,
      ...files.map((f) => `  - ${KIND_MARK[f.kind]} ${f.path}${f.binary ? ' (binary)' : ` (+${f.added} −${f.removed})`}`),
      '',
      '## Diff',
      diff ? fence(diff, 'diff') : '(no changes)',
    ];
    return textResult(clip(lines.join('\n'), MAX_RESULT_CHARS));
  }

  private async getSession(caller: SessionSummary, args: Record<string, unknown>): Promise<ToolResult> {
    const target = this.resolve(caller, args.session_id);
    this.observe(caller.id, target.id);
    return json(await this.status(target, caller, true));
  }

  private async waitSessions(caller: SessionSummary, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const { host } = this.deps;
    const timeoutMs = intArg(args.timeout_seconds, 1, WAIT_MAX_SECONDS, WAIT_DEFAULT_SECONDS) * 1000;
    const ids = Array.isArray(args.session_ids) ? args.session_ids : [];
    const children = host.list().filter((s) => s.parentId === caller.id && !s.archived);
    const targets = ids.length > 0 ? ids.map((id) => this.resolve(caller, id, true)) : children.filter((s) => isBusy(host.stateOf(s.id) ?? 'exited'));
    if (targets.length === 0) {
      return json({
        timed_out: false,
        note: children.length > 0 ? 'No child session is working.' : 'There are no child sessions.',
        sessions: await Promise.all(children.map((s) => this.status(s, caller, false))),
      });
    }
    const ready = () => targets.filter((t) => !isBusy(host.stateOf(t.id) ?? 'exited'));
    if (ready().length === 0) await this.until(() => ready().length > 0, timeoutMs, signal);
    const done = new Set(ready().map((t) => t.id));
    for (const id of done) this.observe(caller.id, id);
    return json({
      timed_out: done.size === 0,
      ready: [...done],
      sessions: await Promise.all(targets.map((t) => this.status(this.summary(t.id) ?? t, caller, done.has(t.id)))),
    });
  }

  // --- 子セッションを動かすツール ---

  private async startSession(caller: SessionSummary, args: Record<string, unknown>): Promise<ToolResult> {
    const { host } = this.deps;
    if (caller.parentId) throw new ToolError('A child session cannot start sessions (only one level of children, and no independent sessions).');
    const prompt = stringArg(args.prompt);
    if (!prompt) throw new ToolError('prompt (the first instruction) is empty.');
    if (typeof args.worktree !== 'boolean') throw new ToolError('Pass worktree (whether to start in a new worktree) as true or false.');
    if (args.independent !== undefined && typeof args.independent !== 'boolean') throw new ToolError('Pass independent as true or false.');
    // 独立したセッション: 親のない、ふつうのセッションとして始める（人が動かす。このセッションからは指示も中断もできない）
    const independent = args.independent === true;
    const folder = await this.folderFor(caller, args.folder, args.worktree);
    // 権限モードは、このセッションより強くできない（親を通じて、人が許していない操作を通さないため）
    const limit = host.modeOf(caller.id) ?? 'manual';
    const wanted = args.permission_mode === undefined ? (limit === 'plan' ? 'manual' : limit) : args.permission_mode;
    if (!PERMISSION_MODES.includes(wanted as PermissionMode)) throw new ToolError(`Unknown permission mode: ${String(wanted)}`);
    const mode = wanted as PermissionMode;
    if (!modeWithin(mode, limit)) throw new ToolError(`Permission mode ${mode} cannot be used because it is more permissive than this session's (${limit}).`);
    // モデルとエフォートは、省けばこのセッションの今のもの（途中で変えていれば、変えたあとのもの）。分からなければ Claude Code の既定
    const callerEffort = host.currentEffort(caller.id);
    const options: NewSessionOptions = {
      model: stringArg(args.model) || host.currentModel(caller.id),
      effort: stringArg(args.effort) || (callerEffort && EFFORTS.includes(callerEffort) ? callerEffort : null),
      // 登録した設定ファイル（別のアカウントなど）は、親と同じものを使う
      settingsFile: caller.settingsFile,
      mode,
      // Remote Control も、このセッションの指定に合わせる（子も。Remote Control から頼まれて始めたセッションを、そのまま外から操作できるように）
      remoteControl: caller.remoteControl,
      worktree: args.worktree,
    };
    const parentId = independent ? null : caller.id;
    const id = options.worktree ? await host.createInWorktree(folder, options, parentId) : host.create(folder, options, parentId);
    const name = stringArg(args.name);
    if (name) host.rename(id, name);
    this.lastState.set(id, host.stateOf(id));
    // 起動（worktree の準備も）が終わってから送る。待たずに返す（結果は wait_sessions で待つ）
    void host.submitWhenReady(id, parentMessageText(caller.id, prompt), FIRST_PROMPT_TIMEOUT_MS).catch((error: unknown) => {
      console.error('子セッションに最初の指示を送れませんでした', error);
    });
    const child = this.summary(id);
    // worktree の準備は、最初の指示より前に済む。親が子に準備（作る・依存を入れる）を頼まないように伝える
    const setup = options.worktree
      ? ` The worktree is set up before the first instruction is sent (the state is starting until then), so the ${independent ? 'session' : 'child'} needs no setup for the worktree itself.`
      : '';
    return json({
      session_id: id,
      name: name || null,
      folder: child?.cwd ?? folder,
      worktree: child?.worktree ? { name: child.worktree.name, branch: child.worktree.branch } : null,
      independent,
      model: options.model,
      effort: options.effort,
      permission_mode: mode,
      remote_control: options.remoteControl,
      state: host.stateOf(id),
      note: independent
        ? `The first instruction will be sent as soon as the session has started.${setup} It is an independent session that the user runs: you cannot instruct, wait for or stop it, and no notice arrives when it finishes. Tell the user it has started.`
        : `The first instruction will be sent as soon as the child has started.${setup} Check on the child at regular intervals with get_session until it is done; do not wait for the notice alone, and do not wait synchronously (end your turn and come back with a background timer, so that the user can talk to you).`,
    });
  }

  private async sendMessage(caller: SessionSummary, args: Record<string, unknown>): Promise<ToolResult> {
    const { host } = this.deps;
    const child = this.resolve(caller, args.session_id, true);
    const message = stringArg(args.message);
    if (!message) throw new ToolError('message (the instruction to send) is empty.');
    const state = host.stateOf(child.id);
    const who = `"${nameOf(child)}"`;
    if (state === 'archived') throw new ToolError(`${who} is archived. To continue it, ask the user to restore it with "${t('sessions.sidebar.unarchive')}" in the session list.`);
    if (state === 'question') throw new ToolError(`${who} is waiting for an answer to a question. Answer it with answer_question (get_session shows the question).`);
    if (state === 'permission') throw new ToolError(`${who} is waiting for an answer to a permission prompt. Read it with get_session and answer it with answer_permission, or ask the user.`);
    if (state === 'waiting') throw new ToolError(`${who} is waiting for an operation in its terminal (the user needs to handle it).`);
    const text = parentMessageText(caller.id, message);
    // 手の空いている子には、すぐ打つ
    if (state === 'idle' || state === 'background') {
      await host.submitWhenReady(child.id, text, SEND_IDLE_TIMEOUT_MS);
      return json({ session_id: child.id, state: host.stateOf(child.id), note: 'Sent.' });
    }
    // 作業中・起動中・止まっている子は、手が空くまでアプリが預かってから打つ（作業中に打つと、そのあいだに出た許可の確認で、
    // Enter や数字が選択になってしまうことがあるため）。待たずに返す
    if (state === 'exited') await host.open(child.id);
    void host.submitWhenReady(child.id, text, SEND_TIMEOUT_MS).catch((error: unknown) => console.error('子セッションに指示を送れませんでした', error));
    return json({
      session_id: child.id,
      state: host.stateOf(child.id),
      note:
        state === 'exited'
          ? 'Restarted the child. The instruction will be sent as soon as it has started.'
          : 'The child is working, so the instruction will be sent as soon as it finishes its current work (queued).',
    });
  }

  private async answerQuestion(caller: SessionSummary, args: Record<string, unknown>): Promise<ToolResult> {
    const { host } = this.deps;
    const child = this.resolve(caller, args.session_id, true);
    const asked = stringArg(args.question);
    const choices = Array.isArray(args.choices) ? args.choices.filter((c): c is string => typeof c === 'string' && c.trim() !== '') : [];
    // 自由記述は子の画面に打つので、キー操作になる文字（ESC・改行など）を除き、1 行にする
    const other = stripControlChars(stringArg(args.other)).replace(/\s*\n\s*/g, ' ').trim();
    if (choices.length === 0 && !other) throw new ToolError('Pass choices (the options to pick) or other (a free-text answer).');
    const current = () => {
      const screen = host.screen(child.id);
      return screen?.state.kind === 'menu' ? screen.state.menu : null;
    };
    const menu = current();
    // 許可の確認には答えさせない（人だけが答える）
    if (menu?.kind === 'permission') throw new ToolError(`"${nameOf(child)}" is showing a permission prompt, not a question. Answer it with answer_permission (get_session shows it).`);
    if (menu?.kind !== 'question') throw new ToolError('No question is showing (the user answered it first, or it was withdrawn). Check with get_session.');
    // 質問と読めても、AskUserQuestion で出した質問でなければ答えない（コマンドの文字に ☐ があると、許可の確認が質問に見える）
    if (!isAskedQuestion(menu, host.askedQuestions(child.id))) {
      throw new ToolError(`"${nameOf(child)}" is not showing an AskUserQuestion question. The user answers it.`);
    }
    const same = (m: Menu | null) => m?.kind === 'question' && normalizeText(m.title) === normalizeText(menu.title);
    if (normalizeText(menu.title) !== normalizeText(asked)) {
      throw new ToolError(`The question showing now is "${menu.title}" (the user answered first, or it has moved on to the next question). To answer it, pass this question text as question.`);
    }
    const selectable = menu.options.filter(isChoice);
    const picked = choices.map((label) => {
      const option = selectable.find((o) => normalizeText(o.label) === normalizeText(label));
      if (!option) throw new ToolError(`There is no option "${label}". The options are: ${selectable.map((o) => `"${o.label}"`).join(', ')}.`);
      return option;
    });
    const textOption = menu.options.find((o) => o.textInput);
    if (other && !textOption) throw new ToolError('This question has no field for an answer that is not among the options (free text).');
    const changed = () => new ToolError('Could not answer because the question changed or the user acted on it while answering. Check with get_session.');
    // キーを送る前に毎回、同じ質問が出ているかを確かめる（途中で許可の確認などに変わったら、何も押さない）
    const choose = async (choice: ScreenChoice) => {
      if (!(await host.chooseIf(child.id, choice, (m) => same(m) && isAskedQuestion(m, host.askedQuestions(child.id))))) throw changed();
    };
    if (!menu.multiSelect) {
      if (picked.length + (other ? 1 : 0) !== 1) throw new ToolError('Only one option can be picked for this question (pass one choice, or only other).');
      const option = picked[0] ?? textOption!;
      await choose({ optionId: option.id, key: 'enter', text: other || undefined });
    } else {
      for (const option of picked) {
        if (current()?.options.find((o) => o.id === option.id)?.checked) continue;
        await choose({ optionId: option.id, key: 'space' });
        await sleep(300);
      }
      if (other && textOption) {
        // 複数選択の自由記述は、打つだけでチェックが付く（Enter だと外れる）
        await choose({ optionId: textOption.id, key: 'none', text: other });
        await sleep(300);
      }
      if (!current()?.options.some((o) => o.id === 'submit')) throw new ToolError('Could not find the option that submits the answers. Check the terminal.');
      await choose({ optionId: 'submit', key: 'enter' });
    }
    // 答えが受け付けられて、質問が閉じた（次の質問に進んだ）のを確かめる
    for (let i = 0; i < 20 && same(current()); i++) await sleep(100);
    if (same(current())) throw new ToolError('Sent the answer, but the question did not close. Check with get_session.');
    const next = await this.followUpQuestion(child.id, same);
    this.observe(caller.id, child.id);
    return json({
      answered: true,
      state: host.stateOf(child.id),
      next_question: next ? questionOf(next) : undefined,
      note: next ? 'The child is showing another question (next_question). Answer it now with answer_question, and keep going until the result has no next_question.' : undefined,
    });
  }

  // 答えたあと、子が続けて出す次の質問を、少しのあいだ待つ。出たら、その質問のメニューを返す。
  // 子は、決めることがいくつもあるとき、1 問ずつ別々の AskUserQuestion で聞くことが多い（「1/3」「2/3」…）。答えた直後の子は作業中でも、
  // 数秒で次の質問を出す。待たずに返すと、親は「作業中」と見て離れ、次の質問が、親がもう一度見に来るまで待たされる
  // （2026-10-12、3 問のうち 1 問ごとに、次の質問が 1 分以上待たされた）。
  // 子の手が空いた・人の操作待ちになった・終了したら、次の質問は来ないので、待つのをやめる
  private async followUpQuestion(id: string, same: (menu: Menu | null) => boolean): Promise<Menu | null> {
    const { host } = this.deps;
    const limit = this.deps.followUpMs ?? FOLLOW_UP_MS;
    const deadline = Date.now() + limit;
    for (;;) {
      const screen = host.screen(id);
      const menu = screen?.state.kind === 'menu' ? screen.state.menu : null;
      if (menu?.kind === 'question' && !same(menu)) return menu;
      const state = host.stateOf(id);
      if (state !== 'working' && state !== 'starting' && state !== 'question') return null;
      if (Date.now() >= deadline) return null;
      await sleep(Math.min(200, Math.max(1, limit / 5)));
    }
  }

  // 子が出している許可の確認に、親が答える。選ぶのは「今回だけ許す」（Yes）か「断る」（No）だけで、
  // 許可を覚えさせる選択肢・権限モードを変える選択肢は選ばない（permissionOf が、その 2 つの選択肢だけを見分ける）。
  // 答えるのは、親が get_session で読んだ確認（permission_id）が、そのまま出ているときだけ。キーを送る直前にも確かめ直す
  private async answerPermission(caller: SessionSummary, args: Record<string, unknown>): Promise<ToolResult> {
    const { host } = this.deps;
    const child = this.resolve(caller, args.session_id, true);
    const who = `"${nameOf(child)}"`;
    const id = stringArg(args.permission_id);
    if (!id) throw new ToolError('Pass permission_id (permission.id from get_session) to say which permission prompt you are answering.');
    if (args.decision !== 'allow' && args.decision !== 'deny') throw new ToolError('Pass decision as "allow" or "deny".');
    const allow = args.decision === 'allow';
    // 理由は子の入力欄に打つので、キー操作になる文字（ESC など）を除く
    const reason = stripControlChars(stringArg(args.reason)).trim();
    if (allow && reason) throw new ToolError('reason is only for decision "deny". To allow with a condition, allow it and then instruct the child with send_message.');
    const current = async () => {
      const screen = host.screen(child.id);
      const menu = screen?.state.kind === 'menu' ? screen.state.menu : null;
      return menu?.kind === 'permission' ? permissionOf(menu, host.pendingPermission(child.id), await host.conversation(child.id)) : null;
    };
    const shown = await current();
    if (!shown) throw new ToolError(`${who} is not showing a permission prompt that can be answered here (the user answered it first, or it is another kind of screen). Check with get_session.`);
    const changed = () => new ToolError('The permission prompt showing now is not the one you read (the user answered it, or the child moved on to another prompt). Nothing was answered. Read it again with get_session.');
    if (shown.id !== id) throw changed();
    if (allow) {
      // 親が自分の操作を人に毎回許してもらうモードなら、子の操作も親には許させない（子を通じて、人の確認を省かせない）
      const mode = host.modeOf(caller.id) ?? 'manual';
      if (!MODES_ALLOWING_PERMISSION.has(mode)) {
        throw new ToolError(`This session is in ${mode} mode, so it cannot allow a child's permission prompts (it can only deny them). Ask the user to answer it: show them exactly what the child wants to run.`);
      }
      if (shown.problem) throw new ToolError(`Cannot allow this prompt: ${shown.problem} Ask the user to answer it in the child session (you can still deny it).`);
    }
    const optionId = allow ? shown.allowOption : shown.denyOption;
    if (!optionId) throw new ToolError(`Could not tell which option ${allow ? 'allows this once' : 'denies it'} (the options are: ${shown.labels.map((l) => `"${l}"`).join(', ')}). Nothing was answered. Ask the user to answer it.`);
    // キーを送る直前に、同じ確認が出ているか確かめる（別の確認にすり替わっていたら、何も押さない）。
    // 会話は先に読んでおく（expect は同期で確かめるため）
    const events = await host.conversation(child.id);
    const same = (menu: Menu) => menu.kind === 'permission' && permissionOf(menu, host.pendingPermission(child.id), events).id === id;
    if (!(await host.chooseIf(child.id, { optionId, key: 'enter' }, same))) throw changed();
    // 答えが受け付けられて、確認が閉じた（次の確認に進んだ）のを確かめる
    let next = await current();
    for (let i = 0; i < 20 && next?.id === id; i++) {
      await sleep(100);
      next = await current();
    }
    if (next?.id === id) throw new ToolError('Sent the answer, but the permission prompt did not close. Check with get_session.');
    this.observe(caller.id, child.id);
    // 断った理由は、子の手が空いてから、親からの指示として送る（確認の画面には文字を打たない）。待たずに返す
    if (!allow && reason) {
      const what = shown.view.tool ? ` to use ${String(shown.view.tool)}` : '';
      const text = `The parent session denied your permission request${what}. Do not retry the same operation. Reason: ${reason}`;
      void host.submitWhenReady(child.id, parentMessageText(caller.id, text), SEND_TIMEOUT_MS).catch((error: unknown) => console.error('子セッションに断った理由を送れませんでした', error));
    }
    return json({
      session_id: child.id,
      answered: true,
      decision: allow ? 'allow' : 'deny',
      state: host.stateOf(child.id),
      note: allow
        ? 'Allowed this once. Nothing was remembered: the same operation will ask again.'
        : reason
          ? 'Denied. The reason will be sent to the child as an instruction as soon as it is idle.'
          : 'Denied. The child stops this operation and waits for an instruction: tell it what to do instead with send_message.',
      next_permission: next ? next.view : undefined,
    });
  }

  private async stopSession(caller: SessionSummary, args: Record<string, unknown>): Promise<ToolResult> {
    const { host } = this.deps;
    const child = this.resolve(caller, args.session_id, true);
    const state = host.stateOf(child.id);
    if (state === 'question' || state === 'permission' || state === 'waiting') {
      throw new ToolError(`"${nameOf(child)}" cannot be interrupted while it is ${SESSION_STATE_LABEL[state]}.`);
    }
    if (state !== 'working') {
      return json({ session_id: child.id, state, note: state === 'background' ? 'Its turn has finished, and it is waiting for background tasks to finish.' : 'It is not working.' });
    }
    // 止めて手が空いたことは、親に知らせない（親が止めたので）
    this.stopped.add(child.id);
    host.interrupt(child.id);
    // 応答の前に止めると、親の指示が子の入力欄に戻る。残すと次の指示を打てず、人の入力欄にも囲みのまま移るので消す
    await host.withdrawParentDraft(child.id);
    return json({ session_id: child.id, state: host.stateOf(child.id), note: 'Interrupted.' });
  }

  // 役目を終えた子を片付ける。アーカイブして、worktree の子なら worktree も消す（remove_worktree: false なら残す）。
  // 人の確認は出さない: アーカイブは一覧から戻せ、worktree を消しても、未コミットの変更は控えの ref に、手元にしか無いコミットはブランチに残る。
  // 手が空いている・終了している・裏のタスクの完了待ちの子だけ（裏のタスクは Claude Code と一緒に止まる）。
  // アーカイブ済みの子に呼んだら、残っている worktree を消す（何度呼んでも同じ結果になる）
  private async endSession(caller: SessionSummary, args: Record<string, unknown>): Promise<ToolResult> {
    const { host } = this.deps;
    const child = this.resolve(caller, args.session_id, true);
    if (args.remove_worktree !== undefined && typeof args.remove_worktree !== 'boolean') throw new ToolError('Pass remove_worktree as true or false.');
    const who = `"${nameOf(child)}"`;
    const check = () => {
      const state = host.stateOf(child.id) ?? 'exited';
      if (!ENDABLE_STATES.has(state)) throw new ToolError(`${who} ${END_REFUSAL[state] ?? `cannot be ended while it is ${SESSION_STATE_LABEL[state]}.`}`);
      return state;
    };
    const before = check();
    const removeWorktree = args.remove_worktree !== false && !!child.worktree;
    // PR の状態は GitHub に問い合わせるので、少しかかる。調べられなくても、片付けは続ける
    const leftovers = removeWorktree ? await host.worktreeLeftovers(child.id).catch(() => null) : null;
    // 調べている間に、子が動き出していないか（人が子に直接指示したなど）
    const state = check();
    const tasks = state === 'background' ? runningTasks(host, child.id) : [];
    let removal: WorktreeRemoval | null = null;
    let failure: string | null = null;
    try {
      removal = await this.deps.archive(child.id, { removeWorktree });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    // worktree を消せなかったときも、アーカイブは済んでいる。アーカイブもできていなければ、そのまま失敗として返す
    if (host.stateOf(child.id) !== 'archived') throw new ToolError(`Could not archive ${who}: ${failure ?? 'unknown error'}`);
    this.notices.remove(caller.id, child.id);
    this.stopped.delete(child.id);
    const alreadyArchived = before === 'archived';
    const notes = [alreadyArchived ? 'It was already archived.' : `Archived. The user can restore it with "${t('sessions.sidebar.unarchive')}" in the session list.`];
    if (tasks.length > 0) {
      notes.push(
        `Stopped its ${tasks.length} background ${tasks.length === 1 ? 'task' : 'tasks'} together with Claude Code. Processes it detached from Claude Code (for example with nohup or open) are not tracked and may still be running.`,
      );
    }
    let worktree: Record<string, unknown> | null = null;
    if (child.worktree) {
      const folder = !removeWorktree ? 'kept' : failure !== null ? 'not_removed' : leftovers && !leftovers.exists ? 'already_removed' : 'removed';
      worktree = {
        name: child.worktree.name,
        branch: child.worktree.branch,
        folder,
        ...(removal ? { branch_kept: removal.branchKept, backup_ref: removal.backupRef } : {}),
        ...(failure !== null ? { error: failure } : {}),
        ...(leftovers ? { unpushed_commits: leftovers.unpushed, pull_request: pullRequestOf(leftovers) } : {}),
      };
      if (!removeWorktree) notes.push('Kept its worktree (remove_worktree was false). Call end_session again without it to remove the worktree.');
      else if (failure !== null) notes.push('Could not remove its worktree (see worktree.error), so the folder and the branch are still there. Tell the user, or call end_session again once the cause is gone.');
      else if (folder === 'already_removed') notes.push('Its worktree folder was already gone.');
      else notes.push('Removed its worktree. If the user restores the session, the worktree is recreated.');
      if (removal?.backupRef) notes.push(`It had uncommitted changes or untracked files. They are saved as a commit at ${removal.backupRef} (gitignored files are not included).`);
      if (removal?.branchKept) notes.push(`Kept the branch ${removal.branch} because it has commits that exist only locally.`);
    } else if (args.remove_worktree === true) {
      notes.push('It has no worktree, so no folder was removed.');
    }
    return json({
      session_id: child.id,
      name: nameOf(child),
      archived: true,
      already_archived: alreadyArchived,
      ...(tasks.length > 0 ? { stopped_background_tasks: tasks } : {}),
      worktree,
      note: notes.join(' '),
    });
  }

  // --- 親への知らせ ---

  // 子が作業中から手の空いた状態になったら、親に知らせる（親が待っていなくても）。
  // 親が子に出した指示の作業だけ（人が子に直接出した指示の作業では、親を起こさない）。親の手が空いたら送るのは SessionNotices
  private stateChanged(id: string): void {
    const state = this.deps.host.stateOf(id);
    const before = this.lastState.get(id);
    this.lastState.set(id, state);
    const parentId = this.deps.host.parentOf(id);
    // 子がまた動き出したら、まだ送っていない知らせは取り下げる。最適化圧縮の流れ（仕上げ・再開のターン）で作業中に見えているだけなら、
    // 取り下げない（ターンの終わりの自動の切り替えは、子が作業を終えた直後に始まる。親が忙しくて、まだ送れていない知らせが消える）
    // 流れは、再開の文のターンが始まったところで終わる。そのターン（「引き継ぎました」の報告）が終わるまでも、同じ扱いにする
    if (this.deps.compacting?.(id)) this.compacted.add(id);
    const busy = !!state && isBusy(state);
    if (parentId && busy && !this.compacted.has(id)) this.notices.remove(parentId, id);
    if (!busy) this.compacted.delete(id);
    // 作業していた子のターンが終わったとき（起動中から手が空いたのは、作業を終えたのではない。アプリを起動し直して引き継いだときなど）
    if (parentId && before === 'working' && state && NOTIFY_STATES.has(state)) void this.queueNotice(id, parentId, state);
  }

  private async queueNotice(childId: string, parentId: string, state: SessionState): Promise<void> {
    const at = Date.now();
    if (this.stopped.delete(childId)) return;
    const events = await this.deps.host.conversation(childId);
    // /clear のあとの会話だけを見る（最後の指示が親のものでも、/clear で会話を始め直していれば、親の作業ではない）。
    // 最適化圧縮の切り替え（アプリが打った /clear）は、区切りにしない（会話を消しても、だれの作業かは変わらない。手動も自動も同じ）
    const reset = lastOf(events, (e): e is Extract<ChatEvent, { type: 'reset' }> => e.type === 'reset' && !e.compact);
    const after = reset ? events.slice(events.lastIndexOf(reset) + 1) : events;
    // アプリが打った /clear（新しい会話に、コマンドの発言として残る）は、人の発言に数えない
    const user = lastOf(withoutCompaction(after), isUser);
    // アプリを起動し直したあとは、切り替える前の会話が手元に無い。再開の文に入っている発言の原文で見分ける
    const fromParent = user ? user.parent === parentId : (carriedMessages(after).at(-1)?.fromParent ?? false);
    if (!fromParent) return;
    // 切り替えのあとの「引き継ぎました」の報告で終わったターン（ターンの終わりの自動・手動）と、取りやめた仕上げのターンは、
    // 作業の終わりではない（作業の終わりは、切り替える前に知らせてある）。途中で止めて続きを進めたターンの終わりは、作業の終わり
    const last = [...after].reverse().find(startsTurn);
    if (last?.type === 'notice' && last.compact && !compactMidTurn(detailOf(last))) return;
    this.notices.add(parentId, childId, { state, at });
  }

  // 続けて手が空いた子の知らせを、1 つにまとめた文。親がもう読んだ出来事は除く
  private noticeFor(parentId: string, queue: Map<string, { state: SessionState; at: number }>): string | null {
    const all = this.deps.host.list();
    const notices = [...queue].filter(([child, event]) => (this.observedAt.get(`${parentId}:${child}`) ?? 0) < event.at);
    if (notices.length === 0) return null;
    const message = [...notices.map(([child, event]) => noticeText(all.find((s) => s.id === child), child, event.state)), t('tools.notice.checkSessions')].join(' ');
    return sessionEventText(notices.map(([child]) => child), message);
  }

  private observe(parentId: string, childId: string): void {
    // 最適化圧縮の流れの途中に読んだのは、「作業中」の状態。手が空いたことは、まだ読んでいない（そのあとの知らせを止めない）
    if (this.deps.compacting?.(childId)) return;
    this.observedAt.set(`${parentId}:${childId}`, Date.now());
  }

  // --- 補助 ---

  private summary(id: string): SessionSummary | undefined {
    return this.deps.host.list().find((s) => s.id === id);
  }

  private visible(caller: SessionSummary): SessionSummary[] {
    return this.deps.host.list().filter((s) => canSee(caller, s));
  }

  // session_id（全体か、先頭 8 文字以上）を、見えるセッションに解決する。child: 自分の子セッションに限る
  private resolve(caller: SessionSummary, raw: unknown, child = false): SessionSummary {
    const id = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (id.length < 8) throw new ToolError('Pass a session ID (at least its first 8 characters) as session_id.');
    const matches = this.visible(caller).filter((s) => s.id.startsWith(id));
    if (matches.length === 0) throw new ToolError(`No visible session has the ID ${id} (check with list_sessions).`);
    if (matches.length > 1) throw new ToolError(`More than one session has an ID starting with ${id}. Pass a longer ID.`);
    const target = matches[0];
    if (child && target.parentId !== caller.id) {
      throw new ToolError(`"${nameOf(target)}" is not a child session of this session. You can only instruct children you started with start_session.`);
    }
    return target;
  }

  // このプロファイルが覚えているフォルダ（新規セッションの画面の「最近のフォルダ」の元。アーカイブしたセッションのものも）。
  // 新しい順。worktree のセッションは元のフォルダ
  private knownFolders(): string[] {
    const sessions = [...this.deps.host.list()].sort((a, b) => b.updatedAt - a.updatedAt);
    return [...new Set(sessions.map((s) => projectRootOf(s)))];
  }

  // セッションを始めるフォルダ。省けば、このセッションのリポジトリのフォルダ。
  // 選べるのは、このセッションのリポジトリの中か、このプロファイルのセッションのフォルダだけ（人が開いたことのない場所で Claude Code を動かさせない）。
  // 別のリポジトリのフォルダも選べるが、そこの会話が読めるようにはならない（見える範囲は canSee のまま）。
  // シンボリックリンクは解いてから比べる（リポジトリの中のリンクから、外のフォルダで始めさせない）
  private async folderFor(caller: SessionSummary, raw: unknown, worktree: boolean): Promise<string> {
    const root = projectRootOf(caller);
    const given = stringArg(raw);
    if (given && !isAbsolute(given)) throw new ToolError('Pass folder as an absolute path.');
    const real = (path: string) => realpath(path).catch(() => null);
    let folder = await real(given ? normalize(given) : root);
    if (!folder) throw new ToolError(`Folder not found: ${given || root}`);
    const realRoot = (await real(root)) ?? root;
    const inside = folder === realRoot || (realRoot !== this.deps.home && realRoot !== '/' && folder.startsWith(`${realRoot}/`));
    const known = inside
      ? true
      : (await Promise.all(this.deps.host.list().flatMap((s) => [real(s.cwd), real(projectRootOf(s))]))).includes(folder);
    if (!known) {
      throw new ToolError(
        `Cannot start in ${given}. Only a folder inside this session's repository (${root}) or a folder of another tanacode session (start_folders of list_sessions) can be chosen.`,
      );
    }
    const isDirectory = await stat(folder).then(
      (s) => s.isDirectory(),
      () => false,
    );
    if (!isDirectory) throw new ToolError(`Not a folder: ${folder}`);
    // worktree の中から worktree を作ると入れ子になるので、元のフォルダから作る
    if (worktree) folder = projectRootOf({ cwd: folder });
    return folder;
  }

  private describe(s: SessionSummary, caller: SessionSummary): Record<string, unknown> {
    const state = this.deps.host.stateOf(s.id) ?? 'exited';
    return {
      id: s.id,
      name: nameOf(s),
      relation: relationOf(s, caller),
      state,
      state_label: SESSION_STATE_LABEL[state],
      folder: s.cwd,
      worktree: s.worktree ? { name: s.worktree.name, branch: s.worktree.branch } : null,
      parent_id: s.parentId ?? null,
    };
  }

  private headerLines(target: SessionSummary, caller: SessionSummary, all: SessionSummary[]): string[] {
    const state = this.deps.host.stateOf(target.id) ?? 'exited';
    // all は、呼び出し元から見えるセッション（見えない子の名前や ID は出さない）
    const parent = target.parentId ? all.find((s) => s.id === target.parentId) : undefined;
    const children = all.filter((s) => s.parentId === target.id);
    const label = (s: SessionSummary) => `"${nameOf(s)}" (${s.id.slice(0, 8)}, ${SESSION_STATE_LABEL[this.deps.host.stateOf(s.id) ?? 'exited']})`;
    return [
      `- ID: ${target.id}`,
      `- Relation: ${RELATION_LABEL[relationOf(target, caller)]}`,
      `- State: ${SESSION_STATE_LABEL[state]} (${state})`,
      `- Folder: ${target.cwd}`,
      ...(target.worktree ? [`- Worktree: ${target.worktree.name} (branch ${target.worktree.branch})`] : []),
      ...(parent ? [`- Parent: ${label(parent)}`] : []),
      ...(children.length > 0 ? [`- Children: ${children.map(label).join(', ')}`] : []),
    ];
  }

  // get_session・wait_sessions で返す 1 つのセッションの状態。detail: 最後の応答と質問も入れる
  private async status(s: SessionSummary, caller: SessionSummary, detail: boolean): Promise<Record<string, unknown>> {
    const base = this.describe(s, caller);
    if (!detail) return base;
    const all = await this.deps.host.conversation(s.id);
    // 最適化圧縮の仕上げの頼み・再開の文と、その返事（「リストを更新しました」「引き継ぎました」）は、指示と作業の応答に数えない
    const events = withoutCompaction(all, this.deps.compacting?.(s.id) ?? false);
    const prompt = lastOf(events, isPrompt);
    const promptAt = prompt ? events.lastIndexOf(prompt) : -1;
    // 作業の結果を返す。チェックリストを直した報告しか無ければ、それを返す
    const { work, notes } = responsesOf(events.slice(promptAt + 1));
    // アプリを起動し直したあとは、切り替える前の会話が手元に無い。再開の文に入っている、最後の発言と最後の応答で補う
    const resume = prompt ? undefined : lastOf(all, isResume);
    const carried = resume ? carriedMessages([resume]).at(-1) : undefined;
    const lastPrompt: Prompt | undefined = prompt ?? (carried ? { type: 'user', id: '', text: carried.text, ...(carried.fromParent && s.parentId ? { parent: s.parentId } : {}) } : undefined);
    const response = work[work.length - 1] ?? notes[notes.length - 1] ?? (resume ? (lastReplyIn(detailOf(resume)) ?? undefined) : undefined);
    const screen = this.deps.host.screen(s.id);
    const menu = screen?.state.kind === 'menu' ? screen.state.menu : null;
    return {
      ...base,
      last_prompt: lastPrompt
        ? { from: lastPrompt.type === 'notice' ? 'notice' : lastPrompt.parent ? (s.parentId ? 'parent' : 'session') : 'human', text: clip(lastPrompt.text, 1000) }
        : null,
      last_response: response ? clip(response, 4000) : null,
      question: base.state === 'question' && menu?.kind === 'question' ? questionOf(menu) : undefined,
      permission: base.state === 'permission' && menu?.kind === 'permission' ? permissionOf(menu, this.deps.host.pendingPermission(s.id), all).view : undefined,
    };
  }

  // cond が真になるか、timeoutMs が過ぎるか、取り消されるまで待つ。状態の変化を見て、取りこぼしに備えて 1 秒ごとにも確かめる
  private until(cond: () => boolean, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolveWait) => {
      const finish = () => {
        clearTimeout(timer);
        clearInterval(poll);
        unwatch();
        signal?.removeEventListener('abort', finish);
        resolveWait();
      };
      const check = () => cond() && finish();
      const timer = setTimeout(finish, timeoutMs);
      const poll = setInterval(check, 1000);
      const unwatch = this.deps.host.watchState(check);
      if (signal?.aborted) finish();
      else signal?.addEventListener('abort', finish, { once: true });
    });
  }
}

const RELATION_LABEL = {
  self: 'this session',
  parent: 'the parent of this session',
  child: 'a child of this session',
  sibling: 'a sibling (a child of the same parent)',
  project: 'a session in the same repository',
} as const;

function relationOf(s: SessionSummary, caller: SessionSummary): keyof typeof RELATION_LABEL {
  if (s.id === caller.id) return 'self';
  if (s.id === caller.parentId) return 'parent';
  if (s.parentId === caller.id) return 'child';
  if (caller.parentId && s.parentId === caller.parentId) return 'sibling';
  return 'project';
}

// 動いている裏のタスク（一覧の数え方と同じ: SessionManager の countBackground）
function runningTasks(host: SessionsHost, id: string): { kind: string; name: string }[] {
  return [
    ...host.bashTasks(id).filter((task) => task.state === 'running').map((task) => ({ kind: 'bash', name: clip(task.description || task.command, 200) })),
    ...host.subagents(id).filter((run) => run.background && run.state === 'running').map((run) => ({ kind: 'subagent', name: clip(run.description ?? '', 200) })),
    ...host.workflows(id).filter((run) => run.status === 'running').map((run) => ({ kind: 'workflow', name: clip(run.name, 200) })),
  ];
}

function pullRequestOf(leftovers: WorktreeLeftovers): Record<string, unknown> {
  const { pr } = leftovers;
  if (pr.state === 'none' || pr.state === 'unknown') return { state: pr.state };
  return { state: pr.state, number: pr.number, base: pr.base, url: pr.url };
}

const KIND_MARK = { added: 'A', modified: 'M', deleted: 'D' } as const;

// 名前の無いセッションは、画面の一覧と同じ名前（画面の言語）にする。Claude が利用者に伝える名前が、一覧の名前と合うように
function nameOf(s: SessionSummary | undefined): string {
  return s?.title ?? t('main.session.untitled');
}

// 親への知らせの文。チャットに知らせとして出るので、画面の言語で書く
function noticeText(child: SessionSummary | undefined, id: string, state: SessionState): string {
  const params = { name: child?.title ?? t('tools.notice.untitledSession'), id: id.slice(0, 8) };
  if (state === 'question') return t('tools.notice.childQuestion', params);
  // 子セッションは人に通知しないので、親から人に伝える
  if (state === 'permission') return t('tools.notice.childPermission', params);
  if (state === 'waiting') return t('tools.notice.childWaiting', params);
  if (state === 'exited') return t('tools.notice.childExited', params);
  return t('tools.notice.childDone', params);
}

// 許可の確認の選択肢のうち、「今回だけ許す」と「断る」。名前がちょうど Yes・No のものだけ（「Yes, and don't ask again …」のように
// 許可を覚えさせるもの・権限モードを変えるものは、名前が Yes で終わらないので選ばれない）。断るほうは「No, and tell Claude …」の形も。
// どちらも、ちょうど 1 つのときだけ決める（見分けられないメニューには答えない）
function permissionOptions(menu: Menu): { allow: string | null; deny: string | null } {
  const one = (match: (label: string) => boolean) => {
    const found = menu.options.filter((o) => !o.textInput && match(normalizeText(o.label)));
    return found.length === 1 ? found[0].id : null;
  };
  return { allow: one((label) => /^yes$/i.test(label)), deny: one((label) => /^no$/i.test(label) || /^no, /i.test(label)) };
}

// 画面の確認が、フックの入力と同じものを指しているか（画面に出ている範囲で確かめる）。Bash はコマンドのはじめか終わりが、
// ファイルを書き換えるツールはファイルの名前が、画面に出ている。ほかのツールは、画面からは確かめない
function shownOnScreen(menu: Menu, request: PermissionRequest): boolean {
  const squash = (text: string) => text.replace(/\s+/g, '');
  const screen = squash([menu.title, ...menu.context].join(' '));
  const { input } = request;
  if (request.tool === 'Bash' && typeof input.command === 'string') {
    const command = squash(input.command);
    return command !== '' && (screen.includes(command.slice(0, 40)) || screen.includes(command.slice(-40)));
  }
  const file = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : null;
  if (file) return screen.includes(squash(basename(file)));
  return true;
}

// 会話に、まだ結果の出ていない同じツールの呼び出しがあるか（答え終えた確認の入力が残っているだけでないことを確かめる）。
// サブエージェントの中の呼び出しは、この会話には出ないので確かめられない
function pendingInConversation(events: ChatEvent[], request: PermissionRequest): boolean {
  const done = new Set<string>();
  for (const e of events) if (e.type === 'tool-result') done.add(e.id);
  const { input } = request;
  const file = typeof input.file_path === 'string' ? input.file_path : null;
  const head = (request.tool === 'Bash' && typeof input.command === 'string' ? input.command : JSON.stringify(input, null, 2)).slice(0, 200);
  return events.some((e) => e.type === 'tool-use' && !done.has(e.id) && e.name === request.tool && (file ? e.filePath === file : e.input.includes(head)));
}

// 今出ている許可の確認を、親に渡す形にする。
// id: この確認の目印（メニューの文と、フックの入力と、受け取った順番から作る。違う確認は、見た目が同じでも違う ID になる）。
// 選択肢の名前は入れない（カーソルを動かすと、折り返した名前の読み取りが変わることがあり、選んでいる途中で別の確認に見えてしまう）。
// problem: 親に許させない理由（全文を渡せない・今の確認のものと確かめられない）。あっても、断ることはできる
function permissionOf(
  menu: Menu,
  request: PermissionRequest | null,
  events: ChatEvent[],
): { id: string; view: Record<string, unknown>; problem: string | null; allowOption: string | null; denyOption: string | null; labels: string[] } {
  const options = permissionOptions(menu);
  const labels = menu.options.map((o) => o.label);
  const full = request ? JSON.stringify(request.input, null, 2) : '';
  let problem: string | null = null;
  if (!request) problem = 'tanacode could not capture what this prompt asks to run, so you cannot read all of it.';
  else if (!shownOnScreen(menu, request)) problem = 'the prompt on the screen does not match the tool input tanacode captured, so it may be about something else.';
  else if (request.agent === null && !pendingInConversation(events, request)) problem = "the tool input tanacode captured is not a pending tool call in the child's conversation, so it may belong to an earlier prompt.";
  else if (full.length > MAX_PERMISSION_INPUT_CHARS) problem = `the tool input is too long to show in full (${full.length} characters), so you cannot read all of it.`;
  else if (!options.allow) problem = 'tanacode could not tell which option allows it only this once.';
  // 画面と合わない・前の確認のものかもしれない入力は、親に見せない（別の操作を読んで判断させないため）
  const trusted = request !== null && (problem === null || full.length > MAX_PERMISSION_INPUT_CHARS || !options.allow) ? request : null;
  const id = createHash('sha256')
    .update(JSON.stringify([menu.title, menu.context, request ? [request.seq, request.tool, full] : null]))
    .digest('hex')
    .slice(0, 12);
  return {
    id,
    problem,
    allowOption: options.allow,
    denyOption: options.deny,
    labels,
    view: {
      id,
      title: menu.title,
      context: menu.context.slice(0, 12),
      ...(trusted
        ? {
            tool: trusted.tool,
            input: full.length > MAX_PERMISSION_INPUT_CHARS ? `${full.slice(0, MAX_PERMISSION_INPUT_CHARS)}\n…(truncated)` : trusted.input,
            from_subagent: trusted.agent ?? undefined,
          }
        : {}),
      can_allow: problem === null,
      cannot_allow_reason: problem ?? undefined,
      can_deny: options.deny !== null,
    },
  };
}

// 質問の選択肢そのもの（自由記述・確定・Chat about this 以外）
function isChoice(option: MenuOption): boolean {
  return !option.textInput && option.id !== 'submit' && option.label !== 'Chat about this';
}

function questionOf(menu: Menu): Record<string, unknown> {
  return {
    title: menu.title,
    multi_select: menu.multiSelect,
    tabs: menu.tabs.length > 1 ? menu.tabs.map((t) => ({ label: t.label, answered: t.answered })) : undefined,
    options: menu.options.filter(isChoice).map((o) => ({ label: o.label, description: o.description || undefined, checked: o.checked ?? undefined })),
    accepts_other: menu.options.some((o) => o.textInput),
  };
}

// 会話を、新しいほうから turns 回分の指示とその応答にまとめる（長い応答は途中を省く）。
// parentId: そのセッションの親。親のないセッションへの指示（独立したセッションの最初の指示）は、親からの指示と書かない
function conversationLines(events: ChatEvent[], turns: number, titleOf: (id: string) => string, parentId: string | null = null): string[] {
  // notes: チェックリストの知らせにターンの終わりを止められたあとの応答（チェックリストを直した報告）
  type Turn = { who: string; text: string; responses: string[]; notes: string[]; tools: string[] };
  let all: Turn[] = [];
  let current: Turn | null = null;
  let stopped = false;
  // 最適化圧縮の仕上げのターン（頼みと、「リストを更新しました」の返事）。そのあと切り替えたら、出さない。
  // 取りやめになったときは出す（Claude が頼みに従わず、そのターンで元の作業を続けることがある）
  let handoff: Turn | null = null;
  // アプリが /clear を打って、まだ再開の文を送っていない
  let cleared = false;
  for (const e of events) {
    if (startsTurn(e)) stopped = false;
    if (e.type === 'reset') {
      // 最適化圧縮の切り替えでは、前のターンも残す（下の知らせの 1 行を挟む）。仕上げのターンと、アプリが打った /clear は出さない
      if (e.compact) {
        const dropped = handoff;
        all = all.filter((turn) => turn !== dropped);
        handoff = null;
        current = null;
        cleared = true;
        continue;
      }
      // /clear で会話を始め直した
      all = [];
      current = null;
    } else if (cleared && e.type === 'user' && e.command) {
      current = null;
    } else if (e.type === 'notice' && e.compact === 'handoff') {
      const auto = autoPercentOf(detailOf(e));
      current = {
        who: 'Notice',
        text: `tanacode asked this session to bring its checklists up to date for an optimized compaction${auto === null ? '' : ` (automatic at ${auto}% of the context)`}. The conversation was not reset after this: the compaction was cancelled, or is still in progress.`,
        responses: [],
        notes: [],
        tools: [],
      };
      handoff = current;
      all.push(current);
    } else if (e.type === 'notice' && e.compact === 'resume') {
      // 再開の文は長いので、切り替えたことだけを書く
      cleared = false;
      const auto = autoPercentOf(detailOf(e));
      const text = [
        `tanacode reset the conversation of this session and resumed it from its checklists (optimized compaction${auto === null ? '' : `, automatic at ${auto}% of the context`}).`,
        compactMidTurn(detailOf(e))
          ? 'The reset was made in the middle of a turn, and the session then continued the same work: what follows is the rest of that work.'
          : 'What follows is its report of what it carried over, not a result of its work.',
      ].join(' ');
      current = { who: 'Notice', text, responses: [], notes: [], tools: [] };
      all.push(current);
    } else if (e.type === 'user') {
      const from = parentId ? 'the parent session' : 'the session that started this one,';
      current = { who: e.parent ? `Instruction from ${from} "${titleOf(e.parent)}"` : 'User message', text: [e.text, ...(e.pastes ?? [])].filter(Boolean).join('\n\n'), responses: [], notes: [], tools: [] };
      all.push(current);
    } else if (e.type === 'notice') {
      current = { who: 'Notice', text: e.text, responses: [], notes: [], tools: [] };
      all.push(current);
    } else if (e.type === 'checklist-stop') {
      stopped = true;
    } else if (e.type === 'assistant-text' && current) {
      (stopped ? current.notes : current.responses).push(e.text);
    } else if (e.type === 'tool-use' && current) {
      current.tools.push(e.target ? `${e.name} ${e.target}` : e.name);
    }
  }
  if (all.length === 0) return ['## Recent conversation', '(no conversation yet)'];
  const shown = all.slice(-turns);
  const lines = [`## Recent conversation (the latest ${shown.length} of ${all.length} ${all.length === 1 ? 'instruction' : 'instructions'})`];
  shown.forEach((turn, i) => {
    lines.push('', `### ${all.length - shown.length + i + 1}. ${turn.who}`, clip(turn.text, 3000));
    if (turn.responses.length > 0) {
      // 最後の応答（結果のまとめ）は長めに、途中の応答は短く
      const responses = turn.responses.map((r, j) => clip(r, j === turn.responses.length - 1 ? 4000 : 600));
      lines.push('', 'Claude:', responses.join('\n\n'));
    }
    // 結果のまとめのあとに続くので、結果と取り違えないように分けて、短く出す
    if (turn.notes.length > 0) lines.push('', 'Claude, after tanacode reminded it to update its checklists at the end of the turn:', clip(turn.notes.join('\n\n'), 600));
    if (turn.tools.length > 0) {
      const tools = turn.tools.slice(0, 30).join(', ');
      lines.push('', `Tools: ${tools}${turn.tools.length > 30 ? ` and ${turn.tools.length - 30} more` : ''}`);
    }
  });
  return lines;
}

// 会話の中で編集したファイル（フォルダからの相対。外のものは絶対パスのまま）
function editedFiles(events: ChatEvent[], cwd: string): string[] {
  const files = new Set<string>();
  for (const e of events) {
    if (e.type === 'reset' && !e.compact) files.clear();
    if (e.type !== 'tool-use' || !EDIT_TOOLS.has(e.name) || !e.filePath) continue;
    const rel = relative(cwd, e.filePath);
    // .. そのものか ../ で始まるものが外（..env.local のような名前のファイルは中）
    files.add(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? rel : e.filePath);
  }
  return [...files].slice(0, 200);
}

async function branchOf(s: SessionSummary): Promise<string | null> {
  if (!existsSync(s.cwd)) return s.worktree?.branch ?? null;
  return git(s.cwd, ['symbolic-ref', '--short', '-q', 'HEAD']).then(
    (out) => out.trim() || null,
    () => s.worktree?.branch ?? null,
  );
}

// 未追跡のファイルを、新しいファイルの差分の形にする（大きいもの・バイナリは中身を出さない）。
// ふつうのファイルだけを読む（シンボリックリンクの先・デバイス・名前付きパイプは読まない）。読む大きさにも上限を付ける
async function untrackedDiff(cwd: string, file: string): Promise<string> {
  const head = `diff --git a/${file} b/${file}\nnew file (untracked)\n--- /dev/null\n+++ b/${file}`;
  const info = await lstat(join(cwd, file)).catch(() => null);
  if (!info) return head;
  if (info.isSymbolicLink()) return `${head}\n(symbolic link; contents not read)`;
  if (!info.isFile()) return `${head}\n(not a regular file; contents not read)`;
  if (info.size > MAX_UNTRACKED_BYTES) return `${head}\n(large file of ${Math.round(info.size / 1024)} KB; contents omitted)`;
  const data = await readHead(join(cwd, file), MAX_UNTRACKED_BYTES);
  // 空のファイルは、行の無い新しいファイル（git diff と同じく @@ の行を書かない）
  if (!data || data.length === 0) return head;
  if (data.includes(0)) return `${head}\n(binary)`;
  const lines = data.toString('utf8').replace(/\n$/, '').split('\n');
  return `${head}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}`;
}

// ファイルの先頭から、limit バイトまで読む（読めなければ null）
async function readHead(path: string, limit: number): Promise<Buffer | null> {
  const handle = await open(path, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, limit, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

// AskUserQuestion で出した質問か（質問文がフックの書いた質問のどれかに合う。複数の質問の最後の、回答の確認の画面も）
function isAskedQuestion(menu: Menu, asked: AskQuestion[] | null): boolean {
  if (!asked || asked.length === 0) return false;
  const title = normalizeText(menu.title);
  if (!title) return false;
  if (/submit your answers/i.test(title) && menu.tabs.length > 1) return true;
  return asked.some((q) => {
    const question = normalizeText(q.question);
    return !!question && (title.startsWith(question.slice(0, 30)) || question.startsWith(title.slice(0, 30)));
  });
}

// フォルダの外を指さない相対パスにする
function safeRelative(path: string): string {
  const rel = normalize(path).replace(/\/+$/, '');
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new ToolError('Pass path as a path relative to the session folder.');
  return rel === '.' ? '' : rel;
}

// 中身の最も長いバッククォートの連続より長いフェンスで囲む（中身の ``` でブロックから抜けないように）
function fence(content: string, lang: string): string {
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));
  const mark = '`'.repeat(Math.max(3, longest + 1));
  return `${mark}${lang}\n${content}\n${mark}`;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const omitted = text.length - max;
  return `${text.slice(0, head)}\n…(${omitted} ${omitted === 1 ? 'character' : 'characters'} omitted)…\n${text.slice(text.length - (max - head))}`;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function stringArg(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function intArg(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

function json(value: unknown): ToolResult {
  return textResult(JSON.stringify(value, null, 2));
}

function lastOf<T, S extends T>(list: T[], match: (item: T) => item is S): S | undefined {
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i];
    if (match(item)) return item;
  }
  return undefined;
}

type Prompt = Extract<ChatEvent, { type: 'user' | 'notice' }>;
const isPrompt = (e: ChatEvent): e is Prompt => e.type === 'user' || e.type === 'notice';
const isUser = (e: ChatEvent): e is Extract<ChatEvent, { type: 'user' }> => e.type === 'user';
// 知らせの全文（最適化圧縮の仕上げの頼み・再開の文）
const detailOf = (e: Extract<ChatEvent, { type: 'notice' }>): string => e.detail ?? '';
const isResume = (e: ChatEvent): e is Extract<ChatEvent, { type: 'notice' }> => e.type === 'notice' && e.compact === 'resume';
// ターンのはじまり（発言・知らせ・別の Claude からの知らせ）
const startsTurn = (e: ChatEvent): boolean => e.type === 'user' || e.type === 'notice' || e.type === 'turn-start';

// 応答を、作業の応答（work）と、チェックリストを直した報告（notes）に分ける。
// チェックリストを使い続けさせるフック（checklist-hook.ts）がターンの終わりを止めると、Claude はリストを直して 1 行で報告する。
// それは作業の結果ではないので、ほかのセッションに「最後の応答」として返さない。次のターンのはじまりで、作業の応答に戻る
function responsesOf(events: ChatEvent[]): { work: string[]; notes: string[] } {
  const work: string[] = [];
  const notes: string[] = [];
  let stopped = false;
  for (const e of events) {
    if (startsTurn(e)) stopped = false;
    else if (e.type === 'checklist-stop') stopped = true;
    else if (e.type === 'assistant-text') (stopped ? notes : work).push(e.text);
  }
  return { work, notes };
}

// 会話から、最適化圧縮のぶんを除く。仕上げの頼みと再開の文（知らせ）と、その返事。
// - 途中で止めて続きを進めた切り替えでは、再開のあとの応答は作業の続きなので残す（切り替える前の指示の応答として読める）
// - 仕上げのターンの応答は、そのあと会話を消した（切り替えた）ときだけ除く。取りやめになったときは残す。
//   Claude が仕上げの頼みに従わず、そのターンで元の作業を続けることがある（実機の Haiku 5.5 で起きた。除くと、作業の結果が読めない）
// flowing: 流れが進んでいる途中（最後の仕上げのターンは、まだ取りやめと決まっていないので除く）
function withoutCompaction(events: ChatEvent[], flowing = false): ChatEvent[] {
  const kept: ChatEvent[] = [];
  let skipping = false;
  // アプリが /clear を打って、まだ再開の文を送っていない（新しい会話に残る /clear のコマンドの発言を除く）
  let cleared = false;
  // 仕上げのターンのイベント（切り替えたら捨て、取りやめなら残す）
  let handoff: ChatEvent[] | null = null;
  for (const e of events) {
    if (e.type === 'reset' && e.compact) {
      cleared = true;
      handoff = null;
      continue;
    }
    if (e.type === 'notice' && e.compact) {
      cleared = false;
      if (handoff) kept.push(...handoff);
      handoff = e.compact === 'handoff' ? [] : null;
      skipping = e.compact === 'resume' && !compactMidTurn(detailOf(e));
      continue;
    }
    if (cleared && e.type === 'user' && e.command) continue;
    if (startsTurn(e)) {
      skipping = false;
      if (handoff) kept.push(...handoff);
      handoff = null;
    }
    if (handoff) handoff.push(e);
    else if (!skipping) kept.push(e);
  }
  if (handoff && !flowing) kept.push(...handoff);
  return kept;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// テストで使う
export const testing = { conversationLines, editedFiles, safeRelative, withoutCompaction };
