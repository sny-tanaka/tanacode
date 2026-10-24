import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { t } from '@shared/i18n';
import {
  MAX_BODY_CHARS,
  MAX_STEPS,
  MAX_TITLE_CHARS,
  shownStep,
  stepLocation,
  type SessionWalkthrough,
  type Walkthrough,
  type WalkthroughShown,
  type WalkthroughStep,
} from '@shared/walkthrough';
import { walkthroughTool } from '@shared/walkthrough-tools';
import { textResult, type ToolResult } from './mcp-bridge';
import { postWalkthroughAsDrafted, type CommentDeps } from './walkthrough-github';
import { Workspace } from './workspace';

// ウォークスルー（MCP サーバー tanacode-walkthrough のツールの実行。PR への投稿も）と、画面からの「次へ」「戻る」・閉じる。
// 呼び出し元のセッションは中継の env で渡ってくる。保存はせず、セッションごとに今の 1 つだけをメモリに持つ。
// 人が閉じても捨てず、Claude が作り直すまで、もう一度開ける（go）。
// ツールは人の操作を待たずにすぐ返す（Claude Code は、120 秒たっても終わらない MCP のツールをバックグラウンドに移すため）。
// ただし示した場所を画面がどう扱ったか（動かした・帯だけ・別のセッションを見ていた）は、画面の返事を少しだけ待って、結果に書く。
// 人が別のファイルやセッションを見ていると画面は動かないので、「示した」とだけ返すと Claude が見せたつもりになるため
// Claude に返す結果とエラーは英語（画面の項目の名前だけ、画面の言語で入れる）

type Deps = {
  // セッションのフォルダ（worktree のセッションは worktree）。無いセッションなら null
  cwdOf: (sessionId: string) => string | null;
  // メニューの「MCP → ウォークスルー」
  enabled: () => boolean;
  // 変わった（終えたら null）。画面に送る
  onChange: (sessionId: string, walkthrough: Walkthrough | null) => void;
  // PR を探す・コメントを書く（post_walkthrough）
  comment: CommentDeps;
  clock?: () => number;
  // 画面の返事（shown）を待つ長さ。画面はすぐ返すので、これを過ぎたら画面がいない（作り直している間など）とみる
  shownTimeoutMs?: number;
};

const SHOWN_TIMEOUT_MS = 2000;
const SHOWN = new Set<string>(['moved', 'band', 'unseen'] satisfies WalkthroughShown[]);

class WalkthroughError extends Error {}

export class WalkthroughControl {
  private readonly walks = new Map<string, Walkthrough>();
  // PR に載せたウォークスルー（id → コメントの URL）。二重に載せる前に知らせる
  private readonly posted = new Map<string, string>();
  // 画面の返事を待っているもの（セッション・ウォークスルー・seq → 受け取る関数）
  private readonly waiting = new Map<string, (shown: WalkthroughShown | null) => void>();
  // 人が見ているセッションと、そこで Claude の示している場所を見ているか（画面から。まだ届いていなければ null）
  private view: { sessionId: string | null; onWalkthrough: boolean } | null = null;

  constructor(private readonly deps: Deps) {}

  // --- 画面から ---

  list(): SessionWalkthrough[] {
    return [...this.walks].map(([sessionId, walkthrough]) => ({ sessionId, walkthrough }));
  }

  get(sessionId: string): Walkthrough | null {
    return this.walks.get(sessionId) ?? null;
  }

  // 人が見るステップを変えた。寄り道からも戻る。閉じていれば開く
  go(sessionId: string, index: number): void {
    const w = this.walks.get(sessionId);
    if (!w || w.steps.length === 0 || !Number.isInteger(index)) return;
    const current = Math.min(Math.max(index, 0), w.steps.length - 1);
    const visited = w.visited.includes(current) ? w.visited : [...w.visited, current].sort((a, b) => a - b);
    this.set(sessionId, { ...w, open: true, current, aside: null, visited, movedBy: 'human', seq: w.seq + 1 });
  }

  // 人が閉じた。手順は残す（寄り道だけで、もう一度見るステップが無ければ捨てる）
  close(sessionId: string): void {
    const w = this.walks.get(sessionId);
    if (!w) return;
    if (w.steps.length === 0) return this.discard(sessionId);
    if (w.open) this.set(sessionId, { ...w, open: false, aside: null, movedBy: 'human', seq: w.seq + 1 });
  }

