import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { line, ScriptedApp } from './helpers/scripted-claude';

// 会話ログの行の振り分け（SessionManager の handleEntry）。行の種類は 1 回だけ分け（@shared/transcript-line）、
// 読み手（裏のタスクの追跡・読んだファイル・コンテキストの中身・書いている途中の文・巻き戻し・チャット）には、要る種類の行だけを渡す

let app: ScriptedApp;
beforeEach(() => {
  app = new ScriptedApp();
});
afterEach(() => {
  vi.restoreAllMocks();
  app.dispose();
});

// API に送った要求の控え（2.1.301 から）。前の tool_use と tool_result が、toolUseResult なしでもう一度入る（uuid は無い）
const copy = (role: 'user' | 'assistant', content: unknown[]) => ({ type: 'api-request-blob', hash: `h-${role}`, message: { role, content } });
const AGENT_INPUT = { description: '調べもの', prompt: '調べて', run_in_background: true };

describe('会話ログの行の振り分け', () => {
  it('API の要求の控え・意図して捨てる行・知らない行は、どの読み手にも渡さない。知らない行だけを、未知のイベントとしてチャットに出す', async () => {
    const { id } = app.create();
    await app.ready(id);
    const rt = app.manager['runtimes'].get(id)!;
    const readers = {
      tasks: vi.spyOn(rt.tasks, 'track'),
      knowledge: vi.spyOn(rt.knowledge, 'handle'),
      context: vi.spyOn(rt.context, 'handle'),
      partial: vi.spyOn(rt.partial, 'cover'),
    };
    app.append(
      id,
      line.user('調べて'),
      copy('assistant', [{ type: 'tool_use', id: 'toolu_copy', name: 'Agent', input: AGENT_INPUT }]),
      copy('user', [{ type: 'tool_result', tool_use_id: 'toolu_copy', content: 'Async agent launched successfully.' }]),
      { type: 'file-history-snapshot', messageId: 'm1' },
      // 知らない種類の行（会話の行と同じ形の中身があっても読まない）
      { type: 'brand-new', uuid: 'n1', version: '2.1.999', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_new', name: 'Bash', input: { command: 'sleep 9', run_in_background: true } }] } },
      line.text('おわり'),
    );
    await app.waitFor('最後の応答', () => app.events(id).some((e) => e.type === 'assistant-text' && e.text === 'おわり'));

    // 読み手に届いたのは、発言と応答の行だけ
    for (const spy of Object.values(readers)) expect(spy.mock.calls.map(([entry]) => entry.type)).toEqual(['user', 'assistant']);
    expect(app.manager.subagents(id)).toEqual([]);
    expect(app.manager.summary(id)?.backgroundTasks).toBe(0);
    // チャットには、知らない行の未知のイベントだけが増える（控えの発言・応答は出ない）
    expect(app.events(id).filter((e) => e.type === 'unknown-event')).toMatchObject([{ name: 'brand-new', source: 'transcript', version: '2.1.999', id: 'unknown:n1' }]);
    expect(app.events(id).flatMap((e) => (e.type === 'user' || e.type === 'assistant-text' ? [e.text] : []))).toEqual(['調べて', 'おわり']);
  });

  it('ほかで使う付帯の行（名前・順番待ち）は、名前と裏のタスクの追跡に渡し、読んだファイル・コンテキストの中身には渡さない', async () => {
    const { id } = app.create();
    await app.ready(id);
    const rt = app.manager['runtimes'].get(id)!;
    const tasks = vi.spyOn(rt.tasks, 'track');
    const knowledge = vi.spyOn(rt.knowledge, 'handle');
    const context = vi.spyOn(rt.context, 'handle');
    app.append(id, { type: 'custom-title', customTitle: '付けた名前' }, { type: 'queue-operation', operation: 'enqueue', content: '追加の頼み' }, line.text('はい'));
    await app.waitFor('応答', () => app.events(id).some((e) => e.type === 'assistant-text'));
    expect(app.manager.summary(id)?.title).toBe('付けた名前');
    expect(tasks.mock.calls.map(([entry]) => entry.type)).toEqual(['custom-title', 'queue-operation', 'assistant']);
    expect(knowledge.mock.calls.map(([entry]) => entry.type)).toEqual(['assistant']);
    expect(context.mock.calls.map(([entry]) => entry.type)).toEqual(['assistant']);
  });
});
