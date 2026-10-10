import type { SentFiles } from '@shared/chat';
import { t } from '@shared/i18n';

type Props = {
  files: SentFiles;
  // 送れなかった（ファイルが無いなど）
  failed: boolean;
  // 無ければ押せない（作業の書き出し）
  onOpenFile?: (absPath: string) => void;
};

// Claude が SendUserFile でユーザーに送ったファイル。1 件ずつ並べ、クリックでエディタに開く（フォルダの外のファイルも絶対パスで開く）
export function SentFilesCard({ files, failed, onOpenFile }: Props) {
  return (
    <div className="sent-files">
      <div className="sent-files-head">
        <span className="sent-files-label">{t('composer.sentFiles.label')}</span>
        {failed && <span className="sent-files-failed">{t('composer.sentFiles.failed')}</span>}
      </div>
      {files.caption && <div className="sent-files-caption">{files.caption}</div>}
      {files.paths.map((path) => {
        const name = path.split('/').pop() || path;
        const dir = path.slice(0, path.length - name.length).replace(/\/$/, '');
        const label = (
          <>
            <span className="sent-file-name">{name}</span>
            <span className="sent-file-dir">{dir}</span>
          </>
        );
        if (!onOpenFile) {
          return (
            <div key={path} className="sent-file">
              {label}
            </div>
          );
        }
        return (
          <button key={path} className="sent-file" onClick={() => onOpenFile(path)} title={t('composer.sentFiles.openTip', { path })}>
            {label}
          </button>
        );
      })}
    </div>
  );
}
