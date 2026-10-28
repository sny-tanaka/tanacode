import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeImage, webContents as allWebContents, type KeyboardInputEvent, type NativeImage, type Session, type WebContents } from 'electron';
import {
  BROWSER_DEVICES,
  BROWSER_MCP,
  browserTool,
  browserToolId,
  isClaudeAllowedUrl,
  isLocalUrl,
  NETWORK_PRESETS,
  THROTTLE_LIMITS,
  TOUCH_LIMITS,
  VIEWPORT_LIMITS,
  type NetworkPresetName,
} from '@shared/browser-tools';
import { t } from '@shared/i18n';
import type { BrowserActivity, BrowserAsk, BrowserAskChange, BrowserPoint, BrowserRect, BrowserThrottleChange, IpcChannel, IpcEvent } from '@shared/ipc';
import { mcpToolLabel } from '@shared/mcp-tools';
import { BrowserAsks } from './browser-asks';
import { sendAsClaude } from './claude-input';
import { BROWSER_GATE_REQUEST } from './browser-bridge';
import { textResult, type ToolResult } from './mcp-bridge';

// Claude Code から（中継とソケット経由で）届いた、アプリ内ブラウザの操作を実行する。
// 操作するのは、そのセッションの今のタブの webview の中身（webContents）。メインプロセスが直接動かす（capturePage・CDP）。
// ページが新しいウィンドウで開くもの（target=_blank・window.open）は、同じセッションの新しいタブで開かせる（openFromPage）。
// ページが開くポップアップ（features 付きの window.open など）は、アプリ内ブラウザの外の別ウインドウで開く（browser-windows.ts）。
// 別ウインドウは Claude の操作の対象にしない。Claude の操作で開いたときは、そのことを伝える（allowsPopup）。
// クリックは CDP（Input.*）で送る。キーと文字は、ページそのもの（webContents）に sendInputEvent・insertText で送る（key の説明）。
// どちらもウィンドウが前に無くても届き、ページには本物の操作（isTrusted）として届く。
// 隠れているセッションの webview も、画面（renderer）が透明にして描かせたままにするので、撮れるし操作できる。
// ユーザーに操作を頼む（ask_user_to_act）間は、Claude の操作として扱わない（ログインで外の認証のページへ移って戻ってこられるように）。
// その間は、Claude にブラウザを使わせない（ユーザーの操作とぶつからないように）。
// 許す先（isClaudeAllowedUrl）の外のページも開けるが、開くたびに人の許可を求める（フックが Claude Code の許可の確認を出させる。browser-gate.ts）。
// 人が許したら、そのタブでそのオリジンを許可し、タブを閉じるまで、その中の操作（読む・押す・同じオリジンの中の移動）には許可を求めない。
// 別のオリジンへ移ろうとしたら止め、続けるなら、また人に許可を求める（navigate の action: "continue"）。別オリジンの iframe には、許可は効かない。
// Claude に返す文は英語。画面の項目（メニュー・帯のボタン）の名前だけ、Claude が利用者に伝えられるよう t() で画面の言語にする

// 要素を探したり読んだりするスクリプトを動かす、ページとは別の JavaScript の世界（ページのスクリプトに書き換えられない）
const WORLD = 1100;
const MAX_TEXT = 20_000;
const MAX_CONSOLE = 200;
const MAX_FAILED = 100;
// 控えておく、トップのフレームで確定した移動の数（1 回の読み取りの間に、これより多く移ることは無い）
const MAX_NAVIGATED = 20;
const MAX_TREE_LINES = 1500;
// スクリーンショットの長い辺の上限（Claude が画像を読むときに縮める大きさ）
const MAX_IMAGE_SIDE = 1568;
// fullPage で撮る高さの上限（幅に対する倍率）。Claude は長い辺を縮めて読むので、細長すぎると字が読めなくなる
const MAX_FULL_PAGE_RATIO = 2.5;
// 1 回の操作の上限。中継の待ち（90 秒）より短くする
const TOOL_TIMEOUT_MS = 60_000;
// 撮るのを待つ上限。ふつうは数十ミリ秒で撮れる。返ってこないのは、アプリの画面が描かれていないとき（capture のコメント）なので、
// 1 回の操作の上限まで待たずに、理由の見当を添えて断る
const CAPTURE_TIMEOUT_MS = 15_000;
const CAPTURE_STALLED =
  `Could not take a screenshot: nothing came back within ${CAPTURE_TIMEOUT_MS / 1000} seconds. The tanacode window is probably not being drawn ` +
  '(for example, the window is hidden, or the screen is locked). The tools that read the page as text (get_text, get_accessibility_tree, inspect) still work. ' +
  'If you need the look of the page, tell the user and try again when they are back at the screen.';
// 許す先の外を開くときに、人に確認した印（navigate の確認のフックに ask を返したときに控える）が使える間と、セッションごとに控える数
const MARK_TTL_MS = 15 * 60_000;
const MAX_MARKS = 20;
// 撮った絵が空のとき、描かれるのを待って撮り直す時間と間隔（shoot）
const EMPTY_SHOT_WAIT_MS = 3_000;
const EMPTY_SHOT_POLL_MS = 100;
// CDP で大きさを当てたときに、ページの拡大率を 1 にする（Emulation.setPageScaleFactor）。スマホとして扱うページの拡大率が、1 でないまま残ることがあるため
// （Electron 44.7。機種の大きさにして、やめて、アプリの画面を拡大してから、また機種の大きさにすると、1.548 倍になった。
// そのときは、タッチが (368, 100) + 1.1 × 送った位置に届き、さわった所とずれた。Emulation.resetPageScaleFactor では戻らなかった）
const ONE_PAGE_SCALE = { pageScaleFactor: 1 };
// 要素まで動かしたあとの絵が描かれるのを待つスクリプト（2 コマ）と、待つ上限（screenshot）
const FRAMES_DRAWN = 'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))';
const FRAME_WAIT_MS = 500;
// 画素密度を決めたタブを CDP で撮るのを待つ時間（過ぎたら capturePage で撮る。shoot）
const DENSE_SHOT_WAIT_MS = 5_000;
// タブが大きさを持つまで待つ時間と間隔（laidOut）
const LAYOUT_WAIT_MS = 3_000;
const LAYOUT_POLL_MS = 100;
const LOAD_TIMEOUT_MS = 30_000;
// 画面（renderer）が webview を作って知らせるまで待つ時間
const ATTACH_TIMEOUT_MS = 10_000;
// 今のタブの webview がまだ知らされていないとき（作った直後）に待つ時間
const ACTIVE_WAIT_MS = 3_000;
// クリックする要素に枠を出してから押すまでの間（ユーザーが目で追えるように）
const HIGHLIGHT_MS = 400;
// 最後の操作のあと、「Claude が操作中」の帯を出しておく時間
const ACTIVE_LINGER_MS = 8_000;
// 操作が終わったあとも、Claude の操作として扱う間（押したボタンの処理が少し遅れてページを移すことがあるため）
const OPERATING_GRACE_MS = 2_000;
// 1 つのセッションで開けるタブの数（ページが window.open を繰り返しても、タブで埋まらないように）
const MAX_TABS = 20;
const VIEWPORTS: Record<string, number> = { full: 0, mobile: 390, tablet: 768 };
// 保存しておくスクリーンショットの数（screenshot の save。古いものから消す）
const MAX_SAVED_SHOTS = 100;
// タッチの既定の時間（長押し・なぞる）と、タップで指を置いておく時間
const LONG_PRESS_MS = 800;
const SWIPE_MS = 300;
const TAP_MS = 50;
// 2 本指のタップ・なぞるときの指の間（CSS の px）
const FINGER_GAP = 40;
const DEFAULT_STYLES = [
  'display', 'position', 'box-sizing', 'width', 'height', 'margin', 'padding', 'border', 'border-radius',
  'color', 'background-color', 'background-image', 'opacity', 'font-family', 'font-size', 'font-weight', 'line-height',
  'text-align', 'overflow', 'z-index', 'flex-direction', 'justify-content', 'align-items', 'gap', 'grid-template-columns', 'visibility',
];

// ページの中で動かすスクリプトの前に置く部品。いちばん外のページと、同じオリジンの iframe の中（5 段まで）を、同じように探す。
// 位置は、いちばん外の見えている範囲の左上から（CDP の Input に、そのまま渡せる）。別オリジンの iframe の中は、スクリプトからは見えない
const FRAMES = `
const __view = (el) => el.ownerDocument.defaultView;
const __style = (el) => __view(el).getComputedStyle(el);
const __inner = (f) => { const r = f.getBoundingClientRect(); const cs = __style(f); return { x: r.left + f.clientLeft + parseFloat(cs.paddingLeft || '0'), y: r.top + f.clientTop + parseFloat(cs.paddingTop || '0') }; };
const __docs = () => {
  const out = [];
  const walk = (doc, ox, oy, frame, depth) => {
    out.push({ doc, ox, oy, frame });
    if (depth >= 5) return;
    for (const f of doc.querySelectorAll('iframe, frame')) {
      let d = null;
      try { d = f.contentDocument; } catch (e) {}
      if (!d || !d.documentElement) continue;
      const p = __inner(f);
      walk(d, ox + p.x, oy + p.y, f, depth + 1);
    }
  };
  walk(document, 0, 0, null, 0);
  return out;
};
const __frameOf = (d) => (d.frame ? d.doc.location.href : null);
const __all = (sel) => { const out = []; for (const d of __docs()) for (const el of d.doc.querySelectorAll(sel)) out.push({ el, ...d }); return out; };
const __offset = (doc) => __docs().find((d) => d.doc === doc) || { ox: 0, oy: 0 };
const __rect = (el) => { const r = el.getBoundingClientRect(); const o = __offset(el.ownerDocument); return { x: r.left + o.ox, y: r.top + o.oy, width: r.width, height: r.height }; };
const __shown = (el) => { const r = el.getBoundingClientRect(); const cs = __style(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden'; };
const __hit = (x, y) => {
  let el = document.elementFromPoint(x, y), ox = 0, oy = 0;
  while (el && /^(IFRAME|FRAME)$/.test(el.tagName)) {
    let d = null;
    try { d = el.contentDocument; } catch (e) {}
    if (!d) return { el, cross: true, src: el.src };
    const p = __inner(el);
    ox += p.x; oy += p.y;
    el = d.elementFromPoint(x - ox, y - oy);
  }
  return { el, cross: false };
};
const __name = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.classList.length ? '.' + [...e.classList].slice(0, 2).join('.') : '');
const __label = (el) => {
  // パスワードの欄は、入っている値を使わない（ユーザーが入れた値を Claude に渡さない）
  const v = el.type === 'password' ? '' : el.value;
  const t = (el.innerText || v || (el.getAttribute && el.getAttribute('aria-label')) || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
  const f = el.ownerDocument === document ? null : el.ownerDocument.location.href;
  return __name(el) + (t ? ' "' + t + '"' : '') + (f ? ' (inside iframe ' + f + ')' : '');
};
`;

// 押す（press）ときに、ページの中で使う部品（FRAMES のあとに置く）
// - __closest: shadow DOM の外まで（ホストをたどって）祖先を探す
// - __deepHit: その位置の要素を、開いている shadow DOM の中までたどる（Shoelace・Lit などの部品の中のボタン）。
//   中身が見えない部品（閉じた shadow DOM の見込み）は closed
// - __realReason: ページの中の JavaScript では効かないので、本物の押下で押す理由（無ければ null）
// - __focusAt: 本物の押下と同じく、押した要素（かフォーカスできる祖先）にフォーカスを移す。編集できる所なら、押した位置にカーソルを置く。
//   フォーカスできる所が無ければ、今のフォーカスを外し、iframe の中なら、その iframe にフォーカスを移す（このあとのキーが、外の欄に入らないように）
const PRESS_PARTS = `
const __closest = (el, sel) => { for (let n = el; n; n = n.parentNode || n.host || null) if (n.nodeType === 1 && n.matches(sel)) return n; return null; };
const __deepHit = (x, y) => {
  const hit = __hit(x, y);
  if (!hit.el || hit.cross) return hit;
  let el = hit.el;
  const o = __offset(el.ownerDocument);
  while (el.shadowRoot) {
    const inner = el.shadowRoot.elementFromPoint(x - o.ox, y - o.oy);
    if (!inner || inner === el) break;
    el = inner;
  }
  return { el, cross: false, closed: el.localName.includes('-') && !el.shadowRoot };
};
const __realReason = (hit) => {
  const el = hit.el;
  const doc = el.ownerDocument;
  if (__closest(el, 'select')) return 'because it is a <select>';
  const input = __closest(el, 'input');
  const label = __closest(el, 'label');
  if ((input && input.type === 'file') || (label && label.control && label.control.type === 'file')) return 'because it is a file input';
  if (input && /^(range|number|date|time|datetime-local|month|week|color)$/.test(input.type)) return 'because it is an <input type=' + input.type + '>';
  if (__closest(el, 'video[controls], audio[controls]')) return 'because it is a media player with controls';
  const newWindow = (t) => !!t && !/^_(self|parent|top)$/i.test(t);
  const base = (doc.querySelector('base[target]') || {}).target || '';
  const link = __closest(el, 'a[href], area[href]');
  if (link && newWindow(link.target || base)) return 'because the link opens a new window';
  const submit = __closest(el, 'button, input[type=submit], input[type=image]');
  if (submit && submit.form && (submit.type === 'submit' || submit.type === 'image') && newWindow(submit.formTarget || submit.form.target || base)) {
    return 'because the form opens a new window';
  }
  if (__closest(el, '[draggable="true"]')) return 'because the element is draggable';
  if (hit.closed) return 'because JavaScript cannot reach inside the element (' + el.localName + ')';
  return null;
};
const __focusable = 'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), a[href], area[href], iframe, summary, [tabindex], [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], audio[controls], video[controls]';
const __focusAt = (el, lx, ly) => {
  const doc = el.ownerDocument;
  const to = __closest(el, __focusable);
  if (to) {
    to.focus({ preventScroll: true });
    if (el.isContentEditable && doc.caretRangeFromPoint) {
      const range = doc.caretRangeFromPoint(lx, ly);
      const selection = doc.getSelection();
      if (range && selection) { selection.removeAllRanges(); selection.addRange(range); }
    }
    return;
  }
  if (doc.activeElement && doc.activeElement !== doc.body) doc.activeElement.blur();
  for (let w = doc.defaultView; w && w.frameElement; w = w.frameElement.ownerDocument.defaultView) w.frameElement.focus({ preventScroll: true });
};
`;

// CDP の Accessibility.getFullAXTree の 1 つ
type AXValue = { value?: unknown };
type AXNode = {
  nodeId: string;
  ignored: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: { name: string; value: AXValue }[];
  childIds?: string[];
  parentId?: string;
};

// seq: 記録の通し番号（上限で前から削っても、移動で空にしても、番号は続く。ある時点からあとの記録を切り出すのに使う）。
// origin: 文を出したフレームのオリジン（分からなければ null）/ top: トップのフレームか。Claude に返すのは、許した先のフレームの文だけ（visibleLog）。
// 別オリジンの iframe の文や、移り始めたあとに前のページが出した文（pagehide など）も、同じ記録に入るため
type LogEntry = { level: string; text: string; seq: number; origin: string | null; top: boolean };
// 失敗した通信の記録。text: Claude に返す行 / origin・top: 通信を出したもの（requestSource。LogEntry と同じく visibleLog で、Claude に返すかを決める）
type RequestEntry = { text: string; origin: string | null; top: boolean };
// トップのフレームで確定した移動（did-navigate）。count: これまでの数（減らない）/ urls: 新しいもの MAX_NAVIGATED 件の URL。
// 読んでいる間に確定したページを、読み終えたときに確かめる（readFrom）
type Navigated = { count: number; urls: string[] };
// webview ごとのコンソールと失敗した通信（今のページを開いてから）と、確定した移動。画面がタブを知らせてくる前（ページの最初のスクリプト）から集める
type Logs = { console: LogEntry[]; failed: RequestEntry[]; seq: number; navigated: Navigated };
// タブ 1 つ（webview 1 つ）
type Guest = {
  tabId: string;
  contents: WebContents;
  logs: Logs;
  // CDP（debugger）をつないだか
  cdp: boolean;
  // 別プロセスで動く iframe（別サイトのもの）の CDP のセッション（Target.setAutoAttach でつなぐ）。
  // 見ていないタブ（透明にして描かせているもの）では、ページに送った操作がこの iframe に届かないので、iframe のセッションに直に送る。
  // セッションの ID → その iframe のフレームの ID（CDP の targetId。DOM.describeNode の frameId と同じ）
  children: Map<string, string>;
  // 人が、このタブで開くことを許した、許す先の外のオリジン（タブを閉じるまで残す）
  granted: Set<string>;
  // このタブに CDP で決めた画面の大きさ（Emulation。セッションの viewport を写したもの。決めていなければ null）。
  // CDP が外れると、決めたものも消えるので null に戻す（次に Claude が操作するときに決め直す）
  emulated: Emulation | null;
  // このタブを遅くしている様子（throttle。cpu: 何倍遅くするか。1 は遅くしていない / network: 通信の速さ。null は遅くしていない）。
  // タブを閉じるか、CDP が外れるまで、読み込み直しても・別のページへ移っても残る
  throttle: { cpu: number; network: NetworkPresetName | null };
  // Claude の操作の間に、許していない先へ移ろう（開こう）として止めた先。navigate の action: "continue" で、人に許可を求めて開く。
  // newWindow: ページが新しいウインドウで開こうとしたもの（新しいタブで開く）
  stopped: { url: string; newWindow: boolean } | null;
};
// セッションのタブ
type Tabs = {
  tabs: Map<string, Guest>;
  // 今のタブ（画面が知らせてくる。Claude の操作はこのタブに対して行う）
  active: string | null;
  // Claude の操作の間に、許していない先へ移ろう（開こう）として止めたもの・新しいタブで開いたもの・別ウインドウで開いたポップアップ・
  // 許していない先へ移ろうとして止めたポップアップの移動（呼び出しごとに空にする）
  blocked: string | null;
  opened: string[];
  popups: string[];
  popupBlocked: string | null;
  // これからできるタブに渡す許可（navigate で新しいタブに開く・許可したページが同じオリジンを新しいウインドウで開く）。
  // 画面がタブを作って知らせてくるまでの間だけ（until まで）
  handoff: { origin: string; until: number }[];
  // Claude が set_viewport で決めた画面の大きさ（数字か機種の名前で決めたもの）。セッションのどのタブにも（あとで開いたタブにも）当てる。
  // set_viewport で full・mobile・tablet を選ぶか、人がツールバーで表示幅を選ぶまで残る
  viewport: Emulation | null;
};

// CDP で決める画面の大きさ。width・height: CSS の px（0 は枠の大きさのまま）/ deviceScaleFactor: 画素密度（0 は画面のまま）/
// mobile: スマホとして扱う（タッチ・meta viewport）/ label: ツールバーと Claude への答えに出す名前
type Emulation = { label: string; width: number; height: number; deviceScaleFactor: number; mobile: boolean };

// JavaScript の実行の確認のフックが答えたときのページ。フックに渡った式と、そのときの今のタブのオリジン（無い・空のタブなら null）。
// evaluate が同じ式で呼ばれたら 1 回だけ使い、そのオリジンのページでだけ動かす（フックが確認を省いた・人が確認したページと、動かすページをずらさない）。
// 控えは「断る」にしか使わないので、期限やメニューのオフでは消さない（消すと、確認したページを確かめずに動かす側に倒れる）。
// 控えが無い（フックが動かなかった・アプリに聞けなかった・上限で押し出された）呼び出しも、動かさない。捨てるのは、上限と forget だけ
// toolUseId: その呼び出しの ID（フックの入力に tool_use_id があったときだけ）。呼び出しにも ID があれば、ID で結びつける
type EvaluateMark = { expression: string; origin: string | null; toolUseId?: string };

// 許す先の外を開くことを、人に確認した印。フックが ask を返したときに控え、navigate が開くときに 1 回だけ使う。
// url: 開く先 / newTab: 新しいタブに開くか / tabId: 確認したときの今のタブ（無ければ null）
type Mark = { url: string; newTab: boolean; tabId: string | null; until: number };

