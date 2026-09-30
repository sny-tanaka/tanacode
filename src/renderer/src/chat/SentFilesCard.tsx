import type { SentFiles } from '@shared/chat';

type Props = {
  files: SentFiles;
  // 送れなかった（ファイルが無いなど）
  failed: boolean;
  onOpenFile: (absPath: string) => void;
};

// Claude が SendUserFile でユーザーに送ったファイル。1 件ずつ並べ、クリックでエディタに開く（フォルダの外のファイルも絶対パスで開く）
export function SentFilesCard({ files, failed, onOpenFile }: Props) {
  return (
    <div className="sent-files">
      <div className="sent-files-head">
        <span className="sent-files-label">Claude から届いたファイル</span>
        {failed && <span className="sent-files-failed">送れませんでした</span>}
      </div>
      {files.caption && <div className="sent-files-caption">{files.caption}</div>}
      {files.paths.map((path) => {
        const name = path.split('/').pop() || path;
        const dir = path.slice(0, path.length - name.length).replace(/\/$/, '');
        return (
          <button key={path} className="sent-file" onClick={() => onOpenFile(path)} title={`${path}\nクリックでエディタに開く`}>
            <span className="sent-file-name">{name}</span>
            <span className="sent-file-dir">{dir}</span>
          </button>
        );
      })}
    </div>
  );
}