  // 捨てる（セッションをアーカイブした・一覧から削除した）
  discard(sessionId: string): void {
    if (!this.walks.delete(sessionId)) return;
    this.deps.onChange(sessionId, null);
  }

  // Claude が示した場所を、画面がどう扱ったか。待っているもの（同じウォークスルーの同じ seq）にだけ渡す
  shown(sessionId: string, walkthroughId: string, seq: number, shown: unknown): void {
    if (typeof shown !== 'string' || !SHOWN.has(shown)) return;
    this.waiting.get(waitKey(sessionId, walkthroughId, seq))?.(shown as WalkthroughShown);
  }

  viewing(sessionId: string | null, onWalkthrough: boolean): void {
    this.view = { sessionId, onWalkthrough };
  }

  postedUrl(walkthroughId: string): string | null {
    return this.posted.get(walkthroughId) ?? null;
  }

  markPosted(walkthroughId: string, url: string): void {
    this.posted.set(walkthroughId, url);
  }

  // セッションを一覧から消した
  forget(sessionId: string): void {
    this.walks.delete(sessionId);
  }

  // --- MCP のツール ---

  async handle(callerId: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (!walkthroughTool(name)) return textResult(`Unknown tool: ${name}`, true);
    if (!this.deps.enabled()) {
      return textResult(`The user has turned off the tanacode MCP "${t('main.menu.walkthroughControl')}". Ask the user to turn on "${t('main.menu.walkthroughControl')}" under tanacode > ${t('main.menu.mcp')}.`, true);
    }
    const cwd = this.deps.cwdOf(callerId);
    if (!cwd) return textResult('This session is not in tanacode.', true);
    try {
      return textResult(await this.run(callerId, cwd, name, args));
    } catch (error) {
      if (!(error instanceof WalkthroughError)) throw error;
      return textResult(error.message, true);
    }
  }

