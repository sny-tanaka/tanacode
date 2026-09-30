import { existsSync, readFileSync } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { WorkflowAgent, WorkflowRun } from '@shared/workflow';

const POLL_MS = 1000;
// 完了時の記録が起動より前に書かれたものか見るときの余裕（会話ログの時刻とファイルの更新時刻のずれ）
const CLOCK_SLACK_MS = 1000;
const PREVIEW_CHARS = 300;

// 会話ログの toolUseResult（Workflow ツールがバックグラウンドで起動したとき）
export type WorkflowLaunch = {
  toolUseId: string;
  runId: string;
  name: string;
  summary: string;
  // <セッション>/subagents/workflows/<runId>。journal.jsonl と各エージェントの会話ログがある
  transcriptDir: string;
  scriptPath: string | null;
  script: string | null;
  // 起動した時刻（会話ログの時刻）。これより前に書かれた完了の記録は、同じ runId の前の実行のもの
  launchedAt: number;
};

export function workflowLaunchOf(entry: unknown, scripts: Map<string, string>): WorkflowLaunch | null {
  const e = entry as { type?: string; timestamp?: string; message?: { content?: unknown }; toolUseResult?: Record<string, unknown> };
  const r = e.toolUseResult;
  if (e.type !== 'user' || !r || r.taskType !== 'local_workflow' || typeof r.runId !== 'string') return null;
  if (typeof r.transcriptDir !== 'string') return null;
  const block = Array.isArray(e.message?.content) ? (e.message.content[0] as { tool_use_id?: string } | undefined) : undefined;
  if (!block?.tool_use_id) return null;
  return {
    toolUseId: block.tool_use_id,
    runId: r.runId,
    name: typeof r.workflowName === 'string' ? r.workflowName : r.runId,
    summary: typeof r.summary === 'string' ? r.summary : '',
    transcriptDir: r.transcriptDir,
    scriptPath: typeof r.scriptPath === 'string' ? r.scriptPath : null,
    script: scripts.get(block.tool_use_id) ?? null,
    launchedAt: (e.timestamp && Date.parse(e.timestamp)) || Date.now(),
  };
}

type AgentLog = {
  offset: number;
  // 会話ログの最初の行の時刻（エージェントが始まった時刻）と、ファイルの更新時刻
  startedAt: number | null;
  modifiedAt: number | null;
  toolCalls: number;
  lastTool: string | null;
  prompt: string | null;
};
type Tracked = {
  run: WorkflowRun;
  launch: WorkflowLaunch;
  logs: Map<string, AgentLog>;
  journalOffset: number;
  // journal の started と result / failed に振った通し番号（エージェントの startSeq / endSeq）。
  // 再開した実行でも、前の起動からの順番がそのまま残っている（完了時の記録の時刻は、前の結果を使ったものが 0 になる）
  order: Map<string, { start: number | null; end: number | null }>;
  seq: number;
  // 完了通知（<task-notification>）の状態。完了時の記録が読めないときに使う
  notified: string | null;
  // 再開された実行は、次の起動の時刻より前に書かれたものだけを読む（そのあとは再開した実行のもの）
  until: number | null;
  // ファイルの読み込みは一度に一つずつ（ポーリング・完了通知・再開が重なっても順に読む）
  queue: Promise<unknown>;
};

// セッションのワークフローを追跡する。実行中は journal.jsonl（エージェントの開始・結果）と
// 各エージェントの会話ログ（ツールの呼び出し）を読み、完了後は workflows/<runId>.json の記録で置き換える。
// 再開（resumeFromRunId）すると同じ runId のまま同じファイルに書き足し・上書きするので、
// 再開された前の起動は、次の起動の時刻より前に始まったエージェントと、その前に書かれた完了時の記録から組み立て直す
export class WorkflowTracker {
  private readonly runs = new Map<string, Tracked>();
  // runId ごとの最後の起動（tool_use ID）
  private readonly latest = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(private readonly onChange: (runs: WorkflowRun[]) => void) {}

  all(): WorkflowRun[] {
    return [...this.runs.values()].map((t) => t.run);
  }

