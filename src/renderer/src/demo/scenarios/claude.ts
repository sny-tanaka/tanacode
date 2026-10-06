import type { ChatEvent } from '@shared/chat';
import { checklistTarget, checklistToolId } from '@shared/checklist-tools';
import type { MenuOption } from '@shared/screen';
import type { StatusLineInfo } from '@shared/statusline';
import type { DemoBackend } from '../backend';
import { ROOT } from '../data';
import { sleep } from '../director';

// 台本で使う、Claude の作り物。ツールの呼び出しと結果を、実際の Claude Code と同じ順で会話に足す

type ToolResult = Partial<Extract<ChatEvent, { type: 'tool-result' }>>;
export type ToolExtra = { filePath?: string; input?: string; description?: string; result?: ToolResult };

export class Claude {
  private seq = 0;
  private elapsed = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly backend: DemoBackend,
    private readonly id: string,
    // 同じ台本で複数のセッションを動かすとき、出来事の ID が重ならないようにする
    private readonly prefix = '',
  ) {}

  // 作業中の表示（考えている・経過時間）を 1 秒ごとに進める
  startWorking(): void {
    this.elapsed = 0;
    this.stopWorking();
    this.backend.setActivity(this.id, { phase: 'thinking', elapsed: '0s', tokens: null });
    this.timer = setInterval(() => {
      this.elapsed += 1;
      const e = this.elapsed;
      const elapsed = e < 60 ? `${e}s` : `${Math.floor(e / 60)}m ${e % 60}s`;
      this.backend.setActivity(this.id, { phase: e % 7 < 3 ? 'thinking' : 'working', elapsed, tokens: `${(0.3 + e * 0.12).toFixed(1)}k` });
    }, 1000);
  }

  stopWorking(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.backend.setActivity(this.id, null);
  }

  user(text: string): void {
    this.backend.push(this.id, { type: 'user', id: this.next('u'), text });
  }

  say(text: string): void {
    this.backend.push(this.id, { type: 'assistant-text', id: this.next('t'), text });
  }

  // ツールを呼ぶ（結果は返さない）。結果は result で返す
  use(name: string, target: string, extra: ToolExtra = {}): string {
    const id = this.next('tool');
    this.backend.push(this.id, {
      type: 'tool-use',
      id,
      name,
      target,
      filePath: extra.filePath,
      input: extra.input ?? target,
      description: extra.description,
      at: Date.now(),
    });
    return id;
  }

  result(id: string, result: ToolResult = {}): void {
    this.backend.push(this.id, { type: 'tool-result', id, isError: false, at: Date.now(), ...result });
  }

  // ツールを呼んで、ms 後に結果を返す
  async tool(name: string, target: string, ms: number, extra: ToolExtra = {}): Promise<string> {
    const id = this.use(name, target, extra);
    await sleep(ms);
    this.result(id, extra.result);
    return id;
  }

  // ファイルを書き換える Edit。patch は差分の行（+ / - で始まる）
  async edit(path: string, text: string, ms: number, patch: string[], afterUse?: (id: string) => void | Promise<void>): Promise<string> {
    const added = patch.filter((l) => l.startsWith('+')).length;
    const removed = patch.filter((l) => l.startsWith('-')).length;
    const id = this.use('Edit', path, { filePath: `${ROOT}/${path}`, input: patch.join('\n') });
    await sleep(ms);
    this.result(id, { filePath: `${ROOT}/${path}`, added, removed, line: 1, patch });
    this.backend.writeFile(path, text);
    this.backend.know(this.id, { [path]: 'edited' });
    await afterUse?.(id);
    return id;
  }

  // チェックリストの MCP のツール（tanacode-checklist）を呼び、ms 後に結果を返す。
  // run がチェックリスト（backend.checklists）を書き換えて、ツールの結果の文を返す
  async checklist(tool: string, input: Record<string, unknown>, ms: number, run: () => string): Promise<string> {
    const name = checklistToolId(tool);
    const id = this.use(name, checklistTarget(name, input) ?? '', { input: JSON.stringify(input, null, 2) });
    await sleep(ms);
    this.result(id, { output: run() });
    return id;
  }

  next(prefix: string): string {
    this.seq += 1;
    return `${this.prefix}${prefix}-${this.seq}`;
  }
}

export const option = (id: string, label: string, description: string, preview?: string): MenuOption => ({
  id,
  label,
  description,
  pointed: id === '1',
  checked: null,
  textInput: false,
  preview,
});

export function statusLine(percent: number, tokens: number): StatusLineInfo {
  return {
    model: { id: 'claude-opus-5-5', name: 'Opus 5.5' },
    version: '2.1.283',
    context: { size: 200_000, usedPercent: percent, tokens },
    rateLimits: null,
    costUsd: null,
    transcriptPath: null,
    updatedAt: Date.now(),
  };
}

// 前に終わった会話（開いた時点で、もう会話がある状態にする）。tools は [名前, 対象, 所要ミリ秒]
export function pastTurn(prefix: string, prompt: string, tools: [string, string, number][], reply: string, endedAgo = 5 * 60_000): ChatEvent[] {
  let at = Date.now() - endedAgo - tools.reduce((sum, [, , ms]) => sum + ms + 400, 0);
  const events: ChatEvent[] = [{ type: 'user', id: `${prefix}-u`, text: prompt }];
  tools.forEach(([name, target, ms], i) => {
    const id = `${prefix}-tool-${i}`;
    const filePath = /^(Read|Edit|Write)$/.test(name) ? `${ROOT}/${target}` : undefined;
    events.push({ type: 'tool-use', id, name, target, filePath, input: target, at });
    at += ms;
    events.push({ type: 'tool-result', id, isError: false, filePath, at });
    at += 400;
  });
  events.push({ type: 'assistant-text', id: `${prefix}-t`, text: reply }, { type: 'turn-end' });
  return events;
}