  private async run(sessionId: string, cwd: string, name: string, args: Record<string, unknown>): Promise<string> {
    const now = this.deps.clock?.() ?? Date.now();
    const prev = this.walks.get(sessionId);
    switch (name) {
      case 'start_walkthrough': {
        const title = text(args.title, 'title', MAX_TITLE_CHARS);
        const raw = Array.isArray(args.steps) ? args.steps : [];
        if (raw.length === 0) throw new WalkthroughError('Pass at least one step in steps.');
        if (raw.length > MAX_STEPS) throw new WalkthroughError(`A walkthrough can have up to ${MAX_STEPS} steps (got ${raw.length}). Combine steps, or split it into several walkthroughs.`);
        const workspace = new Workspace(cwd);
        const results = await Promise.all(raw.map((s, i) => readStep(workspace, s, true).catch((e: unknown) => errorOf(e, `Step ${i + 1}: `))));
        const errors = results.filter((r): r is string => typeof r === 'string');
        if (errors.length > 0) throw new WalkthroughError(`Could not start the walkthrough. Fix these and call start_walkthrough again.\n${errors.join('\n')}`);
        const steps = results as WalkthroughStep[];
        const walkthrough: Walkthrough = {
          id: randomUUID(),
          title,
          steps,
          open: true,
          current: 0,
          aside: null,
          visited: [0],
          movedBy: 'claude',
          seq: (prev?.seq ?? 0) + 1,
          startedAt: now,
        };
        const shown = await this.show(sessionId, walkthrough);
        const replaced = prev && prev.steps.length > 0 ? `It replaced the previous walkthrough "${prev.title}".` : '';
        const first = `1/${steps.length} "${steps[0].title}" (${stepLocation(steps[0])})`;
        return [
          `Started the walkthrough "${title}" (${stepCount(steps.length)}).`,
          replaced,
          shown === 'moved'
            ? `Opened ${first} in the user's tanacode editor.`
            : shown === 'unseen'
            ? `Prepared ${first}. The user is viewing another session in tanacode, so it opens when the user comes back to this session.`
            : shown === 'band'
            ? `Did not move the user's editor to ${first}: the user has opened another file or view in this session. A band above the editor lets them open it.`
            : `Sent ${first} to the user's tanacode editor, but the tanacode window did not confirm that it opened it.`,
          `The user moves through the steps with "${t('walkthrough.box.next')}" and "${t('walkthrough.box.previous')}" at their own pace. Write only a short line in the chat, end your turn and wait for questions.`,
        ]
          .filter(Boolean)
          .join(' ');
      }
      case 'show_code': {
        const aside = await readStep(new Workspace(cwd), args, false).catch((e: unknown) => {
          throw new WalkthroughError(errorOf(e, ''));
        });
        const base: Walkthrough = prev ?? { id: randomUUID(), title: '', steps: [], open: true, current: 0, aside: null, visited: [], movedBy: 'claude', seq: 0, startedAt: now };
        // 人が閉じていても、質問に答えて示すときは開く
        const shown = await this.show(sessionId, { ...base, open: true, aside, movedBy: 'claude', seq: base.seq + 1 });
        const step = base.current + 1;
        const total = base.steps.length;
        const back = total > 0 ? ` When the user clicks "${t('walkthrough.box.backToWalkthrough', { step, total })}", the editor returns to ${step}/${total}.` : '';
        const where = stepLocation(aside);
        const mention = ' Mention the location in your reply so that the user can find it.';
        if (shown === 'moved') return `Showed ${where} in the user's editor (an aside).${back}`;
        if (shown === 'band') {
          return `Did not move the user's editor to ${where}: the user has opened another file or view in this session. A band above the editor tells them that you are showing ${where}, with "${t('walkthrough.band.backToClaude')}" to open it.${mention}${back}`;
        }
        if (shown === 'unseen') return `Did not move the user's editor: the user is viewing another session in tanacode. ${where} opens when the user comes back to this session.${mention}${back}`;
        return `Sent ${where} to the user's editor as an aside, but the tanacode window did not confirm that it showed it.${mention}${back}`;
      }
      case 'walkthrough_status':
        return prev ? statusText(prev, this.elsewhere(sessionId)) : 'There is no walkthrough (the user has finished it, or none has been started).';
      case 'post_walkthrough': {
        if (!prev || prev.steps.length === 0) throw new WalkthroughError('There is no walkthrough to post. Start one with start_walkthrough first.');
        // 同じものを何度も載せないよう、載せたものは、人に頼まれたときだけ載せ直す
        const before = this.posted.get(prev.id);
        if (before && args.repost !== true) {
          throw new WalkthroughError(`The walkthrough "${prev.title}" has already been posted: ${before}. Post it again only if the user asks you to, with repost: true.`);
        }
        const { prNumber, url } = await postWalkthroughAsDrafted(cwd, prev, this.deps.comment).catch((e: unknown) => {
          const reason = e instanceof Error ? e.message : String(e);
          throw new WalkthroughError(`Could not post the walkthrough "${prev.title}". ${reason} Tell the user the reason instead of posting a comment of your own.`);
        });
        this.markPosted(prev.id, url);
        return `Posted the walkthrough "${prev.title}" (${stepCount(prev.steps.length)}) to PR #${prNumber} as a comment: ${url}`;
      }
      default:
        throw new WalkthroughError(`Unknown tool: ${name}`);
    }
  }

  private set(sessionId: string, walkthrough: Walkthrough): void {
    this.walks.set(sessionId, walkthrough);
    this.deps.onChange(sessionId, walkthrough);
  }

  // Claude が示す場所を変えて、画面の返事を待つ（返事が無ければ null）。画面がすぐ返しても受け取れるよう、知らせる前に待ち始める
  private show(sessionId: string, walkthrough: Walkthrough): Promise<WalkthroughShown | null> {
    const key = waitKey(sessionId, walkthrough.id, walkthrough.seq);
    const answer = new Promise<WalkthroughShown | null>((resolve) => {
      const timer = setTimeout(() => done(null), this.deps.shownTimeoutMs ?? SHOWN_TIMEOUT_MS);
      const done = (shown: WalkthroughShown | null) => {
        clearTimeout(timer);
        if (this.waiting.get(key) === done) this.waiting.delete(key);
        resolve(shown);
      };
      this.waiting.set(key, done);
    });
    this.set(sessionId, walkthrough);
    return answer;
  }

  // 人がこのセッションの示している場所を見ていなければ、その一文（画面から届いていなければ null）
  private elsewhere(sessionId: string): string | null {
    if (!this.view) return null;
    if (this.view.sessionId !== sessionId) return 'The user is viewing another session in tanacode now.';
    if (!this.view.onWalkthrough) return 'The user has opened another file or view in the editor instead (a band above the editor offers to go back).';
    return null;
  }
}

function waitKey(sessionId: string, walkthroughId: string, seq: number): string {
  return `${sessionId}\n${walkthroughId}\n${seq}`;
}