type Deps = {
  // 画面（renderer）へ送る。チャンネルごとの中身は shared/ipc.ts の IpcEvent
  send: <C extends keyof IpcEvent>(channel: C, payload: IpcEvent[C]) => void;
  // メニューで、Claude にアプリ内ブラウザを操作させるのがオンか
  enabled: () => boolean;
  // ユーザーが足した、Claude に許す先
  extraHosts: () => string[];
  // アプリの画面（webview を持っている webContents）
  host: () => WebContents | null;
  // アプリの画面を、描かれる状態にする（戻す関数を返す）。見ていないプロファイルの画面は非表示で、その中のタブは大きさが決まらず、
  // 撮ることもできないため、ツールを動かす間だけ頼む
  drawHost: () => () => void;
  // screenshot の save で、撮った画像を保存するフォルダ（アプリのデータの中）
  screenshotDir: string;
  // あるセッションか（アーカイブしたものも含む）
  hasSession: (id: string) => boolean;
  // ユーザーに操作を頼んだ・終わった（ask が null）。一覧の印と通知に使う（画面の帯は channels.ask で送る）
  onAsk: (sessionId: string, ask: BrowserAsk | null) => void;
  channels: {
    open: typeof IpcChannel.BrowserOpen;
    activity: typeof IpcChannel.BrowserActivity;
    viewport: typeof IpcChannel.BrowserViewport;
    throttle: typeof IpcChannel.BrowserThrottle;
    newTab: typeof IpcChannel.BrowserNewTab;
    selectTab: typeof IpcChannel.BrowserSelectTab;
    closeTab: typeof IpcChannel.BrowserCloseTab;
    ask: typeof IpcChannel.BrowserAsk;
  };
};

class ToolError extends Error {}

export class BrowserControl {
  private readonly sessions = new Map<string, Tabs>();
  // webContents の ID → コンソールと失敗した通信
  private readonly logs = new Map<number, Logs>();
  private readonly waiters = new Map<string, ((guest: Guest) => void)[]>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  // 動いている呼び出しの数（セッションごと）。0 になって少したったら、帯を消す
  private readonly running = new Map<string, number>();
  // 最後の呼び出しが終わった時刻（セッションごと）
  private readonly endedAt = new Map<string, number>();
  // 描かせ続けている webContents と、頼んでいる数（unthrottle）
  private readonly drawing = new Map<WebContents, number>();
  // ユーザーに頼んでいる操作
  private readonly asks: BrowserAsks;
  // 人に確認した、許す先の外を開く印（セッションごと）
  private readonly marks = new Map<string, Mark[]>();
  // JavaScript の実行の確認のフックが答えたときのページ（セッションごと）
  private readonly evaluateMarks = new Map<string, EvaluateMark[]>();

  constructor(private readonly deps: Deps) {
    this.asks = new BrowserAsks((sessionId, ask) => {
      this.deps.send(this.deps.channels.ask, { sessionId, ask } satisfies BrowserAskChange);
      this.deps.onAsk(sessionId, ask);
    });
  }

  // 失敗した通信（4xx・5xx・つながらなかったもの）を集める。プレビューの webview が使うセッションに 1 回だけ付ける
  watchNetwork(session: Session): void {
    const filter = { urls: ['http://*/*', 'https://*/*'] };
    // 通信を出したもの（どのページ・フレームか）も残す。Claude に返すのは、許した先のものだけ（failedRequests）
    const record = (details: RequestDetails & { webContentsId?: number }, text: string) => {
      const logs = details.webContentsId === undefined ? undefined : this.logs.get(details.webContentsId);
      if (!logs) return;
      logs.failed.push({ text, ...requestSource(details) });
      if (logs.failed.length > MAX_FAILED) logs.failed.splice(0, logs.failed.length - MAX_FAILED);
    };
    session.webRequest.onCompleted(filter, (details) => {
      if (details.statusCode >= 400) record(details, `${details.statusCode} ${details.method} ${details.url} (${details.resourceType})`);
    });
    session.webRequest.onErrorOccurred(filter, (details) => {
      // 移ったための中断（ERR_ABORTED）は失敗にしない
      if (details.error !== 'net::ERR_ABORTED') record(details, `${details.error} ${details.method} ${details.url} (${details.resourceType})`);
    });
  }

  // プレビューの webview ができたとき（did-attach-webview）。コンソールと失敗した通信を、この時から集める
  track(contents: WebContents): Logs {
    const existing = this.logs.get(contents.id);
    if (existing) return existing;
    const logs: Logs = { console: [], failed: [], seq: 0, navigated: { count: 0, urls: [] } };
    const id = contents.id;
    this.logs.set(id, logs);
    contents.on('console-message', (event) => {
      const { level, message, sourceId, lineNumber } = event;
      const where = sourceId ? ` (${sourceId}${lineNumber ? `:${lineNumber}` : ''})` : '';
      const { origin, top } = frameOf(event);
      logs.console.push({ level, text: `${message}${where}`, seq: logs.seq++, origin, top });
      if (logs.console.length > MAX_CONSOLE) logs.console.splice(0, logs.console.length - MAX_CONSOLE);
    });
    // 新しいページを開いたら、コンソールと失敗した通信を空にする（「今のページを開いてから」のもの）
    contents.on('did-start-navigation', (event) => {
      if (event.isMainFrame && !event.isSameDocument) {
        logs.console.length = 0;
        logs.failed.length = 0;
      }
    });
    // トップのフレームで確定した移動を控える（読んでいる間に、許していない先を経て戻ったかを見るため）
    contents.on('did-navigate', (_event, url: string) => {
      logs.navigated.count++;
      logs.navigated.urls.push(url);
      if (logs.navigated.urls.length > MAX_NAVIGATED) logs.navigated.urls.splice(0, logs.navigated.urls.length - MAX_NAVIGATED);
    });
    contents.once('destroyed', () => this.logs.delete(id));
    return logs;
  }

  // 画面（renderer）が、セッションのタブの webview を作って知らせてきた。アプリの画面の中の webview だけを受け付ける
  attach(sessionId: string, tabId: string, contentsId: number): void {
    const contents = allWebContents.fromId(contentsId);
    const host = this.deps.host();
    if (!contents || !host || contents.getType() !== 'webview' || contents.hostWebContents !== host) return;
    const session = this.tabsOf(sessionId);
    if (session.tabs.get(tabId)?.contents === contents) return;
    // 画面が同じタブの webview を作り直したときは、そのタブの許可を引き継ぐ。作ったばかりのタブなら、渡す許可を受け取る
    let granted = session.tabs.get(tabId)?.granted;
    if (!granted) {
      const now = Date.now();
      granted = new Set(session.handoff.filter((h) => h.until > now).map((h) => h.origin));
      session.handoff = [];
    }
    const guest: Guest = {
      tabId,
      contents,
      logs: this.track(contents),
      cdp: false,
      children: new Map(),
      granted,
      stopped: null,
      emulated: null,
      throttle: { cpu: 1, network: null },
    };
    session.tabs.set(tabId, guest);
    // 並びは、画面がタブを作った順（タブの ID の番号）
    session.tabs = new Map([...session.tabs].sort(([a], [b]) => tabNumber(a) - tabNumber(b)));
    // CDP が外れると、CDP で決めた画面の大きさと遅くする設定も消える
    contents.debugger.on('detach', () => {
      guest.cdp = false;
      guest.children.clear();
      guest.emulated = null;
      if (guest.throttle.cpu !== 1 || guest.throttle.network) {
        guest.throttle = { cpu: 1, network: null };
        this.sendThrottle(sessionId, guest);
      }
    });
    contents.debugger.on('message', (_event, method, params: { sessionId?: string; targetInfo?: { type?: string; targetId?: string } }) => {
      if (method === 'Target.attachedToTarget' && params.sessionId && params.targetInfo?.type === 'iframe') guest.children.set(params.sessionId, params.targetInfo.targetId ?? '');
      if (method === 'Target.detachedFromTarget' && params.sessionId) guest.children.delete(params.sessionId);
    });
    contents.once('destroyed', () => {
      const current = this.sessions.get(sessionId);
      if (current?.tabs.get(tabId) === guest) current.tabs.delete(tabId);
    });
    for (const resolve of this.waiters.get(sessionId) ?? []) resolve(guest);
    this.waiters.delete(sessionId);
    // Claude が決めた画面の大きさは、あとで開いたタブにも当てる（人が開いたタブも、枠はその大きさになるため）
    if (session.viewport) void this.emulate(guest, session.viewport).catch(() => undefined);
  }

  // 人がツールバーで表示幅を選んだ。Claude が set_viewport で決めた大きさ・画素密度・タッチをやめる（画面は、選んだ幅にする）
  resetViewport(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.viewport = null;
    for (const guest of session.tabs.values()) if (!guest.contents.isDestroyed()) void this.emulate(guest, null).catch(() => undefined);
  }

  // 人がツールバーで、タブを遅くするのをやめた
  clearThrottle(sessionId: string, tabId: string): void {
    const guest = this.sessions.get(sessionId)?.tabs.get(tabId);
    if (guest && !guest.contents.isDestroyed()) void this.applyThrottle(sessionId, guest, { cpu: 1, network: null }).catch(() => undefined);
  }

  // 画面で今のタブが変わった（タブが無くなったら null）
  activate(sessionId: string, tabId: string | null): void {
    this.tabsOf(sessionId).active = tabId;
  }

  // Claude が操作している最中（と、終わってすぐ）の webview か。この間は、許していない先へ移らせず、開かせない
  isOperating(contents: WebContents): boolean {
    const found = this.find(contents);
    return !!found && this.operating(found.sessionId);
  }

  // webview のトップのフレームが url へ移ろうとしている（リンク・リダイレクト・ページのスクリプト）。
  // Claude の操作で、許していない先（許す先の外で、このタブで許可していないオリジン）へ移ろうとしていれば止める（true を返す）。
  // 止めた先はタブに控える（続けるなら、navigate の action: "continue" で人に許可を求める）。ユーザーの操作は止めない。
  // popup: contents のタブが開いたポップアップ（別ウインドウ）の移動。そのタブで許した先かを見て、止めたことだけを Claude に伝える
  // （Claude はポップアップを操作できないので、continue の先には控えない）
  blocksNavigation(contents: WebContents, url: string, popup = false): boolean {
    const found = this.find(contents);
    if (!found || !this.operating(found.sessionId) || this.allowedIn(found.guest, url)) return false;
    if (popup) {
      found.session.popupBlocked = url;
      return true;
    }
    found.session.blocked = url;
    found.guest.stopped = { url, newWindow: false };
    return true;
  }

  // ページがポップアップ（別ウインドウ）を開こうとした。開いてよいか（browser-windows.ts）。
  // Claude の操作で、許していない先を開こうとしたものは開かない（開こうとしたタブに控える。continue では、新しいタブに開く）。
  // Claude の操作の間に開くものは、Claude に伝える。知らないタブ（画面からまだ知らせが来ていない）は、Claude が操作していないので開いてよい。
  // 空のページ（about:blank）は開いてよい（中身は開いたページが書く。そこから移るときは、blocksNavigation の popup で確かめる）
  allowsPopup(contents: WebContents, url: string): boolean {
    const found = this.find(contents);
    if (!found || !this.operating(found.sessionId)) return true;
    if (!isBlank(url) && !this.allowedIn(found.guest, url)) {
      found.session.blocked = url;
      found.guest.stopped = { url, newWindow: true };
      return false;
    }
    found.session.popups.push(url);
    return true;
  }

  // ページが新しいウィンドウで開こうとした（target=_blank・window.open）。同じセッションの新しいタブで開かせる。
  // Claude の操作で、許していない先を開こうとしたものは開かない（開こうとしたページのタブに控える）。
  // そのタブで許可したオリジンなら、新しいタブにも許可を渡す（同じサイトの中の移動として扱う）。
  // 知らない webview なら false（呼び出し元が扱う）
  openFromPage(contents: WebContents, url: string, disposition: string): boolean {
    const found = this.find(contents);
    if (!found) return false;
    const { sessionId, session, guest } = found;
    if (session.tabs.size >= MAX_TABS) return true;
    const operating = this.operating(sessionId);
    if (operating && !this.allowedIn(guest, url)) {
      session.blocked = url;
      guest.stopped = { url, newWindow: true };
      return true;
    }
    if (operating) {
      session.opened.push(url);
      // 許す先でなければ、このタブで許したオリジン（上の allowedIn）
      if (!this.allowed(url)) this.handOff(session, webOrigin(url)!);
    }
    // ⌘ を押したままのクリックは、裏で開く（Claude の操作は、続けて操作できるよう前に出す）
    this.deps.send(this.deps.channels.newTab, { sessionId, url, background: !operating && disposition === 'background-tab', openerTabId: found.guest.tabId });
    return true;
  }

  // ユーザーに操作を頼んでいるか・頼んでいるもの（画面を作り直したとき用）
  isAsking(sessionId: string): boolean {
    return this.asks.has(sessionId);
  }

  pendingAsks(): BrowserAskChange[] {
    return this.asks.list();
  }

  // ユーザーが帯のボタンを押した
  answerAsk(sessionId: string, askId: unknown, answer: unknown): void {
    this.asks.answer(sessionId, askId, answer);
  }

  // メニューで Claude の操作をオフにした。頼んでいるものはやめる（帯が残って、押すとページを返すことのないように）。
  // 人が許した、許す先の外のオリジンと、確認した印も捨てる（オンに戻したら、また人に許可を求める）
  turnOff(): void {
    this.asks.cancelAll(`The request was withdrawn because the user turned off the tanacode MCP "${t('tools.server.browser')}" in tanacode > ${t('main.menu.mcpSettings')}.`);
    for (const session of this.sessions.values()) {
      session.handoff = [];
      for (const guest of session.tabs.values()) {
        guest.granted.clear();
        guest.stopped = null;
      }
    }
    this.marks.clear();
  }

  // 子セッションの許可の確認のうち、人だけが答えられるもの（親の Claude に許させない。sessions-control.ts の answer_permission）。
  // 親が読むときと答えるときに、そのときの様子で決める。当たれば、親に伝える理由（英語）を返す
  // - 開く: 許す先の外を開く確認（フックが ask を返して、印を控えたもの）。印のある間の navigate の確認は、どれも人に任せる
  //   （どの確認の印かを取り違えても、人に聞く側に倒す）
  // - JavaScript の実行: 今のタブのページが、人が許したサイト（許す先か、そのタブで人が開くのを許したオリジン）のときだけ、親も答えられる。
  //   まだ許していないサイト・許したあとに別のサイトへ移った・タブが無い（確かめられない）ときは、人に任せる
  humanOnly(sessionId: string, request: { tool: string }): string | null {
    if (request.tool === browserToolId('evaluate')) {
      const guest = this.activeNow(sessionId);
      const url = guest?.contents.getURL() ?? '';
      if (guest && !isBlank(url) && this.allowedIn(guest, url)) return null;
      return 'it asks to run JavaScript on a page that the user has not allowed for Claude in the in-app browser (neither a host the user allowed in tanacode nor a site the user permitted in that tab), and only the user can answer such a prompt.';
    }
    if (request.tool !== browserToolId('navigate') || this.liveMarks(sessionId).length === 0) return null;
    return 'it asks to open a page outside the hosts the user allowed for Claude in the in-app browser, and only the user can answer such a prompt.';
  }

  // セッションを消した・アーカイブしたとき
  forget(sessionId: string): void {
    this.asks.cancel(sessionId);
    this.marks.delete(sessionId);
    this.evaluateMarks.delete(sessionId);
    this.sessions.delete(sessionId);
    this.running.delete(sessionId);
    this.endedAt.delete(sessionId);
    clearTimeout(this.idleTimers.get(sessionId));
    this.idleTimers.delete(sessionId);
  }

