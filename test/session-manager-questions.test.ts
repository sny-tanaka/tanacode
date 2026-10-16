import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AskQuestion } from '@shared/screen';
import { QUESTION_HOOK_ENV } from '@shared/chat';
import { QUESTION_SESSION_ENV, QUESTION_SOCKET_ENV } from '../src/main/question-hook';
import { QUESTION } from './scenario';
import { ScriptedApp } from './helpers/scripted-claude';

// SessionManager の、フック（question-hook.ts）が答えを待っている AskUserQuestion（本物の claude なしで動かす）。
// 返事を待つ・状態と操作待ちの種類・通知・画面への知らせ・待つのをやめる（終わった・アーカイブ・フックが止められた）。
// stream-json では、質問は can_use_tool で受け取るので、フックは Claude Code に足さない（質問の待ちは、順番 4 で「待っている要求」に広げる）

let app: ScriptedApp;
beforeEach(() => {
  app = new ScriptedApp();
});
afterEach(() => app.dispose());

const SECOND: AskQuestion = { question: 'テストも書きますか？', header: 'テスト', multiSelect: false, options: [{ label: '書く', description: '' }, { label: '書かない', description: '' }] };
const input = (...questions: AskQuestion[]) => ({ questions });
// フックに返す結果（JSON）
const replyOf = async (result: Promise<{ content: { type: string; text?: string }[] }>) => JSON.parse((await result).content[0].text!) as unknown;

// 動いているセッションで、フックが質問を渡す。返事の結果（Promise）と、つながりを切る口を返す
async function asked(...questions: AskQuestion[]) {
  const { id, pipe } = app.create();
  await app.ready(id);
  const hook = new AbortController();
  const result = app.manager.waitQuestion(id, input(...questions), hook.signal);
  await app.waitFor('待っている質問', () => app.manager.pendingQuestion(id) !== null);
  return { id, pipe, result, hook, question: app.manager.pendingQuestion(id)! };
}

describe('フックが答えを待っている質問', () => {
  it('起動する Claude Code に、質問のフックを足さない（質問は stream-json の can_use_tool で受け取る。PermissionRequest は書くだけのフック）', async () => {
    const { pipe } = app.create();
    const settings = JSON.parse(pipe.arg('--settings')!) as { hooks: { PermissionRequest?: { matcher: string; hooks: { command: string; timeout: number }[] }[] } };
    expect(settings.hooks.PermissionRequest).toEqual([{ matcher: '*', hooks: [{ type: 'command', command: expect.not.stringContaining(QUESTION_HOOK_ENV), timeout: 10 }] }]);
    expect(pipe.request.env[QUESTION_SOCKET_ENV]).toBeUndefined();
    expect(pipe.request.env[QUESTION_SESSION_ENV]).toBeUndefined();
  });

  it('待っている間は質問中で、画面に知らせ、通知を 1 回出す。返事をすると、フックにその返事を返し、待っている質問が消える', async () => {
    const { id, result, question } = await asked(QUESTION);
    expect(question).toMatchObject({ questions: [QUESTION], answered: {} });
    expect(app.manager.stateOf(id)).toBe('question');
    expect(app.manager.summary(id)?.attention).toBe('question');
    expect(app.questionLog.at(-1)).toEqual({ id, question });
    // 通知の本文は質問文
    expect(app.attentions).toEqual([{ id, attention: { kind: 'menu', menu: expect.objectContaining({ kind: 'question', title: QUESTION.question }) } }]);
    expect(app.manager.replyQuestion(id, question.id, { kind: 'answer', answers: { [QUESTION.question]: 'だ・である' } })).toBe(true);
    expect(await replyOf(result)).toEqual({ kind: 'answer', answers: { [QUESTION.question]: 'だ・である' } });
    expect(app.manager.pendingQuestion(id)).toBeNull();
    expect(app.questionLog.at(-1)).toEqual({ id, question: null });
    // もう待っていない質問には返事を渡せない
    expect(app.manager.replyQuestion(id, question.id, { kind: 'chat' })).toBe(false);
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

  it('親が答えたプレビュー付きの質問には、カードで答えたときと同じく、選んだ案のプレビューを添え書き（annotations）で付ける', async () => {
    const preview: AskQuestion = { question: 'どの画面にしますか？', header: '画面', multiSelect: false, options: [{ label: '縦', description: '', preview: '┌縦┐' }, { label: '横', description: '' }] };
    const { id, result, question } = await asked(preview, SECOND);
    app.manager.answerPendingQuestion(id, question.id, preview.question, '縦');
    expect(app.manager.answerPendingQuestion(id, question.id, SECOND.question, '書く')).toBe('sent');
    expect(await replyOf(result)).toEqual({ kind: 'answer', answers: { [preview.question]: '縦', [SECOND.question]: '書く' }, annotations: { [preview.question]: { preview: '┌縦┐' } } });
  });

  it('Claude Code が終わった・アーカイブした・フックが止められた（つながりが切れた）ら、待つのをやめる', async () => {
    const exited = await asked(QUESTION);
    exited.pipe.exit(0);
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
    const { id, pipe } = app.create();
    await app.ready(id);
    expect(await replyOf(app.manager.waitQuestion(id, { questions: 'x' }, new AbortController().signal))).toEqual({ kind: 'none' });
    pipe.exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
    expect(await replyOf(app.manager.waitQuestion(id, input(QUESTION), new AbortController().signal))).toEqual({ kind: 'none' });
    expect(app.manager.pendingQuestion(id)).toBeNull();
  });
});
