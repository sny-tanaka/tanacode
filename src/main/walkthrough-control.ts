import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { t } from '@shared/i18n';
import { MAX_BODY_CHARS, MAX_STEPS, MAX_TITLE_CHARS, shownStep, stepLocation, type SessionWalkthrough, type Walkthrough, type WalkthroughStep } from '@shared/walkthrough';
import { walkthroughTool } from '@shared/walkthrough-tools';
import { textResult, type ToolResult } from './mcp-bridge';
import { Workspace } from './workspace';

// ウォークスルー（MCP サーバー tanacode-walkthrough のツールの実行）と、画面からの「次へ」「戻る」・閉じる。
// 呼び出し元のセッションは中継の env で渡ってくる。保存はせず、セッションごとに今の 1 つだけをメモリに持つ。
// 人が閉じても捨てず、Claude が作り直すまで、もう一度開ける（go）。
// ツールは人の操作を待たずにすぐ返す（Claude Code は、120 秒たっても終わらない MCP のツールをバックグラウンドに移すため）。
// Claude に返す結果とエラーは英語（画面の項目の名前だけ、画面の言語で入れる）

type Deps = {
  // セッションのフォルダ（worktree のセッションは worktree）。無いセッションなら null
  cwdOf: (sessionId: string) => string | null;
  // メニューの「Claude にウォークスルーさせる」
  enabled: () => boolean;
  // 変わった（終えたら null）。画面に送る
  onChange: (sessionId: string, walkthrough: Walkthrough | null) => void;
  clock?: () => number;
};

class WalkthroughError extends Error {}

export class WalkthroughControl {
  private readonly walks = new Map<string, Walkthrough>();
  // PR に載せたウォークスルー（id → コメントの URL）。二重に載せる前に知らせる
  private readonly posted = new Map<string, string>();

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
      return textResult(`The user has turned off "${t('main.menu.walkthroughControl')}" in the tanacode menu. Ask the user to turn it on.`, true);
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
        this.set(sessionId, walkthrough);
        const replaced = prev && prev.steps.length > 0 ? `It replaced the previous walkthrough "${prev.title}".` : '';
        return [
          `Started the walkthrough "${title}" (${stepCount(steps.length)}).`,
          replaced,
          `Opened 1/${steps.length} "${steps[0].title}" (${stepLocation(steps[0])}) in the user's tanacode editor.`,
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
        this.set(sessionId, { ...base, open: true, aside, movedBy: 'claude', seq: base.seq + 1 });
        const step = base.current + 1;
        const total = base.steps.length;
        const back = total > 0 ? ` When the user clicks "${t('walkthrough.box.backToWalkthrough', { step, total })}", the editor returns to ${step}/${total}.` : '';
        return `Showed ${stepLocation(aside)} in the user's editor (an aside).${back}`;
      }
      case 'walkthrough_status':
        return prev ? statusText(prev) : 'There is no walkthrough (the user has finished it, or none has been started).';
      default:
        throw new WalkthroughError(`Unknown tool: ${name}`);
    }
  }

  private set(sessionId: string, walkthrough: Walkthrough): void {
    this.walks.set(sessionId, walkthrough);
    this.deps.onChange(sessionId, walkthrough);
  }
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

// フォルダからの相対パスにする。フォルダの外は断る（tanacode のエディタはセッションのフォルダの中だけを開く）
export function relativePath(cwd: string, raw: string): string {
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
  const rel = relative(cwd, abs);
  // .. そのものか ../ で始まるものが外（..notes.md のような名前のファイルは中）
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new WalkthroughError(`${raw} is not a file in the folder of this session (${cwd}).`);
  return rel.split(sep).join('/');
}

// ステップ（start_walkthrough の steps の 1 つ・show_code の引数）を読む。ファイルが開けて、範囲がファイルの中にあるかを確かめる
async function readStep(workspace: Workspace, raw: unknown, titled: boolean): Promise<WalkthroughStep> {
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (typeof s.path !== 'string' || !s.path.trim()) throw new WalkthroughError('Pass path.');
  const path = relativePath(workspace.root, s.path.trim());
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

function statusText(w: Walkthrough): string {
  if (w.steps.length === 0) return `No walkthrough has been started. Showing ${stepLocation(shownStep(w))} as an aside.`;
  const now = !w.open
    ? `The user has closed the walkthrough (last viewed ${w.current + 1}/${w.steps.length}; it can be reopened from the list in "${t('app.sidePanel.scmLabel')}").`
    : w.aside
    ? `The user is viewing ${stepLocation(w.aside)}, which you showed as an aside (going back returns to ${w.current + 1}/${w.steps.length}).`
    : `The user is viewing ${w.current + 1}/${w.steps.length} "${w.steps[w.current].title}".`;
  const lines = w.steps.map((s, i) => {
    const mark = i === w.current ? ' (current)' : w.visited.includes(i) ? ' (viewed)' : '';
    return `${i + 1}. ${s.title} — ${stepLocation(s)}${mark}`;
  });
  return `Walkthrough "${w.title}" (${stepCount(w.steps.length)}). ${now}\n${lines.join('\n')}`;
}
