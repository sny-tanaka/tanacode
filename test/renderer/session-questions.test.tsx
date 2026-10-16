// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PendingQuestion } from '@shared/questions';
import { useSessionQuestions } from '../../src/renderer/src/screen/useSessionQuestions';
import { mockApi } from './mock-api';

// セッションごとの、フックが答えを待っている質問（useSessionQuestions）。読み込みと、main からの知らせ

const question = (id: string): PendingQuestion => ({ id, questions: [{ question: `質問 ${id}`, header: '', multiSelect: false, options: [] }], answered: {} });

let api: ReturnType<typeof mockApi>;
let loaded: PendingQuestion | null;
let answerLoad: () => void;
beforeEach(() => {
  loaded = question('q1');
  answerLoad = () => {};
  api = mockApi({ 'question.get': () => new Promise((resolve) => (answerLoad = () => resolve(loaded))) });
  api.install();
});

describe('useSessionQuestions', () => {
  it('開いたセッションの待っている質問を読み込み、知らせが来たら入れ替える。答え終わったら null', async () => {
    const { result } = renderHook(() => useSessionQuestions('s1'));
    expect(result.current.questionOf('s1')).toBeNull();
    act(() => result.current.load('s1'));
    await act(async () => answerLoad());
    expect(api.argsOf('question.get')).toEqual([['s1']]);
    expect(result.current.questionOf('s1')?.id).toBe('q1');
    act(() => api.emit('question.onChanged', { sessionId: 's1', question: question('q2') }));
    expect(result.current.questionOf('s1')?.id).toBe('q2');
    act(() => api.emit('question.onChanged', { sessionId: 's1', question: null }));
    expect(result.current.questionOf('s1')).toBeNull();
  });

  it('読み込みの返事より先に知らせが来ていたら、古い返事で上書きしない', async () => {
    const { result } = renderHook(() => useSessionQuestions('s1'));
    act(() => result.current.load('s1'));
    act(() => api.emit('question.onChanged', { sessionId: 's1', question: null }));
    await act(async () => answerLoad());
    expect(result.current.questionOf('s1')).toBeNull();
  });
});
