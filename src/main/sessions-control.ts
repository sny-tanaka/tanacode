import { lstat, open, realpath, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import type { ChatEvent } from '@shared/chat';
import type { NewSessionOptions, ScreenChoice, SessionSummary } from '@shared/ipc';
import { stripControlChars } from '@shared/prompt-keys';
import type { AskQuestion, Menu, MenuOption, PermissionMode, ScreenInfo } from '@shared/screen';
import {
  canSee,
  isBusy,
  modeWithin,
  parentMessageText,
  PERMISSION_MODES,
  projectRootOf,
  SESSION_STATE_LABEL,
  sessionEventText,
  sessionTool,
  type SessionState,
} from '@shared/session-tools';
import { branchBase, branchFiles, git, repoInfo } from './git';
import { textResult, type ToolResult } from './mcp-bridge';
import { WAIT_MAX_SECONDS } from './sessions-bridge';

// Claude による、ほかのセッションの扱い（MCP サーバー tanacode-sessions のツールの実行）。中継からの呼び出しを、ソケットで受けて答える。
// 呼び出し元のセッションは中継の env で渡ってくるので、親子の関係や見えるセッションは、アプリの記録（SessionSummary.parentId）で判断する。
// 読むだけのツールは、同じリポジトリのセッションと親子・兄弟だけを見せる（別のリポジトリの会話は読ませない）。
// 指示・中断・質問への答えは、自分の子セッションにだけ。許可の確認には答えさせない（親を通じて、権限を広げられないように）

// SessionManager のうち、ツールが使うもの
export type SessionsHost = {
  list(): SessionSummary[];
  // 親セッションの ID（無ければ null）。状態の変化のたびに呼ぶので、一覧を作らずに引く
  parentOf(id: string): string | null;
  stateOf(id: string): SessionState | null;
  modeOf(id: string): PermissionMode | null;
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
};

type Deps = {
  host: SessionsHost;
  // メニューの「Claude にほかのセッションを扱わせる」
  enabled: () => boolean;
  // ホームのフォルダ（ここを開いたセッションに、ホームの下のすべてのセッションを見せないため）
  home: string;
  // 親への知らせをまとめるまでの待ち（テストでは短くする）
  notifyDelayMs?: number;
};

// 子セッションの最初の指示を、起動（worktree の準備も含む）が終わるまで待つ上限
const FIRST_PROMPT_TIMEOUT_MS = 30 * 60_000;
// 子セッションへの指示を、子の手が空くまで預かる上限（作業中の子には、ターンが終わってから打つ）
const SEND_TIMEOUT_MS = 3 * 60 * 60_000;
// 手の空いている子に打つときの待ちの上限（すぐ打てるはず）
const SEND_IDLE_TIMEOUT_MS = 30_000;
// get_session_diff で、未追跡のファイルを読む数と、1 つのファイルから読む大きさの上限
const MAX_UNTRACKED_FILES = 100;
const MAX_UNTRACKED_BYTES = 256 * 1024;
// 親への知らせを、受け付けられるようになるまで待つ上限
const NOTIFY_TIMEOUT_MS = 10_000;
const NOTIFY_DELAY_MS = 1500;
// 1 回の結果の文字数の上限（親のコンテキストを食いつぶさないため）
const MAX_RESULT_CHARS = 60_000;
const WAIT_DEFAULT_SECONDS = 300;

// 編集したファイルとして数えるツール
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

// 親に知らせる、子の手が空いた状態（許可の確認・ターミナルでの操作は人が答えるので、知らせても親は動けない）。
// バックグラウンドのタスクの完了待ちも、ターンは終わっているので知らせる
const NOTIFY_STATES = new Set<SessionState>(['idle', 'background', 'question', 'exited']);
// 親が知らせを受け取れる状態（ターンの外）
const RECEIVE_STATES = new Set<SessionState>(['idle', 'background']);

class ToolError extends Error {}

export class SessionsControl {
  // 子セッションの、前に見た状態（作業中から手が空いたことを知るため）
  private readonly lastState = new Map<string, SessionState | null>();
  // 親に知らせる子の出来事（親の ID → 子の ID → 状態と時刻）。親の手が空いたら送る
  private readonly pending = new Map<string, Map<string, { state: SessionState; at: number }>>();
  // 親が子の状態を読んだ時刻（`親:子`）。読んだあとの知らせは送らない
  private readonly observedAt = new Map<string, number>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  // 親が止めた子。止めてターンが終わったことは、親に知らせない
  private readonly stopped = new Set<string>();
  private readonly unwatch: () => void;

  constructor(private readonly deps: Deps) {
    for (const s of deps.host.list()) this.lastState.set(s.id, deps.host.stateOf(s.id));
    this.unwatch = deps.host.watchState((id) => this.stateChanged(id));
  }

  dispose(): void {
    this.unwatch();
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
  }

  // signal: Claude Code が呼び出しを取り消した（Esc で中断した）。待っている wait_sessions をやめる
  async handle(callerId: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    if (!sessionTool(name)) return textResult(`知らないツールです: ${name}`, true);
    if (!this.deps.enabled()) {
      return textResult('ユーザーが tanacode のメニューで「Claude にほかのセッションを扱わせる」をオフにしています。使うには、ユーザーにオンにしてもらってください', true);
    }
    const caller = this.summary(callerId);
    if (!caller) return textResult('このセッションは tanacode にありません', true);
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
        case 'stop_session':
          return await this.stopSession(caller, args);
        default:
          return textResult(`知らないツールです: ${name}`, true);
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
    const lines = [`# セッション「${nameOf(target)}」`, ...this.headerLines(target, caller, all), ''];
    lines.push(...conversationLines(events, turns, titleOf), '');
    const edited = editedFiles(events, target.cwd);
    lines.push('## このセッションの会話で編集したファイル', ...(edited.length > 0 ? edited.map((f) => `- ${f}`) : ['（なし）']));
    return textResult(clip(lines.join('\n'), MAX_RESULT_CHARS));
  }

  private async sessionDiff(caller: SessionSummary, args: Record<string, unknown>): Promise<ToolResult> {
    const target = this.resolve(caller, args.session_id);
    this.observe(caller.id, target.id);
    const cwd = target.cwd;
    if (!existsSync(cwd)) throw new ToolError(`「${nameOf(target)}」のフォルダがありません（worktree を消したセッションなど）`);
    const path = typeof args.path === 'string' && args.path.trim() ? safeRelative(args.path.trim()) : null;
    const info = await repoInfo(cwd).catch(() => null);
    const inRepo = await git(cwd, ['rev-parse', '--is-inside-work-tree']).then(
      () => true,
      () => false,
    );
    if (!info || !inRepo) throw new ToolError(`「${nameOf(target)}」のフォルダは git のリポジトリではありません`);
    if (info.empty) throw new ToolError(`「${nameOf(target)}」のリポジトリには、まだコミットがありません`);
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
    if (untracked.length > added.length) added.push(`（ほかに未追跡のファイルが ${untracked.length - added.length} 件。path で絞ってください）`);
    const diff = [tracked.trimEnd(), ...added].filter(Boolean).join('\n');
    const lines = [
      `# セッション「${nameOf(target)}」のブランチの変更`,
      `- ブランチ: ${info.branch ?? '（ブランチなし）'}`,
      base ? `- 基点: ${base.ref}（分岐点 ${base.mergeBase.slice(0, 8)}）` : '- 基点: 分からないため、未コミットの変更だけ（HEAD との差分）',
      `- ファイル: ${files.length} 件${path ? `（${path} の中だけ）` : ''}`,
      ...files.map((f) => `  - ${KIND_MARK[f.kind]} ${f.path}${f.binary ? '（バイナリ）' : `（+${f.added} −${f.removed}）`}`),
      '',
      '## 差分',
      diff ? fence(diff, 'diff') : '（差分なし）',
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
        note: children.length > 0 ? '作業中の子セッションはありません' : '子セッションはありません',
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
    if (caller.parentId) throw new ToolError('子セッションは、さらに子セッションを作れません（親子は 1 段まで）');
    const prompt = stringArg(args.prompt);
    if (!prompt) throw new ToolError('prompt（最初の指示）が空です');
    if (typeof args.worktree !== 'boolean') throw new ToolError('worktree（新しい worktree に分けて始めるか）を true か false で渡してください');
    const folder = await this.folderFor(caller, args.folder, args.worktree);
    // 権限モードは、このセッションより強くできない（親を通じて、人が許していない操作を通さないため）
    const limit = host.modeOf(caller.id) ?? 'manual';
    const wanted = args.permission_mode === undefined ? (limit === 'plan' ? 'manual' : limit) : args.permission_mode;
    if (!PERMISSION_MODES.includes(wanted as PermissionMode)) throw new ToolError(`知らない権限モードです: ${String(wanted)}`);
    const mode = wanted as PermissionMode;
    if (!modeWithin(mode, limit)) throw new ToolError(`権限モード ${mode} は、このセッション（${limit}）より強いため使えません`);
    const options: NewSessionOptions = {
      model: stringArg(args.model) || null,
      effort: stringArg(args.effort) || null,
      // 登録した設定ファイル（別のアカウントなど）は、親と同じものを使う
      settingsFile: caller.settingsFile,
      mode,
      remoteControl: false,
      worktree: args.worktree,
    };
    const id = options.worktree ? await host.createInWorktree(folder, options, caller.id) : host.create(folder, options, caller.id);
    const name = stringArg(args.name);
    if (name) host.rename(id, name);
    this.lastState.set(id, host.stateOf(id));
    // 起動（worktree の準備も）が終わってから送る。待たずに返す（結果は wait_sessions で待つ）
    void host.submitWhenReady(id, parentMessageText(caller.id, prompt), FIRST_PROMPT_TIMEOUT_MS).catch((error: unknown) => {
      console.error('子セッションに最初の指示を送れませんでした', error);
    });
    const child = this.summary(id);
    return json({
      session_id: id,
      name: name || null,
      folder: child?.cwd ?? folder,
      worktree: child?.worktree ? { name: child.worktree.name, branch: child.worktree.branch } : null,
      permission_mode: mode,
      state: host.stateOf(id),
      note: '起動が終わりしだい、最初の指示を送ります。結果は wait_sessions で待ってください',
    });
  }

  private async sendMessage(caller: SessionSummary, args: Record<string, unknown>): Promise<ToolResult> {
    const { host } = this.deps;
    const child = this.resolve(caller, args.session_id, true);
    const message = stringArg(args.message);
    if (!message) throw new ToolError('message（送る指示）が空です');
    const state = host.stateOf(child.id);
    const who = `「${nameOf(child)}」`;
    if (state === 'archived') throw new ToolError(`${who}はアーカイブ済みです。続けるには、人に一覧から戻してもらってください`);
    if (state === 'question') throw new ToolError(`${who}は質問への回答を待っています。answer_question で答えてください（質問は get_session で見られます）`);
    if (state === 'permission') throw new ToolError(`${who}は実行の許可を待っています。許可の確認には人が答えます`);
    if (state === 'waiting') throw new ToolError(`${who}はターミナルでの操作を待っています（人の対応が要ります）`);
    const text = parentMessageText(caller.id, message);
    // 手の空いている子には、すぐ打つ
    if (state === 'idle' || state === 'background') {
      await host.submitWhenReady(child.id, text, SEND_IDLE_TIMEOUT_MS);
      return json({ session_id: child.id, state: host.stateOf(child.id), note: '送りました' });
    }
    // 作業中・起動中・止まっている子は、手が空くまでアプリが預かってから打つ（作業中に打つと、そのあいだに出た許可の確認で、
    // Enter や数字が選択になってしまうことがあるため）。待たずに返す
    if (state === 'exited') await host.open(child.id);
    void host.submitWhenReady(child.id, text, SEND_TIMEOUT_MS).catch((error: unknown) => console.error('子セッションに指示を送れませんでした', error));
    return json({
      session_id: child.id,
      state: host.stateOf(child.id),
      note: state === 'exited' ? '子を起動し直しました。起動が終わりしだい送ります' : '子は作業中なので、今の作業が終わりしだい送ります（順番待ち）',
    });
  }

  private async answerQuestion(caller: SessionSummary, args: Record<string, unknown>): Promise<ToolResult> {
    const { host } = this.deps;
    const child = this.resolve(caller, args.session_id, true);
    const asked = stringArg(args.question);
    const choices = Array.isArray(args.choices) ? args.choices.filter((c): c is string => typeof c === 'string' && c.trim() !== '') : [];
    // 自由記述は子の画面に打つので、キー操作になる文字（ESC・改行など）を除き、1 行にする
    const other = stripControlChars(stringArg(args.other)).replace(/\s*\n\s*/g, ' ').trim();
    if (choices.length === 0 && !other) throw new ToolError('choices（選ぶ選択肢）か other（自由記述）を渡してください');
    const current = () => {
      const screen = host.screen(child.id);
      return screen?.state.kind === 'menu' ? screen.state.menu : null;
    };
    const menu = current();
    // 許可の確認には答えさせない（人だけが答える）
    if (menu?.kind === 'permission') throw new ToolError(`「${nameOf(child)}」が出しているのは実行の許可の確認です。許可の確認には人が答えます`);
    if (menu?.kind !== 'question') throw new ToolError('質問は出ていません（人が先に答えたか、取り下げられました）。get_session で確かめてください');
    // 質問と読めても、AskUserQuestion で出した質問でなければ答えない（コマンドの文字に ☐ があると、許可の確認が質問に見える）
    if (!isAskedQuestion(menu, host.askedQuestions(child.id))) {
      throw new ToolError(`「${nameOf(child)}」が出しているのは、AskUserQuestion の質問ではありません。人が答えます`);
    }
    const same = (m: Menu | null) => m?.kind === 'question' && normalizeText(m.title) === normalizeText(menu.title);
    if (normalizeText(menu.title) !== normalizeText(asked)) {
      throw new ToolError(`今出ている質問は「${menu.title}」です（人が先に答えたか、次の質問に進んでいます）。答えるなら、この質問の文を question に渡してください`);
    }
    const selectable = menu.options.filter(isChoice);
    const picked = choices.map((label) => {
      const option = selectable.find((o) => normalizeText(o.label) === normalizeText(label));
      if (!option) throw new ToolError(`選択肢「${label}」はありません。選べるのは: ${selectable.map((o) => `「${o.label}」`).join('・')}`);
      return option;
    });
    const textOption = menu.options.find((o) => o.textInput);
    if (other && !textOption) throw new ToolError('この質問には、選択肢に無い答え（自由記述）を書く欄がありません');
    const changed = () => new ToolError('答えている途中で、質問が変わったか、人が操作していたため、答えられませんでした。get_session で確かめてください');
    // キーを送る前に毎回、同じ質問が出ているかを確かめる（途中で許可の確認などに変わったら、何も押さない）
    const choose = async (choice: ScreenChoice) => {
      if (!(await host.chooseIf(child.id, choice, (m) => same(m) && isAskedQuestion(m, host.askedQuestions(child.id))))) throw changed();
    };
    if (!menu.multiSelect) {
      if (picked.length + (other ? 1 : 0) !== 1) throw new ToolError('この質問は 1 つだけ選べます（choices に 1 つか、other だけを渡してください）');
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
      if (!current()?.options.some((o) => o.id === 'submit')) throw new ToolError('答えを確定する選択肢が見つかりません。ターミナルで確かめてください');
      await choose({ optionId: 'submit', key: 'enter' });
    }
    // 答えが受け付けられて、質問が閉じた（次の質問に進んだ）のを確かめる
    for (let i = 0; i < 20 && same(current()); i++) await sleep(100);
    if (same(current())) throw new ToolError('答えを送りましたが、質問が閉じませんでした。get_session で確かめてください');
    this.observe(caller.id, child.id);
    const next = current();
    return json({
      answered: true,
      state: host.stateOf(child.id),
      next_question: next?.kind === 'question' && !same(next) ? questionOf(next) : undefined,
    });
  }

  private async stopSession(caller: SessionSummary, args: Record<string, unknown>): Promise<ToolResult> {
    const { host } = this.deps;
    const child = this.resolve(caller, args.session_id, true);
    const state = host.stateOf(child.id);
    if (state === 'question' || state === 'permission' || state === 'waiting') {
      throw new ToolError(`「${nameOf(child)}」は人の対応待ち（${SESSION_STATE_LABEL[state]}）のため、中断できません`);
    }
    if (state !== 'working') return json({ session_id: child.id, state, note: state === 'background' ? 'ターンは終わっていて、バックグラウンドのタスクの完了を待っています' : '作業していません' });
    // 止めて手が空いたことは、親に知らせない（親が止めたので）
    this.stopped.add(child.id);
    host.interrupt(child.id);
    // 応答の前に止めると、親の指示が子の入力欄に戻る。残すと次の指示を打てず、人の入力欄にも囲みのまま移るので消す
    await host.withdrawParentDraft(child.id);
    return json({ session_id: child.id, state: host.stateOf(child.id), note: '中断しました' });
  }

  // --- 親への知らせ ---

  // 子が作業中から手の空いた状態になったら、親に知らせる（親が待っていなくても）。
  // 親が子に出した指示の作業だけ（人が子に直接出した指示の作業では、親を起こさない）
  private stateChanged(id: string): void {
    const state = this.deps.host.stateOf(id);
    const before = this.lastState.get(id);
    this.lastState.set(id, state);
    const parentId = this.deps.host.parentOf(id);
    if (parentId && state && isBusy(state)) this.pending.get(parentId)?.delete(id);
    // 作業していた子のターンが終わったとき（起動中から手が空いたのは、作業を終えたのではない。アプリを起動し直して引き継いだときなど）
    if (parentId && before === 'working' && state && NOTIFY_STATES.has(state)) void this.queueNotice(id, parentId, state);
    // 親の手が空いたら、溜まっている知らせを送る
    if (state && RECEIVE_STATES.has(state) && this.pending.has(id)) this.scheduleDelivery(id);
  }

  private async queueNotice(childId: string, parentId: string, state: SessionState): Promise<void> {
    const at = Date.now();
    if (this.stopped.delete(childId)) return;
    const events = await this.deps.host.conversation(childId);
    // /clear のあとの会話だけを見る（最後の指示が親のものでも、/clear で会話を始め直していれば、親の作業ではない）
    const reset = lastOf(events, (e): e is Extract<ChatEvent, { type: 'reset' }> => e.type === 'reset');
    const after = reset ? events.slice(events.lastIndexOf(reset) + 1) : events;
    if (lastOf(after, isUser)?.parent !== parentId) return;
    const queue = this.pending.get(parentId) ?? new Map();
    queue.set(childId, { state, at });
    this.pending.set(parentId, queue);
    this.scheduleDelivery(parentId);
  }

  // 続けて手が空いた子の知らせは、1 つにまとめる
  private scheduleDelivery(parentId: string): void {
    clearTimeout(this.timers.get(parentId));
    this.timers.set(
      parentId,
      setTimeout(() => {
        this.timers.delete(parentId);
        void this.deliver(parentId);
      }, this.deps.notifyDelayMs ?? NOTIFY_DELAY_MS),
    );
  }

  private async deliver(parentId: string): Promise<void> {
    const { host } = this.deps;
    const queue = this.pending.get(parentId);
    if (!queue || queue.size === 0) return;
    const parent = this.summary(parentId);
    if (!this.deps.enabled() || !parent || parent.archived || host.stateOf(parentId) === 'exited') {
      this.pending.delete(parentId);
      return;
    }
    // 親が作業中なら、手が空いたときに送る（stateChanged）。入力欄に書きかけの文字があれば、少し待って試し直す
    const parentState = host.stateOf(parentId);
    if (!parentState || !RECEIVE_STATES.has(parentState)) return;
    const screen = host.screen(parentId);
    if (screen?.state.kind !== 'prompt' || screen.draft) {
      this.timers.set(
        parentId,
        setTimeout(() => void this.deliver(parentId), 5000),
      );
      return;
    }
    this.pending.delete(parentId);
    const all = host.list();
    const notices = [...queue].filter(([child, event]) => (this.observedAt.get(`${parentId}:${child}`) ?? 0) < event.at);
    if (notices.length === 0) return;
    const message = `${notices.map(([child, event]) => noticeText(all.find((s) => s.id === child), child, event.state)).join(' ')} get_session で確かめてください。`;
    await host.submitWhenReady(parentId, sessionEventText(notices.map(([child]) => child), message), NOTIFY_TIMEOUT_MS).catch(() => {});
  }

  private observe(parentId: string, childId: string): void {
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
    if (id.length < 8) throw new ToolError('session_id には、セッションの ID（先頭 8 文字以上）を渡してください');
    const matches = this.visible(caller).filter((s) => s.id.startsWith(id));
    if (matches.length === 0) throw new ToolError(`見えるセッションに、ID が ${id} のものはありません（list_sessions で確かめてください）`);
    if (matches.length > 1) throw new ToolError(`ID が ${id} で始まるセッションが 2 つ以上あります。もっと長く渡してください`);
    const target = matches[0];
    if (child && target.parentId !== caller.id) {
      throw new ToolError(`「${nameOf(target)}」は、このセッションの子セッションではありません。指示できるのは、start_session で起動した子だけです`);
    }
    return target;
  }

  // 子セッションを始めるフォルダ。省けば、このセッションのリポジトリのフォルダ。
  // 選べるのは、このセッションのリポジトリの中か、このセッションから見えるセッションのフォルダだけ（勝手な場所で Claude Code を動かさせない）。
  // シンボリックリンクは解いてから比べる（リポジトリの中のリンクから、外のフォルダで始めさせない）
  private async folderFor(caller: SessionSummary, raw: unknown, worktree: boolean): Promise<string> {
    const root = projectRootOf(caller);
    const given = stringArg(raw);
    if (given && !isAbsolute(given)) throw new ToolError('folder は絶対パスで渡してください');
    const real = (path: string) => realpath(path).catch(() => null);
    let folder = await real(given ? normalize(given) : root);
    if (!folder) throw new ToolError(`フォルダが見つかりません: ${given || root}`);
    const realRoot = (await real(root)) ?? root;
    const inside = folder === realRoot || (realRoot !== this.deps.home && realRoot !== '/' && folder.startsWith(`${realRoot}/`));
    const known = inside
      ? true
      : (await Promise.all(this.visible(caller).flatMap((s) => [real(s.cwd), real(projectRootOf(s))]))).includes(folder);
    if (!known) {
      throw new ToolError(`${given} では始められません。選べるのは、このセッションのリポジトリ（${root}）の中か、ほかのセッションのフォルダだけです`);
    }
    const isDirectory = await stat(folder).then(
      (s) => s.isDirectory(),
      () => false,
    );
    if (!isDirectory) throw new ToolError(`フォルダではありません: ${folder}`);
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
    const label = (s: SessionSummary) => `「${nameOf(s)}」（${s.id.slice(0, 8)}・${SESSION_STATE_LABEL[this.deps.host.stateOf(s.id) ?? 'exited']}）`;
    return [
      `- ID: ${target.id}`,
      `- 関係: ${RELATION_LABEL[relationOf(target, caller)]}`,
      `- 状態: ${SESSION_STATE_LABEL[state]}（${state}）`,
      `- フォルダ: ${target.cwd}`,
      ...(target.worktree ? [`- worktree: ${target.worktree.name}（ブランチ ${target.worktree.branch}）`] : []),
      ...(parent ? [`- 親: ${label(parent)}`] : []),
      ...(children.length > 0 ? [`- 子: ${children.map(label).join('、')}`] : []),
    ];
  }

  // get_session・wait_sessions で返す 1 つのセッションの状態。detail: 最後の応答と質問も入れる
  private async status(s: SessionSummary, caller: SessionSummary, detail: boolean): Promise<Record<string, unknown>> {
    const base = this.describe(s, caller);
    if (!detail) return base;
    const events = await this.deps.host.conversation(s.id);
    const lastPrompt = lastOf(events, isPrompt);
    const promptAt = lastPrompt ? events.lastIndexOf(lastPrompt) : -1;
    const response = lastOf(events.slice(promptAt + 1), isResponse);
    const screen = this.deps.host.screen(s.id);
    const menu = screen?.state.kind === 'menu' ? screen.state.menu : null;
    return {
      ...base,
      last_prompt: lastPrompt
        ? { from: lastPrompt.type === 'notice' ? 'notice' : lastPrompt.parent ? 'parent' : 'human', text: clip(lastPrompt.text, 1000) }
        : null,
      last_response: response ? clip(response.text, 4000) : null,
      question: base.state === 'question' && menu?.kind === 'question' ? questionOf(menu) : undefined,
      permission: base.state === 'permission' && menu?.kind === 'permission' ? { title: menu.title, context: menu.context.slice(0, 12) } : undefined,
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
  self: 'このセッション',
  parent: 'このセッションの親',
  child: 'このセッションの子',
  sibling: '兄弟（同じ親の子）',
  project: '同じリポジトリのセッション',
} as const;

function relationOf(s: SessionSummary, caller: SessionSummary): keyof typeof RELATION_LABEL {
  if (s.id === caller.id) return 'self';
  if (s.id === caller.parentId) return 'parent';
  if (s.parentId === caller.id) return 'child';
  if (caller.parentId && s.parentId === caller.parentId) return 'sibling';
  return 'project';
}

const KIND_MARK = { added: 'A', modified: 'M', deleted: 'D' } as const;

function nameOf(s: SessionSummary | undefined): string {
  return s?.title ?? '新しいセッション';
}

function noticeText(child: SessionSummary | undefined, id: string, state: SessionState): string {
  const who = `子セッション「${nameOf(child)}」（${id.slice(0, 8)}）`;
  if (state === 'question') return `${who}が質問への回答を待っています（answer_question で答えられます）。`;
  if (state === 'exited') return `${who}が終了しました。`;
  return `${who}の作業が終わりました。`;
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

// 会話を、新しいほうから turns 回分の指示とその応答にまとめる（長い応答は途中を省く）
function conversationLines(events: ChatEvent[], turns: number, titleOf: (id: string) => string): string[] {
  type Turn = { who: string; text: string; responses: string[]; tools: string[] };
  let all: Turn[] = [];
  let current: Turn | null = null;
  for (const e of events) {
    if (e.type === 'reset') {
      // /clear で会話を始め直した
      all = [];
      current = null;
    } else if (e.type === 'user') {
      current = { who: e.parent ? `親セッション「${titleOf(e.parent)}」からの指示` : '人の発言', text: e.text, responses: [], tools: [] };
      all.push(current);
    } else if (e.type === 'notice') {
      current = { who: '知らせ', text: e.text, responses: [], tools: [] };
      all.push(current);
    } else if (e.type === 'assistant-text' && current) {
      current.responses.push(e.text);
    } else if (e.type === 'tool-use' && current) {
      current.tools.push(e.target ? `${e.name} ${e.target}` : e.name);
    }
  }
  if (all.length === 0) return ['## 最近の会話', '（まだ会話がありません）'];
  const shown = all.slice(-turns);
  const lines = [`## 最近の会話（全 ${all.length} 件の指示のうち、新しいほうから ${shown.length} 件）`];
  shown.forEach((turn, i) => {
    lines.push('', `### ${all.length - shown.length + i + 1}. ${turn.who}`, clip(turn.text, 3000));
    if (turn.responses.length > 0) {
      // 最後の応答（結果のまとめ）は長めに、途中の応答は短く
      const responses = turn.responses.map((r, j) => clip(r, j === turn.responses.length - 1 ? 4000 : 600));
      lines.push('', 'Claude:', responses.join('\n\n'));
    }
    if (turn.tools.length > 0) {
      const tools = turn.tools.slice(0, 30).join('、');
      lines.push('', `ツール: ${tools}${turn.tools.length > 30 ? ` ほか ${turn.tools.length - 30} 件` : ''}`);
    }
  });
  return lines;
}

// 会話の中で編集したファイル（フォルダからの相対。外のものは絶対パスのまま）
function editedFiles(events: ChatEvent[], cwd: string): string[] {
  const files = new Set<string>();
  for (const e of events) {
    if (e.type === 'reset') files.clear();
    if (e.type !== 'tool-use' || !EDIT_TOOLS.has(e.name) || !e.filePath) continue;
    const rel = relative(cwd, e.filePath);
    files.add(rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : e.filePath);
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
  if (info.isSymbolicLink()) return `${head}\n（シンボリックリンクのため、中身は読みません）`;
  if (!info.isFile()) return `${head}\n（ふつうのファイルではないため、中身は読みません）`;
  if (info.size > MAX_UNTRACKED_BYTES) return `${head}\n（${Math.round(info.size / 1024)} KB の大きなファイルのため、中身は省きます）`;
  const data = await readHead(join(cwd, file), MAX_UNTRACKED_BYTES);
  if (!data) return head;
  if (data.includes(0)) return `${head}\n（バイナリ）`;
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
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new ToolError('path は、セッションのフォルダからの相対パスで渡してください');
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
  return `${text.slice(0, head)}\n…（${text.length - max} 文字を省略）…\n${text.slice(text.length - (max - head))}`;
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
const isResponse = (e: ChatEvent): e is Extract<ChatEvent, { type: 'assistant-text' }> => e.type === 'assistant-text';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// テストで使う
export const testing = { conversationLines, editedFiles, safeRelative };