  // ワークフローのエージェントの会話ログ
  agentLogFile(toolUseId: string, agentId: string): string | null {
    const t = this.runs.get(toolUseId);
    return t ? join(t.launch.transcriptDir, `agent-${agentId}.jsonl`) : null;
  }

  // fromHistory: 再開時に読み直した過去の会話。以前の Claude Code で起動したものなので、完了の記録が無ければ止まっている
  add(launch: WorkflowLaunch, fromHistory: boolean): void {
    if (this.runs.has(launch.toolUseId)) return;
    const previous = this.runs.get(this.latest.get(launch.runId) ?? '');
    this.latest.set(launch.runId, launch.toolUseId);
    if (previous) {
      // 過去の会話を読み直すときは、前の起動のファイルを読み終わる前にここへ来る。
      // 読んだものも再開した実行の分が混ざっているので、次の起動の時刻までで読み直す
      previous.until = launch.launchedAt;
      previous.run = { ...previous.run, resumedLater: true };
      void this.enqueue(previous, async () => {
        reset(previous);
        await this.update(previous);
        previous.run = settled(previous.run, previous.run.status === 'running' ? (previous.notified ?? 'stopped') : previous.run.status);
      }).then(() => this.onChange(this.all()));
    }
    const run: WorkflowRun = {
      toolUseId: launch.toolUseId,
      runId: launch.runId,
      name: launch.name,
      summary: launch.summary,
      status: 'running',
      phases: phasesOf(launch.script ?? readScript(launch.scriptPath)),
      agents: [],
      startedAt: fromHistory ? null : Date.now(),
      durationMs: null,
      totalTokens: null,
      totalToolCalls: null,
      resumed: !!previous,
      resumedLater: false,
    };
    const tracked: Tracked = {
      run,
      launch,
      logs: new Map(),
      journalOffset: 0,
      order: new Map(),
      seq: 0,
      notified: null,
      until: null,
      queue: Promise.resolve(),
    };
    this.runs.set(launch.toolUseId, tracked);
    if (fromHistory) {
      void this.enqueue(tracked, async () => {
        await this.update(tracked);
        if (tracked.run.status === 'running') tracked.run = settled(tracked.run, tracked.notified ?? 'stopped');
      }).then(() => this.onChange(this.all()));
      return;
    }
    this.onChange(this.all());
    this.timer ??= setInterval(() => void this.poll(), POLL_MS);
    void this.poll();
  }

  // 完了通知（<task-notification>）。完了時の記録が読めなかったときの状態として使う
  notified(toolUseId: string, status: string): void {
    const t = this.runs.get(toolUseId);
    if (!t) return;
    // 過去の会話を読み直すときは、読み終わる前に次の起動（再開）が来ることがあるので、先に覚えておく
    t.notified = status;
    if (t.run.status !== 'running') return;
    void this.enqueue(t, async () => {
      await this.update(t);
      if (t.run.status === 'running') t.run = settled(t.run, status);
    }).then(() => this.onChange(this.all()));
  }

