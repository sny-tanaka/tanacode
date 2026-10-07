// ウォークスルー（Claude がエディタでコードを示しながら説明し、人が「次へ」で進めて、その場で質問する）の型と、
// main・画面で使う文の組み立て。Claude は MCP サーバー tanacode-walkthrough で扱う（walkthrough-tools.ts）。
// 保存はしない（コードが進むと行番号がずれて壊れるため）。main のメモリの上に、セッションごとに今の 1 つだけを持つ。
// 人が閉じても捨てず、Claude が作り直す（start_walkthrough）までは、ソース管理の一覧からもう一度見られる

// 1 つのステップ。path: セッションのフォルダからの相対パス / startLine・endLine: 示す範囲（1 から。両端を含む）/
// title: 見出し / body: 説明（Markdown）/ view: file はエディタ、diff はブランチの差分（基点 ↔ 作業ツリー）の変更後の側に出す
// （ブランチで変わっていない・消したファイルは、エディタに出す）
export type WalkthroughView = 'file' | 'diff';
export type WalkthroughStep = { path: string; startLine: number; endLine: number; title: string; body: string; view: WalkthroughView };

// movedBy: 最後に示す場所を変えたのは誰か（Claude なら、人が前の場所を見ていれば画面を追従させる）/
// seq: 示す場所が変わるたびに増える / current: 人が見ているステップ（0 から）/ aside: 質問に答えるための寄り道（show_code）/
// visited: 人が開いたステップ / open: 人が見ている（閉じたら false。エディタの吹き出し・帯・「ここを聞く」を出さない）
export type Walkthrough = {
  id: string;
  title: string;
  steps: WalkthroughStep[];
  open: boolean;
  current: number;
  aside: WalkthroughStep | null;
  visited: number[];
  movedBy: 'claude' | 'human';
  seq: number;
  startedAt: number;
};

// main → 画面。walkthrough が null なら無くなった（セッションをアーカイブ・一覧から削除した など）
export type SessionWalkthrough = { sessionId: string; walkthrough: Walkthrough | null };

// 上限（Claude が大きすぎる手順を渡さないように）
export const MAX_STEPS = 40;
export const MAX_TITLE_CHARS = 120;
export const MAX_BODY_CHARS = 4000;

// 今、示している場所（寄り道があればそれ）
export function shownStep(w: Walkthrough): WalkthroughStep {
  return w.aside ?? w.steps[w.current];
}

export function lineRange(step: { startLine: number; endLine: number }): string {
  return step.startLine === step.endLine ? `${step.startLine}` : `${step.startLine}-${step.endLine}`;
}

export function stepLocation(step: WalkthroughStep): string {
  return `${step.path}:${lineRange(step)}`;
}

// 画面の「質問する」から送る発言。どこを見ての質問かを添える（Claude は MCP の説明でこの形を知っている）
export function stepQuestionText(w: Walkthrough, question: string): string {
  const step = shownStep(w);
  // 寄り道はパスで終わるので空白を挟み、ステップは括弧で終わるので挟まない
  const where = w.aside ? `寄り道で示した ${stepLocation(step)} ` : `${w.current + 1}/${w.steps.length}「${step.title}」（${stepLocation(step)}）`;
  return `ウォークスルー「${w.title}」の ${where}について質問です。\n\n${question.trim()}`;
}

// エディタで範囲を選んで「ここを聞く」から送る発言。選んだコードを添える
export function rangeQuestionText(path: string, startLine: number, endLine: number, quote: string, question: string): string {
  const fence = quote.includes('```') ? '````' : '```';
  return `${path}:${lineRange({ startLine, endLine })} について質問です。\n${fence}\n${quote}\n${fence}\n\n${question.trim()}`;
}

// 始めたあとで、ステップのファイルがディスク側で変わったときに「Claude に示し直してもらう」で送る発言
export function restartRequestText(w: Walkthrough): string {
  return `ウォークスルー「${w.title}」のコードが変わり、示している位置がずれているかもしれません。今のコードで、${w.current + 1}/${w.steps.length} から先を start_walkthrough で示し直してください。`;
}
