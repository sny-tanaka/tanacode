// サブエージェントが SubagentHandback で返した報告。Claude Code は、報告を「別の Claude からの知らせ」として本体に届け、
// 完了通知（<task-notification>）の <result> には報告の代わりの文を書く（2.1.296 から）。
// 届け方は 3 つの行で、どれにも同じ報告が入る（会話ログの並びは、いつも完了通知より先。2.1.302 の手元の会話ログ）:
// - queue-operation の enqueue: `<agent-message from="エージェントの ID">` の囲みの中に、枠の行と報告
// - 待機中に届いた: isMeta の user 行。origin が {kind:'peer', from, senderTaskId, name, body, handback:true, handbackReportText（2.1.302 から）}
// - 作業中に届いた: attachment の queued_command。origin は同じ

export type Handback = {
  // 報告したエージェントの ID（Agent の結果の agentId・完了通知の <task-id> と同じ）
  agentId: string;
  // エージェントの種類（general-purpose など）。無ければ ID
  name: string;
  report: string;
  // 枠の行より前の注記（auto モードの警告など）。無ければ null
  note: string | null;
};

// 報告の前に付く枠の行（Claude Code が付ける。報告の行は、どれも 2 字下げ）
const FRAME_START = '[Subagent hand-back]';
const FRAME_END = 'The report follows:';

// user 行・attachment の origin から読む
export function handbackOf(origin: unknown): Handback | null {
  const o = (origin && typeof origin === 'object' ? origin : {}) as Record<string, unknown>;
  if (o.kind !== 'peer' || o.handback !== true) return null;
  const agentId = text(o.senderTaskId) || text(o.from);
  if (!agentId) return null;
  const body = typeof o.body === 'string' ? o.body : null;
  const parts = body === null ? null : splitHandback(body);
  const report = typeof o.handbackReportText === 'string' ? o.handbackReportText : (parts?.report ?? body);
  if (report === null) return null;
  const note = typeof o.handbackNote === 'string' ? o.handbackNote : (parts?.note ?? null);
  return { agentId, name: text(o.name) || agentId, report: report.trim(), note: note?.trim() || null };
}

// queue-operation の enqueue の中身（`<agent-message from="…">…</agent-message>`）から読む。サブエージェントの報告でなければ null
export function handbackOfMessage(content: unknown): Handback | null {
  if (typeof content !== 'string') return null;
  const m = content.match(/^<agent-message from="([^"]+)">\n?([\s\S]*?)\n?<\/agent-message>\s*$/);
  if (!m) return null;
  const parts = splitHandback(m[2]);
  return parts ? { agentId: m[1], name: m[1], ...parts } : null;
}

// 枠の行より後ろを報告（2 字下げを外す）、前を注記にする。枠の行が無い・報告の行が 2 字下げでないなら null（Claude Code と同じ読み方）
function splitHandback(body: string): { report: string; note: string | null } | null {
  const lines = body.split('\n');
  const at = lines.findIndex((l) => l.startsWith(FRAME_START) && l.trimEnd().endsWith(FRAME_END));
  if (at === -1) return null;
  const rest = lines.slice(at + 1);
  if (!rest.every((l) => l === '' || l.startsWith('  '))) return null;
  return { report: rest.map((l) => l.slice(2)).join('\n').trim(), note: lines.slice(0, at).join('\n').trim() || null };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
