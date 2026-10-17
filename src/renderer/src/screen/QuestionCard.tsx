import { useState } from 'react';
import { t } from '@shared/i18n';
import { answerText, type PendingQuestion, type QuestionAnnotations, type QuestionReply } from '@shared/questions';
import type { AskQuestion } from '@shared/screen';
import { CheckIcon, CloseIcon, IconButton } from '../icons';

// 1 つの質問の、カードの中での答え（選んだ選択肢と自由記述）
type Draft = { picked: string[]; other: string };

const EMPTY: Draft = { picked: [], other: '' };

function answered(draft: Draft): boolean {
  return draft.picked.length > 0 || draft.other.trim() !== '';
}

// 選択肢のどれかにプレビューがある質問。Claude Code と同じく、この形には自由記述が無い
function hasPreview(question: AskQuestion): boolean {
  return question.options.some((o) => o.preview);
}

type Props = {
  sessionId: string;
  question: PendingQuestion;
};

// Claude Code が答えを待っている AskUserQuestion（PendingQuestion）の質問のカード。質問の入力だけで描く。
// ページの送り方は Claude Code の画面と同じ: 質問を 1 問ずつ出し（タブで、答えた質問が分かる）、単一選択は選ぶと次の質問へ、
// 複数選択はチェックしてから次の質問へ。質問が複数あるときと複数選択のときは、最後に回答の確認を出してから送る。
// 質問が 1 つで単一選択なら、選んだらすぐ送る。答えは全部そろってから、まとめて返す。
// プレビュー付きの質問には自由記述が無いので、代わりにメモ欄を出し、選んだ案のプレビューと一緒に添え書き（annotations）で渡す（決めたこと）
export function QuestionCard({ sessionId, question }: Props) {
  const { questions } = question;
  const [drafts, setDrafts] = useState<Draft[]>(() => questions.map(() => EMPTY));
  // プレビュー付きの質問のメモ（質問ごと）
  const [notes, setNotes] = useState<string[]>(() => questions.map(() => ''));
  // 今のページ（questions.length は回答の確認）
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  // 送れなかったときの知らせ
  const [failure, setFailure] = useState<string | null>(null);
  // プレビューを出す選択肢（ホバー・フォーカスしたもの。はじめはプレビューのある最初の選択肢）
  const [previewed, setPreviewed] = useState<string | null>(null);

  const reviewing = page === questions.length;
  const current = reviewing ? null : questions[page];
  const draft = reviewing ? EMPTY : drafts[page];
  // 質問が 1 つで単一選択なら、確認せずに送る（Claude Code の画面と同じ）
  const direct = questions.length === 1 && !questions[0].multiSelect;
  const complete = drafts.every(answered);

  const send = (reply: QuestionReply) => {
    setSending(true);
    setFailure(null);
    window.tanacode.question
      .reply(sessionId, question.id, reply)
      .then(
        // 送れたら、待っている質問が無くなってカードが消える
        (ok) => !ok && setFailure(t('screen.card.questionGone')),
        () => setFailure(t('screen.card.sendFailed')),
      )
      .finally(() => setSending(false));
  };

  const answers = (list: Draft[]) => Object.fromEntries(questions.map((q, i) => [q.question, answerText(q, list[i].picked, list[i].other)]));

  // プレビュー付きの質問の添え書き（メモと、選んだ案がひとつならそのプレビュー）。無ければ undefined
  const annotations = (list: Draft[]): QuestionAnnotations | undefined => {
    const result: QuestionAnnotations = {};
    questions.forEach((q, i) => {
      if (!hasPreview(q)) return;
      const note = notes[i].trim();
      const picked = q.options.filter((o) => list[i].picked.includes(o.label));
      const preview = picked.length === 1 ? picked[0].preview : undefined;
      if (note || preview) result[q.question] = { ...(note ? { notes: note } : {}), ...(preview ? { preview } : {}) };
    });
    return Object.keys(result).length > 0 ? result : undefined;
  };
  const answer = (list: Draft[]): QuestionReply => {
    const added = annotations(list);
    return { kind: 'answer', answers: answers(list), ...(added ? { annotations: added } : {}) };
  };

  const go = (next: number) => {
    setPage(next);
    setEditing(false);
    setText('');
    setPreviewed(null);
  };

  // 今のページの答えを決めて、次へ進む（質問が 1 つで単一選択なら送る）
  const decide = (next: Draft) => {
    const list = drafts.map((d, i) => (i === page ? next : d));
    setDrafts(list);
    if (direct) send(answer(list));
    else go(page + 1);
  };

  const toggle = (label: string) => {
    const picked = draft.picked.includes(label) ? draft.picked.filter((l) => l !== label) : [...draft.picked, label];
    setDrafts(drafts.map((d, i) => (i === page ? { ...d, picked } : d)));
  };

  const submitText = () => {
    if (!current || !text.trim()) return;
    if (current.multiSelect) {
      // 複数選択の自由記述は、チェックの 1 つとして足す（次の質問へは、下のボタンで進む）
      setDrafts(drafts.map((d, i) => (i === page ? { ...d, other: text } : d)));
      setEditing(false);
    } else decide({ picked: [], other: text });
  };

  const shown = current && hasPreview(current) ? (current.options.find((o) => o.label === previewed) ?? current.options.find((o) => o.preview)) : undefined;

  return (
    <div className="menu-card question">
      {/* 見出しの行。キャンセルは右上に置く（Claude Code の画面の Esc と同じく、作業を止める） */}
      <div className="menu-card-head">
        <div className="menu-card-kind">{t('screen.kind.question')}</div>
        <IconButton icon={CloseIcon} size="md" label={t('common.cancel')} disabled={sending} onClick={() => send({ kind: 'cancel' })} />
      </div>
      {questions.length > 1 && (
        <div className="menu-tabs">
          {questions.map((q, i) => (
            <button
              key={q.question}
              type="button"
              className={`menu-tab${answered(drafts[i]) ? ' answered' : ''}${i === page ? ' current' : ''}`}
              disabled={sending}
              onClick={() => go(i)}
            >
              {answered(drafts[i]) && <CheckIcon size={12} />}
              {q.header || t('screen.card.questionTab', { n: i + 1 })}
            </button>
          ))}
        </div>
      )}
      {current ? (
        <>
          <div className="menu-title">{current.question}</div>
          {hasPreview(current) && (
            <label className="menu-notes-input">
              <span>{t('screen.card.notes')}</span>
              <textarea
                rows={2}
                value={notes[page]}
                placeholder={t('screen.card.notesPlaceholder')}
                disabled={sending}
                onChange={(e) => setNotes(notes.map((n, i) => (i === page ? e.target.value : n)))}
              />
            </label>
          )}
          <div className="menu-options">
            {current.options.map((option) => {
              const picked = draft.picked.includes(option.label);
              return (
                <button
                  key={option.label}
                  type="button"
                  className={`menu-option${picked && !current.multiSelect ? ' chosen' : ''}${shown && option.label === shown.label ? ' previewed' : ''}`}
                  disabled={sending}
                  onClick={() => (current.multiSelect ? toggle(option.label) : decide({ picked: [option.label], other: '' }))}
                  onMouseEnter={() => setPreviewed(option.label)}
                  onFocus={() => setPreviewed(option.label)}
                >
                  {current.multiSelect && <span className={`menu-check${picked ? ' on' : ''}`}>{picked && <CheckIcon size={12} />}</span>}
                  <span className="menu-option-text">
                    <span className="menu-option-label">{option.label}</span>
                    {option.description && <span className="menu-option-desc">{option.description}</span>}
                  </span>
                </button>
              );
            })}
            {!hasPreview(current) &&
              (editing ? (
                <form
                  className="menu-text-input multiline"
                  onSubmit={(e) => {
                    e.preventDefault();
                    submitText();
                  }}
                >
                  <textarea
                    autoFocus
                    rows={3}
                    value={text}
                    placeholder={t('screen.card.answerPlaceholderMultiline')}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                      // チャットの入力欄と同じく、Enter は改行、⌘+Enter で決める。変換確定の Enter では決めない
                      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.nativeEvent.isComposing || e.keyCode === 229) return;
                      e.preventDefault();
                      submitText();
                    }}
                  />
                  <div className="menu-text-actions">
                    <button className="send-button" type="submit" disabled={!text.trim() || sending}>
                      {direct ? t('screen.card.send') : t('screen.card.confirm')}
                    </button>
                    <IconButton icon={CloseIcon} size="md" label={t('screen.card.stopEditing')} onClick={() => setEditing(false)} />
                  </div>
                </form>
              ) : (
                <button
                  type="button"
                  className={`menu-option${draft.other.trim() && !current.multiSelect ? ' chosen' : ''}`}
                  disabled={sending}
                  onClick={() => {
                    setText(draft.other);
                    setEditing(true);
                  }}
                >
                  {current.multiSelect && <span className={`menu-check${draft.other.trim() ? ' on' : ''}`}>{draft.other.trim() && <CheckIcon size={12} />}</span>}
                  <span className="menu-option-text">
                    <span className="menu-option-label">{draft.other.trim() ? t('screen.card.otherTyped', { text: draft.other.trim() }) : t('screen.card.other')}</span>
                  </span>
                </button>
              ))}
            {current.multiSelect && (
              <button type="button" className="menu-option submit" disabled={sending} onClick={() => go(page + 1)}>
                {page + 1 < questions.length ? t('screen.card.nextQuestion') : t('screen.card.reviewAnswers')}
              </button>
            )}
            <button type="button" className="menu-option" disabled={sending} onClick={() => send({ kind: 'chat' })}>
              <span className="menu-option-text">
                <span className="menu-option-label">{t('screen.card.chat')}</span>
              </span>
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="menu-title">{t('screen.card.review')}</div>
          <dl className="menu-review">
            {questions.map((q, i) => (
              <div key={q.question} className="menu-review-item">
                <dt>{q.question}</dt>
                <dd className={answered(drafts[i]) ? undefined : 'unanswered'}>
                  {answered(drafts[i]) ? answerText(q, drafts[i].picked, drafts[i].other) : t('screen.card.unanswered')}
                </dd>
              </div>
            ))}
          </dl>
          <div className="menu-options">
            <button type="button" className="menu-option submit" disabled={sending || !complete} onClick={() => send(answer(drafts))}>
              {t('screen.card.submitAnswers')}
            </button>
            <button type="button" className="menu-option" disabled={sending} onClick={() => send({ kind: 'cancel' })}>
              <span className="menu-option-text">
                <span className="menu-option-label">{t('common.cancel')}</span>
              </span>
            </button>
          </div>
        </>
      )}
      {failure && (
        <div className="menu-card-error" role="alert">
          {failure}
        </div>
      )}
      {/* 選択肢のプレビュー（比べるための図や文章）。ホバーした選択肢のものを出す */}
      {shown && (
        <div className="menu-preview">
          <div className="menu-preview-label">{t('screen.card.preview', { label: shown.label })}</div>
          {shown.preview ? <pre className="menu-preview-body">{shown.preview}</pre> : <div className="menu-preview-none">{t('screen.card.noPreview')}</div>}
        </div>
      )}
    </div>
  );
}
