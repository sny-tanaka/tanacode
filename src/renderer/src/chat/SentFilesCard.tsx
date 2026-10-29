import type { SentFiles } from '@shared/chat';
import { t } from '@shared/i18n';
import { ImageList } from './ChatImages';

type Props = {
  files: SentFiles;
  // 送れなかった（ファイルが無いなど）
  failed: boolean;
  // 無ければ押せない（作業の書き出し）
  onOpenFile?: (absPath: string) => void;
  // このチャットのセッション。あれば、画像のファイルを絵で出す（無ければ、名前だけ。作業の書き出し）
  sessionId?: string;
};

// 絵で出す画像。SVG は、エディタでは文字として開くので、ほかのファイルと同じく名前で出す
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico']);

function isImage(path: string): boolean {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 && IMAGE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

// Claude が SendUserFile でユーザーに送ったファイル。1 件ずつ並べ、クリックでエディタに開く（フォルダの外のファイルも絶対パスで開く）。
// 画像は、人が貼った画像と同じく絵で並べ（クリックで拡大）、名前はその下に添える
export function SentFilesCard({ files, failed, onOpenFile, sessionId }: Props) {
  const images = sessionId && !failed ? files.paths.filter(isImage) : [];
  const others = files.paths.filter((path) => !images.includes(path));
  const fileButton = (path: string) => {
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
  };
  return (
    <div className="sent-files">
      <div className="sent-files-head">
        <span className="sent-files-label">{t('composer.sentFiles.label')}</span>
        {failed && <span className="sent-files-failed">{t('composer.sentFiles.failed')}</span>}
      </div>
      {files.caption && <div className="sent-files-caption">{files.caption}</div>}
      {sessionId && images.length > 0 && (
        <ImageList
          images={images.map((path) => ({
            key: `file:${path}`,
            // 中身は送ったあとで書き換わることがあるので、覚えておかずに、出すたびに読む
            load: () =>
              window.tanacode.workspace
                .readFile(sessionId, path)
                .then((content) => (content.kind === 'image' ? content.url : null))
                .catch(() => null),
            footer: fileButton(path),
          }))}
        />
      )}
      {others.map(fileButton)}
    </div>
  );
}
