import { describe, expect, it } from 'vitest';
import { answerText, questionReplyOf } from '@shared/questions';
import { PendingQuestions } from '../src/main/pending-questions';
import { QUESTION } from './scenario';
import { ASK_TABS } from './scenarios/questions';

// 答えを待っている AskUserQuestion（pending-questions.ts）と、答えの文・返事の読み方（@shared/questions）

describe('待っている質問（PendingQuestions）', () => {
  it('来た順に持ち、いちばん前を返す。前を答えると、次が前になる。待つ前につながりが切れていたら、待たない', async () => {
    const changed: string[] = [];
    const pending = new PendingQuestions((id) => changed.push(id));
    const first = pending.wait('s', [QUESTION], new AbortController().signal);
    const second = pending.wait('s', ASK_TABS, new AbortController().signal);
    const firstId = pending.first('s')!.id;
    expect(pending.first('s')?.questions).toEqual([QUESTION]);
    expect(pending.reply('s', firstId, { kind: 'chat' })).toBe(true);
    expect(await first).toEqual({ kind: 'chat' });
    expect(pending.first('s')?.questions).toEqual(ASK_TABS);
    pending.releaseAll('s');
    expect(await second).toBeNull();
    expect(pending.first('s')).toBeNull();
    expect(changed).toEqual(['s', 's', 's', 's']);
    const aborted = new AbortController();
    aborted.abort();
    expect(await pending.wait('s', [QUESTION], aborted.signal)).toBeNull();
    expect(pending.first('s')).toBeNull();
    expect(pending.reply('s', 'nope', { kind: 'chat' })).toBe(false);
    expect(pending.answerOne('s', 'nope', QUESTION.question, 'x')).toBeNull();
  });
});

describe('答えの文（answerText）', () => {
  it('画面で答えたときと同じ形: 選んだ選択肢を選択肢の順に「, 」でつなぎ、自由記述は最後に足す。改行はそのまま', () => {
    const languages = ASK_TABS[1];
    expect(answerText(languages, ['Go', 'TypeScript'], 'Zig')).toBe('TypeScript, Go, Zig');
    expect(answerText(languages, [], '  1 行目\n2 行目  ')).toBe('1 行目\n2 行目');
    expect(answerText(QUESTION, ['です・ます'], '')).toBe('です・ます');
    expect(answerText(QUESTION, ['無い選択肢'], '')).toBe('');
  });
});

describe('返事の読み方（questionReplyOf）', () => {
  it('画面から届いた返事を読む。形の違うものは null', () => {
    expect(questionReplyOf({ kind: 'answer', answers: { a: 'b' } })).toEqual({ kind: 'answer', answers: { a: 'b' } });
    expect(questionReplyOf({ kind: 'chat' })).toEqual({ kind: 'chat' });
    expect(questionReplyOf({ kind: 'answer', answers: ['x'] })).toBeNull();
    expect(questionReplyOf(null)).toBeNull();
  });
});