  // 中継から届いた呼び出し。signal: Claude Code が呼び出しを取り消した（中継がソケットを閉じた）。
  // toolUseId: Claude Code がその呼び出しに付けた ID（中継が受け取ったときだけ。evaluate の控えと結びつける）
  async handle(sessionId: string, name: string, args: Record<string, unknown>, signal?: AbortSignal, toolUseId?: string): Promise<ToolResult> {
    if (name === BROWSER_GATE_REQUEST) return this.gate(sessionId, args);
    const tool = browserTool(name);
    if (!tool) return textResult(`Unknown tool: ${name}`, true);
    if (!this.deps.enabled()) return textResult(`The user has turned off the tanacode MCP "${t('tools.server.browser')}" in tanacode > ${t('main.menu.mcpSettings')}.`, true);
    if (!this.deps.hasSession(sessionId)) return textResult('This session is not in tanacode.', true);
    if (tool.kind === 'ask') {
      this.yieldToUser(sessionId);
      return this.asks.wait(sessionId, args.message, () => this.askedPage(sessionId), signal);
    }
    if (this.asks.has(sessionId)) {
      const done = t('preview.ask.done');
      return textResult(
        `You have asked the user to act in the browser. The browser cannot be used until the user presses "${done}" or "${t('preview.ask.decline')}" in the banner. ` +
          `Wait for the answer without operating the browser (if the user says in the chat that they are done, ask them to press "${done}" in the banner).`,
        true,
      );
    }
    this.begin(sessionId, mcpToolLabel(BROWSER_MCP, tool));
    const release = this.drawHost();
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ToolError(`Did not finish within ${TOOL_TIMEOUT_MS / 1000} seconds.`)), TOOL_TIMEOUT_MS);
      });
      return await Promise.race([this.run(sessionId, name, args, toolUseId), timeout]);
    } catch (error) {
      return textResult(error instanceof Error ? error.message : String(error), true);
    } finally {
      clearTimeout(timer);
      release();
      this.end(sessionId);
    }
  }

  // ユーザーの返事に添える、今のページ。許していない先のページ（外の認証のページなど）は、タイトルも URL の道筋も読ませない
  // （ページが書ける・認証の途中の値が URL に入っていることがある）
  private askedPage(sessionId: string): string[] {
    const session = this.sessions.get(sessionId);
    const guest = session?.active ? session.tabs.get(session.active) : undefined;
    const url = guest && !guest.contents.isDestroyed() ? guest.contents.getURL() : '';
    if (!guest || isBlank(url)) return ['Current tab: (no page open)'];
    if (!this.allowedIn(guest, url)) return [`The current page is not allowed for Claude (${originOf(url) ?? 'invalid URL'}). It can be neither read nor operated any further.`];
    return [`Current page: ${guest.contents.getTitle() || '(untitled)'}`, `URL: ${url}`];
  }

  // 確認のフック（browser-gate.ts）への答え。request.tool: ツールの名前（mcp__…）/ request.input: ツールの入力。待たない（フックは短い間しか待たない）
  // - JavaScript の実行: 今のタブが localhost のページなら、確認を省いてよい。タブが無い・空のときは、確認を出させる側に倒す。
  //   答える URL は、許していない先ならオリジンだけ（フックが確認の理由に書く）
  // - 開く: 許す先の外で、そのタブで許可していないオリジンを開くなら、人に確認させ（outside にオリジン）、確認した印を控える
  private gate(sessionId: string, request: Record<string, unknown>): ToolResult {
    if (request.tool === browserToolId('navigate')) {
      const input = request.input && typeof request.input === 'object' ? (request.input as Record<string, unknown>) : {};
      return textResult(JSON.stringify({ outside: this.gateNavigate(sessionId, input) }));
    }
    // メニューでオフのとき・知らないセッションには答えない（フックは、確認を出させる側に倒す）
    if (!this.deps.enabled() || !this.deps.hasSession(sessionId)) return textResult('The in-app browser is not available for this session.', true);
    const guest = this.activeNow(sessionId);
    const url = guest?.contents.getURL() ?? '';
    // 答えたときのページを、同じ式の呼び出しのために控える
    const input = request.input && typeof request.input === 'object' ? (request.input as Record<string, unknown>) : {};
    if (typeof input.expression === 'string') {
      const marks = this.evaluateMarks.get(sessionId) ?? [];
      const toolUseId = typeof request.toolUseId === 'string' ? request.toolUseId : undefined;
      marks.push({ expression: input.expression, origin: webOrigin(url), ...(toolUseId ? { toolUseId } : {}) });
      this.evaluateMarks.set(sessionId, marks.slice(-MAX_MARKS));
    }
    // フックは、この URL を確認の理由に書く（Claude Code の確認の理由として、親のセッションにも届く）。許していない先は、オリジンだけ
    return textResult(JSON.stringify({ local: isLocalUrl(url), url: guest && !isBlank(url) ? this.shownUrl(url, guest) : url }));
  }

  // navigate の入力から、人に確認する先を決めて、確認した印を控える。確認しないものは null
  // （許す先・そのタブで許可したオリジン・開けないもの。開けないものは navigate が断る）
  private gateNavigate(sessionId: string, input: Record<string, unknown>): string | null {
    // オフ・知らないセッションでは、navigate が断る
    if (!this.deps.enabled() || !this.deps.hasSession(sessionId)) return null;
    const guest = this.activeNow(sessionId);
    const target = this.destination(guest, input);
    if (!target) return null;
    const origin = webOrigin(target.url);
    if (!origin || this.openable(guest, target.url, target.newTab)) return null;
    const marks = this.liveMarks(sessionId);
    marks.push({ ...target, tabId: guest?.tabId ?? null, until: Date.now() + MARK_TTL_MS });
    this.marks.set(sessionId, marks.slice(-MAX_MARKS));
    return origin;
  }

  // navigate が開く先と、新しいタブに開くか。navigate と同じ順に読む（action を先に見る）。読み込み直す・開く先の無いものは null
  private destination(guest: Guest | undefined, input: Record<string, unknown>): { url: string; newTab: boolean } | null {
    const action = optionalString(input.action);
    if (action === 'continue') return guest?.stopped ? { url: guest.stopped.url, newTab: guest.stopped.newWindow } : null;
    if (action === 'back' || action === 'forward') {
      if (!guest) return null;
      const history = guest.contents.navigationHistory;
      const index = history.getActiveIndex() + (action === 'back' ? -1 : 1);
      return index >= 0 && index < history.length() ? { url: history.getEntryAtIndex(index).url, newTab: false } : null;
    }
    if (action) return null;
    const raw = optionalString(input.url);
    return raw ? { url: toUrl(raw), newTab: !guest || input.newTab === true } : null;
  }

  // 生きている印（使える間を過ぎたものは捨てる）
  private liveMarks(sessionId: string): Mark[] {
    const now = Date.now();
    const marks = (this.marks.get(sessionId) ?? []).filter((m) => m.until > now);
    if (marks.length > 0) this.marks.set(sessionId, marks);
    else this.marks.delete(sessionId);
    return marks;
  }

  private async run(sessionId: string, name: string, args: Record<string, unknown>, toolUseId?: string): Promise<ToolResult> {
    const session = this.tabsOf(sessionId);
    session.blocked = null;
    session.opened = [];
    session.popups = [];
    session.popupBlocked = null;
    const result = await this.dispatch(sessionId, name, args, toolUseId);
    if (result.isError) return result;
    // 操作の途中で、許していない先へ移ろうとして止めたら、そう伝える
    if (session.blocked) result.content.push({ type: 'text', text: `Blocked an attempt to navigate to (or open) a page not allowed for Claude (${originShown(session.blocked)}).${CONTINUE_HINT}` });
    // ポップアップは別ウインドウで開き、Claude は操作できない。ログインなどは人に頼むよう伝える（オリジンだけ。URL に認証の途中の値が入っていることがある）
    if (session.popups.length > 0) {
      result.content.push({
        type: 'text',
        text:
          `Opened a popup window outside the in-app browser (${[...new Set(session.popups.map((url) => (isBlank(url) ? 'about:blank' : originShown(url))))].join(', ')}). ` +
          'You can neither read nor operate it (it is not a tab). If the user needs to act there (for example, to log in), ask them with ask_user_to_act.',
      });
    }
    if (session.popupBlocked) result.content.push({ type: 'text', text: `Blocked an attempt to move a popup window opened by the page to a page not allowed for Claude (${originShown(session.popupBlocked)}).` });
    // 新しいタブで開いたら、そのタブができるのを待って伝える（画面がそのタブを今のタブにする）
    if (session.opened.length > 0) {
      const guest = await this.activeGuest(sessionId).catch(() => null);
      if (guest) await waitForLoad(guest.contents);
      const index = guest ? [...session.tabs.keys()].indexOf(guest.tabId) + 1 : 0;
      result.content.push({
        type: 'text',
        text: `Opened in a new tab${index > 0 ? ` (tab ${index})` : ''}: ${session.opened.join(', ')}. Further actions apply to this tab (switch tabs with list_tabs and select_tab).`,
      });
    }
    return result;
  }

  private async dispatch(sessionId: string, name: string, args: Record<string, unknown>, toolUseId?: string): Promise<ToolResult> {
    if (name === 'navigate') return this.navigate(sessionId, args);
    if (name === 'list_tabs') return this.listTabs(sessionId);
    if (name === 'select_tab') return this.selectTab(sessionId, args.index);
    if (name === 'close_tab') return this.closeTab(sessionId, args.index);
    const guest = await this.current(sessionId);
    // Claude が決めた画面の大きさが、このタブに当たっていなければ当てる（CDP が外れて消えた・当てる前に操作した）
    // 当てられなくても（CDP をつなげない など）、ツールは続ける（読むツールまで止めない）。当たっていないので、次の呼び出しでまた当てる
    if (name !== 'set_viewport') await this.emulate(guest, this.tabsOf(sessionId).viewport).catch(() => undefined);
    switch (name) {
      case 'screenshot':
        return this.screenshot(guest, optionalString(args.selector), args.fullPage === true, args.save === true);
      case 'get_text':
        return this.text(guest, optionalString(args.selector));
      case 'get_accessibility_tree':
        return this.tree(guest);
      case 'inspect':
        return this.inspect(guest, requiredString(args.selector, 'selector'), stringList(args.properties));
      case 'get_console_logs':
        return this.consoleLogs(guest, optionalString(args.level) ?? 'all', args.clear === true);
      case 'get_failed_requests':
        return this.failedRequests(guest, args.clear === true);
      case 'click':
        return this.click(sessionId, guest, args);
      case 'type':
        return this.type(sessionId, guest, args);
      case 'press_key':
        return this.pressKey(guest, requiredString(args.key, 'key'), stringList(args.modifiers) ?? []);
      case 'scroll':
        return this.scroll(guest, optionalString(args.selector), numberOr(args.deltaX, 0), numberOr(args.deltaY, 0));
      case 'wait_for':
        return this.waitFor(guest, args);
      case 'set_viewport':
        return this.setViewport(sessionId, guest, args);
      case 'touch':
        return this.touch(sessionId, guest, args);
      case 'throttle':
        return this.throttle(sessionId, guest, args);
      case 'evaluate':
        return this.evaluate(sessionId, guest, requiredString(args.expression, 'expression'), toolUseId);
    }
    return textResult(`Unknown tool: ${name}`, true);
  }

  // ---- 開く ----

  private async navigate(sessionId: string, args: Record<string, unknown>): Promise<ToolResult> {
    const action = optionalString(args.action);
    const rawUrl = optionalString(args.url);
    if (!action && !rawUrl) throw new ToolError('Provide url or action.');
    if (action === 'continue') return this.continueStopped(sessionId);
    if (action) {
      const guest = await this.current(sessionId);
      const history = guest.contents.navigationHistory;
      if (action === 'reload') guest.contents.reload();
      else {
        const index = history.getActiveIndex() + (action === 'back' ? -1 : 1);
        if (index < 0 || index >= history.length()) throw new ToolError(action === 'back' ? 'There is no page to go back to.' : 'There is no page to go forward to.');
        this.permit(sessionId, guest, history.getEntryAtIndex(index).url, false, 'The destination');
        if (action === 'back') history.goBack();
        else history.goForward();
      }
      await waitForLoad(guest.contents);
      return this.pageResult(guest, action === 'reload' ? 'Reloaded' : action === 'back' ? 'Went back' : 'Went forward');
    }
    const url = toUrl(rawUrl!);
    const current = await this.activeGuest(sessionId).catch(() => null);
    // まだブラウザを開いていないセッションも、新しいタブに開く
    const newTab = !current || args.newTab === true;
    this.permit(sessionId, current, url, newTab, 'The URL to open');
    const guest = await this.open(sessionId, current, url, newTab);
    return this.pageResult(guest, args.newTab === true ? `Opened in a new tab (tab ${this.numberOf(sessionId, guest)})` : 'Opened');
  }

  // 止めた先へ進む（action: "continue"）。今のタブで止めたものを開く（許す先の外なら、フックが人に許可を求めている）
  private async continueStopped(sessionId: string): Promise<ToolResult> {
    const current = await this.activeGuest(sessionId);
    const stopped = current.stopped;
    if (!stopped) throw new ToolError('Nothing was stopped in the current tab, so there is nothing to continue. To open a page, pass url.');
    this.permit(sessionId, current, stopped.url, stopped.newWindow, 'The page to continue to');
    current.stopped = null;
    const guest = await this.open(sessionId, current, stopped.url, stopped.newWindow);
    return this.pageResult(guest, stopped.newWindow ? `Opened in a new tab (tab ${this.numberOf(sessionId, guest)})` : 'Opened');
  }

  // url を開いて、開いたタブを返す。newTab: 新しいタブに開く（current が無ければ、ブラウザを開いて最初のタブに）
  private async open(sessionId: string, current: Guest | null, url: string, newTab: boolean): Promise<Guest> {
    const session = this.tabsOf(sessionId);
    const stoppedError = (blocked: string) =>
      new ToolError(`Stopped ${url} because it tried to navigate to a page not allowed for Claude (${originShown(blocked)}).${CONTINUE_HINT}`);
    if (newTab || !current) {
      // 画面に webview を作らせ、知らせを待つ
      const attached = this.waitAttach(sessionId);
      if (current) this.deps.send(this.deps.channels.newTab, { sessionId, url, background: false, openerTabId: current.tabId });
      else this.deps.send(this.deps.channels.open, { sessionId, url });
      const guest = await attached;
      await waitForLoad(guest.contents);
      if (session.blocked) throw stoppedError(session.blocked);
      return guest;
    }
    await current.contents.loadURL(url).catch((error: unknown) => {
      // 許していない先へのリダイレクトを止めた
      if (session.blocked) throw stoppedError(session.blocked);
      // 移ったための中断（リダイレクトなど）は失敗にしない
      if (!/ERR_ABORTED/.test(String(error))) throw new ToolError(`Could not open ${url} (${error instanceof Error ? error.message : String(error)}).`);
    });
    return current;
  }

  // url を開いてよいか確かめ、人に許可されたものなら、開くタブに許可を足す（新しいタブなら、できたときに渡す）。
  // 許す先・そのタブで許可したオリジンなら、そのまま開いてよい。ほかの http(s) の先は、フックが人に確認したときの印を使い切る。
  // 印が無ければ断る（フックが動かなかった・確認したときと今のタブが違う）
  private permit(sessionId: string, current: Guest | null, url: string, newTab: boolean, what: string): void {
    if (this.openable(current ?? undefined, url, newTab)) return;
    const origin = webOrigin(url);
    if (!origin) throw new ToolError(`${what} (${originShown(url)}) is not allowed for Claude. Only http and https pages can be opened.`);
    const marks = this.liveMarks(sessionId);
    const tabId = current?.tabId ?? null;
    const index = marks.findIndex((m) => m.url === url && m.newTab === newTab && m.tabId === tabId);
    if (index === -1) {
      throw new ToolError(
        `${what} (${origin}) is outside the hosts the user allowed for Claude (localhost, 127.0.0.1, *.local and the hosts added under "${t('mcpSettings.hostsTitle')}" in tanacode > ${t('main.menu.mcpSettings')}), ` +
          'so opening it needs the permission of the user every time, and tanacode has no permission from the user for this. Call navigate again to ask the user. ' +
          'If the user is not asked, this session started before tanacode added this check: ask the user to restart Claude Code in this session.',
      );
    }
    marks.splice(index, 1);
    if (newTab) this.handOff(this.tabsOf(sessionId), origin);
    else current!.granted.add(origin);
  }

  // 許す先か、そのタブで許可したオリジンを、確認なしで開けるか。新しいタブは、許す先だけ
  private openable(current: Guest | undefined, url: string, newTab: boolean): boolean {
    return newTab ? this.allowed(url) : this.allowedIn(current, url);
  }

  // これからできるタブに、オリジンの許可を渡す（画面がタブを作って知らせてくるまでの間）
  private handOff(session: Tabs, origin: string): void {
    session.handoff.push({ origin, until: Date.now() + ATTACH_TIMEOUT_MS });
  }

  // タブの番号（1 から）
  private numberOf(sessionId: string, guest: Guest): number {
    return [...this.tabsOf(sessionId).tabs.keys()].indexOf(guest.tabId) + 1;
  }

  // ---- タブ ----

  private listTabs(sessionId: string): ToolResult {
    const session = this.tabsOf(sessionId);
    const tabs = [...session.tabs.values()].filter((g) => !g.contents.isDestroyed());
    if (tabs.length === 0) return textResult('There are no tabs (open one with navigate).');
    const lines = tabs.map((guest, i) => {
      const url = guest.contents.getURL();
      // 許していない先のページは、タイトルも URL の道筋も読ませない（ページが書ける・認証の途中の値が URL に入っていることがある）。
      // 空のタブ（「＋」で開いたもの）は、許していない先ではない（navigate で開ける）。タイトルは読まない
      const title = isBlank(url) ? '(untitled)' : this.allowedIn(guest, url) ? guest.contents.getTitle() || '(untitled)' : '(not allowed for Claude)';
      return `${guest.tabId === session.active ? '*' : ' '} ${i + 1}. ${title} — ${isBlank(url) ? '(empty tab)' : this.shownUrl(url, guest)}`;
    });
    return textResult(`Tabs (* marks the current tab):\n${lines.join('\n')}`);
  }

  // index: 1 から数えたタブの番号
  private tabAt(sessionId: string, index: unknown): Guest {
    const tabs = [...this.tabsOf(sessionId).tabs.values()].filter((g) => !g.contents.isDestroyed());
    const guest = typeof index === 'number' && Number.isInteger(index) ? tabs[index - 1] : undefined;
    if (!guest) throw new ToolError(`There is no tab ${String(index)} (${count(tabs.length, 'tab')} open; check with list_tabs).`);
    return guest;
  }

  private async selectTab(sessionId: string, index: unknown): Promise<ToolResult> {
    const guest = this.tabAt(sessionId, index);
    this.tabsOf(sessionId).active = guest.tabId;
    this.deps.send(this.deps.channels.selectTab, { sessionId, tabId: guest.tabId });
    await sleep(150);
    return this.pageResult(guest, `Switched to tab ${String(index)}`);
  }

  private async closeTab(sessionId: string, index: unknown): Promise<ToolResult> {
    const session = this.tabsOf(sessionId);
    const guest = index === undefined ? await this.activeGuest(sessionId) : this.tabAt(sessionId, index);
    const number = [...session.tabs.keys()].indexOf(guest.tabId) + 1;
    this.deps.send(this.deps.channels.closeTab, { sessionId, tabId: guest.tabId });
    session.tabs.delete(guest.tabId);
    // 今のタブを閉じたときは、画面が次のタブを今のタブにして知らせてくる
    await sleep(150);
    return textResult(`Closed tab ${number} (${count(session.tabs.size, 'tab')} left)`);
  }

  // 開いたあとのページの様子。許していない先に移っていたら、そう伝える（タイトルと URL の道筋は伏せる）
  private pageResult(guest: Guest, done: string): ToolResult {
    const url = guest.contents.getURL();
    // 空のタブ（「＋」で開いたもの）は、許していない先ではない。navigate で、このタブに開けることを伝える
    if (isBlank(url)) return textResult(`${done}: (empty tab)\nThe current tab is empty. Open a page in it with navigate.`);
    const allowed = this.allowedIn(guest, url);
    const lines = [`${done}: ${allowed ? guest.contents.getTitle() || '(untitled)' : '(not allowed for Claude)'}`, `URL: ${this.shownUrl(url, guest)}`];
    if (!allowed) lines.push('This page is not allowed for Claude, so it can be neither read nor operated any further.');
    const errors = guest.logs.console.filter((l) => l.level === 'error' && this.visibleLog(guest, l)).length;
    if (errors > 0) lines.push(`The console has ${count(errors, 'error')} (read them with get_console_logs).`);
    const failed = guest.logs.failed.filter((r) => this.visibleLog(guest, r)).length;
    if (failed > 0) lines.push(`${count(failed, 'request')} failed (read them with get_failed_requests).`);
    return textResult(lines.join('\n'));
  }

  // ---- 読む ----

  // アプリの画面（webview を持っている webContents）を、描かれる状態にして、戻す関数を返す。ツールを動かす間ずっと頼む。
  // アプリの画面が「隠れている」扱いの間は、中のタブの置き場所が決まらず（大きさが 0 のまま）、撮ることもできない
  // （capturePage も CDP の Page.captureScreenshot も、アプリの画面が描いて合成した絵から撮るので、返ってこない。エラーにもならない）。
  // 隠れている扱いになるのは、
  // - 見ていないプロファイルの画面（足したプロファイルの画面は WebContentsView で、見ていないものは非表示にしている）
  // - 足したプロファイルの画面を見ているときに、Mac の画面をロックした（既定のプロファイルの画面は、ロック中も描かれ続ける）
  // 2026-10-12、足したプロファイルのセッションで、画面のロック中に、撮るたびに 60 秒の時間切れになった。
  // 2 つのことをする（どちらが欠けても、撮れない状態が残る。開発用ビルドで確かめた）
  // - 非表示の画面を、表示にする（deps.drawHost）
  // - backgroundThrottling を切る（unthrottle）。ロック中は、表示にしてあっても描かれないため
  // ツールを動かす間だけにする（隠れている間も描き続けると、電気を使う）
  private drawHost(): () => void {
    const hide = this.deps.drawHost();
    const throttle = this.unthrottle(this.deps.host());
    return () => {
      throttle();
      hide();
    };
  }

  // backgroundThrottling を切って、戻す関数を返す。切った webContents がウインドウに 1 つでもあると、ウインドウ全体が描かれ続ける
  // （Electron の決まり）。同じ画面でいくつものツールが同時に動くことがあるので、頼んでいる数を数えて、最後の 1 つが終わったら戻す。
  // もともと切ってあるものには触れない
  private unthrottle(contents: WebContents | null | undefined): () => void {
    if (!contents || contents.isDestroyed()) return () => {};
    const count = this.drawing.get(contents) ?? 0;
    if (count === 0) {
      if (!contents.getBackgroundThrottling()) return () => {};
      contents.setBackgroundThrottling(false);
    }
    this.drawing.set(contents, count + 1);
    return () => {
      const left = (this.drawing.get(contents) ?? 1) - 1;
      if (left > 0) {
        this.drawing.set(contents, left);
        return;
      }
      this.drawing.delete(contents);
      if (!contents.isDestroyed()) contents.setBackgroundThrottling(true);
    };
  }

  // タブが大きさを持つまで待つ。アプリの画面を描かせ始めた直後（drawHost）は、タブの置き場所がまだ決まっておらず、大きさが 0 のことがある。
  // そのまま進めると、要素の位置が取れず、撮った絵も空になる。0 でない同じ大きさが 2 回続いたら、決まったとみなす。
  // 待っても決まらなければ、そのまま進める（どうなったかは、あとの操作が伝える）
  private async laidOut(guest: Guest): Promise<void> {
    const size = async () => (await this.world(guest, '({ laidOutWidth: innerWidth, laidOutHeight: innerHeight })').catch(() => null)) as { laidOutWidth: number; laidOutHeight: number } | null;
    let last = await size();
    if (!last || (last.laidOutWidth > 0 && last.laidOutHeight > 0)) return;
    const until = Date.now() + LAYOUT_WAIT_MS;
    while (Date.now() < until) {
      await sleep(LAYOUT_POLL_MS);
      const next = await size();
      if (!next) return;
      if (next.laidOutWidth > 0 && next.laidOutHeight > 0 && next.laidOutWidth === last.laidOutWidth && next.laidOutHeight === last.laidOutHeight) return;
      last = next;
    }
  }

  // 撮る。撮る間は、タブの backgroundThrottling も切る（アプリの画面の分は、drawHost）。それでも返ってこなければ、理由の見当を添えて断る
  private async capture<T>(guest: Guest, take: () => Promise<T>): Promise<T> {
    const release = this.unthrottle(guest.contents);
    let timer: NodeJS.Timeout | undefined;
    try {
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ToolError(CAPTURE_STALLED)), CAPTURE_TIMEOUT_MS);
      });
      return await Promise.race([take(), stalled]);
    } finally {
      clearTimeout(timer);
      release();
    }
  }

  // 見えている範囲（rect があれば、その中）を撮る。空の絵が返ったり、例外になったりしたら、少しの間、撮り直す
  // （描かせ始めた直後は、まだ 1 枚も描かれていないことがある。capturePage は、描いた絵を合成する側の都合で、
  // UnknownVizError などの例外になることもある）。撮り直しても例外のままなら、CDP の Page.captureScreenshot で撮る
  // （別の道筋で撮るもの。それも撮れなければ、capturePage の例外を伝える）
  // 画素密度を決めているタブ（set_viewport の deviceScaleFactor）は、先に CDP で撮る（denseShot）。capturePage は、アプリの画面の画素密度で撮るため
  // （Retina なら 2 倍。iPhone の 3 倍にならない）。CDP で撮れなければ（返ってこない・空・画面と違う絵）、capturePage で撮る
  private shoot(guest: Guest, rect?: { x: number; y: number; width: number; height: number }): Promise<NativeImage> {
    return this.capture(guest, async () => {
      if (guest.emulated?.deviceScaleFactor) {
        const dense = await Promise.race([this.denseShot(guest, rect), sleep(DENSE_SHOT_WAIT_MS).then(() => null)]);
        if (dense) return dense;
      }
      const until = Date.now() + EMPTY_SHOT_WAIT_MS;
      while (true) {
        let image: NativeImage | null = null;
        let failure: unknown = null;
        try {
          image = await (rect ? guest.contents.capturePage(rect) : guest.contents.capturePage());
        } catch (error) {
          failure = error;
        }
        if (image && !image.isEmpty()) return image;
        if (Date.now() >= until) {
          if (image) return image;
          const fallback = await this.cdpShot(guest, rect);
          if (fallback) return fallback;
          throw new ToolError(`Could not take a screenshot (${failure instanceof Error ? failure.message : String(failure)}).`);
        }
        await sleep(EMPTY_SHOT_POLL_MS);
      }
    });
  }

  // CDP の Page.captureScreenshot で、見えている範囲（rect があれば、その中。CSS の px）を撮る。撮れなければ null。
  // rect は、見えている範囲をまるごと撮ってから切り出す。clip は使わない（Electron 44.7 の webview で、clip をページの先頭から測るか
  // 見えている範囲から測るかが、ブラウザを閉じているか・その前に captureBeyondViewport で撮ったかで入れ替わり、別の場所が撮れたため）
  private async cdpShot(guest: Guest, rect?: { x: number; y: number; width: number; height: number }): Promise<NativeImage | null> {
    const shot = (await this.cdp(guest, 'Page.captureScreenshot', { format: 'png' }).catch(() => null)) as { data?: unknown } | null;
    const image = typeof shot?.data === 'string' ? nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64')) : null;
    if (!image || image.isEmpty()) return null;
    return rect ? this.cropShot(guest, image, rect) : image;
  }

  // 画素密度を決めたタブを、その画素密度で撮る（CDP）。撮った絵が、capturePage で撮った絵（画面に出ている絵）と合うときだけ使い、
  // 合わなければ null（capturePage で撮る）。アプリの画面の画素密度より大きい画素密度を決めると、CDP が崩れた絵を返すことがあるため
  // （Electron 44.7 の webview。画面の画素密度 1 で、2 倍・3 倍を決めると、真っ黒・ページ全体が青い四角のくり返し、などになった。
  // 画面が 2 倍（Retina）なら、3 倍でも正しく撮れた。どの組み合わせで崩れるかの決まりは見つけられなかったので、撮るたびに見比べる）
  private async denseShot(guest: Guest, rect?: { x: number; y: number; width: number; height: number }): Promise<NativeImage | null> {
    const whole = await this.cdpShot(guest);
    if (!whole) return null;
    const dense = rect ? await this.cropShot(guest, whole, rect) : whole;
    // 見比べるのは、撮る範囲どうし（見えている範囲全体で比べると、小さな要素の所が違っても、まわりが合って同じとみなしてしまう）
    const plain = await (rect ? guest.contents.capturePage(rect) : guest.contents.capturePage()).catch(() => null);
    if (!dense || !plain || plain.isEmpty() || !looksSame(dense, plain)) return null;
    return dense;
  }

  // 見えている範囲をまるごと撮った絵から、rect（CSS の px）を切り出す。撮った絵は、見えている範囲の画素密度倍
  private async cropShot(guest: Guest, image: NativeImage, rect: { x: number; y: number; width: number; height: number }): Promise<NativeImage | null> {
    const scale = image.getSize().width / Math.max((await this.viewport(guest)).width, 1);
    const cropped = image.crop({ x: Math.round(rect.x * scale), y: Math.round(rect.y * scale), width: Math.round(rect.width * scale), height: Math.round(rect.height * scale) });
    return cropped.isEmpty() ? null : cropped;
  }

  private async screenshot(guest: Guest, selector: string | undefined, fullPage: boolean, save: boolean): Promise<ToolResult> {
    const { contents } = guest;
    const since = guest.logs.navigated.count;
    let image: NativeImage;
    // 撮った範囲の幅（CSS の px）。撮った画像は、Retina などでは画素密度の倍の大きさなので、Claude にはこの幅に縮めて返す。
    // CDP で撮るもの（fullPage）は、はじめからページの大きさ
    let cssWidth: number;
    let note: string;
    if (selector) {
      const target = await this.locate(guest, selector);
      const pad = 8;
      const x = Math.max(0, Math.floor(target.rect.x - pad));
      const y = Math.max(0, Math.floor(target.rect.y - pad));
      const width = Math.min(target.viewport.width - x, Math.ceil(target.rect.width + pad * 2));
      const height = Math.min(target.viewport.height - y, Math.ceil(target.rect.height + pad * 2));
      if (width <= 0 || height <= 0) throw new ToolError(`"${selector}" has zero size and cannot be captured.`);
      // 要素まで動かした（locate の scrollIntoView）あとの絵が描かれるのを待つ。待たずに CDP で撮ると、動かす前の絵が撮れた
      // （Electron 44.7 の webview。ブラウザを閉じて見ていないタブ）。描かれない状態でも先へ進むよう、待つのは長くても 0.5 秒
      await Promise.race([this.world(guest, FRAMES_DRAWN).catch(() => undefined), sleep(FRAME_WAIT_MS)]);
      image = await this.shoot(guest, { x, y, width, height });
      cssWidth = width;
      note = `${selector} (${target.description})`;
    } else if (fullPage) {
      await this.laidOut(guest);
      const metrics = (await this.cdp(guest, 'Page.getLayoutMetrics')) as { cssContentSize: { width: number; height: number }; cssLayoutViewport: { clientWidth: number } };
      const width = metrics.cssLayoutViewport.clientWidth;
      const total = Math.ceil(metrics.cssContentSize.height);
      const height = Math.min(total, Math.round(width * MAX_FULL_PAGE_RATIO));
      const shot = (await this.capture(guest, () =>
        this.cdp(guest, 'Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width, height, scale: 1 },
        }),
      )) as { data: string };
      image = nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'));
      // captureBeyondViewport で撮ると、CDP で決めた大きさのうち、タッチ対応が外れる（Electron 44.7 で確かめた。大きさと画素密度は残る）ので、当て直す
      if (guest.emulated) {
        const emulation = guest.emulated;
        guest.emulated = null;
        await this.emulate(guest, emulation).catch(() => undefined);
      }
      cssWidth = width;
      note = height < total ? `Top ${height}px of the page (full height ${total}px; scroll and take another screenshot for the rest)` : `Full page (${width}×${height})`;
    } else {
      await this.laidOut(guest);
      image = await this.shoot(guest);
      cssWidth = (await this.viewport(guest)).width;
      note = 'Visible area';
    }
    const url = contents.getURL();
    this.readFrom(guest, url, since);
    if (image.isEmpty()) throw new ToolError('Could not take a screenshot (the page may not have been rendered yet).');
    // 保存するものは、撮ったままの大きさ（人に見せるもの。実機と同じ画素の細かさ）
    const saved = save ? await this.saveShot(image) : null;
    const original = image.getSize();
    image = shrink(image, original.width / Math.max(cssWidth, 1));
    const size = image.getSize();
    const lines = [`${note}, ${this.shownUrl(url, guest)}, image ${size.width}×${size.height}`];
    // 画素密度を決めたのに、その細かさで撮れなかった（CDP の絵が画面と合わなかった）。ページ全体は、はじめから CSS の px で撮る
    const density = guest.emulated?.deviceScaleFactor ?? 0;
    const shotDensity = original.width / Math.max(cssWidth, 1);
    if (save && !fullPage && density > 0 && shotDensity < density * 0.99) {
      lines.push(
        `The saved image has the pixel density of this screen (${round(shotDensity)}×), not the emulated ${density}×: on this screen, the capture at ${density}× did not match what is shown, so tanacode used the screen's capture.`,
      );
    }
    if (saved) lines.push(`Saved to ${saved} (${original.width}×${original.height}). Send it to the user with SendUserFile if they need to see it.`);
    return {
      content: [
        { type: 'image', data: image.toPNG().toString('base64'), mimeType: 'image/png' },
        { type: 'text', text: lines.join('\n') },
      ],
    };
  }

  // 撮った画像を、アプリのデータの中のフォルダに PNG で保存して、そのパスを返す。古いものは、新しいもの MAX_SAVED_SHOTS 枚を残して消す。
  // 名前は撮った時刻（並べると古い順）と、同じ時刻に撮ったものを分ける乱数
  private async saveShot(image: NativeImage): Promise<string> {
    const dir = this.deps.screenshotDir;
    try {
      await mkdir(dir, { recursive: true });
      const file = join(dir, `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}.png`);
      await writeFile(file, image.toPNG());
      const shots = (await readdir(dir)).filter((name) => /^screenshot-.*\.png$/.test(name)).sort();
      for (const old of shots.slice(0, Math.max(0, shots.length - MAX_SAVED_SHOTS))) await rm(join(dir, old), { force: true });
      return file;
    } catch (error) {
      throw new ToolError(`Took the screenshot, but could not save it in ${dir} (${error instanceof Error ? error.message : String(error)}).`);
    }
  }

  // 同じオリジンの iframe の中の文字も、iframe ごとに分けて読む
  private async text(guest: Guest, selector: string | undefined): Promise<ToolResult> {
    const result = (await this.world(
      guest,
      `(() => {${FRAMES}
        const textOf = (el) => (el ? el.innerText || el.textContent || '' : '');
        ${
          selector
            ? `const hit = __all(${JSON.stringify(selector)})[0];
        if (!hit) return null;
        const parts = [{ frame: __frameOf(hit), text: textOf(hit.el) }];`
            : `const parts = __docs().map((d) => ({ frame: __frameOf(d), text: textOf(d.doc.body) }));`
        }
        return { title: document.title, url: location.href, parts };
      })()`,
    )) as { title: string; url: string; parts: { frame: string | null; text: string }[] } | null;
    if (!result) throw new ToolError(`No element matches "${selector}".`);
    // 読んだ文書が、許していない先のもの（読む前に確かめたあとで、移動が確定した）なら返さない
    this.readFrom(guest, result.url);
    // ページ全体のときは、別プロセスの iframe（許す先のものだけ）の文字も読む
    if (!selector) {
      for (const frame of await this.childFrames(guest)) {
        if (!this.allowed(frame.url)) continue;
        const value = (await this.cdp(guest, 'Runtime.evaluate', { expression: 'document.body ? document.body.innerText : ""', returnByValue: true }, frame.child).catch(() => null)) as { result?: { value?: unknown } } | null;
        if (typeof value?.result?.value === 'string') result.parts.push({ frame: frame.url, text: value.result.value });
      }
    }
    const body = result.parts
      .map((p) => `${p.frame ? `--- inside iframe (${p.frame}) ---\n` : ''}${p.text.replace(/\n{3,}/g, '\n\n').trim()}`)
      .join('\n\n');
    return textResult([`Title: ${result.title || '(none)'}`, `URL: ${this.shownUrl(result.url, guest)}`, '', clip(body, MAX_TEXT)].join('\n'));
  }

  private async tree(guest: Guest): Promise<ToolResult> {
    // いちばん外のページと、同じプロセスで動く iframe（同じオリジンなど）のフレームごとに読む。許していない先の iframe は読まない。
    // いちばん外のページと同じオリジンの iframe は、そのページと同じく、タブで許可したオリジンなら読む（get_text と同じ）
    const since = guest.logs.navigated.count;
    const top = originOf(guest.contents.getURL());
    type FrameTree = { frame: { id: string; url: string }; childFrames?: FrameTree[] };
    const { frameTree } = (await this.cdp(guest, 'Page.getFrameTree')) as { frameTree: FrameTree };
    const frames: { id: string; url: string; top: boolean }[] = [];
    const collect = (node: FrameTree, top: boolean) => {
      frames.push({ id: node.frame.id, url: node.frame.url, top });
      node.childFrames?.forEach((child) => collect(child, false));
    };
    collect(frameTree, true);
    const lines: string[] = [];
    for (const frame of frames) {
      if (lines.length >= MAX_TREE_LINES) break;
      if (!frame.top) {
        if (!this.allowed(frame.url) && !(originOf(frame.url) === top && this.allowedIn(guest, frame.url))) continue;
        lines.push(`--- inside iframe (${frame.url}) ---`);
      }
      const result = (await this.cdp(guest, 'Accessibility.getFullAXTree', { frameId: frame.id }).catch(() => null)) as { nodes: AXNode[] } | null;
      if (result) this.formatTree(result.nodes, lines);
    }
    // 別プロセスの iframe（許す先のものだけ）
    for (const frame of await this.childFrames(guest)) {
      if (lines.length >= MAX_TREE_LINES || !this.allowed(frame.url)) continue;
      lines.push(`--- inside iframe (${frame.url}) ---`);
      const result = (await this.cdp(guest, 'Accessibility.getFullAXTree', {}, frame.child).catch(() => null)) as { nodes: AXNode[] } | null;
      if (result) this.formatTree(result.nodes, lines);
    }
    if (lines.length >= MAX_TREE_LINES) lines.push(`…(truncated at ${MAX_TREE_LINES} lines)`);
    const url = guest.contents.getURL();
    this.readFrom(guest, url, since);
    return textResult([`URL: ${this.shownUrl(url, guest)}`, ...lines].join('\n'));
  }

  // 読み終えたときに、読んだページ（url）が許していない先なら断る。読む前に今のページを確かめても（current）、前から読み込み中だった
  // 移動が読んでいる間に確定すると、読んだものは移った先のものかもしれない。空のタブになっただけなら、そのまま返す（前のページか、空のもの）。
  // since: 読み始めたときの、トップのフレームで確定した移動の数（何度かに分けて読むもの。スクリーンショット・ツリー）。読んでいる間に確定した
  // ページも確かめる（許していない先を経て、許す先へ戻ったときも、その間に読んだものは、許していない先のものかもしれない）
  private readFrom(guest: Guest, url: string, since?: number): void {
    const { count, urls } = guest.logs.navigated;
    const moved = since === undefined ? 0 : count - since;
    if (moved > urls.length) throw new ToolError('The page moved several times while it was being read, so the result was not returned.');
    for (const page of [...urls.slice(urls.length - moved), url]) {
      if (!isBlank(page) && !this.allowedIn(guest, page)) {
        throw new ToolError(`The page moved to a page not allowed for Claude (${originShown(page)}) while it was being read, so the result was not returned.`);
      }
    }
  }

  // CDP のアクセシビリティのツリーを、字下げした一覧にして lines に足す
  private formatTree(nodes: AXNode[], lines: string[]): void {
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));
    const root = nodes.find((n) => !n.parentId) ?? nodes[0];
    const STATES = ['focused', 'checked', 'pressed', 'selected', 'expanded', 'disabled', 'required', 'invalid', 'level'];
    const walk = (node: AXNode | undefined, depth: number) => {
      if (!node || lines.length >= MAX_TREE_LINES) return;
      const role = String(node.role?.value ?? '');
      const name = String(node.name?.value ?? '').replace(/\s+/g, ' ').trim();
      // 中身の無い入れ物は飛ばして、子を同じ深さで出す
      const skip = node.ignored || ((role === 'generic' || role === 'none' || role === 'InlineTextBox' || role === 'LineBreak') && !name) || role === 'StaticText';
      let next = depth;
      if (!skip) {
        const states = (node.properties ?? [])
          .filter((p) => STATES.includes(p.name) && p.value.value !== false && p.value.value !== 'false')
          .map((p) => (p.value.value === true || p.value.value === 'true' ? p.name : `${p.name}=${String(p.value.value)}`));
        const value = node.value?.value !== undefined && node.value.value !== '' ? ` value=${JSON.stringify(String(node.value.value).slice(0, 100))}` : '';
        lines.push(`${'  '.repeat(depth)}- ${role}${name ? ` "${name.slice(0, 200)}"` : ''}${value}${states.length ? ` [${states.join(', ')}]` : ''}`);
        next = depth + 1;
      }
      for (const child of node.childIds ?? []) walk(byId.get(child), next);
    };
    walk(root, 0);
  }

  private async inspect(guest: Guest, selector: string, properties: string[] | undefined): Promise<ToolResult> {
    const props = properties && properties.length > 0 ? properties : DEFAULT_STYLES;
    const found = (await this.world(
      guest,
      `(() => {${FRAMES}
        const props = ${JSON.stringify(props)};
        let all;
        try { all = __all(${JSON.stringify(selector)}); } catch (e) { return { url: location.href, error: 'Invalid selector: ' + e.message }; }
        return { url: location.href, total: all.length, items: all.slice(0, 10).map((hit) => {
          const el = hit.el;
          const r = __rect(el);
          const cs = __style(el);
          const html = el.outerHTML;
          return {
            html: html.length > 2000 ? html.slice(0, 2000) + '…' : html,
            rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
            visible: __shown(el) && cs.display !== 'none',
            frame: __frameOf(hit),
            styles: Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)])),
          };
        }) };
      })()`,
    )) as { url?: string; error?: string; total: number; items: { html: string; rect: BrowserRect; visible: boolean; frame: string | null; styles: Record<string, string> }[] };
    // 読んだ文書が、許していない先のもの（読む前に確かめたあとで、移動が確定した）なら返さない
    this.readFrom(guest, found.url ?? guest.contents.getURL());
    if (found.error) throw new ToolError(found.error);
    if (found.total === 0) throw new ToolError(`No element matches "${selector}".`);
    const parts = found.items.map((item, i) =>
      [
        `## Element ${i + 1} (${item.visible ? 'visible' : 'not visible'}, x=${item.rect.x} y=${item.rect.y} ${item.rect.width}×${item.rect.height}${item.frame ? `, inside iframe (${item.frame})` : ''})`,
        '```html',
        item.html,
        '```',
        ...Object.entries(item.styles).map(([k, v]) => `- ${k}: ${v}`),
      ].join('\n'),
    );
    const more = found.total > found.items.length ? `\n\n(${found.total - found.items.length} more not shown)` : '';
    return textResult(`Elements matching "${selector}": ${found.total}\n\n${parts.join('\n\n')}${more}`);
  }

  // 許していない先のフレームの文は返さず、除いた数だけを伝える
  private consoleLogs(guest: Guest, level: string, clear: boolean): ToolResult {
    const levels = level === 'error' ? ['error'] : level === 'warning' ? ['error', 'warning'] : null;
    const picked = guest.logs.console.filter((l) => !levels || levels.includes(l.level));
    const logs = picked.filter((l) => this.visibleLog(guest, l));
    const hidden = picked.length - logs.length;
    if (clear) guest.logs.console.length = 0;
    const note = hidden > 0 ? `(${count(hidden, 'more message')} from pages or frames not allowed for Claude ${hidden === 1 ? 'is' : 'are'} not shown.)` : '';
    if (logs.length === 0) return textResult(note || 'No console messages.');
    return textResult([clip(logs.map((l) => `[${l.level}] ${l.text}`).join('\n'), MAX_TEXT), ...(note ? [note] : [])].join('\n'));
  }

  // Claude に返してよい記録（コンソールの文・失敗した通信）か。トップのフレームのものは、そのオリジンが許した先（許す先か、このタブで人が
  // 許したオリジン）のとき。iframe のものは、許す先のときか、今のトップと同じオリジンでトップが許した先のとき（別オリジンの iframe には、
  // タブの許可は効かない）。オリジンが分からないものは返さない
  private visibleLog(guest: Guest, entry: { origin: string | null; top: boolean }): boolean {
    if (!entry.origin) return false;
    if (entry.top) return this.allowedIn(guest, entry.origin);
    if (this.allowed(entry.origin)) return true;
    const topUrl = guest.contents.isDestroyed() ? '' : guest.contents.getURL();
    return webOrigin(topUrl) === entry.origin && this.allowedIn(guest, topUrl);
  }

  // 許していない先のページ・フレームの通信は返さず、除いた数だけを伝える（コンソールの記録と同じ）。clear は、除いたものも消す
  private failedRequests(guest: Guest, clear: boolean): ToolResult {
    const failed = guest.logs.failed.filter((r) => this.visibleLog(guest, r));
    const hidden = guest.logs.failed.length - failed.length;
    if (clear) guest.logs.failed.length = 0;
    const note = hidden > 0 ? `(${count(hidden, 'more failed request')} from pages or frames not allowed for Claude ${hidden === 1 ? 'is' : 'are'} not shown.)` : '';
    if (failed.length === 0) return textResult(note || 'No failed requests.');
    return textResult([clip(failed.map((r) => r.text).join('\n'), MAX_TEXT), ...(note ? [note] : [])].join('\n'));
  }

  // ---- 動かす ----

  // selector か、見えている範囲の x・y（スクリーンショットの位置）で押す
  private async click(sessionId: string, guest: Guest, args: Record<string, unknown>): Promise<ToolResult> {
    const selector = optionalString(args.selector);
    const double = args.double === true;
    const button = optionalString(args.button) ?? 'left';
    let target: Target;
    if (selector) target = await this.locate(guest, selector);
    else if (typeof args.x === 'number' && typeof args.y === 'number' && Number.isFinite(args.x) && Number.isFinite(args.y)) target = await this.pointAt(guest, args.x, args.y);
    else throw new ToolError('Provide selector, or x and y.');
    const before = guest.contents.getURL();
    await this.highlight(sessionId, target.rect);
    const { real, note } = await this.press(guest, target, { double, button: button === 'right' || button === 'middle' ? button : 'left', real: args.real === true });
    await settle(guest.contents);
    const lines = [`${double ? 'Double-clicked' : 'Clicked'}: ${target.description}${real ? ` (with a real mouse press, ${real})` : ''}`];
    if (target.covered) lines.push(`(another element, ${target.covered}, was covering the clicked position)`);
    if (note) lines.push(note);
    const after = guest.contents.getURL();
    // 移る前に止められなかった形（ページの「戻る」ボタンの history.back など）で許していない先へ移ったときは、オリジンだけを伝える
    if (after !== before) lines.push(`The page navigated to ${this.shownUrl(after, guest)}${this.allowedIn(guest, after) ? '' : ' (not allowed for Claude, so it can be neither read nor operated any further)'}`);
    return textResult(lines.join('\n'));
  }

  // 要素を押す。ふだんは、ページの中の JavaScript で押す（押す位置の要素に、本物の押下と同じ順のイベント（乗せる・押す・離す・click）を送り、
  // 押した要素にページの中でフォーカスを移す）。本物の押下（CDP の Input.dispatchMouseEvent）は、Chromium が押されたページを持つ webview に
  // フォーカスを移すので、人がチャットの入力欄などで打っていると、そのフォーカスを奪ってしまうため（ページが mousedown を止めても移る）。
  // JavaScript では効かないもの（PRESS_PARTS の __realReason）と、別オリジンの iframe の中・右や真ん中のボタン・Claude が real を指定したときは、
  // 本物の押下で押し、押したらすぐ人のフォーカスを元の場所へ戻す（keepHumanFocus）。
  // 返すもの: real は本物の押下で押した理由（ページの中で押したときは null）。note は、ページの中で押したときに、ページの処理がエラーを投げたこと
  private async press(
    guest: Guest,
    target: Target,
    options: { double: boolean; button: 'left' | 'right' | 'middle'; real: boolean },
  ): Promise<{ real: string | null; note: string | null }> {
    const point = center(target.rect);
    let reason: string | null = options.real ? 'as requested' : options.button !== 'left' ? `because it is the ${options.button} button` : null;
    if (target.cross) reason = 'because it is inside a cross-origin iframe';
    if (!reason) {
      // どう押すかを先に決める（人の操作の印は、ページの中で押すときだけ付ける）
      const decided = (await this.world(
        guest,
        `(() => {${FRAMES}${PRESS_PARTS}
          const hit = __deepHit(${point.x}, ${point.y});
          if (!hit.el) return { real: 'because there was no element to press with JavaScript' };
          if (hit.cross) return { real: 'because it is inside a cross-origin iframe' };
          return { real: __realReason(hit) };
        })()`,
      )) as { real: string | null };
      reason = decided.real;
    }
    if (!reason) {
      const result = (await this.world(
        guest,
        `(() => {${FRAMES}${PRESS_PARTS}
          const x = ${point.x}, y = ${point.y};
          const hit = __deepHit(x, y);
          if (!hit.el || hit.cross) return { real: 'because the element at the position changed' };
          const real = __realReason(hit);
          if (real) return { real };
          const el = hit.el;
          const doc = el.ownerDocument;
          const view = doc.defaultView;
          const o = __offset(doc);
          // 押す要素の文書の中の位置
          const lx = x - o.ox, ly = y - o.oy;
          const Pointer = view.PointerEvent || view.MouseEvent;
          const at = { bubbles: true, cancelable: true, composed: true, clientX: lx, clientY: ly, screenX: lx, screenY: ly, button: 0 };
          const pointer = { ...at, pointerId: 1, pointerType: 'mouse', isPrimary: true, width: 1, height: 1 };
          // ページの処理が投げたエラー（pointerdown の中の setPointerCapture など。本物の押下でないと効かないもの）
          const errors = [];
          const onError = (e) => errors.push(String((e.error && e.error.message) || e.message || e.error));
          view.addEventListener('error', onError);
          try {
            // 乗せる（hover で開く・選ぶメニューなど）
            el.dispatchEvent(new Pointer('pointerover', { ...pointer, buttons: 0 }));
            el.dispatchEvent(new Pointer('pointerenter', { ...pointer, bubbles: false, buttons: 0 }));
            el.dispatchEvent(new view.MouseEvent('mouseover', { ...at, buttons: 0 }));
            el.dispatchEvent(new view.MouseEvent('mouseenter', { ...at, bubbles: false, buttons: 0 }));
            el.dispatchEvent(new Pointer('pointermove', { ...pointer, buttons: 0 }));
            el.dispatchEvent(new view.MouseEvent('mousemove', { ...at, buttons: 0 }));
            for (let count = 1; count <= ${options.double ? 2 : 1}; count++) {
              const down = el.dispatchEvent(new Pointer('pointerdown', { ...pointer, buttons: 1, pressure: 0.5, detail: count }));
              // pointerdown を止められたら、マウスの互換のイベント（mousedown・mouseup）は送らない（ブラウザと同じ）
              const mouse = down && el.dispatchEvent(new view.MouseEvent('mousedown', { ...at, buttons: 1, detail: count }));
              if (mouse) __focusAt(el, lx, ly);
              el.dispatchEvent(new Pointer('pointerup', { ...pointer, buttons: 0, pressure: 0, detail: count }));
              if (down) el.dispatchEvent(new view.MouseEvent('mouseup', { ...at, buttons: 0, detail: count }));
              el.dispatchEvent(new view.MouseEvent('click', { ...at, buttons: 0, detail: count }));
            }
            if (${options.double}) el.dispatchEvent(new view.MouseEvent('dblclick', { ...at, buttons: 0, detail: 2 }));
          } finally {
            view.removeEventListener('error', onError);
          }
          return { real: null, errors: errors.slice(0, 3) };
        })()`,
        // 押したボタンの処理が、ポップアップを開く・全画面にするなど、人の操作が要るものも使えるように
        true,
      )) as { real: string | null; errors?: string[] };
      if (!result.real) {
        const errors = result.errors ?? [];
        const note = errors.length
          ? `The page threw an error while handling the JavaScript click (${clip(errors.join('; '), 300)}). If the click did not work, click again with real: true.`
          : null;
        return { real: null, note };
      }
      reason = result.real;
    }
    // 本物の押下。別プロセスの iframe の中は、その iframe のセッションに、iframe の中の位置で送る
    const { x, y } = target.child ?? point;
    const child = target.child?.session;
    await this.keepHumanFocus(guest, async () => {
      await this.cdp(guest, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, child);
      for (let count = 1; count <= (options.double ? 2 : 1); count++) {
        await this.cdp(guest, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: options.button, clickCount: count }, child);
        await this.cdp(guest, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: options.button, clickCount: count }, child);
      }
    });
    return { real: reason, note: null };
  }

  // 本物の入力（send。マウスの押下・タッチ）で、アプリの画面のフォーカスが、このタブの webview の要素へ移ったら、すぐ元の場所へ戻す。
  // - 人のフォーカスがこのタブのページ（webview の要素）にあれば、戻さない。ほかのタブ・ほかのセッションのページにあれば、そこへ戻す。
  //   どこにも無かった（body）なら、webview の要素から外す
  // - 移るのは、送り終えたときにはもう移っている（Electron 44 で実測。webview には focusin が届かず、外れた要素の focusout だけが届く）。
  //   まだなら、KEEP_FOCUS_WAIT_MS まで、少しずつ見る
  // - 見ている間に、人が押した・打った（アプリの画面か、このタブのページで）ら戻さない（人がページを押して移したフォーカスを、引き戻さない）
  private async keepHumanFocus(guest: Guest, send: () => Promise<void>): Promise<void> {
    const host = guest.contents.hostWebContents as WebContents | null;
    if (!host || host.isDestroyed()) {
      await send();
      return;
    }
    const id = JSON.stringify(randomUUID());
    const armed = await host
      .executeJavaScript(
        `(() => {
          const mine = [...document.querySelectorAll('webview')].find((w) => { try { return w.getWebContentsId() === ${guest.contents.id}; } catch (e) { return false; } });
          const el = document.activeElement;
          if (!mine || el === mine) return false;
          const k = { el, mine, human: false };
          k.onInput = () => { k.human = true; };
          for (const type of ['pointerdown', 'mousedown', 'keydown']) document.addEventListener(type, k.onInput, true);
          (window.__tanacodeKeepFocus ??= {})[${id}] = k;
          return true;
        })()`,
      )
      .catch(() => false);
    try {
      await send();
    } finally {
      if (armed === true) await this.restoreHumanFocus(guest, host, id);
    }
  }

  private async restoreHumanFocus(guest: Guest, host: WebContents, id: string): Promise<void> {
    // このタブのページで人が押した・打った
    let human = false;
    const onInput = (_event: unknown, input: { type?: string }) => {
      if (input.type && /^(mouseDown|keyDown|rawKeyDown|touchStart|gestureTapDown)$/.test(input.type)) human = true;
    };
    guest.contents.on('input-event', onInput);
    try {
      for (let waited = 0; ; waited += KEEP_FOCUS_POLL_MS) {
        const state = (await host
          .executeJavaScript(
            `(() => {
              const k = (window.__tanacodeKeepFocus || {})[${id}];
              if (!k) return 'gone';
              if (k.human) return 'human';
              return document.activeElement === k.mine ? 'moved' : 'not yet';
            })()`,
          )
          .catch(() => 'gone')) as string;
        if (human || state === 'human' || state === 'gone') return;
        if (state === 'moved') {
          await host
            .executeJavaScript(
              `(() => {
                const k = (window.__tanacodeKeepFocus || {})[${id}];
                if (!k || k.human || document.activeElement !== k.mine) return;
                if (k.el && k.el !== document.body && k.el.isConnected) k.el.focus({ preventScroll: true });
                else k.mine.blur();
              })()`,
            )
            .catch(() => undefined);
          return;
        }
        if (waited >= KEEP_FOCUS_WAIT_MS) return;
        await sleep(KEEP_FOCUS_POLL_MS);
      }
    } finally {
      guest.contents.off('input-event', onInput);
      if (!host.isDestroyed()) {
        await host
          .executeJavaScript(
            `(() => {
              const keep = window.__tanacodeKeepFocus || {};
              const k = keep[${id}];
              if (!k) return;
              for (const type of ['pointerdown', 'mousedown', 'keydown']) document.removeEventListener(type, k.onInput, true);
              delete keep[${id}];
            })()`,
          )
          .catch(() => undefined);
      }
    }
  }

  private async type(sessionId: string, guest: Guest, args: Record<string, unknown>): Promise<ToolResult> {
    const text = typeof args.text === 'string' ? args.text : '';
    const selector = optionalString(args.selector);
    let where = 'the focused element';
    if (selector) {
      // 欄を押してから打つ。押すのは click と同じ（ふだんはページの中の JavaScript で押し、人のフォーカスを奪わない）
      const target = await this.locate(guest, selector);
      await this.highlight(sessionId, target.rect);
      const { real, note } = await this.press(guest, target, { double: false, button: 'left', real: args.real === true });
      where = `${target.description}${real ? ` (pressed with a real mouse press, ${real})` : ''}${note ? ` (${note})` : ''}`;
    }
    // フォーカスが別プロセスの iframe の中なら、そのセッションに送る
    const child = await this.focusedChild(guest);
    if (args.clear === true && child) {
      await this.cdp(
        guest,
        'Runtime.evaluate',
        { expression: '(() => { const el = document.activeElement; if (el && typeof el.select === "function") el.select(); else if (el && el.isContentEditable) getSelection().selectAllChildren(el); })()' },
        child,
      );
      await this.key(guest, 'Backspace', [], child);
    } else if (args.clear === true) {
      // 欄の文字を全部選んでから消す（ページには、ふつうの削除として届く）
      await this.world(
        guest,
        `(() => {
          // フォーカスが同じオリジンの iframe の中にあれば、その中の欄
          let el = document.activeElement;
          while (el && /^(IFRAME|FRAME)$/.test(el.tagName)) {
            let d = null;
            try { d = el.contentDocument; } catch (e) {}
            if (!d) break;
            el = d.activeElement;
          }
          if (el && typeof el.select === 'function') el.select();
          else if (el && el.isContentEditable) el.ownerDocument.getSelection().selectAllChildren(el);
        })()`,
      );
      await this.key(guest, 'Backspace', []);
    }
    if (text) await this.insertText(guest, text, child);
    if (args.submit === true) await this.key(guest, 'Enter', [], child);
    await settle(guest.contents);
    return textResult(`Typed into ${where}${args.submit === true ? ' and pressed Enter' : ''}`);
  }

  private async pressKey(guest: Guest, key: string, modifiers: string[]): Promise<ToolResult> {
    await this.key(guest, key, modifiers, await this.focusedChild(guest));
    await settle(guest.contents);
    return textResult(`Pressed ${[...modifiers, key].join('+')}`);
  }

  // キーと文字は、ページ（webview の中身）そのものに届ける（webContents.sendInputEvent・insertText）。CDP の Input.dispatchKeyEvent・
  // Input.insertText は、ページのタブに送っても、アプリ全体でフォーカスのある所に届く。人がチャットの入力欄などへ戻っていると、
  // Claude がページで打つつもりのキーが、人の入力として入ってしまう（⌘Enter なら、人の発言として送られうる）。
  // sendInputEvent は、webview にフォーカスを渡さず、人のフォーカスも動かさない。
  // ただし、sendInputEvent はページのいちばん外のフレームにしか届かないので、フォーカスが別プロセスの iframe の中なら、その iframe の CDP の
  // セッション（child）に送る（その iframe そのものに届き、人のフォーカスがある所には入らないことを確かめた）
  private async key(guest: Guest, name: string, modifiers: string[], child?: string): Promise<void> {
    const spec = keySpec(name);
    if (!spec) throw new ToolError(`Unknown key: ${name}`);
    const held = modifiers.filter((m) => Object.hasOwn(MODIFIER_BITS, m));
    const bits = held.reduce((sum, m) => sum | MODIFIER_BITS[m], 0);
    // Ctrl・⌘ と一緒に押すときは、文字を入れない
    const text = bits & (MODIFIER_BITS.control | MODIFIER_BITS.meta) ? undefined : spec.text;
    if (child) {
      const base = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode, modifiers: bits };
      await this.cdp(guest, 'Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text, unmodifiedText: text } : {}) }, child);
      await this.cdp(guest, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base }, child);
      return;
    }
    const keyCode = electronKeyCode(spec);
    const mods = held as KeyboardInputEvent['modifiers'];
    // sendInputEvent は送りっぱなしなので、ページが離したキー（keyup）を受けるまで待つ（このあとの文字・キーと順番が入れ替わらないように）
    await this.afterPage(guest, 'keyup', () => {
      if (guest.contents.isDestroyed()) throw new ToolError('The tab was closed.');
      // Claude の送ったキーは、アプリのショートカットにしない（claude-input.ts）
      sendAsClaude(guest.contents, { type: 'keyDown', keyCode, modifiers: mods });
      // 文字を入れるキーは、続けて文字（char）を送る（Enter の char は、フォームを送るなどの既定の動きになる）
      if (text) sendAsClaude(guest.contents, { type: 'char', keyCode: text === '\r' ? 'Enter' : text, modifiers: mods });
      sendAsClaude(guest.contents, { type: 'keyUp', keyCode, modifiers: mods });
    });
  }

  // send でページに入力を送り、ページのフォーカスのある文書に event（keyup・input）が届くまで待つ（届かなければ INPUT_WAIT_MS で諦める）。
  // 待ち受けは、送る前に付けておく
  private async afterPage(guest: Guest, event: 'keyup' | 'input', send: () => void | Promise<void>): Promise<void> {
    const id = JSON.stringify(randomUUID());
    await this.world(
      guest,
      `(() => {
        let w = window;
        let el = document.activeElement;
        while (el && /^(IFRAME|FRAME)$/.test(el.tagName)) {
          let d = null;
          try { d = el.contentDocument; } catch (e) {}
          if (!d) break;
          w = d.defaultView;
          el = d.activeElement;
        }
        const waits = (window.__tanacodeInputWaits ??= {});
        waits[${id}] = new Promise((resolve) => {
          const done = () => { clearTimeout(timer); resolve(true); };
          const timer = setTimeout(() => { w.removeEventListener(${JSON.stringify(event)}, done, true); resolve(false); }, ${INPUT_WAIT_MS});
          w.addEventListener(${JSON.stringify(event)}, done, { once: true, capture: true });
        });
      })()`,
    );
    await send();
    await this.world(guest, `(async () => { const waits = window.__tanacodeInputWaits || {}; await waits[${id}]; delete waits[${id}]; })()`).catch(() => undefined);
  }

  // 文字を、ページのフォーカスのある欄に入れる（IME で確定したのと同じ。日本語・絵文字も 1 回で入る）。届け先は key と同じ
  private async insertText(guest: Guest, text: string, child?: string): Promise<void> {
    if (child) {
      await this.cdp(guest, 'Input.insertText', { text }, child);
      return;
    }
    // 入った（input が届いた）まで待つ（このあとの Enter などと順番が入れ替わらないように）
    await this.afterPage(guest, 'input', async () => {
      if (guest.contents.isDestroyed()) throw new ToolError('The tab was closed.');
      await guest.contents.insertText(text);
    });
  }

  private async scroll(guest: Guest, selector: string | undefined, deltaX: number, deltaY: number): Promise<ToolResult> {
    if (!selector && !deltaX && !deltaY) throw new ToolError('Provide selector, or deltaX or deltaY.');
    const position = (await this.world(
      guest,
      `(() => {${FRAMES}
        const target = ${selector ? `(__all(${JSON.stringify(selector)})[0] || {}).el` : 'null'};
        ${selector ? `if (!target) return null; target.scrollIntoView({ block: 'center', inline: 'nearest' });` : ''}
        const dx = ${deltaX}, dy = ${deltaY};
        let scroller = document.scrollingElement || document.documentElement;
        if (dx || dy) {
          // 真ん中（selector があればその要素）から上へたどって、動かせる入れ物を探す。iframe の中のページの上まで来たら、iframe の外へ
          const can = (e) => {
            const cs = __style(e);
            const root = e === e.ownerDocument.scrollingElement;
            return (dy && e.scrollHeight > e.clientHeight && (root || /(auto|scroll|overlay)/.test(cs.overflowY))) ||
              (dx && e.scrollWidth > e.clientWidth && (root || /(auto|scroll|overlay)/.test(cs.overflowX)));
          };
          const start = target || __hit(innerWidth / 2, innerHeight / 2).el;
          for (let e = start; e; ) {
            if (can(e)) { scroller = e; break; }
            e = e.parentElement || __view(e).frameElement;
          }
          scroller.scrollBy({ left: dx, top: dy, behavior: 'instant' });
        }
        const page = scroller === scroller.ownerDocument.scrollingElement;
        return { x: Math.round(scroller.scrollLeft), y: Math.round(scroller.scrollTop), where: page ? (scroller.ownerDocument === document ? 'page' : 'page inside the iframe') : 'inner scroll container' };
      })()`,
    )) as { x: number; y: number; where: string } | null;
    if (!position) throw new ToolError(`No element matches "${selector}".`);
    return textResult(`Scrolled (scroll position of the ${position.where}: x=${position.x} y=${position.y})`);
  }

  private async waitFor(guest: Guest, args: Record<string, unknown>): Promise<ToolResult> {
    const selector = optionalString(args.selector);
    const text = optionalString(args.text);
    if (!selector && !text) throw new ToolError('Provide selector or text.');
    const state = optionalString(args.state) ?? 'visible';
    const timeout = Math.min(Math.max(numberOr(args.timeoutMs, 10_000), 0), 30_000);
    const check = `(() => {${FRAMES}
      const state = ${JSON.stringify(state)};
      let el = null;
      ${selector ? `el = (__all(${JSON.stringify(selector)})[0] || {}).el || null;` : ''}
      ${
        text
          ? `if (!${selector ? 'el' : 'false'}) {
        const want = ${JSON.stringify(text)};
        for (const d of __docs()) {
          if (!d.doc.body) continue;
          const walker = d.doc.createTreeWalker(d.doc.body, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent.includes(want)) { el = n.parentElement; break; }
          if (el) break;
        }
      }`
          : ''
      }
      const visible = !!el && __shown(el);
      return state === 'attached' ? !!el : state === 'hidden' ? !visible : visible;
    })()`;
    const started = Date.now();
    while (true) {
      if (await this.world(guest, check).catch(() => false)) {
        return textResult(`"${selector ?? text}" ${state === 'hidden' ? 'disappeared' : 'appeared'} (${Date.now() - started} ms)`);
      }
      if (Date.now() - started > timeout) throw new ToolError(`"${selector ?? text}" did not ${state === 'hidden' ? 'disappear' : 'appear'} within ${timeout} ms.`);
      await sleep(150);
    }
  }

  // 画面の大きさを変える。full・mobile・tablet だけなら、前と同じく、画面（枠）の幅だけを変える（CDP では決めない）。
  // 機種の名前か数字なら、CDP の Emulation で、ページから見える大きさ・画素密度・タッチをそのとおりにし、画面の枠もその大きさにする。
  // セッションのどのタブにも当てる（あとで開いたタブにも。attach）
  private async setViewport(sessionId: string, guest: Guest, args: Record<string, unknown>): Promise<ToolResult> {
    const session = this.tabsOf(sessionId);
    const deviceName = optionalString(args.device);
    const device = deviceName ? BROWSER_DEVICES.find((d) => d.name.toLowerCase() === deviceName.trim().toLowerCase()) : undefined;
    if (deviceName && !device) {
      throw new ToolError(`Unknown device: ${deviceName}. Choose one of ${BROWSER_DEVICES.map((d) => d.name).join(', ')}, or pass width, height and deviceScaleFactor.`);
    }
    // in だと、Object の持ち物の名前（toString・constructor・__proto__）も通るので、自分の持つキーだけを受け付ける
    const named = typeof args.width === 'string' ? args.width : undefined;
    if ((named !== undefined && !Object.hasOwn(VIEWPORTS, named)) || (args.width !== undefined && named === undefined && typeof args.width !== 'number')) {
      throw new ToolError(`width must be full, mobile or tablet, or a number: ${String(args.width)}`);
    }
    if (args.mobile !== undefined && typeof args.mobile !== 'boolean') throw new ToolError(`mobile must be true or false: ${String(args.mobile)}`);
    // mobile: false だけ（数字なし）は、CDP で決めるものが何も無いので、幅だけの切り替えとして扱う
    const numbers = typeof args.width === 'number' || args.height !== undefined || args.deviceScaleFactor !== undefined || args.mobile === true;
    if (!device && !numbers) {
      if (named === undefined) throw new ToolError('Provide device or width.');
      // 前と同じ、画面の幅だけを変えるもの。CDP で決めたものはやめる
      session.viewport = null;
      this.deps.send(this.deps.channels.viewport, { sessionId, width: VIEWPORTS[named]! });
      await this.emulateAll(session, null);
      // 画面が webview の幅を変えて、ページが描き直すのを待つ
      await sleep(400);
      const viewport = await this.viewport(guest);
      return textResult(`Set the viewport to ${named} (page width ${viewport.width}px, height ${viewport.height}px)`);
    }
    const size = (value: unknown, name: string, fallback: number) => (value === undefined ? fallback : ranged(value, name, VIEWPORT_LIMITS.min, VIEWPORT_LIMITS.max));
    // 数字は機種のものより先に使う（機種を横向きにするなど）。full は枠の幅いっぱい（0）
    const width = named !== undefined ? VIEWPORTS[named]! : size(args.width, 'width', device?.width ?? 0);
    const height = size(args.height, 'height', device?.height ?? 0);
    const deviceScaleFactor =
      args.deviceScaleFactor === undefined
        ? (device?.deviceScaleFactor ?? 0)
        : ranged(args.deviceScaleFactor, 'deviceScaleFactor', VIEWPORT_LIMITS.minScale, VIEWPORT_LIMITS.maxScale);
    const mobile = typeof args.mobile === 'boolean' ? args.mobile : !!device;
    const dims = `${width || 'pane width'}×${height || 'pane height'}${deviceScaleFactor ? ` @${deviceScaleFactor}x` : ''}`;
    const label = device ? `${device.name} ${dims}` : dims;
    const emulation: Emulation = { label, width, height, deviceScaleFactor, mobile };
    session.viewport = emulation;
    this.deps.send(this.deps.channels.viewport, { sessionId, width, custom: { height, deviceScaleFactor, device: device?.name ?? null } });
    await this.emulateAll(session, emulation);
    // 画面が枠の大きさを変えて、ページが描き直すのを待つ。描き直すときに、ページの拡大率がまた決まり直すことがあるので、待ってからも 1 にする
    await sleep(400);
    for (const tab of session.tabs.values()) if (!tab.contents.isDestroyed() && tab.emulated) await this.cdp(tab, 'Emulation.setPageScaleFactor', ONE_PAGE_SCALE).catch(() => undefined);
    const viewport = await this.viewport(guest);
    return textResult(
      `Set the viewport to ${label}${mobile ? ' as a mobile device with touch support' : ''}. ` +
        `The page now sees innerWidth ${viewport.width}, innerHeight ${viewport.height} and devicePixelRatio ${viewport.dpr}. ` +
        'This applies to every tab of this session (also tabs opened later) and stays across reloads and navigations, until you call set_viewport with width full, mobile or tablet, or the user picks a width in the toolbar.',
    );
  }

  // セッションのどのタブにも、画面の大きさを当てる（emulation が null なら、やめる）。失敗したタブ（閉じかけている など）は、
  // 次にそのタブを操作するときに当て直す（dispatch）
  private async emulateAll(session: Tabs, emulation: Emulation | null): Promise<void> {
    for (const tab of session.tabs.values()) {
      if (!tab.contents.isDestroyed()) await this.emulate(tab, emulation).catch(() => undefined);
    }
  }

  // タブに、CDP で画面の大きさを当てる（null なら、やめる）。当たっているものと同じなら、何もしない
  // （決めていないタブに、やめる命令を送るために CDP をつなぐこともしない）
  private async emulate(guest: Guest, emulation: Emulation | null): Promise<void> {
    if (JSON.stringify(guest.emulated) === JSON.stringify(emulation)) return;
    if (emulation) {
      const { width, height, deviceScaleFactor, mobile } = emulation;
      await this.cdp(guest, 'Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile });
      await this.cdp(guest, 'Emulation.setTouchEmulationEnabled', mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
      await this.cdp(guest, 'Emulation.setPageScaleFactor', ONE_PAGE_SCALE);
    } else {
      await this.cdp(guest, 'Emulation.clearDeviceMetricsOverride');
      await this.cdp(guest, 'Emulation.setTouchEmulationEnabled', { enabled: false });
    }
    guest.emulated = emulation;
  }

  // 指でさわる（CDP の Input.dispatchTouchEvent。ページには本物のタッチ・pointerType が touch のポインターのイベントとして届く）。
  // 指の位置は、ブラウザを見ている人に丸で見せる（動かすあいだも）
  private async touch(sessionId: string, guest: Guest, args: Record<string, unknown>): Promise<ToolResult> {
    const action = requiredString(args.action, 'action');
    if (!['tap', 'long_press', 'swipe', 'pinch'].includes(action)) throw new ToolError(`action must be tap, long_press, swipe or pinch: ${action}`);
    if (args.fingers !== undefined && args.fingers !== 1 && args.fingers !== 2) throw new ToolError(`fingers must be 1 or 2: ${String(args.fingers)}`);
    const fingers = args.fingers === 2 ? 2 : 1;
    if (fingers === 2 && (action === 'long_press' || action === 'pinch')) {
      throw new ToolError(`fingers 2 is only for tap and swipe${action === 'pinch' ? ' (pinch always uses two fingers)' : ''}.`);
    }
    const duration =
      args.durationMs === undefined ? (action === 'long_press' ? LONG_PRESS_MS : SWIPE_MS) : ranged(args.durationMs, 'durationMs', 0, TOUCH_LIMITS.maxDurationMs);
    const selector = optionalString(args.selector);
    let target: { rect: BrowserRect; description: string; child?: { session: string; x: number; y: number } };
    if (selector) target = await this.locate(guest, selector);
    else if (typeof args.x === 'number' && typeof args.y === 'number' && Number.isFinite(args.x) && Number.isFinite(args.y)) target = await this.pointAt(guest, args.x, args.y);
    else throw new ToolError('Provide selector, or x and y.');
    const start = selector ? center(target.rect) : { x: args.x as number, y: args.y as number };
    // 指の位置（いちばん外の見えている範囲から）。動かす前と、動かしたあと
    let from: BrowserPoint[];
    let to: BrowserPoint[];
    let done: string;
    if (action === 'swipe') {
      const toX = optionalNumber(args.toX, 'toX') ?? (args.deltaX === undefined ? undefined : start.x + optionalNumber(args.deltaX, 'deltaX')!);
      const toY = optionalNumber(args.toY, 'toY') ?? (args.deltaY === undefined ? undefined : start.y + optionalNumber(args.deltaY, 'deltaY')!);
      if (toX === undefined && toY === undefined) throw new ToolError('swipe needs toX and toY, or deltaX or deltaY.');
      const end = { x: toX ?? start.x, y: toY ?? start.y };
      from = fingersAt(start, fingers);
      to = fingersAt(end, fingers);
      done = `Swiped${fingers === 2 ? ' with two fingers' : ''} from x=${round(start.x)} y=${round(start.y)} to x=${round(end.x)} y=${round(end.y)} in ${duration} ms`;
    } else if (action === 'pinch') {
      if (args.scale === undefined) throw new ToolError('pinch needs scale (above 1 moves the fingers apart, below 1 moves them together).');
      const scale = ranged(args.scale, 'scale', TOUCH_LIMITS.minScale, TOUCH_LIMITS.maxScale);
      // 寄せるときは広げて置いてから、広げるときは寄せて置いてから
      const apart = scale < 1 ? 200 : 100;
      from = [
        { x: start.x - apart / 2, y: start.y },
        { x: start.x + apart / 2, y: start.y },
      ];
      to = [
        { x: start.x - (apart * scale) / 2, y: start.y },
        { x: start.x + (apart * scale) / 2, y: start.y },
      ];
      done = `Pinched (scale ${scale}: the fingers moved from ${apart}px to ${round(apart * scale)}px apart in ${duration} ms)`;
    } else {
      from = to = fingersAt(start, fingers);
      done = action === 'tap' ? (fingers === 2 ? 'Tapped with two fingers' : 'Tapped') : `Long-pressed for ${duration} ms`;
    }
    const before = guest.contents.getURL();
    // Input.dispatchTouchEvent の位置は、タブの中ではなく、アプリのウインドウの中の位置として読まれる（Electron 44.7 の webview で確かめた。
    // タブの中の位置のまま送ると、webview の左上の分だけずれて届く。マウスの Input.dispatchMouseEvent は、タブの中の位置のまま届く）。
    // それで、アプリの画面の中の webview の左上を足す（hostOffset）。別プロセスの iframe の中も、その iframe のセッションに、同じ位置で送る（実機では確かめていない）
    const child = target.child?.session;
    let at: HostOffset;
    const send = (type: string, points: BrowserPoint[]) =>
      this.cdp(
        guest,
        'Input.dispatchTouchEvent',
        { type, touchPoints: points.map((p, id) => ({ x: round(at.x + p.x * at.scale), y: round(at.y + p.y * at.scale), id })) },
        child,
      );
    const show = (points: BrowserPoint[]) => this.emit({ sessionId, active: true, label: null, box: null, touches: points.map((p) => ({ x: round(p.x), y: round(p.y) })) });
    // さわる前に、指を置く場所を見せる
    show(from);
    await sleep(HIGHLIGHT_MS);
    // webview の位置は、見せたあとに読む。Claude の操作が始まると、ツールバーの下に「Claude が操作中」の帯が出て webview が下へ動くので、
    // それより前に読むと、帯の高さの分だけずれて届く（CI の E2E で、前の操作から帯が消えていたときに y だけずれた）
    at = await this.hostOffset(guest);
    // 指の位置が、アプリの画面に出ていなければ断る。出ていない所（枠のスクロールの外・ウインドウの外）へのタッチは、ページに届かずに捨てられる
    // （CI の小さなウインドウで、機種の大きさの枠からはみ出た所をタップすると、エラーにならずに届かなかった）。動かす道すじは直線なので、両端を見る
    const hidden = [...from, ...to].find((p) => !shownAt(at, p));
    if (hidden) {
      const v = at.visible;
      const shown = (from: number, to: number, origin: number) => `${Math.ceil((from - origin) / at.scale)}–${Math.floor((to - origin) / at.scale)}`;
      throw new ToolError(
        `x=${round(hidden.x)} y=${round(hidden.y)} is not shown in the tanacode window, so a touch there would not reach the page. ` +
          (v.right > v.left && v.bottom > v.top
            ? `The browser pane shows only x ${shown(v.left, v.right, at.x)} and y ${shown(v.top, v.bottom, at.y)} of the visible area of the page (the pane is smaller than the viewport). `
            : 'The browser pane shows no part of the page. ') +
          'Touch inside that part (scroll the page to bring the spot into it), or set a smaller viewport with set_viewport.',
      );
    }
    // 指を置く・離すと、マウスの押下と同じく、Chromium が webview にフォーカスを移すので、すぐ人のフォーカスを元の場所へ戻す（E2E で確かめた。
    // タップは、離したとき（click になるとき）に移った）。置いたときと離したときに、それぞれ戻す（長押し・なぞる間、webview に置いたままにしない）
    await this.keepHumanFocus(guest, async () => {
      await send('touchStart', from);
    });
    if (action === 'swipe' || action === 'pinch') {
      // 16 ミリ秒ごと（画面の 1 コマ）に動かす。5 回から 60 回まで
      const steps = Math.min(60, Math.max(5, Math.round(duration / 16)));
      for (let step = 1; step <= steps; step++) {
        await sleep(duration / steps);
        const now = from.map((p, i) => ({ x: p.x + (to[i]!.x - p.x) * (step / steps), y: p.y + (to[i]!.y - p.y) * (step / steps) }));
        await send('touchMove', now);
        show(now);
      }
    } else {
      await sleep(action === 'tap' ? TAP_MS : duration);
    }
    await this.keepHumanFocus(guest, async () => {
      await send('touchEnd', []);
    });
    await settle(guest.contents);
    const lines = [`${done}: ${target.description}`];
    const after = guest.contents.getURL();
    if (after !== before) lines.push(`The page navigated to ${this.shownUrl(after, guest)}${this.allowedIn(guest, after) ? '' : ' (not allowed for Claude, so it can be neither read nor operated any further)'}`);
    return textResult(lines.join('\n'));
  }

  // タッチを送る位置の決め方。送る位置 = 左上 + タブの中の位置 × scale。画面がタブの webview に付けた data-tab-id で探す。
  // アプリの画面を拡大（表示のメニュー）しているときの決まりは、Electron 44.7 の webview で、1.1 倍にして測って決めた（2 点ずつ、ずれは 1px 以内）:
  // - 左上は、アプリの画面の CSS の px のまま（拡大の倍率を掛けない）
  // - タブの中の位置は、CDP で大きさを決めていないタブではそのまま、決めたタブ（set_viewport の機種・数字）では倍率で割る
  // visible: webview のうち、アプリの画面に出ている所（アプリの画面の CSS の px。枠のスクロールなど、はみ出たものを切る入れ物と、ウインドウの端で切る）
  private async hostOffset(guest: Guest): Promise<HostOffset> {
    const host = this.deps.host();
    const found = host && !host.isDestroyed() ? ((await host.executeJavaScript(webviewPlace(guest.tabId)).catch(() => null)) as Omit<HostOffset, 'scale'> | null) : null;
    if (!found) throw new ToolError('Could not find this tab in the tanacode window, so the touch was not sent.');
    return { ...found, scale: guest.emulated ? 1 / host!.getZoomFactor() : 1 };
  }

  // 今のタブの CPU・通信を遅くする（やめる）。指定しなかったほうは、今のまま
  private async throttle(sessionId: string, guest: Guest, args: Record<string, unknown>): Promise<ToolResult> {
    if (args.cpu === undefined && args.network === undefined) throw new ToolError('Provide cpu or network.');
    const cpu = args.cpu === undefined ? guest.throttle.cpu : ranged(args.cpu, 'cpu', 1, THROTTLE_LIMITS.maxCpu);
    let network = guest.throttle.network;
    if (args.network !== undefined) {
      const name = String(args.network);
      if (name === 'off') network = null;
      else if (Object.hasOwn(NETWORK_PRESETS, name)) network = name as NetworkPresetName;
      else throw new ToolError(`network must be off, ${Object.keys(NETWORK_PRESETS).join(', ')}: ${name}`);
    }
    await this.applyThrottle(sessionId, guest, { cpu, network });
    const state = `CPU ${cpu === 1 ? 'not slowed down' : `${cpu}× slower`}, network ${network ? networkShown(network) : 'not slowed down'}`;
    if (cpu === 1 && !network) return textResult(`The current tab is no longer slowed down (${state}).`);
    return textResult(
      `Slowed down the current tab: ${state}. It stays across reloads and navigations in this tab (reload with navigate action "reload" to measure the start of the page), ` +
        'until you turn it off with throttle (cpu 1, network off), the user turns it off in the toolbar, or the tab is closed. Turn it off when you are done.',
    );
  }

  // タブを遅くする設定を、CDP で当てて、画面に知らせる。変わったものだけを送る
  private async applyThrottle(sessionId: string, guest: Guest, next: Guest['throttle']): Promise<void> {
    if (next.cpu !== guest.throttle.cpu) {
      await this.cdp(guest, 'Emulation.setCPUThrottlingRate', { rate: next.cpu });
      guest.throttle = { ...guest.throttle, cpu: next.cpu };
    }
    if (next.network !== guest.throttle.network) {
      const preset = next.network ? NETWORK_PRESETS[next.network] : null;
      await this.cdp(
        guest,
        'Network.emulateNetworkConditions',
        preset
          ? { offline: preset.offline, latency: preset.latency, downloadThroughput: preset.download, uploadThroughput: preset.upload }
          : { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
      );
      guest.throttle = { ...guest.throttle, network: next.network };
    }
    this.sendThrottle(sessionId, guest);
  }

  private sendThrottle(sessionId: string, guest: Guest): void {
    this.deps.send(this.deps.channels.throttle, { sessionId, tabId: guest.tabId, ...guest.throttle } satisfies BrowserThrottleChange);
  }

  // ページの世界で動かす。evaluate の始めに読み直した今のページ（許した先）から、動くまでの間に別のオリジンへの移動が確定していたら、
  // 動かさない（確かめたあとに、前から読み込み中だった移動が確定することがある）。同じスクリプトの先頭で、今のページのオリジンを比べる（guardedScript）
  private async evaluate(sessionId: string, guest: Guest, expression: string, toolUseId?: string): Promise<ToolResult> {
    const url = guest.contents.getURL();
    const origin = webOrigin(url);
    if (!origin || !this.allowedIn(guest, url)) throw new ToolError(`The current page (${originShown(url)}) is not allowed for Claude, so the script was not run.`);
    // 確認のフックが、この呼び出しのために見たページ（確認を省いた localhost のページ・人に確認したページ）から、別のオリジンへ移っていたら動かさない。
    // 控えが無い・フックのときにページが無かったときも、動かさない（確かめたページが分からない）
    const checked = this.takeEvaluateMark(sessionId, expression, toolUseId);
    // 控えが無い。原因は決めつけない（フックが動かなかった・アプリに聞けなかった・オフの間に聞いた・押し出された・フックが切られている など）
    if (!checked) {
      throw new ToolError(
        'tanacode has no record of checking this call, so the script was not run. Call evaluate again. ' +
          '(tanacode checks each evaluate call in its permission hook. The record can be missing for several reasons: hooks are disabled, the hook could not reach tanacode, ' +
          'browser control was turned off at that time, or the record was pushed out by many other checks.) ' +
          'If this keeps happening, tell the user that tanacode cannot check evaluate calls in this session.',
      );
    }
    // フックは ID 付きで控えたのに、呼び出しに ID が無い。アプリを更新する前から動いている Claude Code の中継（ID を渡さない古いもの）。
    // フックは呼ばれるたびに今のアプリから動くので、中継だけが古い。Claude Code を起動し直せば直る
    if (checked === 'no-id') {
      throw new ToolError(
        'tanacode checked this call, but the call reached tanacode without its ID, so the script was not run. ' +
          'The tanacode tools in this session seem to be older than tanacode itself (for example, tanacode was updated after Claude Code started). ' +
          'Ask the user to restart Claude Code in this session (the restart button in the chat header), then call evaluate again.',
      );
    }
    // 同じ呼び出しの控えはあるが、式が違う（ほかのフックが入力を書き換えた など）
    if (checked === 'changed') {
      throw new ToolError(
        'The expression of this call differs from the one tanacode checked for it (another hook may have changed the input), so the script was not run. Call evaluate again. ' +
          'If this keeps happening, tell the user that another hook seems to change the input of evaluate.',
      );
    }
    if (checked.origin === null) {
      throw new ToolError('No page was open in the current tab when tanacode checked this call, so the script was not run. Call evaluate again to run it on the current page.');
    }
    if (checked.origin !== origin) {
      throw new ToolError(
        `The page changed after tanacode checked it for this call (from ${checked.origin} to ${originShown(url)}), so the script was not run. Call evaluate again to run it on the current page.`,
      );
    }
    // 目印は呼び出しごとに変える（ページが同じ文をコンソールに出して、止めたことにさせないように）
    const mark = `${PAGE_CHANGED} ${randomUUID()}`;
    let value: unknown;
    const since = guest.logs.seq;
    try {
      value = await guest.contents.executeJavaScript(guardedScript(origin, mark, expression));
    } catch (error) {
      // 投げられたエラーの中身は、例外には入らずコンソールに出る（届くのを少し待つ）
      await sleep(100);
      throw this.evaluateFailed(guest, origin, mark, since, error);
    }
    let text: string;
    try {
      text = value === undefined ? 'undefined' : (JSON.stringify(value, null, 2) ?? String(value));
    } catch {
      text = String(value);
    }
    return textResult(clip(text, MAX_TEXT));
  }

  // この呼び出しの控えを取り出す（1 回で使い切る）。呼び出しの ID があれば、同じ ID の控え（式も同じものだけ）。
  // 同じ ID の控えが無ければ、ID の無い控え（ID を渡さないフック）のうち、同じ式のいちばん新しいもの。
  // 呼び出しに ID が無い（ID を渡さない中継）ときも、ID の無い控えだけから引く（ID のある控えは、同じ式の別の呼び出しのものや、前に断られて
  // 残ったものかもしれない）。フックと中継は同じ Claude Code から呼ばれるので、ふつうは両方に ID があるか、両方に無い。フックにだけ ID があるときは、断る側に倒れる。
  // 同じ式を並べて呼んでも（本体とサブエージェントなど）、ID があれば取り違えない
  // 同じ ID の控えの式が違えば、その控えは捨てて 'changed' を返す。ID の無い呼び出しに、同じ式の ID のある控えしか無ければ 'no-id'
  // （古い中継）。どちらも、控えが無いときと分けて伝える
  private takeEvaluateMark(sessionId: string, expression: string, toolUseId?: string): EvaluateMark | 'changed' | 'no-id' | null {
    const marks = this.evaluateMarks.get(sessionId) ?? [];
    const take = (index: number) => (index === -1 ? null : marks.splice(index, 1)[0]!);
    let found: EvaluateMark | 'changed' | 'no-id' | null;
    const byId = toolUseId === undefined ? -1 : marks.findIndex((m) => m.toolUseId === toolUseId);
    if (byId !== -1) {
      const mark = take(byId)!;
      found = mark.expression === expression ? mark : 'changed';
    } else {
      // ID で引けない。ID の無い控え（ID を渡さないフック）のうち、同じ式のいちばん新しいもの
      let index = marks.length - 1;
      while (index >= 0 && !(marks[index]!.expression === expression && marks[index]!.toolUseId === undefined)) index--;
      found = take(index);
      if (!found && toolUseId === undefined && marks.some((m) => m.expression === expression)) found = 'no-id';
    }
    if (marks.length > 0) this.evaluateMarks.set(sessionId, marks);
    else this.evaluateMarks.delete(sessionId);
    return found;
  }

  // evaluate が失敗したときに Claude に返すもの。origin: 動かす前に確かめたオリジン / mark: 先頭で比べる文が投げる目印 / since: 動かす前の記録の通し番号。
  // 今のページが許していない先なら、ページのコンソールの文は返さない（オリジンだけ。ページが書いた文や、URL に入った値を渡さない）
  private evaluateFailed(guest: Guest, origin: string, mark: string, since: number, error: unknown): ToolError {
    // 記録は、タブが閉じられても残っている。目印を先に見る（出ていれば、動いていない。目印は文を返さないので、どのフレームの記録でも見る）
    const errors = guest.logs.console.filter((l) => l.seq >= since && l.level === 'error');
    const marked = errors.some((l) => l.text.includes(mark));
    if (guest.contents.isDestroyed()) {
      return new ToolError(
        marked
          ? 'The page moved to another origin and the tab was closed before the script ran, so the script was not run.'
          : 'The tab was closed while the script was running, so it is not known whether the script ran.',
      );
    }
    const now = guest.contents.getURL();
    const nowOrigin = webOrigin(now);
    // 書くのはオリジンだけ。オリジンの無いページ（空のページ）は、about:blank と書く
    const shown = nowOrigin ?? (isBlank(now) ? 'about:blank' : originShown(now));
    if (marked) {
      // タブの URL は確かめたオリジンのままなのに、ページの中が違った（読み込みに失敗したときのエラーのページ chrome-error・移って戻った など）
      if (nowOrigin === origin) {
        return new ToolError(
          `The page in the current tab changed before the script ran (for example, it shows an error page because ${origin} could not be loaded, or it moved to another origin and back), so the script was not run. Reload it or open the page again with navigate if needed.`,
        );
      }
      return new ToolError(`The page moved to another origin (${shown}) before the script ran, so the script was not run.`);
    }
    // 目印が無い（ページが window.onerror で隠した・動いてから移った など）。動いたかどうかは分からない
    if (!this.allowedIn(guest, now)) {
      return new ToolError(
        `The page moved to a page not allowed for Claude (${shown}) while the script was running or just before it, so it is not known whether the script ran. Check the page (for example, with list_tabs) before running it again.`,
      );
    }
    // 返すのは、許した先のフレームの文だけ
    const thrown = errors.filter((l) => this.visibleLog(guest, l)).map((l) => l.text);
    const failed = `Execution failed: ${thrown.length > 0 ? thrown.join('\n') : error instanceof Error ? error.message : String(error)}`;
    return new ToolError(nowOrigin === origin ? failed : `${failed}\n(The page moved to ${shown} while the script was running or just before it.)`);
  }

  // ---- 部品 ----

  // 今のタブのページ。開いていない・許していない先なら、理由を添えて断る
  private async current(sessionId: string): Promise<Guest> {
    const guest = await this.activeGuest(sessionId);
    const url = guest.contents.getURL();
    if (isBlank(url)) throw new ToolError('The current tab is empty. Open a page with navigate.');
    if (!this.allowedIn(guest, url)) {
      throw new ToolError(
        `The current page (${originShown(url)}) is not allowed for Claude: it is outside the hosts the user allowed for Claude (localhost, 127.0.0.1, *.local and the hosts added under "${t('mcpSettings.hostsTitle')}" in tanacode > ${t('main.menu.mcpSettings')}), ` +
          'and the user has not permitted it in this tab. To use it, open it with navigate (tanacode asks the user for permission).',
      );
    }
    return guest;
  }

  // 今のタブ（待たない。無い・壊れていれば undefined）
  private activeNow(sessionId: string): Guest | undefined {
    const session = this.sessions.get(sessionId);
    const guest = session?.active ? session.tabs.get(session.active) : undefined;
    return guest && !guest.contents.isDestroyed() ? guest : undefined;
  }

  // 今のタブ。作った直後で、まだ画面から知らせが来ていなければ少し待つ
  private async activeGuest(sessionId: string): Promise<Guest> {
    const started = Date.now();
    while (true) {
      const session = this.sessions.get(sessionId);
      const guest = session?.active ? session.tabs.get(session.active) : undefined;
      if (guest && !guest.contents.isDestroyed()) return guest;
      if (!session?.active || Date.now() - started > ACTIVE_WAIT_MS) {
        throw new ToolError('No page has been opened in the in-app browser for this session yet. Open one with navigate.');
      }
      await sleep(50);
    }
  }

  private tabsOf(sessionId: string): Tabs {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { tabs: new Map(), active: null, blocked: null, opened: [], popups: [], popupBlocked: null, handoff: [], viewport: null };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private find(contents: WebContents): { sessionId: string; session: Tabs; guest: Guest } | null {
    for (const [sessionId, session] of this.sessions) {
      for (const guest of session.tabs.values()) if (guest.contents === contents) return { sessionId, session, guest };
    }
    return null;
  }

  // ユーザーに操作を頼んでいる間は、並べて呼ばれた読むツールが動いていても、Claude の操作として扱わない（ユーザーがログインで外へ移れるように）
  private operating(sessionId: string): boolean {
    if (this.asks.has(sessionId)) return false;
    return (this.running.get(sessionId) ?? 0) > 0 || Date.now() - (this.endedAt.get(sessionId) ?? 0) < OPERATING_GRACE_MS;
  }

  // 許す先（既定と、ユーザーが足した先）のページか
  private allowed(url: string): boolean {
    return isClaudeAllowedUrl(url, this.deps.extraHosts());
  }

  // そのタブで、Claude が読んで・操作してよいページか。許す先か、人がそのタブで開くことを許したオリジン（別オリジンの iframe には使わない）
  private allowedIn(guest: Guest | undefined, url: string): boolean {
    if (this.allowed(url)) return true;
    const origin = webOrigin(url);
    return !!guest && origin !== null && guest.granted.has(origin);
  }

  // Claude に見せる URL。許していない先は、オリジンだけ（ログインで外の認証のページへ移ったとき、URL に認証の途中の値が入っていることがある）
  private shownUrl(url: string, guest?: Guest): string {
    return this.allowedIn(guest, url) ? url : originShown(url);
  }

  private waitAttach(sessionId: string): Promise<Guest> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new ToolError('Could not open the in-app browser (the tanacode window did not respond).')), ATTACH_TIMEOUT_MS);
      const list = this.waiters.get(sessionId) ?? [];
      list.push((guest) => {
        clearTimeout(timer);
        resolve(guest);
      });
      this.waiters.set(sessionId, list);
    });
  }

  // userGesture: 人の操作として動かす（押したボタンの処理が、ポップアップを開くなど、人の操作が要るものを使えるように）
  private world(guest: Guest, code: string, userGesture = false): Promise<unknown> {
    return userGesture ? guest.contents.executeJavaScriptInIsolatedWorld(WORLD, [{ code }], true) : guest.contents.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]);
  }

  // CDP の命令を送る。child: 別プロセスの iframe のセッション（無ければページ）
  private async cdp(guest: Guest, method: string, params?: Record<string, unknown>, child?: string): Promise<unknown> {
    const dbg = guest.contents.debugger;
    if (!guest.cdp || !dbg.isAttached()) {
      try {
        dbg.attach('1.3');
      } catch (error) {
        if (!dbg.isAttached()) throw new ToolError(`Could not get ready to control the page (${error instanceof Error ? error.message : String(error)}).`);
      }
      guest.cdp = true;
      // 別プロセスの iframe にもつなぐ（つながると Target.attachedToTarget が届く）
      await dbg.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => undefined);
      await sleep(150);
    }
    return dbg.sendCommand(method, params, child);
  }

  // 別プロセスの iframe と、その今の URL
  private async childFrames(guest: Guest): Promise<{ child: string; url: string }[]> {
    await this.cdp(guest, 'Target.getTargets').catch(() => undefined);
    const frames: { child: string; url: string }[] = [];
    for (const child of guest.children.keys()) {
      const result = (await this.cdp(guest, 'Runtime.evaluate', { expression: 'location.href', returnByValue: true }, child).catch(() => null)) as { result?: { value?: unknown } } | null;
      if (typeof result?.result?.value === 'string') frames.push({ child, url: result.result.value });
    }
    return frames;
  }

  // src の iframe が別プロセスで動いていれば、そのセッション（オリジンで見つける）
  private async childFor(guest: Guest, src: string): Promise<{ child: string; url: string } | null> {
    const origin = originOf(src);
    if (!origin) return null;
    return (await this.childFrames(guest)).find((f) => originOf(f.url) === origin) ?? null;
  }

  // 今キーボードのフォーカスがある、別プロセスの iframe のセッション（ページの中なら undefined）。許していない先なら断る。
  // フォーカスが別オリジンの iframe の中なら、その iframe の要素から、CDP でフレームを確かめる（src のオリジンでは決めない。iframe は
  // 転送などで src と別のオリジンへ移り、src が無いまま・about:blank からスクリプトで移ることもある）。
  // 別プロセスなら、その iframe のセッション。同じプロセスなら、ページに送ったキーが届くので undefined。
  // どちらとも分からなければ、送ったキーが黙って失われるので、断る
  private async focusedChild(guest: Guest): Promise<string | undefined> {
    const mark = `tc-${randomUUID()}`;
    const found = (await this.world(
      guest,
      `(() => {
        let el = document.activeElement;
        while (el && /^(IFRAME|FRAME)$/.test(el.tagName)) {
          let d = null;
          try { d = el.contentDocument; } catch (e) {}
          if (!d) { el.setAttribute('data-tanacode-focus', ${JSON.stringify(mark)}); return { src: el.src || '' }; }
          el = d.activeElement;
        }
        return null;
      })()`,
    )) as { src: string } | null;
    if (!found) return undefined;
    const frameId = await this.markedFrame(guest, mark);
    const unknown = () =>
      new ToolError('Cannot type because the focus is inside an iframe that could not be identified. Click the field with the x and y of click, then type again.');
    if (!frameId) throw unknown();
    const child = [...guest.children].find(([, targetId]) => targetId === frameId)?.[0];
    let url: string | null = null;
    if (child) {
      const result = (await this.cdp(guest, 'Runtime.evaluate', { expression: 'location.href', returnByValue: true }, child).catch(() => null)) as { result?: { value?: unknown } } | null;
      if (typeof result?.result?.value === 'string') url = result.result.value;
    } else {
      url = await this.frameUrl(guest, frameId);
    }
    if (url === null) throw unknown();
    if (!this.allowed(url)) throw new ToolError(`Cannot type because the focus is inside an iframe not allowed for Claude (${frameShown(url)}).`);
    return child;
  }

  // 目印（data-tanacode-focus）を付けた iframe の要素の中のフレームの ID。目印は外す。見つからなければ null
  private async markedFrame(guest: Guest, mark: string): Promise<string | null> {
    const selector = JSON.stringify(`[data-tanacode-focus="${mark}"]`);
    try {
      const found = (await this.cdp(guest, 'Runtime.evaluate', {
        expression: `(() => {
          const find = (doc) => {
            const el = doc.querySelector(${selector});
            if (el) return el;
            for (const frame of doc.querySelectorAll('iframe, frame')) {
              let d = null;
              try { d = frame.contentDocument; } catch (e) {}
              const inner = d && find(d);
              if (inner) return inner;
            }
            return null;
          };
          return find(document);
        })()`,
      }).catch(() => null)) as { result?: { objectId?: string } } | null;
      const objectId = found?.result?.objectId;
      if (!objectId) return null;
      const described = (await this.cdp(guest, 'DOM.describeNode', { objectId }).catch(() => null)) as { node?: { frameId?: string } } | null;
      await this.cdp(guest, 'Runtime.releaseObject', { objectId }).catch(() => undefined);
      return described?.node?.frameId ?? null;
    } finally {
      await this.world(
        guest,
        `(() => { const strip = (doc) => { for (const el of doc.querySelectorAll(${selector})) el.removeAttribute('data-tanacode-focus');
          for (const frame of doc.querySelectorAll('iframe, frame')) { let d = null; try { d = frame.contentDocument; } catch (e) {} if (d) strip(d); } }; strip(document); })()`,
      ).catch(() => undefined);
    }
  }

  // ページと同じプロセスで動くフレームの今の URL（Page.getFrameTree。別プロセスのフレームは入らない）。無ければ null
  private async frameUrl(guest: Guest, frameId: string): Promise<string | null> {
    type Node = { frame?: { id?: string; url?: string; urlFragment?: string }; childFrames?: Node[] };
    const tree = (await this.cdp(guest, 'Page.getFrameTree').catch(() => null)) as { frameTree?: Node } | null;
    const find = (node: Node | undefined): string | null => {
      if (!node) return null;
      if (node.frame?.id === frameId) return (node.frame.url ?? '') + (node.frame.urlFragment ?? '');
      for (const child of node.childFrames ?? []) {
        const url = find(child);
        if (url !== null) return url;
      }
      return null;
    };
    return find(tree?.frameTree);
  }

  private async viewport(guest: Guest): Promise<{ width: number; height: number; dpr: number }> {
    return (await this.world(guest, '({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })')) as { width: number; height: number; dpr: number };
  }

  // セレクタに当たる要素（同じオリジンの iframe の中も）のうち、見えている最初のものを、見える位置まで動かして、その位置を返す
  private async locate(guest: Guest, selector: string): Promise<{ rect: BrowserRect; viewport: { width: number; height: number }; description: string; covered: string | null }> {
    await this.laidOut(guest);
    const found = (await this.world(
      guest,
      `(() => {${FRAMES}
        let all;
        try { all = __all(${JSON.stringify(selector)}); } catch (e) { return { error: 'Invalid selector: ' + e.message }; }
        if (all.length === 0) return { error: 'none' };
        const hit = all.find((h) => __shown(h.el));
        if (!hit) return { error: 'hidden', count: all.length };
        const el = hit.el;
        // iframe の中の要素は、外のページも合わせて動かす
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        const r = __rect(el);
        const top = __hit(r.x + r.width / 2, r.y + r.height / 2).el;
        return {
          rect: r,
          viewport: { width: innerWidth, height: innerHeight },
          description: __label(el),
          covered: top && top !== el && !el.contains(top) && !top.contains(el) ? __name(top) : null,
        };
      })()`,
    )) as { error?: string; count?: number; rect: BrowserRect; viewport: { width: number; height: number }; description: string; covered: string | null };
    if (found.error === 'none') throw new ToolError(`No element matches "${selector}".`);
    if (found.error === 'hidden') {
      throw new ToolError(found.count === 1 ? `The element matching "${selector}" is not visible.` : `None of the ${found.count} elements matching "${selector}" is visible.`);
    }
    if (found.error) throw new ToolError(found.error);
    return found;
  }

  // 見えている範囲の (x, y) にある要素。別オリジンの iframe の中は、その iframe の src が許す先のときだけ押せる
  // （スクリプトからは中が見えないので、どのページかは src で決める）
  private async pointAt(
    guest: Guest,
    x: number,
    y: number,
  ): Promise<Target> {
    const found = (await this.world(
      guest,
      `(() => {${FRAMES}
        const x = ${x}, y = ${y};
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return { error: 'outside', width: innerWidth, height: innerHeight };
        const hit = __hit(x, y);
        if (!hit.el) return { error: 'none' };
        const inner = hit.cross ? __inner(hit.el) : null;
        const o = hit.cross ? __offset(hit.el.ownerDocument) : null;
        return {
          cross: hit.cross,
          src: hit.src || null,
          // 別オリジンの iframe の中身の左上（いちばん外の見えている範囲から）
          frame: inner ? { x: inner.x + o.ox, y: inner.y + o.oy } : null,
          description: hit.cross ? __name(hit.el) : __label(hit.el),
        };
      })()`,
    )) as { error?: string; width?: number; height?: number; cross: boolean; src: string | null; frame: { x: number; y: number } | null; description: string };
    if (found.error === 'outside') throw new ToolError(`x=${x} y=${y} is outside the visible area (${found.width}×${found.height}).`);
    if (found.error) throw new ToolError(`There is no element at x=${x} y=${y}.`);
    const rect = { x: x - 10, y: y - 10, width: 20, height: 20 };
    if (!found.cross) return { rect, description: `${found.description} at x=${x} y=${y}`, covered: null };
    // 別オリジンの iframe。別プロセスで動いていれば、そのセッションに、iframe の中の位置で送る
    const frame = found.src ? await this.childFor(guest, found.src) : null;
    const url = frame?.url ?? found.src;
    if (!url || !this.allowed(url)) throw new ToolError(`Cannot click x=${x} y=${y} because it is inside an iframe not allowed for Claude (${url ? frameShown(url) : 'no src'}).`);
    return {
      rect,
      description: `x=${x} y=${y} (inside cross-origin iframe ${url})`,
      covered: null,
      cross: true,
      child: frame && found.frame ? { session: frame.child, x: x - found.frame.x, y: y - found.frame.y } : undefined,
    };
  }

  // 押す要素に枠を出す（ブラウザを見ているユーザーに、どこを押すかを見せる）
  private async highlight(sessionId: string, rect: BrowserRect): Promise<void> {
    this.emit({ sessionId, active: true, label: null, box: rect });
    await sleep(HIGHLIGHT_MS);
  }

  // ユーザーに頼む前に、「Claude が操作中」の帯を下ろし、Claude の操作として扱うのをやめる（終わってすぐの間も）。
  // ほかの呼び出しが動いている途中なら、それが終わるのに任せる
  private yieldToUser(sessionId: string): void {
    if ((this.running.get(sessionId) ?? 0) > 0) return;
    clearTimeout(this.idleTimers.get(sessionId));
    this.idleTimers.delete(sessionId);
    this.endedAt.delete(sessionId);
    this.emit({ sessionId, active: false, label: null, box: null });
  }

  private begin(sessionId: string, label: string): void {
    clearTimeout(this.idleTimers.get(sessionId));
    this.running.set(sessionId, (this.running.get(sessionId) ?? 0) + 1);
    this.emit({ sessionId, active: true, label, box: null });
  }

  private end(sessionId: string): void {
    const left = (this.running.get(sessionId) ?? 1) - 1;
    this.running.set(sessionId, left);
    this.endedAt.set(sessionId, Date.now());
    if (left > 0) return;
    // 枠は押し終わったら消す。帯は、続けて操作することが多いので少し残す
    this.emit({ sessionId, active: true, label: null, box: null });
    clearTimeout(this.idleTimers.get(sessionId));
    this.idleTimers.set(
      sessionId,
      setTimeout(() => {
        this.idleTimers.delete(sessionId);
        this.emit({ sessionId, active: false, label: null, box: null });
      }, ACTIVE_LINGER_MS),
    );
  }

  private emit(activity: BrowserActivity): void {
    this.deps.send(this.deps.channels.activity, activity);
  }
}

