import { statSync } from 'node:fs';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isTranscriptEntry, toolTarget } from '@shared/chat';
import { t } from '@shared/i18n';
import type { SubagentRun } from '@shared/subagent';
import { conversationOf } from '@shared/transcript-line';
import type { TaskUsage } from './task-router';

const POLL_MS = 1000;
const RECENT_TOOLS = 5;
// 結果をこの文字数で切る
const MAX_RESULT = 3000;
// サブエージェントが SubagentHandback で報告したときの、完了通知の <result> の文（報告の代わりに書かれる。2.1.303 の本体にある 4 通り:
// 報告は知らせで届けた・auto モードの警告付きで届けた・まだ報告していない（自分の裏の作業を待っている）・報告せずに終わった）。結果にはしない
const HANDBACK_PLACEHOLDER = /^(?:This agent's report was delivered to you as a message from "|This agent has not reported yet: |The subagent ended without delivering a report through SubagentHandback)/;

type Tracked = { run: SubagentRun; subagentsDir: string; offset: number };

// Agent ツールで起動したサブエージェントを追跡する。
// <セッション>/subagents/agent-<id>.meta.json に起動元の toolUseId が書かれるので、それで会話ログを見つけて読む
export class SubagentTracker {
  private readonly runs = new Map<string, Tracked>();
  // SubagentHandback で届いた報告（エージェントの ID ごと。SendMessage で再開したものは同じ ID なので、新しい報告で置き換える）
  private readonly reports = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(
    private readonly cwd: string,
    private readonly onChange: (runs: SubagentRun[]) => void,
  ) {}

  all(): SubagentRun[] {
    return [...this.runs.values()].map((t) => t.run);
  }

  // サブエージェントの会話ログ。まだ分からなければ null
  logFile(toolUseId: string, fallbackDir: string): string | null {
    const t = this.runs.get(toolUseId);
    if (!t?.run.agentId) return null;
    return `${t.subagentsDir || fallbackDir}/agent-${t.run.agentId}.jsonl`;
  }

  // live: 今まさに起動した。過去の会話を読み直しているときは結果だけ反映する（finish）
  start(toolUseId: string, sessionDir: string, background: boolean, description: string | null): void {
    if (this.runs.has(toolUseId)) return;
    this.runs.set(toolUseId, {
      run: {
        toolUseId,
        agentId: null,
        description,
        background,
        state: 'running',
        startedAt: Date.now(),
        model: null,
        toolCalls: 0,
        recent: [],
        durationMs: null,
        tokens: null,
        result: null,
      },
      subagentsDir: join(sessionDir, 'subagents'),
      offset: 0,
    });
    this.onChange(this.all());
    this.timer ??= setInterval(() => void this.poll(), POLL_MS);
  }

  // SendMessage で、前に起動したエージェントに続きを頼んだ（結果に resumedAgentId が付く）。
  // バックグラウンドで動き、完了通知は SendMessage の tool_use ID で届く。会話ログは前と同じファイルに続けて書かれる
  resume(toolUseId: string, agentId: string, sessionDir: string, fromHistory: boolean): void {
    if (this.runs.has(toolUseId)) return;
    const subagentsDir = join(sessionDir, 'subagents');
    // ツールの回数は、再開してからの分だけ数える
    let offset = 0;
    try {
      offset = statSync(join(subagentsDir, `agent-${agentId}.jsonl`)).size;
    } catch {
      // まだ無い
    }
    this.runs.set(toolUseId, {
      run: {
        toolUseId,
        agentId,
        description: [...this.runs.values()].find((t) => t.run.agentId === agentId && t.run.description)?.run.description ?? null,
        background: true,
        // 過去の会話から読んだものは、完了通知が無ければ止まっている
        state: fromHistory ? 'stopped' : 'running',
        startedAt: fromHistory ? null : Date.now(),
        model: null,
        toolCalls: 0,
        recent: [],
        durationMs: null,
        tokens: null,
        result: null,
      },
      subagentsDir: fromHistory ? '' : subagentsDir,
      offset,
    });
    this.onChange(this.all());
    if (!fromHistory) this.timer ??= setInterval(() => void this.poll(), POLL_MS);
  }

  // Agent ツールの結果。バックグラウンドの場合は起動の知らせなので、完了通知まで実行中のまま
  finish(toolUseId: string, result: unknown, isError: boolean, fromHistory: boolean): void {
    const r = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>;
    const launched = r.status === 'async_launched';
    let t = this.runs.get(toolUseId);
    if (!t) {
      // 再開時に読み直した過去の会話。以前の Claude Code で動いたものなので追跡はしない
      if (!fromHistory && !launched) return;
      this.runs.set(toolUseId, {
        run: {
          toolUseId,
          agentId: null,
          description: null,
          background: launched,
          state: 'running',
          startedAt: null,
          model: null,
          toolCalls: 0,
          recent: [],
          durationMs: null,
          tokens: null,
          result: null,
        },
        subagentsDir: '',
        offset: 0,
      });
      t = this.runs.get(toolUseId)!;
    }
    const run = { ...t.run, agentId: typeof r.agentId === 'string' ? r.agentId : t.run.agentId };
    if (typeof r.resolvedModel === 'string') run.model = r.resolvedModel;
    if (launched) {
      run.background = true;
      if (fromHistory) run.state = 'stopped';
    } else {
      run.state = isError || r.status === 'failed' ? 'failed' : 'done';
      if (typeof r.totalToolUseCount === 'number') run.toolCalls = r.totalToolUseCount;
      if (typeof r.totalDurationMs === 'number') run.durationMs = r.totalDurationMs;
      if (typeof r.totalTokens === 'number') run.tokens = r.totalTokens;
    }
    t.run = run;
    this.onChange(this.all());
  }

  // バックグラウンドのサブエージェントの完了通知（<task-notification>）。usage は作業中に届いた通知に付く
  notified(toolUseId: string, status: string, result: string | null, usage: TaskUsage | null = null): void {
    const t = this.runs.get(toolUseId);
    if (!t) return;
    // 同じ通知は数値の付かない形（キュー）で先に届くことがある。終わったあとに届いた数値は埋める
    if (t.run.state !== 'running' && t.run.state !== 'stopped') {
      if (!usage) return;
      t.run = {
        ...t.run,
        durationMs: usage.durationMs ?? t.run.durationMs,
        tokens: usage.totalTokens ?? t.run.tokens,
        toolCalls: usage.toolUses ?? t.run.toolCalls,
      };
      this.onChange(this.all());
      return;
    }
    t.run = {
      ...t.run,
      state: status === 'completed' ? 'done' : status === 'failed' ? 'failed' : 'stopped',
      // バックグラウンドの結果には所要時間が無いので、通知に付いていなければ起動を見た時刻から求める
      durationMs: usage?.durationMs ?? t.run.durationMs ?? (t.run.startedAt ? Date.now() - t.run.startedAt : null),
      tokens: usage?.totalTokens ?? t.run.tokens,
      toolCalls: usage?.toolUses ?? t.run.toolCalls,
      result: clipResult(this.resultOf(t.run.agentId, result)),
    };
    this.onChange(this.all());
  }

  // SubagentHandback で届いた報告。ふつうは完了通知より先に届く（会話ログの並び）ので、覚えておいて完了通知の結果にする。
  // 完了通知のあとに届いたとき（報告より先に、まだ報告していない・報告せずに終わったと知らせたもの）は、そのエージェントの結果を置き換える
  handback(agentId: string, report: string): void {
    this.reports.set(agentId, report);
    const runs = [...this.runs.values()].filter((t) => t.run.agentId === agentId);
    const t = runs.find((r) => r.run.state === 'running') ?? runs.at(-1);
    if (!t || t.run.state === 'running' || (t.run.result !== null && !HANDBACK_PLACEHOLDER.test(t.run.result))) return;
    t.run = { ...t.run, result: clipResult(report) };
    this.onChange(this.all());
  }

  // 完了通知の結果。報告の代わりの文なら、届いた報告（無ければ null）
  private resultOf(agentId: string | null, result: string | null): string | null {
    if (result === null || !HANDBACK_PLACEHOLDER.test(result)) return result;
    return agentId ? (this.reports.get(agentId) ?? null) : null;
  }

  // Claude Code が終了すると実行中のサブエージェントも止まる
  stopRunning(): void {
    let changed = false;
    for (const t of this.runs.values()) {
      if (t.run.state !== 'running') continue;
      t.run = { ...t.run, state: 'stopped' };
      changed = true;
    }
    this.stopTimer();
    if (changed) this.onChange(this.all());
  }

  dispose(): void {
    this.stopTimer();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      let changed = false;
      for (const t of this.runs.values()) {
        if (t.run.state === 'running' && t.subagentsDir) changed = (await this.update(t)) || changed;
      }
      if (changed) this.onChange(this.all());
      if (![...this.runs.values()].some((t) => t.run.state === 'running' && t.subagentsDir)) this.stopTimer();
    } finally {
      this.polling = false;
    }
  }

  private async update(t: Tracked): Promise<boolean> {
    if (!t.run.agentId) {
      const found = await findAgent(t.subagentsDir, t.run.toolUseId);
      if (!found) return false;
      t.run = { ...t.run, agentId: found.agentId, model: t.run.model ?? found.model };
    }
    const file = join(t.subagentsDir, `agent-${t.run.agentId}.jsonl`);
    const size = await stat(file).then((s) => s.size, () => 0);
    if (size <= t.offset) return false;
    const handle = await open(file, 'r');
    let text: string;
    try {
      const buf = Buffer.alloc(size - t.offset);
      await handle.read(buf, 0, buf.length, t.offset);
      const end = buf.lastIndexOf(0x0a) + 1;
      t.offset += end;
      text = buf.subarray(0, end).toString('utf8');
    } finally {
      await handle.close();
    }
    let { toolCalls, recent } = t.run;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      // ツールの呼び出しは、会話の行（@shared/transcript-line）の応答から数える（API の要求の控えにも、同じ呼び出しがもう一度入る）
      const e = isTranscriptEntry(value) ? conversationOf(value) : null;
      if (e?.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
      for (const block of e.message.content) {
        if (block.type !== 'tool_use' || !block.name) continue;
        // フォーク（subagent_type: fork）の会話ログは、そのエージェントを起こした Agent の呼び出しから始まる（その前に、親の会話の写しが
        // 並ぶこともある。サブエージェントからのフォーク）。そこまでは親の作業なので数えない（Claude Code の数え方と同じ）
        if (block.id === t.run.toolUseId) {
          toolCalls = 0;
          recent = [];
          continue;
        }
        toolCalls++;
        recent = [...recent, { name: block.name, target: toolTarget(block.input ?? {}, this.cwd) }].slice(-RECENT_TOOLS);
      }
    }
    t.run = { ...t.run, toolCalls, recent };
    return true;
  }
}

async function findAgent(dir: string, toolUseId: string): Promise<{ agentId: string; model: string | null } | null> {
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    const m = name.match(/^agent-(.+)\.meta\.json$/);
    if (!m) continue;
    const meta = await readFile(join(dir, name), 'utf8')
      .then((t) => JSON.parse(t) as { toolUseId?: string; model?: string })
      .catch(() => null);
    if (meta?.toolUseId === toolUseId) return { agentId: m[1], model: meta.model ?? null };
  }
  return null;
}

// 長い結果は切って、省いたことを書き足す
function clipResult(result: string | null): string | null {
  return result && result.length > MAX_RESULT ? `${result.slice(0, MAX_RESULT)}\n${t('main.subagent.omitted')}` : result;
}
