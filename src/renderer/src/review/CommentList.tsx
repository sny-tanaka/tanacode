import { IconButton, TrashIcon } from '../icons';
import type { ReviewComment } from './LineComments';

type Props = {
  comments: ReviewComment[];
  onShow: (comment: ReviewComment) => void;
  onRemove: (id: string) => void;
};

// 差分やエディタの行に付けた Claude へのコメント。次の送信で指示に添えられる
export function CommentList({ comments, onShow, onRemove }: Props) {
  return (
    <div className="review-comments">
      <div className="review-comments-head">
        Claude へのコメント <span className="scm-count">{comments.length}</span>
      </div>
      {comments.length === 0 ? (
        <div className="review-hint">差分やエディタの行番号の横の ＋ でコメントを付けると、次に送る指示に添えられます</div>
      ) : (
        <>
          {comments.map((c) => (
            <div key={c.id} className="review-comment" onClick={() => onShow(c)} title={c.text}>
              <div className="review-comment-where">
                {c.path}:{c.startLine}
                {c.endLine !== c.startLine ? `-${c.endLine}` : ''}
                <IconButton
                  size="sm"
                  danger
                  icon={TrashIcon}
                  label="削除"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(c.id);
                  }}
                />
              </div>
              <div className="review-comment-text">{c.text}</div>
            </div>
          ))}
          <div className="review-hint">チャットの送信で、入力した文章と一緒に送られます</div>
        </>
      )}
    </div>
  );
}
