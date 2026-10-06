import { useEffect, useRef, useState } from 'react';
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
        aria-label="PR にコメントとして載せる"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Escape') onClose();
        }}
      >
        <div className="settings-files-head">
          <h2>{draft?.ok ? `PR #${draft.prNumber} にコメントとして載せる` : 'PR にコメントとして載せる'}</h2>
          <p>ステップの順に、見出し・コードへのリンク（コミットに固定）・説明を並べます。GitHub では、リンクの行がコードの埋め込みとして出ます。質問と答えは載せません。</p>
        </div>
        {!draft && <div className="walk-comment-note">PR を調べています…</div>}
        {draft && !draft.ok && <div className="walk-comment-note warn">{draft.reason}</div>}
        {draft?.ok && postedUrl && (
          <div className="walk-comment-note ok">
            <span>載せました。</span>
            <button className="ghost-button" onClick={() => open(postedUrl)}>
              GitHub で開く
            </button>
          </div>
        )}
        {draft?.ok && !postedUrl && (
          <>
            {draft.postedUrl && (
              <div className="walk-comment-note warn">
                <span>このウォークスルーは、もう載せています。もう一度載せると、コメントが 2 つになります。</span>
                <button className="ghost-button" onClick={() => open(draft.postedUrl!)}>
                  前のコメントを開く
                </button>
              </div>
            )}
            <textarea className="walk-comment-body" value={body} spellCheck={false} onChange={(e) => setBody(e.target.value)} />
            <label className="walk-comment-check">
              <input type="checkbox" checked={attribution} onChange={(e) => setAttribution(e.target.checked)} />
              最後に「Claude が書いた説明」と添える（あなたのアカウントで載るため）
            </label>
            {tooLong && <div className="walk-comment-note warn">長すぎます（{length} 文字。GitHub のコメントは {MAX_COMMENT_CHARS} 文字まで）</div>}
            {error && <div className="walk-comment-note warn">{error}</div>}
          </>
        )}
        <div className="settings-files-foot">
          <button className="ghost-button" onClick={onClose}>
            {postedUrl ? '閉じる' : 'キャンセル'}
          </button>
          {draft?.ok && !postedUrl && (
            <button className="send-button" disabled={posting || tooLong || !body.trim()} onClick={() => void post()}>
              {posting ? '載せています…' : '載せる'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
