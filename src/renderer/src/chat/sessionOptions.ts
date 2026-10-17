import { useEffect, useState } from 'react';
import { locale, t } from '@shared/i18n';
import type { ModelCatalog, ModelChoice, SessionModel } from '@shared/models';
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
const MODE_VALUES = ['manual', 'acceptEdits', 'plan', 'auto'] as const satisfies readonly PermissionMode[];

const modeLabel = (mode: (typeof MODE_VALUES)[number]) => t(`composer.mode.${mode}`);

// 権限モードの選択肢（値と表示名）。表示名は呼んだときの言語で作る
export function modeChoices(): [PermissionMode, string][] {
  return MODE_VALUES.map((mode): [PermissionMode, string] => [mode, modeLabel(mode)]);
}


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
    else window.alert(t('composer.models.loadFailed', { error: result.error }));
  };
  const choices = catalog?.choices ?? FALLBACK_MODELS;
  const labelOf = (c: ModelChoice) => {
    const name = `${c.name}${c.value.endsWith('[1m]') && choices.filter((o) => o.name === c.name).length > 1 ? ' 1M' : ''}`;
    return c.disabled ? t('composer.models.needsUpdate', { name }) : name;
  };
  return { catalog, choices, labelOf, refreshing, refresh };
}

// 動いている Claude Code がその場で切り替えられるモデル（initialize の models）。sessionId が null（起動の前・止まっている）なら null。
// 起動し直すと選べるモデルが変わることがあるので、起動が終わるたびに（sessionId が null から戻るたびに）読み直す
export function useSessionModels(sessionId: string | null): SessionModel[] | null {
  const [models, setModels] = useState<{ sessionId: string; models: SessionModel[] | null } | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    void window.tanacode.sessions.models(sessionId).then((list) => alive && setModels({ sessionId, models: list }));
    return () => {
      alive = false;
    };
  }, [sessionId]);
  return sessionId && models?.sessionId === sessionId ? models.models : null;
}

// モデルの選択肢。見え方はモデル一覧の控えのまま、動いている Claude Code が切り替えられるモデルは、そのモデルで選べるエフォートにする。
// 控えに無いもの（Bedrock のモデル ID など）は、Claude Code が付けた名前で足す。切り替えられないもの（控えにある旧モデルなど）は、
// 選ぶと main が --model で起動し直す
export function withSessionModels(choices: ModelChoice[], live: SessionModel[] | null): ModelChoice[] {
  if (!live) return choices;
  const liveOf = (value: string) => live.find((m) => m.value === value || m.resolvedModel === value);
  const merged = choices.map((c) => {
    const m = liveOf(c.value);
    return m ? { ...c, efforts: m.efforts } : c;
  });
  const extra = live
    .filter((m) => m.value !== 'default' && !choices.some((c) => c.value === m.value || c.value === m.resolvedModel))
    .map((m): ModelChoice => ({ value: m.value, name: m.name, detail: '', disabled: false, efforts: m.efforts }));
  return [...merged, ...extra];
}

export function refreshTitle(catalog: ModelCatalog | null): string {
  return catalog
    ? t('composer.models.refreshAsOf', { time: new Date(catalog.updatedAt).toLocaleString(locale()) })
    : t('composer.models.refresh');
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