  // Claude Code が終了すると実行中のワークフローも止まる
  stopRunning(): void {
    let changed = false;
    for (const t of this.runs.values()) {
      if (t.run.status !== 'running') continue;
      t.run = settled(t.run, 'stopped');
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
        if (t.run.status !== 'running') continue;
        // 順番待ちのあいだに止まった・再開されたものは読まない
        changed = (await this.enqueue(t, async () => t.run.status === 'running' && (await this.update(t)))) || changed;
      }
      if (changed) this.onChange(this.all());
      if (![...this.runs.values()].some((t) => t.run.status === 'running')) this.stopTimer();
    } finally {
      this.polling = false;
    }
  }

  private enqueue<T>(t: Tracked, task: () => Promise<T>): Promise<T> {
    const next = t.queue.then(task);
    t.queue = next.catch(() => undefined);
    return next;
  }

  private async update(t: Tracked): Promise<boolean> {
    const before = JSON.stringify(t.run);
    const journal = await readNew(join(t.launch.transcriptDir, 'journal.jsonl'), t.journalOffset);
    const final = await readFinal(t.launch, t.until);
    t.journalOffset = journal.offset;
    const lines = journal.lines as { type?: string; agentId?: string; label?: string; phase?: string; result?: unknown }[];
    for (const j of lines) {
      if (!j.agentId) continue;
      const order = t.order.get(j.agentId) ?? { start: null, end: null };
      t.order.set(j.agentId, order);
      // 再開すると同じエージェントの started がもう一度書かれることがある。開始は最初、終了は最後を使う
      if (j.type === 'started' && order.start === null) order.start = t.seq++;
      else if (j.type === 'result' || j.type === 'failed') order.end = t.seq++;
    }
    if (final) {
      // 記録にあるのが、この実行のエージェントのすべて（前の起動の結果を使ったものも入っている）。
      // journal にしか無いものは、再開する前の起動で動いて、この実行では使われなかったもの
      t.run = settled({ ...t.run, ...final, agents: withOrder(final.agents, t.order) }, final.status);
      return true;
    }

    let agents = t.run.agents;
    for (const j of lines) {
      if (!j.agentId) continue;
      if (j.type === 'started' && !agents.some((a) => a.agentId === j.agentId)) {
        agents = [...agents, newAgent(j.agentId, j.label ?? null, j.phase ?? null, readModel(t.launch, j.agentId))];
      } else if (j.type === 'result') {
        const preview = typeof j.result === 'string' ? j.result : JSON.stringify(j.result);
        agents = agents.map((a) => (a.agentId === j.agentId ? { ...a, state: 'done', resultPreview: preview.slice(0, PREVIEW_CHARS) } : a));
      } else if (j.type === 'failed') {
        agents = agents.map((a) => (a.agentId === j.agentId ? { ...a, state: 'failed' } : a));
      }
    }
    agents = withOrder(agents, t.order);

    // 実行中のエージェントは会話ログからツールの呼び出しを数える
    agents = await Promise.all(
      agents.map(async (a) => {
        const log = t.logs.get(a.agentId) ?? { offset: 0, startedAt: null, modifiedAt: null, toolCalls: 0, lastTool: null, prompt: null };
        t.logs.set(a.agentId, log);
        await readAgentLog(join(t.launch.transcriptDir, `agent-${a.agentId}.jsonl`), log);
        // meta.json はエージェントの開始より少し遅れて書かれる
        const model = a.model ?? readModel(t.launch, a.agentId);
        return { ...a, model, toolCalls: log.toolCalls, lastTool: log.lastTool, promptPreview: a.promptPreview ?? log.prompt };
      }),
    );
    agents = agents.filter((a) => {
      const log = t.logs.get(a.agentId);
      // 再開された実行には、次の起動で始まったエージェントは入れない
      if (t.until !== null && log?.startedAt != null && log.startedAt >= t.until) return false;
      // 再開した実行の journal には、前の起動で始まって結果が返らないまま止まったエージェントも残っている。
      // この起動のあと会話ログが一度も書かれていないものは、この実行では動いていない
      return a.state !== 'running' || log?.modifiedAt == null || log.modifiedAt >= t.launch.launchedAt - CLOCK_SLACK_MS;
    });
    // 前の起動で動いたエージェントは、スクリプトを直して再開すると同じ名前の別のエージェントに置き換わる。
    // 置き換わったものは、この実行では使われていない（完了時の記録にも入らない）
    agents = agents.filter((a) => {
      const startedAt = t.logs.get(a.agentId)?.startedAt ?? null;
      if (startedAt === null || startedAt >= t.launch.launchedAt - CLOCK_SLACK_MS) return true;
      const seq = t.order.get(a.agentId)?.start ?? null;
      return !agents.some((b) => b !== a && b.label === a.label && b.phase === a.phase && seq !== null && (t.order.get(b.agentId)?.start ?? -1) > seq);
    });
    t.run = settled({ ...t.run, agents }, t.run.status);
    return JSON.stringify(t.run) !== before;
  }
}

function newAgent(agentId: string, label: string | null, phase: string | null, model: string | null): WorkflowAgent {
  return {
    agentId,
    label,
    phase,
    model,
    state: 'running',
    toolCalls: 0,
    lastTool: null,
    promptPreview: null,
    resultPreview: null,
    tokens: null,
    durationMs: null,
    startSeq: null,
    endSeq: null,
  };
}

