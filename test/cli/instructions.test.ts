import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INSTRUCTIONS_FILE, PARENT_INSTRUCTIONS_FILE } from '@shared/project-instructions';
import { buildRelay } from './browser-relay-build';
import { ClaudeRun, claudeVersion } from './claude-run';
import { MockApi } from './mock-api';

// 本物の claude をモックの API で動かし、TANACODE.md を渡す SessionStart のフック（src/main/instructions-hook.ts をビルドしたもの）と、
// 「親にする」（TANACODE_PARENT.md を読ませる発言）を確かめる。アプリと同じ起動の引数（--settings の hooks）と環境変数で起動する。
// - 新しい会話・/clear（最適化圧縮も同じ）・圧縮のあとに、今の TANACODE.md が Claude に渡る。書き換えたら、次の /clear から新しい中身
// - 再開（--resume。起動し直し・切り替え）では、最後に渡したものと同じなら渡し直さない。書き換えていれば新しい中身を渡す
// - チャットのフックの一覧には出ず（ユーザーの SessionStart のフックは出る）、Claude が知っている範囲（読んだファイル・コンテキストの中身）に出る
// - 「親にする」で、TANACODE_PARENT.md が Claude に渡り、チャットには知らせとして出る

const version = claudeVersion();
const RULES_V1 = '# プロジェクトの決まり（1）\n- 答えは日本語で書く\n';
const RULES_V2 = '# プロジェクトの決まり（2）\n- テストを足してから直す\n';
const RULES_V3 = '# プロジェクトの決まり（3）\n- 小さく分けてコミットする\n';
const PARENT_RULES = '# 親として動くときの決まり\n- 作業は子のセッションに任せる\n';
// ユーザーの SessionStart のフックが渡す文（アプリのフックと見分けられるか）
const USER_CONTEXT = 'ユーザーのフックが渡した文';

