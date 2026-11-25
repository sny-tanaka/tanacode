import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { bracketedPaste, stripControlChars } from '@shared/paste';
import type { SessionState } from '@shared/session-tools';
import { xtermOptions } from './xterm';
import { isRemoteMode } from '../remote/mode';
import { MobileKeys, useCtrlKey } from './MobileKeys';

type Term = { term: Terminal; fit: FitAddon; element: HTMLDivElement; opened: boolean };

// セッションごとの xterm。画面を出していない間（チャットを見ている・ほかのセッションや新規セッションの画面を見ている）も
// pty の出力を受け取っておくので、部品（ClaudeScreen）の外に持つ。element は、出すときに部品の中へ移す
const terms = new Map<string, Term>();
// 出力を受け取っているもの（App と、出ている ClaudeScreen）の数
let holders = 0;
let offData: (() => void) | null = null;
let offResized: (() => void) | null = null;
// 打ったものを pty に送る前に通す（スマホの補助キーの Ctrl。出ている ClaudeScreen が差し替える）
let typed: (data: string) => string = (data) => data;

function termFor(sessionId: string): Term {
  let t = terms.get(sessionId);
  if (!t) {
    const term = new Terminal(xtermOptions());
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.onData((data) => window.tanacode.pty.write(sessionId, typed(data)));
    // スマホの画面からは、pty の大きさを変えない（Mac の画面が崩れないように。Issue #464）
    term.onResize(({ cols, rows }) => {
      if (!isRemoteMode()) window.tanacode.pty.resize(sessionId, cols, rows);
    });
    const element = document.createElement('div');
    element.className = 'terminal-instance';
    t = { term, fit, element, opened: false };
    terms.set(sessionId, t);
  }
  return t;
}

// pty の出力を受け取り始める。返す関数で終える。最後の 1 つが終えたら、xterm も片付ける
// スマホの画面は、Mac の画面が変えた pty の大きさにも合わせる（Mac の桁数のまま描く）
function hold(): () => void {
  if (holders++ === 0) {
    offData = window.tanacode.pty.onData(({ sessionId, data }) => termFor(sessionId).term.write(data));
    if (isRemoteMode()) offResized = window.tanacode.pty.onResized(({ sessionId, cols, rows }) => terms.get(sessionId)?.term.resize(cols, rows));
  }
  return () => {
    if (--holders > 0) return;
    offData?.();
    offData = null;
    offResized?.();
    offResized = null;
    for (const t of terms.values()) {
      t.term.dispose();
      t.element.remove();
    }
    terms.clear();
  };
}

// 一覧から消した・アーカイブしたセッションの xterm を片付ける（App が、一覧が変わるたびに、動いているセッションの id で呼ぶ）。
// アーカイブ済みのセッションは画面を出さないので、出している xterm は片付けない
export function keepClaudeScreens(liveIds: readonly string[]): void {
  const live = new Set(liveIds);
  for (const [id, t] of terms) {
    if (live.has(id)) continue;
    t.term.dispose();
    t.element.remove();
    terms.delete(id);
  }
}

// アプリが動いている間、どのセッションの Claude Code の画面の出力も受け取っておく（App が呼ぶ）。
// 画面を出したときに、それまでの出力をさかのぼって読める。
// スマホの画面では受け取らない（通信量を増やさない。画面を出したときに、今の画面を読む。Issue #464）
export function useClaudeScreenOutput(): void {
  useEffect(() => (isRemoteMode() ? undefined : hold()), []);
}

const IMAGE_PASTE_MS = 300;

// 今は貼れないターミナルモードのセッション。TUI が許可の確認・質問のメニューを出している間（一覧の attention。main の tuiAsk）は、
// 貼るとメニューへの入力に混ざる。ターミナルモードで止まっている・起動や切り替えの途中は、貼る先の TUI が無い。
// その間に貼るものは預かり、TUI が動いてメニューが閉じたら順に貼る（main が貼る知らせと同じ。SessionManager.pasteIntoTerminal）。
// 止まっている間に預かったものは、「再開」で TUI が動いたら貼る（チャットの、再開したら送る発言と同じ）。
// 預かっている間にターミナルモードでなくなったら、貼る先の TUI が無いので捨てる
const asking = new Set<string>();
const held = new Map<string, { text: string; attachments: string[] }[]>();

// セッションの一覧が変わった（App が呼ぶ）
export function noteClaudeScreenSessions(
  sessions: readonly { id: string; terminal?: boolean; state?: SessionState | null; attention: string | null }[],
): void {
  for (const session of sessions) {
    if (session.terminal && (session.state !== 'terminal' || session.attention === 'permission' || session.attention === 'question')) {
      asking.add(session.id);
      continue;
    }
    asking.delete(session.id);
    const waiting = held.get(session.id);
    if (!waiting) continue;
    held.delete(session.id);
    if (!session.terminal) continue;
    void (async () => {
      for (const paste of waiting) await writePaste(session.id, paste.text, paste.attachments);
    })();
  }
}

