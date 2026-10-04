// デモのサイトの、親のページ（上の帯・機能一覧。main.tsx）と、iframe の中のアプリの画面（app.tsx）のやりとり。
// アプリの画面は iframe の中で決まった大きさ（STAGE）のままふつうに描き、親のページが iframe ごと縮小して画面に収める。
// アプリの中には縮小がかからないので、PC で見るのと同じ見た目・動きになる

export const STAGE = { width: 1440, height: 900 };

// playing: ツアーの再生中 / done: ツアーが終わった / failed: ツアーが途中で止まった / free: ツアーを選ばずに触っている
export type Phase = 'playing' | 'done' | 'failed' | 'free';

// アプリの画面 → 親のページ
export type StageMessage =
  // いま見せている操作の説明
  | { type: 'demo:caption'; text: string }
  | { type: 'demo:phase'; phase: Phase }
  // 再生中に見ている人がアプリを触ろうとした（帯に「再生中は操作できません」と出す）
  | { type: 'demo:blocked' };

// 親のページ → アプリの画面
export type ShellMessage = { type: 'demo:pause'; paused: boolean };

export function isStageMessage(data: unknown): data is StageMessage {
  const type = (data as { type?: unknown } | null)?.type;
  return type === 'demo:caption' || type === 'demo:phase' || type === 'demo:blocked';
}

export function isShellMessage(data: unknown): data is ShellMessage {
  return (data as { type?: unknown } | null)?.type === 'demo:pause';
}

// iframe の中のページ。ツアーはハッシュで渡す
export function stageUrl(tourId: string | null): string {
  return tourId ? `app.html#${tourId}` : 'app.html';
}
