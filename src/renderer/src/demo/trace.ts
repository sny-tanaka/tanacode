// ツアーの確かめ（scripts/check-demo-tour.mjs・check-demo-tour-sp.mjs）のときだけ、台本の操作の足あと（説明・カーソルの移動・押す・
// ページの中への出来事の、始まりと終わり）をコンソールに出す。ページの処理（JavaScript）が固まると、確かめからはページの中を読めなくなる
// （CI のスマホのツアーで、固まったまま落ちて、直前の説明しか分からなかった）が、それまでに出した足あとは届くので、どの操作の途中で
// 固まったかが分かる。確かめは、足あとを止まったときの様子（state.json）に書き出す（scripts/demo-tour-evidence.mjs）。
// 確かめは、URL に ?demo-trace を付けて開く（アプリの画面の iframe からも、いちばん外のページの URL を見る）。ふだんのデモのサイトでは何も出さない

// 足あとの行の頭。確かめは、これで始まるコンソールの行を足あととして控える（scripts/demo-tour-evidence.mjs の TRACE_PREFIX と同じ）
export const DEMO_TRACE_PREFIX = '[demo-trace]';

export function traceEnabled(): boolean {
  try {
    return new URLSearchParams((window.top ?? window).location.search).has('demo-trace');
  } catch {
    // いちばん外のページが別のオリジン（埋め込まれたとき）なら、このページの URL を見る
    return new URLSearchParams(window.location.search).has('demo-trace');
  }
}

// 描き直し（フレーム）の足あとの行の頭（scripts/demo-tour-evidence.mjs の FRAME_PREFIX と同じ）
export const DEMO_FRAME_PREFIX = '[demo-frame]';

const enabled = traceEnabled();

export function trace(what: string): void {
  if (enabled) console.debug(`${DEMO_TRACE_PREFIX} ${Math.round(performance.now())}ms ${what}`);
}

// 描き直しのたびに、始まり（requestAnimationFrame）と、描き終えたあと（そのとき送ったメッセージを受けるタスク）を出す。
// CI のスマホのツアーで、台本の操作が「済み」になったあと、次の操作の前にページの処理が固まった（台本のコードには、終わらない待ちも
// ループも無かった）。最後の行が「前」なら描き直しの途中（スタイル・レイアウト・描画、ResizeObserver など）で、「後」なら描き直しの間の
// タスク（タイマー・出来事・React の描き直し）で固まったと分かる
export function startFrameTrace(): void {
  if (!enabled) return;
  const channel = new MessageChannel();
  channel.port1.onmessage = (e: MessageEvent<number>) => console.debug(`${DEMO_FRAME_PREFIX} ${Math.round(performance.now())}ms ${e.data} 後`);
  let n = 0;
  const frame = () => {
    console.debug(`${DEMO_FRAME_PREFIX} ${Math.round(performance.now())}ms ${++n} 前`);
    channel.port2.postMessage(n);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// 台本の操作の相手（セレクタ・要素・要素を返す関数）の短い名前
export function describeTarget(target: string | Element | (() => unknown)): string {
  if (typeof target === 'string') return target;
  if (typeof target === 'function') return '(要素を探す関数)';
  const cls = typeof target.className === 'string' && target.className ? `.${target.className.trim().split(/\s+/).join('.')}` : '';
  return `${target.tagName.toLowerCase()}${cls}`;
}
