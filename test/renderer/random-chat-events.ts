import type { ChatEvent, HookRun } from '@shared/chat';

// チャットのイベントの、決まった順の作り物の列（chat-rows.test.tsx）。行を探して書き換えるイベント（ツールの結果・hooks・再試行のエラー・
// shell の出力・未知のイベント）が、同じ id で何度も当たるよう、id は少ない種類から選ぶ

export function random(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
}

const pick = <T>(rnd: () => number, list: readonly T[]): T => list[Math.floor(rnd() * list.length)];

function hookRun(rnd: () => number): HookRun {
  const event = pick(rnd, ['PreToolUse', 'PostToolUse', 'Stop', 'PermissionRequest']);
  return {
    event,
    name: event,
    command: pick(rnd, ['echo a', 'echo b', null]),
    outcome: 'success',
    exitCode: 0,
    durationMs: 1,
    stdout: '',
    stderr: '',
    message: '',
    toolUseId: pick(rnd, ['t1', 't2', 't3', null]),
  };
}

function event(rnd: () => number, serial: number, depth: number): ChatEvent {
  const id = `e${serial}`;
  const tool = pick(rnd, ['t1', 't2', 't3', 't4']);
  switch (pick(rnd, ['user', 'text', 'text', 'thinking', 'use', 'use', 'result', 'result', 'end', 'error', 'hook', 'unknown', 'shell', 'output', 'info', 'misc', 'rare'])) {
    case 'user':
      return { type: 'user', id, text: 'u' };
    case 'text':
      return { type: 'assistant-text', id, text: 'a' };
    case 'thinking':
      return { type: 'thinking', id, text: 't' };
    case 'use':
      return { type: 'tool-use', id: tool, name: pick(rnd, ['Bash', 'AskUserQuestion', 'TaskCreate']), target: '', input: '', taskChange: rnd() < 0.2 ? { kind: 'create', subject: 's' } : undefined };
    case 'result':
      return { type: 'tool-result', id: tool, isError: rnd() < 0.3, output: `o${serial}`, createdTaskId: rnd() < 0.2 ? `${serial}` : undefined };
    case 'end':
      return { type: 'turn-end' };
    case 'error':
      return { type: 'api-error', id: pick(rnd, ['x1', 'x2']), text: 'e', retrying: rnd() < 0.6 };
    case 'hook':
      return { type: 'hook', id, run: hookRun(rnd) };
    case 'unknown':
      return { type: 'unknown-event', id: pick(rnd, ['k1', 'k2', id]), name: pick(rnd, ['a', 'b']), problem: 'unknown', source: pick(rnd, ['stream', 'transcript']), raw: '{}' };
    case 'shell':
      return { type: 'shell', id, command: 'ls', output: rnd() < 0.5 ? '' : 'out' };
    case 'output':
      return { type: 'shell-output', id, output: 'out' };
    case 'info':
      return { type: 'info', id, text: 'i' };
    case 'misc':
      return pick<ChatEvent>(rnd, [{ type: 'divider', id, text: 'd' }, { type: 'notice', id, text: 'n' }, { type: 'turn-start' }, { type: 'ready' }, { type: 'checklist-stop' }]);
    default:
      // 行をまとめて消す・作り直すもの（まれ）
      if (depth > 0) return { type: 'info', id, text: 'i' };
      return pick<ChatEvent>(rnd, [
        { type: 'reset', compact: rnd() < 0.5 ? true : undefined },
        { type: 'process-start' },
        { type: 'process-exit', exitCode: 0 },
        { type: 'replace', events: randomChatEvents(rnd, 1 + Math.floor(rnd() * 8), serial * 100, 1) },
      ]);
  }
}

export function randomChatEvents(rnd: () => number, count: number, start = 0, depth = 0): ChatEvent[] {
  return Array.from({ length: count }, (_, i) => event(rnd, start + i, depth));
}
