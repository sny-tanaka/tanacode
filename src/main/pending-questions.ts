import type { PendingQuestion, QuestionAnnotations, QuestionReply } from '@shared/questions';
import type { AskQuestion } from '@shared/screen';

type Entry = { pending: PendingQuestion; finish: (reply: QuestionReply | null) => void };

// Claude Code が返事を待っている AskUserQuestion（stream-json の can_use_tool）。セッションごとに、来た順に持つ。
// 返事（質問のカード・親の answer_question）を渡すか、待つのをやめる（Claude Code が取り下げた・終わった・ほかで答えた）と、
// その質問は消える。changed: セッションの待っている質問が変わった（増えた・減った・親が 1 問答えた）
export class PendingQuestions {
  private readonly bySession = new Map<string, Entry[]>();
  private next = 0;

  constructor(private readonly changed: (session: string) => void) {}

  // Claude Code が質問を出した。返事か、待つのをやめる（null）まで待つ。signal: 待つのをやめる（要求が取り下げられた・終わった）
  wait(session: string, questions: AskQuestion[], signal: AbortSignal): Promise<QuestionReply | null> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve(null);
        return;
      }
      const pending: PendingQuestion = { id: String(++this.next), questions, answered: {} };
      const abort = () => entry.finish(null);
      const entry: Entry = {
        pending,
        finish: (reply) => {
          const list = this.bySession.get(session) ?? [];
          if (!list.includes(entry)) return;
          signal.removeEventListener('abort', abort);
          const rest = list.filter((e) => e !== entry);
          if (rest.length > 0) this.bySession.set(session, rest);
          else this.bySession.delete(session);
          resolve(reply);
          this.changed(session);
        },
      };
      signal.addEventListener('abort', abort, { once: true });
      this.bySession.set(session, [...(this.bySession.get(session) ?? []), entry]);
      this.changed(session);
    });
  }

  // いちばん前の待っている質問（Claude Code の画面にも、来た順に 1 つずつ出る）。無ければ null
  first(session: string): PendingQuestion | null {
    return this.bySession.get(session)?.[0]?.pending ?? null;
  }

  // 返事を渡す。その質問をもう待っていなければ false
  reply(session: string, id: string, reply: QuestionReply): boolean {
    const entry = this.find(session, id);
    if (!entry) return false;
    entry.finish(reply);
    return true;
  }

  // 1 問だけ答える（親の answer_question）。全部の質問の答えがそろったら、まとめて返事にする（sent）。
  // まだ答えていない質問が残っていれば answered に入れて待つ（waiting）。その質問をもう待っていなければ null
  answerOne(session: string, id: string, question: string, answer: string): 'sent' | 'waiting' | null {
    const entry = this.find(session, id);
    if (!entry) return null;
    const answered = { ...entry.pending.answered, [question]: answer };
    if (entry.pending.questions.every((q) => q.question in answered)) {
      // プレビュー付きの質問は、カードで答えたときと同じく、選んだ案のプレビューを添え書き（annotations）で渡す
      const annotations: QuestionAnnotations = {};
      for (const q of entry.pending.questions) {
        const preview = q.options.find((o) => o.label === answered[q.question])?.preview;
        if (preview) annotations[q.question] = { preview };
      }
      entry.finish({ kind: 'answer', answers: answered, ...(Object.keys(annotations).length > 0 ? { annotations } : {}) });
      return 'sent';
    }
    entry.pending = { ...entry.pending, answered };
    this.changed(session);
    return 'waiting';
  }

  // セッションの待っている質問を、すべてやめる（Claude Code が終わった・アーカイブした）
  releaseAll(session: string): void {
    for (const entry of [...(this.bySession.get(session) ?? [])]) entry.finish(null);
  }

  private find(session: string, id: string): Entry | undefined {
    return this.bySession.get(session)?.find((e) => e.pending.id === id);
  }
}