type FinalRecord = Pick<WorkflowRun, 'status' | 'phases' | 'agents' | 'durationMs' | 'totalTokens' | 'totalToolCalls'> & {
  summary?: string;
};

// 完了時の記録: <セッション>/workflows/<runId>.json。起動より前に書かれたものは、再開する前の実行の記録なので使わない。
// until（再開した起動の時刻）より後に書かれたものは、再開した実行の記録
async function readFinal(launch: WorkflowLaunch, until: number | null): Promise<FinalRecord | null> {
  const sessionDir = dirname(dirname(dirname(launch.transcriptDir)));
  const file = join(sessionDir, 'workflows', `${launch.runId}.json`);
  const written = await stat(file).then((s) => s.mtimeMs, () => null);
  if (written === null || written < launch.launchedAt - CLOCK_SLACK_MS) return null;
  if (until !== null && written >= until) return null;
  const text = await readFile(file, 'utf8').catch(() => null);
  if (!text) return null;
  try {
    const d = JSON.parse(text) as {
      status?: string;
      summary?: string;
      phases?: { title?: string; detail?: string }[];
      workflowProgress?: Record<string, unknown>[];
      durationMs?: number;
      totalTokens?: number;
      totalToolCalls?: number;
    };
    const progress = (d.workflowProgress ?? []).filter((p) => p.type === 'workflow_agent' && typeof p.agentId === 'string');
    const agents = progress.map((p) => ({
      ...newAgent(p.agentId as string, str(p.label), str(p.phaseTitle), str(p.model)),
      // 止まった実行（killed）では、動いていたものが progress・start のまま残る。settled で stopped にする
      state: p.state === 'done' ? ('done' as const) : p.state === 'error' || p.state === 'failed' ? ('failed' as const) : ('running' as const),
      toolCalls: num(p.toolCalls) ?? 0,
      lastTool: str(p.lastToolName),
      promptPreview: str(p.promptPreview),
      resultPreview: str(p.resultPreview)?.slice(0, PREVIEW_CHARS) ?? null,
      tokens: num(p.tokens),
      durationMs: num(p.durationMs),
    }));
    numberByTime(agents, progress);
    // 子ワークフローのフェーズ（「▸ 名前」）も workflowProgress にしか無いので、そちらから集める
    const phaseTitles = (d.workflowProgress ?? []).filter((p) => p.type === 'workflow_phase').map((p) => str(p.title) ?? '');
    const details = new Map((d.phases ?? []).map((p) => [p.title ?? '', p.detail ?? null]));
    return {
      status: d.status ?? 'completed',
      summary: d.summary,
      phases: phaseTitles.map((title) => ({ title, detail: details.get(title) ?? null })),
      agents,
      durationMs: num(d.durationMs),
      totalTokens: num(d.totalTokens),
      totalToolCalls: num(d.totalToolCalls),
    };
  } catch {
    return null;
  }
}

// journal の順番を当てる。journal に無いエージェントがあれば（古い実行など）、完了時の記録の時刻から振った番号のままにする
function withOrder(agents: WorkflowAgent[], order: Tracked['order']): WorkflowAgent[] {
  if (!agents.every((a) => order.get(a.agentId)?.start != null)) return agents;
  return agents.map((a) => ({ ...a, startSeq: order.get(a.agentId)!.start, endSeq: order.get(a.agentId)!.end }));
}

// 完了時の記録の開始時刻（startedAt）と所要時間から、開始・終了に通し番号を振る
function numberByTime(agents: WorkflowAgent[], progress: Record<string, unknown>[]): void {
  const events: { at: number; agent: WorkflowAgent; end: boolean }[] = [];
  agents.forEach((agent, i) => {
    const start = num(progress[i]?.startedAt);
    if (start === null) return;
    events.push({ at: start, agent, end: false });
    if (agent.state !== 'running' && agent.durationMs !== null) events.push({ at: start + agent.durationMs, agent, end: true });
  });
  // 同じ時刻なら終了を先にする（終わった直後に次が始まったものを、順に動いたとみなす）
  events.sort((a, b) => a.at - b.at || Number(b.end) - Number(a.end));
  events.forEach((e, seq) => {
    if (e.end) e.agent.endSeq = seq;
    else e.agent.startSeq = seq;
  });
}

