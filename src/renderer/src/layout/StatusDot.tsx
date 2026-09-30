import { CheckMark } from './CheckMark';

export type DotState = 'running' | 'done' | 'error';

// ツール・タスク・エージェントの状態の印。実行中はぐるぐる、完了は緑のチェック、失敗・停止は赤の ✕。
// 丸（7px）と同じ場所に描くので、状態が変わってもまわりの文字は動かない。animate: 終わった瞬間だけチェックを描いて見せる
export function StatusDot({ state, animate = false }: { state: DotState; animate?: boolean }) {
  if (state === 'running') return <span className="tool-dot running" />;
  return <CheckMark animate={animate} failed={state === 'error'} slot={7} />;
}
