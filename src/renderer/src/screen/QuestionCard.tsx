import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { t } from '@shared/i18n';
import { answerText, type PendingQuestion, type QuestionAnnotations, type QuestionReply } from '@shared/questions';
import type { AskQuestion } from '@shared/screen';
import { CheckIcon, CloseIcon, IconButton } from '../icons';
import { placePreview, type Place } from './previewPlace';

// 1 つの質問の、カードの中での答え（選んだ選択肢と、入力欄に書いた文）。
// textOnly: 「入力だけで答える」で、書いた文だけを答えにした
type Draft = { picked: string[]; text: string; textOnly: boolean };

const EMPTY: Draft = { picked: [], text: '', textOnly: false };

// 答えたか。単一選択は、選択肢を押すか「入力だけで答える」で決める（書いただけでは答えにしない。選択肢と一緒に送る補足かもしれない）。
// 複数選択は、チェックか書いた文があれば答え（チェックが無ければ、書いた文だけを答えにする）
function answered(question: AskQuestion, draft: Draft): boolean {
  if (draft.picked.length > 0) return true;
  return draft.text.trim() !== '' && (question.multiSelect || draft.textOnly);
}

// 1 つの質問の答え（answer）と、選択肢と一緒に送る補足（notes）。選んだ選択肢が無ければ、書いた文だけを答えにする。
// 補足は、答えの文につなげず、添え書き（annotations）の notes で渡す（Claude には「"質問"="選択肢" notes: 補足」と届き、
// 選んだ案と書き足した文の区別がつく。本物の Claude Code で確かめた。test/cli/cards.test.ts）
function replyOf(question: AskQuestion, draft: Draft): { answer: string; notes?: string } {
  const typed = draft.text.trim();
  const labels = answerText(question, draft.picked, '');
  if (!labels) return { answer: typed };
  return typed ? { answer: labels, notes: typed } : { answer: labels };
}

// プレビューのポップアップの向きへマウスを動かしている間に乗った選択肢は、ここまで止まってから、そのプレビューに切り替える（ms）
const REST_MS = 150;

type Props = {
  sessionId: string;
  question: PendingQuestion;
};

