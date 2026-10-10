import { t } from '@shared/i18n';
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
        {t('review.list.title')} <span className="scm-count">{comments.length}</span>
      </div>
      {comments.length === 0 ? (
        <div className="review-hint">{t('review.list.empty')}</div>
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
                  label={t('common.delete')}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(c.id);
                  }}
                />
              </div>
              <div className="review-comment-text">{c.text}</div>
            </div>
          ))}
          <div className="review-hint">{t('review.list.hint')}</div>
        </>
      )}
    </div>
  );
}