// ---- 小さな部品 ----

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// コンソールの文を出したフレーム（Electron の WebFrameMain）の、オリジンとトップのフレームか。
// 分からない（フレームが無い・もう無くなった・オリジンが無い "null"）ときは、オリジンを null にする（Claude に返さない）。
// ただしトップのフレームのオリジンが "null"（Content-Security-Policy: sandbox のページ）なら、そのフレームの URL のオリジン（topOrigin）
function frameOf(event: { frame?: unknown }): { origin: string | null; top: boolean } {
  try {
    const f = event.frame as { origin?: unknown; parent?: unknown; url?: unknown } | null | undefined;
    if (!f) return { origin: null, top: true };
    const top = f.parent === null;
    const origin = typeof f.origin === 'string' && f.origin !== 'null' ? f.origin : null;
    return { origin: origin ?? (top ? topOrigin(f) : null), top };
  } catch {
    return { origin: null, top: true };
  }
}

// オリジンが "null" のトップのフレーム（Content-Security-Policy: sandbox のページ）のオリジンを、URL から決める。中身は、その URL のサーバーが
// 返したもの（Electron 44.7 で、フレームの url はページの URL だった）。iframe は、オリジンが "null" なら決めない（data: など、どこのものか分からない）
function topOrigin(frame: { url?: unknown }): string | null {
  return typeof frame.url === 'string' ? webOrigin(frame.url) : null;
}

