import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeRun, claudeVersion } from './claude-run';
import { MockApi } from './mock-api';

// 本物の claude をモックの API で動かし、子セッションの権限モードの上限にする親のモード（SessionManager.modeOf）が、
// 止まっていたセッションを開き直したときにも、claude の今のモードに合うかを確かめる。
// 開き直すときの権限モードは、新しいセッションと同じ決まり（設定の defaultMode、無ければ auto、使えなければ default）で決め、
// 前回のモードは引き継がない（決めたこと）

const PROMPT = '権限モードの確認を始めます';
const AFTER_REOPEN = '開き直したあとの発言です';

const version = claudeVersion();

describe(`Claude Code ${version} の権限モード`, () => {
  let api: MockApi;
  let run: ClaudeRun;
  const replied = (text: string) => () => run.chatEvents.some((e) => e.type === 'assistant-text' && e.text === text);

  beforeAll(async () => {
    api = new MockApi();
    api.conversations = [{ match: PROMPT, steps: [[{ type: 'text', text: 'はじめの返事' }], [{ type: 'text', text: '開き直したあとの返事' }]] }];
    run = new ClaudeRun(await api.start(), { mode: 'acceptEdits' });
    await run.open();
  });

  afterAll(async () => {
    await run?.stop();
    await api?.stop();
  });

  it('開き直すと、権限モードは新しいセッションと同じ決まりで決め（前回のモードは引き継がない）、上限は Claude Code の今のモードになる', async () => {
    await run.send(PROMPT);
    await run.waitUntil('はじめの返事', replied('はじめの返事'));
    expect(run.manager.modeOf(run.sessionId!)).toBe('acceptEdits');
    run.stopClaude();
    await run.reopen();
    expect(run.manager.parentOf(run.sessionId!)).toBeNull();
    await run.untilState('待機中', (state) => state === 'idle');
    const mode = run.manager.modeOf(run.sessionId!);
    expect(mode).not.toBeNull();
    expect(mode).not.toBe('acceptEdits');
    await run.send(AFTER_REOPEN);
    await run.waitUntil('開き直したあとの返事', replied('開き直したあとの返事'));
    // 今の claude は、発言の行に今のモードを書く。上限はそのモードのまま
    expect(run.entries.some((e) => e.type === 'user' && e.permissionMode && e.permissionMode !== 'acceptEdits')).toBe(true);
    expect(run.manager.modeOf(run.sessionId!)).toBe(mode);
  });
});