function errorOf(error: unknown, prefix: string): string {
  if (error instanceof WalkthroughError) return `${prefix}${error.message}`;
  throw error;
}

function text(value: unknown, key: string, max: number): string {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) throw new WalkthroughError(`Pass ${key}.`);
  if (s.length > max) throw new WalkthroughError(`${key} can be up to ${max} characters (got ${s.length}).`);
  return s;
}

// ステップのパス。セッションのフォルダの中は、フォルダからの相対パスにする（エクスプローラーから開いたタブと同じになる）。
// Claude Code が渡すのはリンクを解いたパスなので、フォルダのリンクを解いた場所とも比べる。
// フォルダの外は、絶対パスのまま示す（断らない。Claude はもともと、どのファイルも読めるので、tanacode だけで制限しても意味がない）
async function stepPath(cwd: string, raw: string): Promise<string> {
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
  return inside(cwd, abs) ?? inside(await realpath(cwd).catch(() => cwd), abs) ?? abs;
}

// root の中なら、root からの相対パス
function inside(root: string, abs: string): string | null {
  const rel = relative(root, abs);
  // .. そのものか ../ で始まるものが外（..notes.md のような名前のファイルは中）
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

// ステップ（start_walkthrough の steps の 1 つ・show_code の引数）を読む。ファイルが開けて、範囲がファイルの中にあるかを確かめる
async function readStep(workspace: Workspace, raw: unknown, titled: boolean): Promise<WalkthroughStep> {
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (typeof s.path !== 'string' || !s.path.trim()) throw new WalkthroughError('Pass path.');
  const path = await stepPath(workspace.root, s.path.trim());
  const startLine = Number(s.start_line);
  const endLine = s.end_line === undefined ? startLine : Number(s.end_line);
  if (!Number.isInteger(startLine) || startLine < 1) throw new WalkthroughError(`${path}: start_line must be an integer of 1 or more.`);
  if (!Number.isInteger(endLine) || endLine < startLine) throw new WalkthroughError(`${path}: end_line must be an integer of start_line or more.`);
  if (s.view !== undefined && s.view !== 'file' && s.view !== 'diff') throw new WalkthroughError(`${path}: view must be "file" or "diff".`);
  const view = s.view === 'diff' ? 'diff' : 'file';
  const title = titled ? text(s.title, 'title', MAX_TITLE_CHARS) : '';
  const body = text(s.body, 'body', MAX_BODY_CHARS);
  const content = await workspace.readFile(path).catch(() => null);
  if (!content) throw new WalkthroughError(`${path} was not found.`);
  if (content.kind !== 'text') throw new WalkthroughError(`${path} is not a text file, or is too large to open in the editor.`);
  const lineCount = content.text.endsWith('\n') ? content.text.split('\n').length - 1 : content.text.split('\n').length;
  if (endLine > Math.max(lineCount, 1)) throw new WalkthroughError(`${path} has ${lineCount} ${lineCount === 1 ? 'line' : 'lines'} (there is no line ${endLine}).`);
  return { path, startLine, endLine, title, body, view };
}

// 「1 step」「2 steps」
function stepCount(count: number): string {
  return `${count} ${count === 1 ? 'step' : 'steps'}`;
}

// elsewhere: 人が示している場所を見ていない（別のセッション・別のファイル）ときの一文
function statusText(w: Walkthrough, elsewhere: string | null): string {
  if (w.steps.length === 0) return [`No walkthrough has been started. Showing ${stepLocation(shownStep(w))} as an aside.`, elsewhere].filter(Boolean).join(' ');
  const at = w.aside
    ? `${stepLocation(w.aside)}, which you showed as an aside (going back returns to ${w.current + 1}/${w.steps.length})`
    : `${w.current + 1}/${w.steps.length} "${w.steps[w.current].title}"`;
  const now = !w.open
    ? `The user has closed the walkthrough (last viewed ${w.current + 1}/${w.steps.length}; it can be reopened from the list in "${t('app.sidePanel.scmLabel')}").`
    : elsewhere
    ? `${elsewhere} The walkthrough is at ${at}.`
    : `The user is viewing ${at}.`;
  const lines = w.steps.map((s, i) => {
    const mark = i === w.current ? ' (current)' : w.visited.includes(i) ? ' (viewed)' : '';
    return `${i + 1}. ${s.title} — ${stepLocation(s)}${mark}`;
  });
  return `Walkthrough "${w.title}" (${stepCount(w.steps.length)}). ${now}\n${lines.join('\n')}`;
}