// 失敗した通信を出したもの（Claude に返すかを、コンソールの記録と同じ決まり visibleLog で決める）。Electron 44.7 で確かめた。
// - 文書の読み込み（mainFrame・subFrame）は、読み込もうとした先のオリジン（そこに入るページ）。initiatorOrigin は読み込みを始めたページなので、
//   許したページのリンクから許していない先へ移るときも、許したページになってしまう。トップの読み込みなら top
// - ほかの通信（スクリプト・画像・fetch など）は、出したオリジン（initiatorOrigin。リダイレクトしても変わらない。不透明なオリジン "null"・
//   ブラウザが自分で始めた通信は無いので、null にして返さない）と、出したフレームがトップか。フレームが分からない（移った・無くなった）
//   ときは iframe として扱う（許す先か、今のトップと同じオリジンでトップが許した先のときだけ返す）
type RequestDetails = { url: string; resourceType: string; initiatorOrigin?: string; frame?: unknown };
function requestSource(details: RequestDetails): { origin: string | null; top: boolean } {
  if (details.resourceType === 'mainFrame' || details.resourceType === 'subFrame') {
    return { origin: webOrigin(details.url), top: details.resourceType === 'mainFrame' };
  }
  const origin = webOrigin(details.initiatorOrigin ?? '');
  try {
    const frame = details.frame as { parent?: unknown; url?: unknown } | null | undefined;
    const top = !!frame && frame.parent === null;
    // 出したオリジンが "null" で、出したのがトップのフレームなら、コンソールの記録と同じく、そのフレームの URL のオリジン
    return { origin: origin ?? (top && details.initiatorOrigin === 'null' ? topOrigin(frame) : null), top };
  } catch {
    return { origin, top: false };
  }
}

