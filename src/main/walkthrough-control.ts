import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { MAX_BODY_CHARS, MAX_STEPS, MAX_TITLE_CHARS, shownStep, stepLocation, type SessionWalkthrough, type Walkthrough, type WalkthroughStep } from '@shared/walkthrough';
import { walkthroughTool } from '@shared/walkthrough-tools';
import { textResult, type ToolResult } from './mcp-bridge';
import { Workspace } from './workspace';

// ウォークスルー（MCP サーバー tanacode-walkthrough のツールの実行）と、画面からの「次へ」「戻る」・終える。
// 呼び出し元のセッションは中継の env で渡ってくる。保存はせず、セッションごとに今の 1 つだけをメモリに持つ。
// ツールは人の操作を待たずにすぐ返す（Claude Code は、120 秒たっても終わらない MCP のツールをバックグラウンドに移すため）

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

  constructor(private readonly deps: Deps) {}

  // --- 画面から ---

  list(): SessionWalkthrough[] {
    return [...this.walks].map(([sessionId, walkthrough]) => ({ sessionId, walkthrough }));
  }

  get(sessionId: string): Walkthrough | null {
    return this.walks.get(sessionId) ?? null;
  }

  // 人が見るステップを変えた。寄り道からも戻る
  go(sessionId: string, index: number): void {
    const w = this.walks.get(sessionId);
    if (!w || w.steps.length === 0 || !Number.isInteger(index)) return;
    const current = Math.min(Math.max(index, 0), w.steps.length - 1);
    const visited = w.visited.includes(current) ? w.visited : [...w.visited, current].sort((a, b) => a - b);
    this.set(sessionId, { ...w, current, aside: null, visited, movedBy: 'human', seq: w.seq + 1 });
  }

  end(sessionId: string): void {
    if (!this.walks.delete(sessionId)) return;
    this.deps.onChange(sessionId, null);
  }

  // セッションを一覧から消した
  forget(sessionId: string): void {
    this.walks.delete(sessionId);
  }

  // --- MCP のツール ---

  async handle(callerId: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (!walkthroughTool(name)) return textResult(`知らないツールです: ${name}`, true);
    if (!this.deps.enabled()) {
      return textResult('ユーザーが tanacode のメニューで「Claude にウォークスルーさせる」をオフにしています。使うには、ユーザーにオンにしてもらってください', true);
    }
    const cwd = this.deps.cwdOf(callerId);
    if (!cwd) return textResult('このセッションは tanacode にありません', true);
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
        if (raw.length === 0) throw new WalkthroughError('steps に、ステップを 1 つ以上渡してください');
        if (raw.length > MAX_STEPS) throw new WalkthroughError(`ステップは ${MAX_STEPS} 個までです（${raw.length} 個あります）。まとめるか、分けて見せてください`);
        const workspace = new Workspace(cwd);
        const results = await Promise.all(raw.map((s, i) => readStep(workspace, s, true).catch((e: unknown) => errorOf(e, `ステップ ${i + 1}: `))));
        const errors = results.filter((r): r is string => typeof r === 'string');
        if (errors.length > 0) throw new WalkthroughError(`始められませんでした。直して、もう一度 start_walkthrough を呼んでください。\n${errors.join('\n')}`);
        const steps = results as WalkthroughStep[];
        const walkthrough: Walkthrough = {
          id: randomUUID(),
          title,
          steps,
          current: 0,
          aside: null,
          visited: [0],
          movedBy: 'claude',
          seq: (prev?.seq ?? 0) + 1,
          startedAt: now,
        };
        this.set(sessionId, walkthrough);
        const replaced = prev && prev.steps.length > 0 ? `前のウォークスルー「${prev.title}」は、これに置き換えました。` : '';
        return [
          `ウォークスルー「${title}」を始めました（${steps.length} ステップ）。${replaced}`,
          `人の tanacode のエディタに 1/${steps.length}「${steps[0].title}」（${stepLocation(steps[0])}）を開きました。`,
          '人は「次へ」「戻る」で自分のペースで進めます。チャットには短く書いてターンを終え、質問を待ってください。',
        ].join('');
      }
      case 'show_code': {
        const aside = await readStep(new Workspace(cwd), args, false).catch((e: unknown) => {
          throw new WalkthroughError(errorOf(e, ''));
        });
        const base: Walkthrough = prev ?? { id: randomUUID(), title: '', steps: [], current: 0, aside: null, visited: [], movedBy: 'claude', seq: 0, startedAt: now };
        this.set(sessionId, { ...base, aside, movedBy: 'claude', seq: base.seq + 1 });
        const back = base.steps.length > 0 ? `人が「ウォークスルーに戻る」を押すと、${base.current + 1}/${base.steps.length} に戻ります。` : '';
        return `人のエディタに ${stepLocation(aside)} を示しました（寄り道）。${back}`;
      }
      case 'walkthrough_status':
        return prev ? statusText(prev) : 'ウォークスルーはありません（人が終えたか、まだ始めていません）。';
      default:
        throw new WalkthroughError(`知らないツールです: ${name}`);
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
  if (!s) throw new WalkthroughError(`${key} を渡してください`);
  if (s.length > max) throw new WalkthroughError(`${key} は ${max} 文字までです（${s.length} 文字あります）`);
  return s;
}