// 読んだものを捨てて、最初から読み直せるようにする
function reset(t: Tracked): void {
  t.logs.clear();
  t.journalOffset = 0;
  t.order.clear();
  t.seq = 0;
  t.run = {
    ...t.run,
    summary: t.launch.summary,
    status: 'running',
    phases: phasesOf(t.launch.script ?? readScript(t.launch.scriptPath)),
    agents: [],
    durationMs: null,
    totalTokens: null,
    totalToolCalls: null,
  };
}

// 実行が止まった・終わったら、結果が返らないままのエージェントも止まっている
function settled(run: WorkflowRun, status: WorkflowRun['status']): WorkflowRun {
  if (status === 'running') return { ...run, status };
  return { ...run, status, agents: run.agents.map((a) => (a.state === 'running' ? { ...a, state: 'stopped' } : a)) };
}

// スクリプト先頭の meta.phases からフェーズ名を拾う（実行中の表示用。完了後は記録で置き換わる）
function phasesOf(script: string | null): WorkflowRun['phases'] {
  const block = script?.match(/phases\s*:\s*\[([\s\S]*?)\]\s*,?\s*\n?\s*\}/)?.[1];
  if (!block) return [];
  return [...block.matchAll(/\{([^{}]*)\}/g)]
    .map((m) => {
      const title = m[1].match(/title\s*:\s*(['"`])(.*?)\1/)?.[2];
      const detail = m[1].match(/detail\s*:\s*(['"`])(.*?)\1/)?.[2] ?? null;
      return title ? { title, detail } : null;
    })
    .filter((p): p is { title: string; detail: string | null } => p !== null);
}

function readScript(path: string | null): string | null {
  if (!path) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function readModel(launch: WorkflowLaunch, agentId: string): string | null {
  const file = join(launch.transcriptDir, `agent-${agentId}.meta.json`);
  if (!existsSync(file)) return null;
  try {
    return str((JSON.parse(readFileSync(file, 'utf8')) as { model?: unknown }).model);
  } catch {
    return null;
  }
}

async function readNew(file: string, offset: number): Promise<{ offset: number; modifiedAt: number | null; lines: unknown[] }> {
  const { size, modifiedAt } = await stat(file).then(
    (s) => ({ size: s.size, modifiedAt: s.mtimeMs }),
    () => ({ size: 0, modifiedAt: null }),
  );
  if (size <= offset) return { offset, modifiedAt, lines: [] };
  const handle = await open(file, 'r');
  try {
    const buf = Buffer.alloc(size - offset);
    await handle.read(buf, 0, buf.length, offset);
    const end = buf.lastIndexOf(0x0a) + 1;
    return { offset: offset + end, modifiedAt, lines: parseLines(buf.subarray(0, end)) };
  } finally {
    await handle.close();
  }
}

async function readAgentLog(file: string, log: AgentLog): Promise<void> {
  const { offset, modifiedAt, lines } = await readNew(file, log.offset);
  log.offset = offset;
  log.modifiedAt = modifiedAt;
  for (const line of lines) {
    const e = line as { type?: string; timestamp?: string; message?: { content?: unknown } };
    if (log.startedAt === null && e.timestamp) log.startedAt = Date.parse(e.timestamp) || null;
    const content = e.message?.content;
    if (e.type === 'user' && typeof content === 'string' && log.prompt === null) log.prompt = content.slice(0, PREVIEW_CHARS);
    if (e.type === 'assistant' && Array.isArray(content)) {
      for (const block of content as { type?: string; name?: string }[]) {
        if (block.type !== 'tool_use') continue;
        log.toolCalls++;
        log.lastTool = block.name ?? null;
      }
    }
  }
}

function parseLines(buf: Buffer): unknown[] {
  const out: unknown[] = [];
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // 書きかけの行は次回読む
    }
  }
  return out;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