// 人の許可を得て開けるページ（http(s)）のオリジン。ほかのもの（file:・about: など）と読めないものは null
function webOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

// Claude に見せる、許していない先。オリジンだけ
function originShown(url: string): string {
  return originOf(url) ?? 'invalid URL';
}

// evaluate で動かすスクリプト。先頭で、今のページのオリジンを確かめたものと比べ、違えば mark を投げる。
// location とその protocol・host は、ページのスクリプトから書き換えられない（[LegacyUnforgeable]。同じ名前の let も置けない）。
// location.origin で比べても同じ（CSP の sandbox のページでも URL のオリジン。"null" になるのは self.origin。Electron 44.7 で確かめた）。
// 比べる文はブロックで包み、改行で区切って、式は手を入れずに続ける（文の並びも最後の値を返す。else で始まる式が、比べる文の if の続きにならない）。
// 式の行番号は、エラーのスタックで 1 つずれる。
// - #! の行（hashbang）はスクリプトの頭にしか書けないので、その行だけ比べる文より前に置き、必ず改行を足す
//   （行の終わりは \n・\r・\u2028・\u2029。足さないと、比べる文が #! の行の続きになって、効かなくなる）
// - 頭の directive に 'use strict' がある式は、比べる文の前に置くと directive が効かなくなるので、頭にも 'use strict'; を足す
//   （全体が strict。式だけで動かすのと同じ。見分け方は hasUseStrict）
function guardedScript(origin: string, mark: string, expression: string): string {
  const hashbang = /^#![^\n\r\u2028\u2029]*/.exec(expression)?.[0] ?? '';
  const body = expression.slice(hashbang.length);
  const strict = hasUseStrict(body) ? "'use strict';" : '';
  const check = `{ if (location.protocol + '//' + location.host !== ${JSON.stringify(origin)}) throw ${JSON.stringify(mark)}; }`;
  return `${hashbang ? `${hashbang}\n` : ''}${strict}${check}\n${body}`;
}

