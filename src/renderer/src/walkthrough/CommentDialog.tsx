import { useEffect, useRef, useState } from 'react';
import { t } from '@shared/i18n';
import { finalCommentBody, MAX_COMMENT_CHARS, type WalkthroughCommentDraft } from '@shared/walkthrough-comment';
import { errorMessage } from '../errorMessage';

type Api = Pick<typeof window.tanacode.walkthrough, 'draftComment' | 'postComment'>;

// ウォークスルーを GitHub の PR にコメントとして載せる前の下見。本文を確かめ、手で直してから投稿する。
// 載せられない（PR が無い・プッシュしていない など）ときは、理由だけを出す。api: Storybook では作り物を渡す
export function CommentDialog({ sessionId, onClose, api = window.tanacode.walkthrough }: { sessionId: string; onClose: () => void; api?: Api }) {
  const [draft, setDraft] = useState<WalkthroughCommentDraft | null>(null);
  const [body, setBody] = useState('');
  const [attribution, setAttribution] = useState(true);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [postedUrl, setPostedUrl] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    void api.draftComment(sessionId).then(
      (d) => {
        if (!alive) return;
        setDraft(d);
        if (d.ok) setBody(d.body);
      },
      (e: unknown) => alive && setDraft({ ok: false, reason: errorMessage(e) }),
    );
    return () => {
      alive = false;
    };
  }, [sessionId, api]);

  // Escape で閉じるには、ダイアログの中にフォーカスが要る。閉じたら、開く前にいた場所に戻す
  useEffect(() => {
    const before = document.activeElement;
    dialog.current?.focus();
    return () => {
      if (before instanceof HTMLElement) before.focus();
    };
  }, []);

  const length = finalCommentBody(body, attribution).length;
  const tooLong = length > MAX_COMMENT_CHARS;
  const post = async () => {
    setPosting(true);
    setError(null);
    try {
      setPostedUrl(await api.postComment(sessionId, body, attribution));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPosting(false);
    }
  };
  const open = (url: string) => void window.tanacode.browser.openExternal(url);

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div
        className="quick-open walk-comment-dialog"
        ref={dialog}
        role="dialog"
        aria-label={t('walkthrough.comment.title')}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Escape') onClose();
        }}
      >
        <div className="settings-files-head">
          <h2>{draft?.ok ? t('walkthrough.comment.titleWithNumber', { number: draft.prNumber }) : t('walkthrough.comment.title')}</h2>
          <p>{t('walkthrough.comment.description')}</p>
        </div>
        {!draft && <div className="walk-comment-note">{t('walkthrough.comment.checking')}</div>}
        {draft && !draft.ok && <div className="walk-comment-note warn">{draft.reason}</div>}
        {draft?.ok && postedUrl && (
          <div className="walk-comment-note ok">
            <span>{t('walkthrough.comment.posted')}</span>
            <button className="ghost-button" onClick={() => open(postedUrl)}>
              {t('walkthrough.comment.openOnGitHub')}
            </button>
          </div>
        )}
        {draft?.ok && !postedUrl && (
          <>
            {draft.postedUrl && (
              <div className="walk-comment-note warn">
                <span>{t('walkthrough.comment.alreadyPosted')}</span>
                <button className="ghost-button" onClick={() => open(draft.postedUrl!)}>
                  {t('walkthrough.comment.openPrevious')}
                </button>
              </div>
            )}
            <textarea className="walk-comment-body" value={body} spellCheck={false} onChange={(e) => setBody(e.target.value)} />
            <label className="walk-comment-check">
              <input type="checkbox" checked={attribution} onChange={(e) => setAttribution(e.target.checked)} />
              {t('walkthrough.comment.attributionOption')}
            </label>
            {tooLong && <div className="walk-comment-note warn">{t('walkthrough.comment.tooLong', { count: length, max: MAX_COMMENT_CHARS })}</div>}
            {error && <div className="walk-comment-note warn">{error}</div>}
          </>
        )}
        <div className="settings-files-foot">
          <button className="ghost-button" onClick={onClose}>
            {postedUrl ? t('common.close') : t('common.cancel')}
          </button>
          {draft?.ok && !postedUrl && (
            <button className="send-button" disabled={posting || tooLong || !body.trim()} onClick={() => void post()}>
              {posting ? t('walkthrough.comment.posting') : t('walkthrough.comment.post')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