// Claude Code の入力欄に貼る（送らない。人が画面で続きを打ち、Enter で送る）。メニューが出ている間・止まっている間は、貼れるように
// なってから貼る（上の asking）。
// 画像は、パスを貼り付けとして送ると [Image #n] として添付される（TUI の決まり）。
// 貼る文は、ファイルの中身・Claude が書いた文・ターミナルの出力などから来るので、ここで必ず制御文字を取り除く
// （ESC が残ると、ESC[201~ で貼り付けを抜け、あとの文字が Enter・Shift+Tab などのキーとして TUI に届く）
export async function pasteIntoClaudeScreen(sessionId: string, text: string, attachments: string[] = []): Promise<void> {
  if (asking.has(sessionId)) {
    held.set(sessionId, [...(held.get(sessionId) ?? []), { text, attachments }]);
    return;
  }
  await writePaste(sessionId, text, attachments);
}

async function writePaste(sessionId: string, text: string, attachments: string[]): Promise<void> {
  for (const path of attachments) {
    window.tanacode.pty.write(sessionId, bracketedPaste(stripControlChars(path)));
    await new Promise((resolve) => setTimeout(resolve, IMAGE_PASTE_MS));
    window.tanacode.pty.write(sessionId, ' ');
  }
  const safe = stripControlChars(text);
  if (safe) window.tanacode.pty.write(sessionId, bracketedPaste(safe));
  terms.get(sessionId)?.term.focus();
}

// Claude Code の生の画面。ターミナルモードで、チャットの代わりに Claude Code ペインに出す。
// 出した時点の大きさに pty をリサイズするので、Claude が画面全体を描き直す。
// 隠したら pty を既定の大きさに戻す（次に出したときに大きさが変わり、TUI が画面全体を描き直す）。
// スマホの画面では、pty の大きさを変えない（Mac の画面が崩れないように）。出している間だけ出力を受け取り、出したときに今の画面と大きさを
// 読んで、Mac の桁数のまま描く（横にスクロールして見る）。スマホのキーボードに無いキーは、補助キーで打つ（Issue #464）
export function ClaudeScreen({ sessionId }: { sessionId: string }) {
  const remote = isRemoteMode();
  return remote ? <RemoteClaudeScreen sessionId={sessionId} /> : <LocalClaudeScreen sessionId={sessionId} />;
}

function LocalClaudeScreen({ sessionId }: { sessionId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useClaudeScreenOutput();

  useEffect(() => {
    const host = hostRef.current!;
    const t = termFor(sessionId);
    host.appendChild(t.element);
    if (!t.opened) {
      t.term.open(t.element);
      t.opened = true;
    }
    t.fit.fit();
    // 大きさが前に出したときと同じだと onResize が来ないので、ここでも pty に伝える
    window.tanacode.pty.resize(sessionId, t.term.cols, t.term.rows);
    t.term.focus();
    const observer = new ResizeObserver(() => t.fit.fit());
    observer.observe(host);
    return () => {
      observer.disconnect();
      t.element.remove();
      window.tanacode.pty.resetSize(sessionId);
    };
  }, [sessionId]);

  return <div className="claude-screen" ref={hostRef} />;
}

function RemoteClaudeScreen({ sessionId }: { sessionId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const ctrl = useCtrlKey();
  const typedNow = ctrl.typed;
  useEffect(() => {
    typed = typedNow;
    return () => {
      typed = (data) => data;
    };
  }, [typedNow]);
  useEffect(hold, []);

  useEffect(() => {
    const host = hostRef.current!;
    const t = termFor(sessionId);
    host.appendChild(t.element);
    if (!t.opened) {
      t.term.open(t.element);
      t.opened = true;
    }
    // 頼んだあとに届いた出力は写しのあとに続くので、写しが届いたら、それまでに書いたものを消して写しを書く
    let alive = true;
    window.tanacode.pty
      .snapshot(sessionId)
      .then((snapshot) => {
        if (!alive || !snapshot) return;
        t.term.reset();
        t.term.resize(snapshot.cols, snapshot.rows);
        t.term.write(snapshot.screen);
      })
      .catch(() => {});
    return () => {
      alive = false;
      t.element.remove();
    };
  }, [sessionId]);

  return (
    <>
      <div className="claude-screen remote" ref={hostRef} />
      <MobileKeys write={(data) => window.tanacode.pty.write(sessionId, ctrl.typed(data))} ctrl={ctrl.ctrl} onCtrl={ctrl.setCtrl} />
    </>
  );
}
