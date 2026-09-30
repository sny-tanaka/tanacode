import { useEffect, useState } from 'react';
import type { ModelCatalog, ModelChoice } from '@shared/models';
import type { PermissionMode } from '@shared/screen';

// モデル・エフォート・権限モードの選択肢（チャットの入力欄の下と、新規セッションの画面で使う）

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// Claude Code のモデル一覧の控えが無いときの選択肢（--model に渡す別名）
const FALLBACK_MODELS: ModelChoice[] = [
  { value: 'opus', name: 'Opus', detail: '', disabled: false, efforts: EFFORTS },
  { value: 'fable', name: 'Fable', detail: '', disabled: false, efforts: EFFORTS },
  { value: 'sonnet', name: 'Sonnet', detail: '', disabled: false, efforts: EFFORTS },
  { value: 'haiku', name: 'Haiku', detail: '', disabled: false, efforts: [] },
];
// Shift+Tab で切り替わる権限モード（--permission-mode と同じ名前）
export const MODES: [PermissionMode, string][] = [
  ['manual', '都度確認'],
  ['acceptEdits', '編集は自動'],
  ['plan', 'プラン'],
  ['auto', 'auto'],
];

export type ModelCatalogState = {
  catalog: ModelCatalog | null;
  choices: ModelChoice[];
  // 同じ名前が並ぶとき（1M とそうでないもの）だけ 1M を付けて見分ける
  labelOf: (choice: ModelChoice) => string;
  refreshing: boolean;
  refresh: () => Promise<void>;
};

// Claude Code が持っているモデル一覧の控え。refresh で読み直す
export function useModelCatalog(): ModelCatalogState {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => void window.tanacode.models.get().then(setCatalog), []);
  const refresh = async () => {
    setRefreshing(true);
    const result = await window.tanacode.models.refresh();
    setRefreshing(false);
    if ('catalog' in result) setCatalog(result.catalog);
    else window.alert(`モデルの一覧を読み込めませんでした: ${result.error}`);
  };
  const choices = catalog?.choices ?? FALLBACK_MODELS;
  const labelOf = (c: ModelChoice) =>
    `${c.name}${c.value.endsWith('[1m]') && choices.filter((o) => o.name === c.name).length > 1 ? ' 1M' : ''}${c.disabled ? '（要更新）' : ''}`;
  return { catalog, choices, labelOf, refreshing, refresh };
}

export function refreshTitle(catalog: ModelCatalog | null): string {
  return `モデル一覧を読み込み直す（Claude Code が持っている一覧の控えから）${catalog ? `。${new Date(catalog.updatedAt).toLocaleString('ja-JP')} 時点` : ''}`;
}

// Remote Control を使えるか（開発版では、TANACODE_REMOTE_CONTROL=1 で起動したときだけ使える）。起動中に変わらないので一度だけ聞く
let remoteAvailable: Promise<boolean> | null = null;
export function useRemoteControlAvailable(): boolean {
  const [available, setAvailable] = useState(true);
  useEffect(() => {
    let alive = true;
    remoteAvailable ??= window.tanacode.sessions.remoteControlAvailable();
    void remoteAvailable.then((value) => alive && setAvailable(value !== false));
    return () => {
      alive = false;
    };
  }, []);
  return available;
}
