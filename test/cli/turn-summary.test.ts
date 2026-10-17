import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeRun, claudeVersion } from './claude-run';
import { MockApi } from './mock-api';

// 本物の claude をモックの API で動かし、Remote Control のターンの終わりの要約が、チャットの完了を待たせないかを確かめる。
// Remote Control でつないでいると、Claude Code はターンの終わりに、スマホ・claude.ai のセッションの一覧に出す要約
// （system/post_turn_summary）を作る。モデルで作るとき、-p（stream-json）では作り終えるまで Stop フックと result を出さない
// （作業中が 1 回 1.5〜5.5 秒延びた。2.1.302 で実測。TUI では裏で作るので待たない）。アプリはチャットの claude に
// CLAUDE_CODE_CLASSIFIER_SUMMARY=0 を渡して、モデルを呼ばずに作らせる（claudeEnv）。
// モックでは、Remote Control のつながりを CLAUDE_CODE_ENVIRONMENT_KIND=bridge で、アカウントでモデルの要約が有効なこと（サーバーの
// フラグ。モックでは配れない）を CLAUDE_CODE_CLASSIFIER_SUMMARY=1 で同じ状態にする（アプリが渡す値が、台本の env より優先される）。
// 要約の呼び出しはツールの一覧が付かないので、モックはその返事を止めておき、止めたままでもターンが終わるかを見る（ターンの終わりの
// あとにアプリが頼むタイトル作りも止まるが、ターンの終わりには関わらない）

const PROMPT = 'ターンの終わりの要約を確かめます';
const REPLY = '確かめました';

const version = claudeVersion();

describe(`Claude Code ${version} の Remote Control のターンの終わりの要約`, () => {
  let api: MockApi;
  let run: ClaudeRun;
  let release: () => void = () => {};

  beforeAll(async () => {
    api = new MockApi();
    api.conversations = [{ match: PROMPT, steps: [[{ type: 'text', text: REPLY }]] }];
    api.holdPlain = new Promise<void>((resolve) => (release = resolve));
    run = new ClaudeRun(await api.start(), { env: { CLAUDE_CODE_ENVIRONMENT_KIND: 'bridge', CLAUDE_CODE_CLASSIFIER_SUMMARY: '1' } });
    await run.open();
    await run.send(PROMPT);
  }, 60_000);

  afterAll(async () => {
    release();
    await run?.stop();
    await api?.stop();
  });

  it('要約をモデルに頼まず、その返事を待たずにターンを終える（作業中から待機中に戻り、完了を知らせる）', async () => {
    await run.waitUntil('要約の返事を止めたまま手が空く', () => run.idle);
    expect(run.turnsCompleted).toHaveLength(1);
  });

  it('要約そのものは出る（Remote Control のセッションの一覧には、応答の文から作った一言が出る）', () => {
    const summaries = run
      .streamLines()
      .map((line) => JSON.parse(line) as { type?: string; subtype?: string; status_detail?: string })
      .filter((m) => m.type === 'system' && m.subtype === 'post_turn_summary');
    expect(summaries.map((m) => m.status_detail)).toEqual([REPLY]);
  });
});
