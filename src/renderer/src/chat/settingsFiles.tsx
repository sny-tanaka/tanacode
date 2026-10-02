import { useEffect, useState, useSyncExternalStore } from 'react';
import type { SettingsFile } from '@shared/settings-file';

// 登録した設定ファイルを選ぶ部品と、その一覧・管理ダイアログの開閉（チャットの入力欄の下と、新規セッションの画面で使う）

// 登録した設定ファイル。ファイルが消えた・直ったのを反映するため、ウィンドウに戻ってきたときも読み直す。
// 一覧を持ち回るとストーリーの間で残ってしまうので、使う部品ごとに読む
export function useSettingsFiles(): SettingsFile[] {
  const [files, setFiles] = useState<SettingsFile[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      void window.tanacode.settingsFiles.list().then((list) => {
        // 返事が配列でないのは、API を差し替えた Storybook
        if (alive) setFiles(Array.isArray(list) ? list : []);
      });
    load();
    const off = window.tanacode.settingsFiles.onChanged(setFiles);
    window.addEventListener('focus', load);
    return () => {
      alive = false;
      off();
      window.removeEventListener('focus', load);
    };
  }, []);
  return files;
}

// 管理ダイアログの開閉。選択欄が 2 か所（チャット・新規セッション）にあり、ダイアログは App に 1 つだけ置くので、props ではなくここで共有する
let dialogOpen = false;
const dialogListeners = new Set<() => void>();

function setDialogOpen(open: boolean) {
  if (dialogOpen === open) return;
  dialogOpen = open;
  dialogListeners.forEach((listener) => listener());
}

export function openSettingsFilesDialog() {
  setDialogOpen(true);
}

export function closeSettingsFilesDialog() {
  setDialogOpen(false);
}

export function useSettingsFilesDialogOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      dialogListeners.add(listener);
      return () => dialogListeners.delete(listener);
    },
    () => dialogOpen,
  );
}

// 「管理…」を選んだときの値（選んでいる設定ファイルは変えず、ダイアログを開く）
const MANAGE = '__manage__';

// 設定ファイルの選択欄。登録が 0 件でも出す（「管理…」から最初の 1 件を登録するため）。
// value: 選んでいる設定ファイルの ID（null は標準）
export function SettingsFileSelect({
  value,
  files,
  disabled = false,
  title,
  onChange,
}: {
  value: string | null;
  files: SettingsFile[];
  disabled?: boolean;
  title: string;
  onChange: (id: string | null) => void;
}) {
  // 選んでいる設定ファイルが登録に無いとき（登録から外した）は、黙って標準に見せない
  const missing = value !== null && !files.some((f) => f.id === value);
  return (
    <select
      // 標準以外は別の設定（接続先・API キーなど）で動くので、取り違えないよう色を付ける
      className={`settings-file-select${value !== null ? ' on' : ''}`}
      value={value ?? ''}
      disabled={disabled}
      title={title}
      onChange={(e) => {
        if (e.target.value === MANAGE) openSettingsFilesDialog();
        else onChange(e.target.value || null);
      }}
    >
      <option value="">標準</option>
      {files.map((f) => (
        <option key={f.id} value={f.id} disabled={f.error !== null} title={f.error ?? f.path}>
          {f.error !== null ? `${f.name}（読めません）` : f.name}
        </option>
      ))}
      {missing && <option value={value}>（登録なし）</option>}
      <option disabled>──────</option>
      <option value={MANAGE}>管理…</option>
    </select>
  );
}
