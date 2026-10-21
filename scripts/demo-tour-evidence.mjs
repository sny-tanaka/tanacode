// ツアーが止まったときの証拠（npm run demo:check・demo:check:sp の --evidence <フォルダ>）。
// 止まり方によっては手元で再現しにくいので、CI で止まったときに、そのときの画面の様子を残して原因を見分けられるようにする（CI の tour のジョブが artifact に残す）。
// 書き出すもの: page.png（ページの写し）・app.html（アプリの画面の HTML）・state.json（止まり方・直前の説明・コンソールのエラー・台本の操作と
// 描き直しの足あとと、下の snapshot が返す画面の様子）。スマホのほうは、WebKit の出力（webkit.log）も
import { existsSync, readFileSync } from 'node:fs';

// 台本の操作の足あと（src/renderer/src/demo/trace.ts）。確かめは、開く URL に TRACE_QUERY を付けて足あとを出させ、TRACE_PREFIX で始まる
// コンソールの行を控える。ページの処理が固まって中を読めなくなっても、それまでに届いた足あとから、どの操作の途中で固まったかが分かる
export const TRACE_QUERY = '?demo-trace';
export const TRACE_PREFIX = '[demo-trace]';
// 控える足あとの数（新しいものから）
const TRACE_KEEP = 40;
// 止まったときに、確かめの出力に出す足あとの数
export const TRACE_SHOWN = 10;

// 足あとの控え。add は、足あとの行なら控えて true を返す（ほかのコンソールの行は false）。lines は、控えた足あと（古い順。確かめを始めてからの秒を添える）。
// freeze のあとは控えない（止まったと決めたあとも、証拠を集める間に台本が進むことがある。止まったときの足あとを残す）
// 描き直しの足あと（trace.ts の startFrameTrace）。描き直しごとに「前」「後」の 2 行が出るので、台本の足あととは分けて、新しいものだけを控える。
// frames は、控えた描き直しの足あと（古い順）。最後の行が「前」なら描き直しの途中で、「後」なら描き直しの間のタスクで固まった
export const FRAME_PREFIX = '[demo-frame]';
const FRAME_KEEP = 6;
export function traceLog() {
  const started = Date.now();
  const lines = [];
  const frameLines = [];
  let frozen = false;
  const keep = (list, max, text, prefix) => {
    list.push(`${((Date.now() - started) / 1000).toFixed(1)}s ${text.slice(prefix.length).trim()}`);
    if (list.length > max) list.shift();
  };
  return {
    add(text) {
      const prefix = [TRACE_PREFIX, FRAME_PREFIX].find((p) => text.startsWith(p));
      if (!prefix) return false;
      if (frozen) return true;
      if (prefix === TRACE_PREFIX) keep(lines, TRACE_KEEP, text, prefix);
      else keep(frameLines, FRAME_KEEP, text, prefix);
      return true;
    },
    freeze() {
      frozen = true;
    },
    lines: () => [...lines],
    frames: () => [...frameLines],
  };
}

// WebKit（ページの処理のプロセスも）の標準出力・標準エラー。Playwright は、DEBUG に pw:browser があればそれを出し、DEBUG_FILE があれば
// そのファイルに書く。ページの処理が固まったまま落ちたときに、WebKit が何を出していたか（落とした理由・警告）を残すため、
// 確かめのジョブのログには出さずにファイルに書かせる。playwright を読み込む前に呼ぶ（読み込んだときの環境変数で決まる）
export function keepBrowserLog(file) {
  process.env.DEBUG = [process.env.DEBUG, 'pw:browser'].filter(Boolean).join(',');
  process.env.DEBUG_FILE = file;
}

// keepBrowserLog で書かせたファイルの、最後の n 行（無ければ空）
export function browserLogTail(file, n) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-n);
}

// 証拠を集める上限。ページの処理が応答しないまま止まったときも、ここで諦めて先へ進む（ジョブを止めたままにしない）
export const EVIDENCE_TIMEOUT_MS = 10_000;

// promise が上限までに終わらなければ fallback を返す
export function within(promise, fallback = null) {
  return Promise.race([promise, new Promise((r) => setTimeout(() => r(fallback), EVIDENCE_TIMEOUT_MS))]);
}

// アプリの画面（iframe の app.html）の中で動かして、画面の様子を JSON にできる形で返す。
// 差分のエディタ（Monaco）は、見えている行だけを描く。差分の行が見つからずに止まったときに、エディタの大きさ・スクロールの位置・描いた行・削除した行の領域から、
// 高さが 0 のままか・見える範囲の外か・描かれていないかを見分ける
export function snapshot() {
  const rect = (e) => {
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  };
  return {
    time: Math.round(performance.now()),
    visibility: document.visibilityState,
    hasFocus: document.hasFocus(),
    inner: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    diff: {
      title: document.querySelector('.diff-pane-title')?.textContent ?? null,
      panes: document.querySelectorAll('.diff-pane').length,
      pane: rect(document.querySelector('.diff-pane')),
      editors: [...document.querySelectorAll('.diff-pane .monaco-diff-editor')].map((diff) => ({
        className: diff.className,
        rect: rect(diff),
        sides: [...diff.querySelectorAll('.monaco-editor')].map((m) => ({
          className: m.className,
          rect: rect(m),
          guard: rect(m.querySelector('.overflow-guard')),
          // スクロールの位置は、行を並べた領域の style（top）に出る
          linesContent: m.querySelector('.lines-content')?.getAttribute('style') ?? null,
          viewLines: [...m.querySelectorAll('.view-lines > .view-line')].map((l) => `${l.style.top} ${(l.textContent ?? '').slice(0, 60)}`),
          viewZones: [...m.querySelectorAll('.view-zones > div')].map((z) => `${z.style.top} h=${z.style.height}`),
          slider: m.querySelector('.scrollbar.vertical .slider')?.getAttribute('style') ?? null,
        })),
      })),
    },
  };
}