// スクリプトの頭の directive（文字列だけの文の並び）に 'use strict' があるか。空白と注釈は読み飛ばす。
// 文字列のあとに式が続くもの（'use strict'.length・改行して + 1 など）は directive ではない。改行のあとは、次の字が式の続きでなければ
// 文の終わり（自動のセミコロン）とみなす。見分けを誤っても、比べる文が先に動くことは変わらない（strict かどうかだけが変わる）
const LINE_END = /[\n\r\u2028\u2029]/;
function hasUseStrict(code: string): boolean {
  let i = 0;
  // 空白と注釈を読み飛ばし、行の終わりをまたいだかを返す
  const skip = (): boolean => {
    let newline = false;
    while (i < code.length) {
      const c = code[i]!;
      if (LINE_END.test(c)) {
        newline = true;
        i++;
      } else if (/\s/.test(c)) i++;
      else if (code.startsWith('//', i)) {
        while (i < code.length && !LINE_END.test(code[i]!)) i++;
      } else if (code.startsWith('/*', i)) {
        const end = code.indexOf('*/', i + 2);
        if (end === -1) return newline;
        if (LINE_END.test(code.slice(i + 2, end))) newline = true;
        i = end + 2;
      } else break;
    }
    return newline;
  };
  while (true) {
    skip();
    const quote = code[i];
    if (quote !== "'" && quote !== '"') return false;
    // 文字列の終わり（エスケープしたものは飛ばす。途中の改行は書き方の誤りなので、そこでやめる）
    let end = i + 1;
    while (end < code.length && code[end] !== quote) {
      if (LINE_END.test(code[end]!)) return false;
      end += code[end] === '\\' ? 2 : 1;
    }
    if (end >= code.length) return false;
    const strict = code.slice(i + 1, end) === 'use strict';
    i = end + 1;
    const newline = skip();
    const rest = code.slice(i);
    if (rest.startsWith(';')) i++;
    else if (rest !== '') {
      // 改行をまたがずにほかのものが続くか、改行のあとが式の続き（. ( [ ` 演算子・in・instanceof など）なら、directive ではない。
      // 改行のあとの ++・-- は続きではない（後置の ++・-- は改行をまたげないので、自動のセミコロンが入り、次の文の前置の ++・-- になる）
      const continues =
        !/^(\+\+|--)/.test(rest) && (/^[.([`+\-*/%&|^?,=<>]/.test(rest) || rest.startsWith('!=') || /^(in|instanceof)(?![\w$])/.test(rest));
      if (!newline || continues) return false;
    }
    if (strict) return true;
  }
}

// evaluate の先頭の比べる文が、確かめたページから別のオリジンへ移っていたときに投げる目印（呼び出しごとの乱数を足して使う）
const PAGE_CHANGED = 'tanacode: the page moved to another origin before the script ran';

// 止めた先へ進む方法（止めたことを伝える文に添える）
const CONTINUE_HINT = ' To open it, call navigate with action "continue" (tanacode asks the user for permission).';

// 断る文に出す、許していない先の iframe の URL。オリジンだけ（iframe の今の URL はページからは読めず、認証・決済の途中の値が入っていることがある）。
// URL として読めないものは、ページに書いてある src そのものなので、そのまま
function frameShown(url: string): string {
  return originOf(url) ?? url;
}

// 空のタブ（「＋」で開いたもの・まだ何も開いていないもの）
function isBlank(url: string): boolean {
  return url === '' || url === 'about:blank';
}

// タブの ID（tab-<番号>）の番号
function tabNumber(tabId: string): number {
  return Number(tabId.replace(/\D/g, '')) || 0;
}

const MODIFIER_BITS: Record<string, number> = { alt: 1, control: 2, meta: 4, shift: 8 };
// 本物の押下のあと、アプリの画面のフォーカスが webview へ移るのを見る長さの上限と間隔（keepHumanFocus。移らなければ、そのまま）
const KEEP_FOCUS_WAIT_MS = 1000;
const KEEP_FOCUS_POLL_MS = 50;
// 押す要素（locate・pointAt）。cross: 別オリジンの iframe の中（スクリプトからは押せない）。child: その iframe が別プロセスなら、そのセッションと中の位置
type Target = { rect: BrowserRect; description: string; covered: string | null; cross?: boolean; child?: { session: string; x: number; y: number } };
// ページに送ったキー・文字が、ページに届いた（keyup・input）のを待つ長さの上限（届かないもの: 文字を入れられない所に入れたなど）
const INPUT_WAIT_MS = 1000;

type KeySpec = { key: string; code: string; keyCode: number; text?: string };

const NAMED_KEYS: Record<string, KeySpec> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};

// sendInputEvent に渡すキーの名前（Electron のアクセラレーターのキーの名前。文字のキーはその文字）
const ELECTRON_KEYS: Record<string, string> = {
  ' ': 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
};
export function electronKeyCode(spec: KeySpec): string {
  return ELECTRON_KEYS[spec.key] ?? spec.key;
}

export function keySpec(name: string): KeySpec | null {
  const named = NAMED_KEYS[name.toLowerCase()];
  if (named) return named;
  const f = /^f([1-9]|1[0-2])$/i.exec(name);
  if (f) return { key: `F${f[1]}`, code: `F${f[1]}`, keyCode: 111 + Number(f[1]) };
  if ([...name].length !== 1) return null;
  const upper = name.toUpperCase();
  if (/[A-Z]/.test(upper)) return { key: name, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: name };
  if (/[0-9]/.test(name)) return { key: name, code: `Digit${name}`, keyCode: name.charCodeAt(0), text: name };
  return { key: name, code: '', keyCode: 0, text: name };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function requiredString(value: unknown, name: string): string {
  const text = optionalString(value);
  if (!text) throw new ToolError(`Provide ${name}.`);
  return text;
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined;
}

// 2 枚の絵（同じ範囲を、違う画素密度で撮ったもの）が、同じに見えるか。10×10 の点で色（透明度も）を比べ、95 点が近ければ同じとみなす
// （画素密度が違うと、縁の色が少し違う。ページが動いている途中なら合わないことがあるが、そのときは画面の画素密度の絵を使うだけ）
function looksSame(a: NativeImage, b: NativeImage): boolean {
  const sa = a.getSize();
  const sb = b.getSize();
  if (Math.abs(sa.width / sa.height - sb.width / sb.height) > 0.02) return false;
  const pa = a.toBitmap();
  const pb = b.toBitmap();
  let near = 0;
  for (let i = 0; i < 10; i++) {
    for (let j = 0; j < 10; j++) {
      const at = (size: { width: number; height: number }) => (Math.floor(((j + 0.5) / 10) * size.height) * size.width + Math.floor(((i + 0.5) / 10) * size.width)) * 4;
      const ia = at(sa);
      const ib = at(sb);
      if ([0, 1, 2, 3].every((c) => Math.abs((pa[ia + c] ?? 0) - (pb[ib + c] ?? 0)) <= 48)) near++;
    }
  }
  return near >= 95;
}

// タッチを送る位置の決め方（hostOffset）
type HostOffset = { x: number; y: number; scale: number; visible: { left: number; top: number; right: number; bottom: number } };

// アプリの画面で動かす、タブの webview の左上と、アプリの画面に出ている所を読むスクリプト
function webviewPlace(tabId: string): string {
  return `(async () => {
    // 動いたあとの配置になるよう、描き終わるのを 2 コマ待つ（描かれないときも、0.3 秒で先へ進む）
    await Promise.race([new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))), new Promise((r) => setTimeout(r, 300))]);
    const el = document.querySelector('webview[data-tab-id=${JSON.stringify(tabId)}]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    let left = Math.max(r.left, 0), top = Math.max(r.top, 0), right = Math.min(r.right, innerWidth), bottom = Math.min(r.bottom, innerHeight);
    for (let a = el.parentElement; a; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const b = a.getBoundingClientRect();
      left = Math.max(left, b.left + a.clientLeft);
      top = Math.max(top, b.top + a.clientTop);
      right = Math.min(right, b.left + a.clientLeft + a.clientWidth);
      bottom = Math.min(bottom, b.top + a.clientTop + a.clientHeight);
    }
    return { x: r.left, y: r.top, visible: { left, top, right, bottom } };
  })()`;
}

// タブの中の位置 p（見えている範囲の左上から）が、アプリの画面に出ている所にあるか
function shownAt(at: HostOffset, p: BrowserPoint): boolean {
  const x = at.x + p.x * at.scale;
  const y = at.y + p.y * at.scale;
  return x >= at.visible.left && x < at.visible.right && y >= at.visible.top && y < at.visible.bottom;
}

// 範囲の中の数字。そうでなければ断る
function ranged(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new ToolError(`${name} must be a number from ${min} to ${max}: ${String(value)}`);
  return value;
}

// 渡されていれば数字（数字でなければ断る）
function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ToolError(`${name} must be a number: ${String(value)}`);
  return value;
}

// 指を置く位置。2 本なら、point を真ん中に、横に FINGER_GAP 離して並べる
function fingersAt(point: BrowserPoint, fingers: number): BrowserPoint[] {
  return fingers === 2
    ? [
        { x: point.x - FINGER_GAP / 2, y: point.y },
        { x: point.x + FINGER_GAP / 2, y: point.y },
      ]
    : [point];
}

// 小数第 1 位まで（Claude に返す位置・CDP に送る位置）
function round(value: number): number {
  return Math.round(value * 10) / 10;
}

// Claude に返す、通信の速さ
function networkShown(name: NetworkPresetName): string {
  const preset = NETWORK_PRESETS[name];
  if (preset.offline) return 'offline';
  return `${name} (latency ${preset.latency} ms, download ${Math.round((preset.download * 8) / 1000)} kbps, upload ${Math.round((preset.upload * 8) / 1000)} kbps)`;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

// Claude に返す文の数と名詞（1 tab・2 tabs）
function count(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

// 「localhost:3000」のようにスキームが無ければ http:// を付ける
function toUrl(input: string): string {
  const text = input.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
}

function center(rect: BrowserRect): { x: number; y: number } {
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…(${text.length - max} more characters omitted)` : text;
}

// Retina では、撮った画像はページの大きさ（CSS の px）の dpr 倍になる。ページの大きさに縮め、長い辺も上限までにする
function shrink(image: NativeImage, dpr: number): NativeImage {
  const { width, height } = image.getSize();
  const scale = Math.min(dpr > 1 ? 1 / dpr : 1, MAX_IMAGE_SIDE / Math.max(width, height, 1));
  if (scale >= 1) return image;
  return image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'good' });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 読み込みが終わるまで待つ（移り始めるのを少し待ってから、読み込み中でなくなるまで）
async function waitForLoad(contents: WebContents): Promise<void> {
  const started = Date.now();
  await sleep(100);
  while (Date.now() - started < LOAD_TIMEOUT_MS) {
    if (contents.isDestroyed()) return;
    const url = contents.getURL();
    if (!contents.isLoading() && url && url !== 'about:blank') return;
    await sleep(100);
  }
}

// 操作のあと、ページが落ち着くのを待つ。移り始めたら、読み込みが終わるまで
async function settle(contents: WebContents): Promise<void> {
  await sleep(250);
  if (!contents.isDestroyed() && contents.isLoading()) await waitForLoad(contents);
}