// Claude Code が答えを待っている AskUserQuestion（PendingQuestion）の質問のカード。質問の入力だけで描く。
// ページの送り方は Claude Code の画面と同じ: 質問を 1 問ずつ出し（タブで、答えた質問が分かる）、単一選択は選ぶと次の質問へ、
// 複数選択はチェックしてから次の質問へ。質問が複数あるときと複数選択のときは、最後に回答の確認を出してから送る。
// 質問が 1 つで単一選択なら、選んだらすぐ送る。答えは全部そろってから、まとめて返す。
// カードの形は、プレビューの有無でそろえる（決めたこと）。自由入力の欄は 1 つだけ、どの質問にも選択肢の下に出す（決めたこと）。
// 書いてから選択肢を押す（複数選択はチェックして次へ進む）と、選択肢と一緒に補足として送る。書いていなければ、選択肢だけを送る。
// 「入力だけで答える」（欄で ⌘+Enter でも）は、選択肢を渡さず、書いた文だけを答えにする（選択肢に無い答え）。
// Claude Code の画面では、プレビュー付きの質問に自由記述が無く、代わりにメモ欄があり、プレビューの無い質問にはメモ欄が無い。
// tanacode では、メモと自由記述を 1 つの欄にまとめた。
// 「Chat about this」も出さない（書けば、質問について話せる）。選んだ案にプレビューがあれば、添え書き（annotations）で渡す。
// 選択肢のプレビューは、ホバー（Tab のフォーカスでも）した選択肢のものを、カードの外にポップアップで出す（PreviewPopup）。
// カードの右（エディタの側）に、選択肢の高さにそろえて出す。右に場所が足りなければ、カードの上（入りきらなければ下）に出す。
// 前はカードの一番下に出していたので、ホバーでカードの高さが変わり、一覧が最下部を保とうとしてカードが上下に動き、止めたマウスの下に
// 別の選択肢が来てプレビューが替わり、また動くのを繰り返した
export function QuestionCard({ sessionId, question }: Props) {
  const { questions } = question;
  const [drafts, setDrafts] = useState<Draft[]>(() => questions.map(() => EMPTY));
  // 今のページ（questions.length は回答の確認）
  const [page, setPage] = useState(0);
  const [sending, setSending] = useState(false);
  // 送れなかったときの知らせ
  const [failure, setFailure] = useState<string | null>(null);
  // プレビューを出す選択肢（ホバー・フォーカスしたもの。カードとポップアップの両方から外れたら null）
  const [previewed, setPreviewed] = useState<string | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const popupId = useId();
  // カード（とポップアップ）の上での、マウスの直前の位置。ポップアップの向きへ動かしているかを見る
  const lastPoint = useRef<{ x: number; y: number } | null>(null);
  // 選択肢のボタン（名前 → 要素）。右に出すポップアップを、プレビューを出す選択肢の高さにそろえる
  const optionButtons = useRef(new Map<string, HTMLButtonElement>());
  // ポップアップの向きへ動かしている間に乗った選択肢（null は入力欄）と、止まったら切り替えるタイマー
  const resting = useRef<{ label: string | null; timer: ReturnType<typeof setTimeout> } | null>(null);
  // マウスがカード（とポップアップ）の上にあるか
  const hovering = useRef(false);
  // キーボード（Tab）でフォーカスした選択肢。マウスがカードから外れたら、そのプレビューに戻す
  const focused = useRef<string | null>(null);
  const textId = useId();

  const reviewing = page === questions.length;
  const current = reviewing ? null : questions[page];
  const draft = reviewing ? EMPTY : drafts[page];
  // 質問が 1 つで単一選択なら、確認せずに送る（Claude Code の画面と同じ）
  const direct = questions.length === 1 && !questions[0].multiSelect;
  const complete = questions.every((q, i) => answered(q, drafts[i]));

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

  const answers = (list: Draft[]) => Object.fromEntries(questions.map((q, i) => [q.question, replyOf(q, list[i]).answer]));

  // 添え書き（選んだ案がひとつで、プレビューがあれば、そのプレビュー。選択肢と一緒に送る補足があれば、その文）。無ければ undefined
  const annotations = (list: Draft[]): QuestionAnnotations | undefined => {
    const result: QuestionAnnotations = {};
    questions.forEach((q, i) => {
      const picked = q.options.filter((o) => list[i].picked.includes(o.label));
      const preview = picked.length === 1 ? picked[0].preview : undefined;
      const { notes } = replyOf(q, list[i]);
      if (preview || notes) result[q.question] = { ...(preview ? { preview } : {}), ...(notes ? { notes } : {}) };
    });
    return Object.keys(result).length > 0 ? result : undefined;
  };
  const answer = (list: Draft[]): QuestionReply => {
    const added = annotations(list);
    return { kind: 'answer', answers: answers(list), ...(added ? { annotations: added } : {}) };
  };

  const stopResting = () => {
    if (resting.current) clearTimeout(resting.current.timer);
    resting.current = null;
  };
  useEffect(() => stopResting, []);

  // マウスがポップアップの向き（右に出ていれば右、上に出ていれば上、下に出ていれば下）へ動いているか
  const towardPopup = (x: number, y: number) => {
    const last = lastPoint.current;
    const element = popup.current;
    if (!element || !last) return false;
    if (element.classList.contains('right')) return x > last.x;
    const box = element.getBoundingClientRect();
    if (y === last.y) return false;
    return box.bottom <= y ? y < last.y : box.top >= y ? y > last.y : false;
  };
  // 選択肢にマウスが乗った・乗ったまま動いた。ふつうはすぐそのプレビューに切り替える。ポップアップの向きへ動かしている間は切り替えず、
  // 止まってから切り替える（ポップアップへ移る途中で、またいだ選択肢のプレビューに替わると、読みたいものに乗れない。
  // 右に出したときも、高いポップアップの下のほうへ斜めに動かすと、下の選択肢をまたぐ）。
  // label が null なら入力欄（とその「入力だけで答える」）。プレビューの無い選択肢と同じく、出ているプレビューを消す
  const hoverOption = (label: string | null, x: number, y: number) => {
    stopResting();
    if (label === previewed) return;
    if (!towardPopup(x, y)) return setPreviewed(label);
    const timer = setTimeout(() => {
      resting.current = null;
      setPreviewed(label);
    }, REST_MS);
    resting.current = { label, timer };
  };

  const go = (next: number) => {
    setPage(next);
    setPreviewed(null);
    stopResting();
  };

  // 今のページの答えを変える
  const update = (next: Partial<Draft>) => setDrafts(drafts.map((d, i) => (i === page ? { ...d, ...next } : d)));

  // 今のページの答えを決めて、次へ進む（質問が 1 つで単一選択なら送る）
  const decide = (next: Partial<Draft>) => {
    const list = drafts.map((d, i) => (i === page ? { ...d, ...next } : d));
    setDrafts(list);
    if (direct) send(answer(list));
    else go(page + 1);
  };

  const toggle = (label: string) => {
    const picked = draft.picked.includes(label) ? draft.picked.filter((l) => l !== label) : [...draft.picked, label];
    update({ picked, textOnly: false });
  };

  // 「入力だけで答える」: 選択肢（チェック）を渡さず、書いた文だけを答えにして、次へ進む（質問が 1 つで単一選択なら送る）
  const answerWithText = () => {
    if (!draft.text.trim() || sending) return;
    decide({ picked: [], textOnly: true });
  };

  // 入力欄（とその「入力だけで答える」）にマウスを乗せた・Tab で移った。プレビューの無い選択肢と同じく、出ているプレビューを消す
  const enterText = (e: React.MouseEvent) => hoverOption(null, e.clientX, e.clientY);
  const focusText = (e: React.FocusEvent) => {
    if (!(e.target as Element).matches(':focus-visible')) return;
    focused.current = null;
    stopResting();
    setPreviewed(null);
  };

  // ポップアップに出す選択肢（プレビューの無い選択肢では出さない）
  const shown = current?.options.find((o) => o.label === previewed && o.preview);

  return (
    <div
      ref={card}
      className="menu-card question"
      onMouseEnter={() => {
        hovering.current = true;
      }}
      onMouseMove={(e) => {
        lastPoint.current = { x: e.clientX, y: e.clientY };
      }}
      // ポップアップは React の木ではカードの中にあるので、マウスをカードからポップアップへ移しても来ない。両方から外れたときに来る。
      // キーボードでフォーカスした選択肢があれば、そのプレビューに戻す
      onMouseLeave={() => {
        hovering.current = false;
        lastPoint.current = null;
        stopResting();
        setPreviewed(focused.current);
      }}
    >
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
              className={`menu-tab${answered(q, drafts[i]) ? ' answered' : ''}${i === page ? ' current' : ''}`}
              disabled={sending}
              onClick={() => go(i)}
            >
              {answered(q, drafts[i]) && <CheckIcon size={12} />}
              {q.header || t('screen.card.questionTab', { n: i + 1 })}
            </button>
          ))}
        </div>
      )}
      {current ? (
        <>
          <div className="menu-title">{current.question}</div>
          <div className="menu-options">
            {current.options.map((option) => {
              const picked = draft.picked.includes(option.label);
              return (
                <button
                  key={option.label}
                  ref={(element) => {
                    if (!element) return;
                    optionButtons.current.set(option.label, element);
                    return () => {
                      optionButtons.current.delete(option.label);
                    };
                  }}
                  type="button"
                  className={`menu-option${picked && !current.multiSelect ? ' chosen' : ''}${shown && option.label === shown.label ? ' previewed' : ''}`}
                  aria-describedby={shown && option.label === shown.label ? popupId : undefined}
                  disabled={sending}
                  // 単一選択は、入力欄に書いた文があれば、補足として一緒に送る
                  onClick={() => (current.multiSelect ? toggle(option.label) : decide({ picked: [option.label], textOnly: false }))}
                  onMouseEnter={(e) => hoverOption(option.label, e.clientX, e.clientY)}
                  onMouseMove={(e) => hoverOption(option.label, e.clientX, e.clientY)}
                  onMouseLeave={() => resting.current?.label === option.label && stopResting()}
                  // キーボードで移ったときだけ出す（押して移ったときは、ホバーで出ている。押したあとでカードから外れたら消す）
                  onFocus={(e) => {
                    if (!e.currentTarget.matches(':focus-visible')) return;
                    focused.current = option.label;
                    stopResting();
                    setPreviewed(option.label);
                  }}
                  onBlur={() => {
                    focused.current = null;
                    if (!hovering.current) setPreviewed(null);
                  }}
                >
                  {current.multiSelect && <span className={`menu-check${picked ? ' on' : ''}`}>{picked && <CheckIcon size={12} />}</span>}
                  <span className="menu-option-text">
                    <span className="menu-option-label">{option.label}</span>
                    {option.description && <span className="menu-option-desc">{option.description}</span>}
                  </span>
                </button>
              );
            })}
            {/* 自由入力の欄（1 つだけ）。選択肢と一緒に送る補足と、選択肢に無い答え（「入力だけで答える」）を兼ねる。
                書いた文だけが答えになっていれば（入力だけで答えた・チェックの無い複数選択）、選んだ選択肢と同じく枠に色を付ける */}
            <div
              className={`menu-free${answered(current, draft) && draft.picked.length === 0 ? ' chosen' : ''}`}
              onMouseEnter={enterText}
              onMouseMove={enterText}
              onMouseLeave={() => resting.current?.label === null && stopResting()}
              onFocus={focusText}
            >
              <label className="menu-free-label" htmlFor={textId}>
                {current.multiSelect ? t('screen.card.notesLabelMulti') : t('screen.card.notesLabel')}
              </label>
              <textarea
                id={textId}
                rows={2}
                value={draft.text}
                placeholder={t('screen.card.textPlaceholder')}
                onChange={(e) => update({ text: e.target.value })}
                onKeyDown={(e) => {
                  // チャットの入力欄と同じく、Enter は改行、⌘+Enter で「入力だけで答える」。変換確定の Enter では答えない
                  if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.nativeEvent.isComposing || e.keyCode === 229) return;
                  e.preventDefault();
                  answerWithText();
                }}
              />
              <div className="menu-text-actions">
                <button type="button" className="send-button" disabled={!draft.text.trim() || sending} onClick={answerWithText}>
                  {t('screen.card.answerWithText')}
                </button>
              </div>
            </div>
            {current.multiSelect && (
              <button type="button" className="menu-option submit" disabled={sending} onClick={() => go(page + 1)}>
                {page + 1 < questions.length ? t('screen.card.nextQuestion') : t('screen.card.reviewAnswers')}
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="menu-title">{t('screen.card.review')}</div>
          <dl className="menu-review">
            {questions.map((q, i) => {
              // 選択肢と、一緒に送る補足を分けて出す
              const reply = answered(q, drafts[i]) ? replyOf(q, drafts[i]) : null;
              return (
                <div key={q.question} className="menu-review-item">
                  <dt>{q.question}</dt>
                  <dd className={reply ? undefined : 'unanswered'}>
                    {reply ? reply.answer : t('screen.card.unanswered')}
                    {reply?.notes && <span className="menu-review-notes">{t('screen.card.reviewNotes', { text: reply.notes })}</span>}
                  </dd>
                </div>
              );
            })}
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
      {/* 選択肢のプレビュー（比べるための図や文章）。ホバーした選択肢のものを出す。選択肢ごとに作り直して、大きさを測り直す */}
      {shown && <PreviewPopup key={shown.label} id={popupId} anchor={card} options={optionButtons} popup={popup} label={shown.label} preview={shown.preview!} />}
    </div>
  );
}

// 選択肢のプレビューのポップアップ。チャットの一覧のスクロールの枠で切れないよう、画面（body）に出す（Tooltip と同じ）。
// カードの右に、選択肢の高さにそろえて出す。右に場所が足りなければ、カードの上（入りきらず下のほうが広ければ下）に出す（placePreview）。
// 入りきらない分は中でスクロールする。
// カードには重ねない（ホバーした選択肢に重なると、マウスがポップアップに乗ったところで選択肢から外れ、ちらつく）。
// カードの側の透明な余白で、カードとすき間なくつなぐ（マウスをカードからポップアップへ移す間に、両方から外れたことにしない）。
// 一覧のスクロール・ウインドウやカードの大きさの変化に合わせて置き直す
function PreviewPopup({
  id,
  anchor,
  options,
  popup,
  label,
  preview,
}: {
  id: string;
  anchor: RefObject<HTMLDivElement | null>;
  options: RefObject<Map<string, HTMLButtonElement>>;
  popup: RefObject<HTMLDivElement | null>;
  label: string;
  preview: string;
}) {
  const [place, setPlace] = useState<Place | null>(null);

  useLayoutEffect(() => {
    const element = popup.current;
    if (!element) return;
    // 置く前（見えない所に、透明な余白を付けずに出している）の大きさ。本文の高さを限らないときの高さは、本文の隠れている分を足す
    const body = element.querySelector('.menu-preview-body');
    const height = element.offsetHeight;
    const natural = { width: element.offsetWidth, height, fullHeight: height + (body ? body.scrollHeight - body.clientHeight : 0) };
    const update = () => {
      const box = anchor.current?.getBoundingClientRect();
      // カードが隠れた（ターミナルモードにした）間は出さない
      if (!box || (box.width === 0 && box.height === 0)) return setPlace(null);
      const option = options.current.get(label)?.getBoundingClientRect() ?? box;
      setPlace(placePreview(box, option, natural, { width: innerWidth, height: innerHeight }));
    };
    update();
    // ポップアップの中のスクロールでは置き直さない
    const scrolled = (e: Event) => {
      if (!(e.target instanceof Node && element.contains(e.target))) update();
    };
    const resize = new ResizeObserver(update);
    if (anchor.current) resize.observe(anchor.current);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', scrolled, true);
    return () => {
      resize.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', scrolled, true);
    };
  }, [anchor, options, popup, label]);

  // side のほかは、そのまま位置と大きさの限りにする
  const { side, ...box } = place ?? { side: 'measuring' };
  return createPortal(
    <div
      ref={popup}
      id={id}
      role="tooltip"
      className={`menu-preview-popup ${side}`}
      style={place ? box : { left: 0, top: 0, visibility: 'hidden' }}
      // React の木ではチャットの一覧の中にあるので、中のホイールを一覧のもの（人が一覧を上へスクロールした）と取り違えさせない
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="menu-preview">
        <div className="menu-preview-label">{t('screen.card.preview', { label })}</div>
        <pre className="menu-preview-body">{preview}</pre>
      </div>
    </div>,
    document.body,
  );
}
