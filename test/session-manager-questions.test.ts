import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AskQuestion } from '@shared/screen';
import { QUESTION_HOOK_ENV } from '@shared/chat';
import { QUESTION_SESSION_ENV, QUESTION_SOCKET_ENV } from '../src/main/question-hook';
import { QUESTION } from './scenario';
import { fixtureScreen, line, ScriptedApp } from './helpers/scripted-claude';

// SessionManager の、フック（question-hook.ts）が答えを待っている AskUserQuestion（本物の claude なしで動かす）。
// 返事を待つ・状態と操作待ちの種類・通知・画面への知らせ・待つのをやめる（人がターミナルで答えた・終わった・アーカイブ・フックが止められた）

let app: ScriptedApp;
const LAUNCH = { command: '/app/Helper', script: '/app/question-hook.js', socketPath: '/data/question.sock', version: '1.0.0' };
beforeEach(() => {
  app = new ScriptedApp({ questionHook: () => LAUNCH });
});
afterEach(() => app.dispose());

const SECOND: AskQuestion = { question: 'テストも書きますか？', header: 'テスト', multiSelect: false, options: [{ label: '書く', description: '' }, { label: '書かない', description: '' }] };
const input = (...questions: AskQuestion[]) => ({ questions });
// フックに返す結果（JSON）
const replyOf = async (result: Promise<{ content: { type: string; text?: string }[] }>) => JSON.parse((await result).content[0].text!) as unknown;

// 動いているセッションで、フックが質問を渡す。返事の結果（Promise）と、つながりを切る口を返す
async function asked(...questions: AskQuestion[]) {
  const { id, pty } = app.create();
  await app.ready(id);
  const hook = new AbortController();
  const result = app.manager.waitQuestion(id, input(...questions), hook.signal);
  await app.waitFor('待っている質問', () => app.manager.pendingQuestion(id) !== null);
  return { id, pty, result, hook, question: app.manager.pendingQuestion(id)! };
}