// フォルダからの相対パスにする。フォルダの外は断る（tanacode のエディタはセッションのフォルダの中だけを開く）
export function relativePath(cwd: string, raw: string): string {
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
  const rel = relative(cwd, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new WalkthroughError(`${raw} は、このセッションのフォルダ（${cwd}）の中のファイルではありません`);
  return rel.split(sep).join('/');
}

// ステップ（start_walkthrough の steps の 1 つ・show_code の引数）を読む。ファイルが開けて、範囲がファイルの中にあるかを確かめる
async function readStep(workspace: Workspace, raw: unknown, titled: boolean): Promise<WalkthroughStep> {
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (typeof s.path !== 'string' || !s.path.trim()) throw new WalkthroughError('path を渡してください');
  const path = relativePath(workspace.root, s.path.trim());
  const startLine = Number(s.start_line);
  const endLine = s.end_line === undefined ? startLine : Number(s.end_line);
  if (!Number.isInteger(startLine) || startLine < 1) throw new WalkthroughError(`${path}: start_line は 1 以上の整数にしてください`);
  if (!Number.isInteger(endLine) || endLine < startLine) throw new WalkthroughError(`${path}: end_line は start_line 以上の整数にしてください`);
  const title = titled ? text(s.title, 'title', MAX_TITLE_CHARS) : '';
  const body = text(s.body, 'body', MAX_BODY_CHARS);
  const content = await workspace.readFile(path).catch(() => null);
  if (!content) throw new WalkthroughError(`${path} が見つかりません`);
  if (content.kind !== 'text') throw new WalkthroughError(`${path} は文字のファイルではないか、大きすぎてエディタで開けません`);
  const lineCount = content.text.endsWith('\n') ? content.text.split('\n').length - 1 : content.text.split('\n').length;
  if (endLine > Math.max(lineCount, 1)) throw new WalkthroughError(`${path} は ${lineCount} 行です（${endLine} 行目はありません）`);
  return { path, startLine, endLine, title, body };
}

function statusText(w: Walkthrough): string {
  if (w.steps.length === 0) return `ウォークスルーは始めていません。寄り道で ${stepLocation(shownStep(w))} を示しています。`;
  const now = w.aside
    ? `人は寄り道で示した ${stepLocation(w.aside)} を見ています（戻ると ${w.current + 1}/${w.steps.length}）。`
    : `人は ${w.current + 1}/${w.steps.length}「${w.steps[w.current].title}」を見ています。`;
  const lines = w.steps.map((s, i) => {
    const mark = i === w.current ? '（今ここ）' : w.visited.includes(i) ? '（見た）' : '';
    return `${i + 1}. ${s.title} — ${stepLocation(s)}${mark}`;
  });
  return `ウォークスルー「${w.title}」（${w.steps.length} ステップ）。${now}\n${lines.join('\n')}`;
}