describe(`Claude Code ${version} と TANACODE.md・TANACODE_PARENT.md`, () => {
  let api: MockApi;
  let run: ClaudeRun;
  const said = (text: string) => run.chatEvents.some((e) => e.type === 'assistant-text' && e.text === text);
  // 送って、返事が来て手が空くまで待つ。その発言を送ったリクエストの、発言の文章（user と system。台本の会話のものだけ記録される）を返す
  const ask = async (text: string): Promise<string> => {
    await run.send(text);
    await run.waitUntil(`「${text}」の返事`, () => run.idle && said(`はい: ${text}`), 30_000);
    return [...api.contexts].reverse().find((c) => c.includes(text)) ?? '';
  };
  const delivered = (context: string) => context.match(/<tanacode-instructions path="[^"]*" sum="[0-9a-f]+">/g) ?? [];
  const writeRules = (text: string) => writeFileSync(join(run.cwd, INSTRUCTIONS_FILE), text);

  beforeAll(async () => {
    const script = await buildRelay('instructions-hook');
    api = new MockApi();
    // どの発言にも「はい: <発言>」と返す（台本の番号を数えない。/clear や再開で会話が変わっても同じ）。
    // リクエストの中身を控えさせるため、どの会話にも当たる台本を置く（応答は intercept が決める）
    api.conversations = [{ match: '', steps: [] }];
    api.intercept = (prompt) => (prompt ? [{ type: 'text', text: `はい: ${prompt.trim().split('\n').at(-1)}` }] : null);
    run = new ClaudeRun(await api.start(), {
      files: { [INSTRUCTIONS_FILE]: RULES_V1, [PARENT_INSTRUCTIONS_FILE]: PARENT_RULES },
      instructions: { command: process.execPath, script },
      settings: {
        hooks: {
          SessionStart: [
            { matcher: 'startup', hooks: [{ type: 'command', command: `printf '%s' '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"${USER_CONTEXT}"}}'` }] },
          ],
        },
      },
    });
    await run.open();
  }, 120_000);

  afterAll(async () => {
    await run?.stop();
    await api?.stop();
  });

  it('新しい会話の始まりに、TANACODE.md が Claude に渡る。チャットのフックの一覧には出ず、読んだファイル・コンテキストの中身に出る', async () => {
    const context = await ask('最初の発言です');
    expect(delivered(context)).toEqual([expect.stringContaining(`path="${join(run.cwd, INSTRUCTIONS_FILE)}"`)]);
    expect(context).toContain(RULES_V1.trim());
    expect(context).toContain(USER_CONTEXT);
    // ユーザーのフックの文は出し、アプリのフックは出さない
    const hooks = run.chatEvents.flatMap((e) => (e.type === 'hook' ? [e.run] : []));
    expect(hooks.some((h) => h.message.includes(USER_CONTEXT))).toBe(true);
    expect(hooks.some((h) => h.message.includes('tanacode-instructions') || (h.command ?? '').includes('TANACODE_INSTRUCTIONS_HOOK'))).toBe(false);
    await run.waitUntil('読んだファイルの印', () => run.knowledge?.files[INSTRUCTIONS_FILE] === 'read', 10_000);
    const items = (await run.manager.context(run.sessionId!)).items;
    expect(items.find((i) => i.kind === 'file' && i.label === INSTRUCTIONS_FILE)?.tokens).toBeGreaterThan(0);
  });

  it('書き換えてから /clear すると、新しい会話に今の TANACODE.md が渡る（最適化圧縮の /clear も同じ）', async () => {
    writeRules(RULES_V2);
    const switched = run.switches.length;
    await run.send('/clear');
    await run.waitUntil('/clear のあとの乗り換え', () => run.switches.length > switched && run.idle, 30_000);
    const context = await ask('消したあとの発言です');
    expect(delivered(context)).toHaveLength(1);
    expect(context).toContain(RULES_V2.trim());
    expect(context).not.toContain(RULES_V1.trim());
  });

  it('再開（--resume）では、同じ中身なら渡し直さず、書き換えていれば新しい中身を渡す', async () => {
    const restart = async () => {
      run.stopClaude();
      await run.waitUntil('終了', () => run.chatEvents.at(-1)?.type === 'process-exit', 30_000);
      run.start({ resume: true });
      await run.untilState('起動', (state) => state === 'idle', 30_000);
    };
    await restart();
    const same = await ask('再開した発言です');
    expect(delivered(same)).toHaveLength(1);
    writeRules(RULES_V3);
    await restart();
    const changed = await ask('書き換えて再開した発言です');
    expect(delivered(changed)).toHaveLength(2);
    expect(changed).toContain(RULES_V3.trim());
  });

  it('/compact で会話を圧縮すると、要約のあとに今の TANACODE.md が 1 つだけ渡る', async () => {
    await run.send('/compact');
    await run.waitUntil('圧縮', () => run.entries.some((e) => e.type === 'system' && e.subtype === 'compact_boundary') && run.idle, 60_000);
    const context = await ask('圧縮したあとの発言です');
    expect(delivered(context)).toHaveLength(1);
    expect(context).toContain(RULES_V3.trim());
  });

  it('「親にする」で、TANACODE_PARENT.md が Claude に渡り、チャットには知らせとして出る', async () => {
    await run.manager.becomeParent(run.sessionId!);
    await run.waitUntil('親にした返事', () => run.idle && api.lastPrompts.some((p) => p.includes(PARENT_RULES.trim())), 30_000);
    const prompt = api.lastPrompts.find((p) => p.includes(PARENT_RULES.trim()))!;
    expect(prompt).toContain(`<tanacode-parent-role path="${join(run.cwd, PARENT_INSTRUCTIONS_FILE)}">`);
    await run.waitUntil('知らせ', () => run.chatEvents.some((e) => e.type === 'notice' && e.text === 'TANACODE_PARENT.md を読ませて、親のセッションにしました'), 10_000);
    expect(run.chatEvents.some((e) => e.type === 'user' && e.text.includes('tanacode-parent-role'))).toBe(false);
    await run.waitUntil('読んだファイルの印', () => run.knowledge?.files[PARENT_INSTRUCTIONS_FILE] === 'read', 10_000);
  });
});