describe('フックが答えを待っている質問', () => {
  it('起動する Claude Code に、質問のフック（PermissionRequest）と、フックが使う環境変数を足す', async () => {
    const { pty } = app.create();
    const settings = JSON.parse(pty.arg('--settings')!) as { hooks: { PermissionRequest?: { matcher: string; hooks: { command: string; timeout: number }[] }[] } };
    expect(settings.hooks.PermissionRequest).toEqual([{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: expect.stringContaining(QUESTION_HOOK_ENV), timeout: 86400 }] }]);
    expect(pty.request.env).toMatchObject({ [QUESTION_SOCKET_ENV]: LAUNCH.socketPath, [QUESTION_SESSION_ENV]: expect.any(String) });
  });

  it('待っている間は質問中で、画面に知らせ、通知を 1 回出す。返事をすると、フックにその返事を返し、待っている質問が消える', async () => {
    const { id, pty, result, question } = await asked(QUESTION);
    expect(question).toMatchObject({ questions: [QUESTION], answered: {} });
    expect(app.manager.stateOf(id)).toBe('question');
    expect(app.manager.summary(id)?.attention).toBe('question');
    expect(app.questionLog.at(-1)).toEqual({ id, question });
    // 通知の本文は質問文（画面に質問が出るより先に、フックが質問を渡す）
    expect(app.attentions).toEqual([{ id, attention: { kind: 'menu', menu: expect.objectContaining({ kind: 'question', title: QUESTION.question }) } }]);
    // 画面に同じ質問が出ても、通知を出し直さない
    pty.output(fixtureScreen('question'));
    await app.waitFor('画面の質問', () => app.screens.get(id)?.state.kind === 'menu');
    expect(app.attentions).toHaveLength(1);
    expect(app.manager.replyQuestion(id, question.id, { kind: 'answer', answers: { [QUESTION.question]: 'だ・である' } })).toBe(true);
    expect(await replyOf(result)).toEqual({ kind: 'answer', answers: { [QUESTION.question]: 'だ・である' } });
    expect(app.manager.pendingQuestion(id)).toBeNull();
    expect(app.questionLog.at(-1)).toEqual({ id, question: null });
    // もう待っていない質問には返事を渡せない
    expect(app.manager.replyQuestion(id, question.id, { kind: 'chat' })).toBe(false);
  });

  it('画面を読めなくても（認識できない画面）、待っている質問があれば質問中。画面に許可の確認が出ていれば、そちらを見せる', async () => {
    const { id, pty } = await asked(QUESTION);
    pty.output('\x1b[H\x1b[2J何かの画面');
    await app.waitFor('認識できない画面', () => app.screens.get(id)?.state.kind === 'unknown', 3000);
    expect(app.manager.summary(id)?.attention).toBe('question');
    expect(app.manager.stateOf(id)).toBe('question');
    pty.output(fixtureScreen('bash-permission'));
    await app.waitFor('許可の確認', () => app.manager.summary(id)?.attention === 'permission');
  });

  it('親は 1 問ずつ答え、全部そろったら、まとめてフックに返す', async () => {
    const { id, result, question } = await asked(QUESTION, SECOND);
    expect(app.manager.answerPendingQuestion(id, question.id, QUESTION.question, 'です・ます')).toBe('waiting');
    expect(app.manager.pendingQuestion(id)?.answered).toEqual({ [QUESTION.question]: 'です・ます' });
    expect(app.questionLog.at(-1)?.question?.answered).toEqual({ [QUESTION.question]: 'です・ます' });
    expect(app.manager.answerPendingQuestion(id, question.id, SECOND.question, '書く')).toBe('sent');
    expect(await replyOf(result)).toEqual({ kind: 'answer', answers: { [QUESTION.question]: 'です・ます', [SECOND.question]: '書く' } });
    expect(app.manager.answerPendingQuestion(id, question.id, SECOND.question, '書く')).toBeNull();
  });

  it('人がターミナルで答えた（会話ログに答えが出た）ら、待つのをやめる。違う質問の答えでは、やめない', async () => {
    const { id, result } = await asked(QUESTION);
    app.append(id, line.toolUse('toolu_other', 'AskUserQuestion', input(SECOND)), line.toolResult('toolu_other', 'answered'));
    await new Promise((r) => setTimeout(r, 300));
    expect(app.manager.pendingQuestion(id)).not.toBeNull();
    app.append(id, line.toolUse('toolu_ask', 'AskUserQuestion', input(QUESTION)), line.toolResult('toolu_ask', 'answered'));
    expect(await replyOf(result)).toEqual({ kind: 'none' });
    expect(app.manager.pendingQuestion(id)).toBeNull();
  });

  it('Claude Code が終わった・アーカイブした・フックが止められた（つながりが切れた）ら、待つのをやめる', async () => {
    const exited = await asked(QUESTION);
    exited.pty.exit(0);
    expect(await replyOf(exited.result)).toEqual({ kind: 'none' });
    const archived = await asked(QUESTION);
    await app.manager.archive(archived.id);
    expect(await replyOf(archived.result)).toEqual({ kind: 'none' });
    const aborted = await asked(QUESTION);
    aborted.hook.abort();
    expect(await replyOf(aborted.result)).toEqual({ kind: 'none' });
    expect(app.manager.pendingQuestion(aborted.id)).toBeNull();
  });

  it('動いていないセッション・質問の形でない入力は、待たずに何も決めない', async () => {
    const { id, pty } = app.create();
    await app.ready(id);
    expect(await replyOf(app.manager.waitQuestion(id, { questions: 'x' }, new AbortController().signal))).toEqual({ kind: 'none' });
    pty.exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
    expect(await replyOf(app.manager.waitQuestion(id, input(QUESTION), new AbortController().signal))).toEqual({ kind: 'none' });
    expect(app.manager.pendingQuestion(id)).toBeNull();
  });
});
