import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeRun, claudeVersion } from './claude-run';
import { MockApi } from './mock-api';

// 本物の claude をモックの API で動かし、子セッションの権限モードの上限にする親のモード（SessionManager.modeOf）が、
// アプリがモードを渡さずに起動したときにも、claude の今のモードに合うかを確かめる。
// 止まっているセッションを一覧から開く（open）と、子でないセッションは --permission-mode を付けずに --resume で起動する。
// Claude Code は前回のモードを戻すので、アプリが決めたモードだけを見ていると、画面は acceptEdits なのに上限は manual になる（実際に起きた）

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

  it('モードを渡さずに開き直すと、Claude Code は前回のモードを戻し、上限も次の発言からそのモードになる', async () => {
    await run.send(PROMPT);
    await run.waitFor('はじめの返事', replied('はじめの返事'));
    expect(run.manager.modeOf(run.sessionId!)).toBe('acceptEdits');
    run.stopClaude();
    await run.reopen();
    expect(run.manager.parentOf(run.sessionId!)).toBeNull();
    await run.waitFor('入力欄', (info) => info.state.kind === 'prompt' && info.ready);
    // --permission-mode を付けずに起動しても、前回のモードに戻っている
    await run.waitFor('戻ったモード', (info) => info.mode === 'acceptEdits');
    await run.send(AFTER_REOPEN);
    await run.waitFor('開き直したあとの返事', replied('開き直したあとの返事'));
    // 今の claude は、発言の行に今のモードを書く
    expect(run.entries.some((e) => e.type === 'user' && e.permissionMode === 'acceptEdits')).toBe(true);
    expect(run.manager.modeOf(run.sessionId!)).toBe('acceptEdits');
  });
});
