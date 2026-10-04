// デモのサイトの、親のページ（上の帯・機能一覧。main.tsx）と、iframe の中のアプリの画面（app.tsx）のやりとり。
// アプリの画面は iframe の中で決まった大きさ（STAGE）のままふつうに描き、親のページが iframe ごと縮小して画面に収める。
// アプリの中には縮小がかからないので、PC で見るのと同じ見た目・動きになる

export const STAGE = { width: 1440, height: 900 };

// 操作の説明が指す場所（アプリの画面の座標。STAGE の大きさのうちのどこか）
export type CaptionBox = { x: number; y: number; width: number; height: number };

// playing: ツアーの再生中 / done: ツアーが終わった / failed: ツアーが途中で止まった / free: ツアーを流さずに触っている
export type Phase = 'playing' | 'done' | 'failed' | 'free';

// アプリの画面 → 親のページ
export type StageMessage =
  // いま見せている操作の説明（空なら消す）。box: 説明が指す場所（null は場所を指さない。吹き出しを画面の下に出す）
  | { type: 'demo:caption'; text: string; box: CaptionBox | null }
  | { type: 'demo:phase'; phase: Phase }
  // いま流している章（chapterInfo.ts の順番）。preparing: 目次から飛んだ先の章の手前まで、早送りで流している
  | { type: 'demo:chapter'; index: number; preparing: boolean }
  // 章を最後まで見た（早送りで流した章は含めない）
  | { type: 'demo:watched'; index: number }
  // 再生中に見ている人がアプリを触ろうとした（帯に「再生中は操作できません」と出す）
  | { type: 'demo:blocked' }
  // 書き出した HTML を、親のページで重ねて見せる（null で閉じる）
  | { type: 'demo:export'; html: string | null };

// 親のページ → アプリの画面
export type ShellMessage =
  | { type: 'demo:pause'; paused: boolean }
  // 今の章の残りを早送りして、次の章から続ける
  | { type: 'demo:next' };

const STAGE_TYPES = new Set(['demo:caption', 'demo:phase', 'demo:chapter', 'demo:watched', 'demo:blocked', 'demo:export']);
const SHELL_TYPES = new Set(['demo:pause', 'demo:next']);

export function isStageMessage(data: unknown): data is StageMessage {
  return STAGE_TYPES.has((data as { type?: unknown } | null)?.type as string);
}

export function isShellMessage(data: unknown): data is ShellMessage {
  return SHELL_TYPES.has((data as { type?: unknown } | null)?.type as string);
}

// iframe の中のページ。始める章はハッシュで渡す（無ければツアーを流さずに触れるようにする）
export function stageUrl(chapterId: string | null): string {
  return chapterId ? `app.html#${chapterId}` : 'app.html';
}
