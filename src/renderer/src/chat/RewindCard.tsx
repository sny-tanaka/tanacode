import { t } from '@shared/i18n';
import type { RewindChoice, RewindPreview } from '@shared/ipc';
import { CloseIcon, IconButton } from '../icons';

// 一覧に出すファイルの数（多いときは、残りの数だけを出す）
const SHOWN_FILES = 8;

type Props = {
  preview: RewindPreview;
  // 作業フォルダ（ファイルを、ここからの相対パスで出す）
  cwd: string;
  // 巻き戻している途中（押せない）
  busy: boolean;
  onChoose: (choice: RewindChoice) => void;
  onCancel: () => void;
};

// 発言の横の「ここまで戻す」を押したときの確かめのカード。その発言の前まで、会話・コード・両方のどれを戻すかを選ぶ。
// コードを戻すと変わるファイルと行の数を、先に調べて出す（rewind_files の dry_run）。「ここから要約」は作らない（決めたこと）
export function RewindCard({ preview, cwd, busy, onChoose, onCancel }: Props) {
  const files = preview.files;
  const code = !!files && files.length > 0;
  const relative = (file: string) => (file.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : file);
  const options: { key: string; label: string; choice: RewindChoice }[] = code
    ? [
        { key: 'both', label: t('chat.rewind.both'), choice: { conversation: true, code: true } },
        { key: 'conversation', label: t('chat.rewind.conversation'), choice: { conversation: true, code: false } },
        { key: 'code', label: t('chat.rewind.code'), choice: { conversation: false, code: true } },
      ]
    : [{ key: 'conversation', label: t('chat.rewind.conversationOnly'), choice: { conversation: true, code: false } }];
  return (
    <div className="menu-card rewind">
      <div className="menu-card-head">
        <div className="menu-card-kind">{t('chat.rewind.kind')}</div>
        <IconButton icon={CloseIcon} size="md" label={t('common.cancel')} disabled={busy} onClick={onCancel} />
      </div>
      <div className="menu-title">{t('chat.rewind.title')}</div>
      <div className="menu-notes">
        {files === null
          ? preview.codeError
            ? t('chat.rewind.codeUnavailable', { reason: preview.codeError })
            : t('chat.rewind.codeUnavailablePlain')
          : files.length === 0
            ? t('chat.rewind.noFiles')
            : t('chat.rewind.files', { count: files.length, insertions: preview.insertions, deletions: preview.deletions })}
      </div>
      {code && (
        <pre className="menu-context">
          {[...files.slice(0, SHOWN_FILES).map(relative), ...(files.length > SHOWN_FILES ? [t('chat.rewind.more', { count: files.length - SHOWN_FILES })] : [])].join('\n')}
        </pre>
      )}
      <div className="menu-options">
        {options.map((option) => (
          <button key={option.key} type="button" className="menu-option" disabled={busy} onClick={() => onChoose(option.choice)}>
            <span className="menu-option-text">
              <span className="menu-option-label">{option.label}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
