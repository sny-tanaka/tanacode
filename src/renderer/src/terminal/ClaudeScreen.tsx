import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { xtermOptions } from './xterm';

type Term = { term: Terminal; fit: FitAddon; element: HTMLDivElement; opened: boolean };

function createTerm(sessionId: string, host: HTMLElement): Term {
  const term = new Terminal(xtermOptions());
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.onData((data) => window.tanacode.pty.write(sessionId, data));
  term.onResize(({ cols, rows }) => window.tanacode.pty.resize(sessionId, cols, rows));
  const element = document.createElement('div');
  element.className = 'terminal-instance';
  element.hidden = true;
  host.appendChild(element);
  return { term, fit, element, opened: false };
}

// Claude Code の生の画面（デバッグ用。ターミナルパネルのタブのひとつ）。pty の出力はセッションごとに常に受け取り、
// 開いたときに初めて DOM に描画する。開いた時点のサイズに pty をリサイズするので、Claude が画面全体を描き直す。
// 閉じたら pty を既定の大きさに戻す（パネルの低さのままだと、質問の選択肢の一部が画面の外に出て読めない）
export function ClaudeScreen({ sessionId, open }: { sessionId: string | null; open: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termsRef = useRef(new Map<string, Term>());
  // pty をパネルの大きさに合わせているセッション
  const fitted = useRef<string | null>(null);

  const termFor = (id: string): Term => {
    let t = termsRef.current.get(id);
    if (!t) {
      t = createTerm(id, hostRef.current!);
      termsRef.current.set(id, t);
    }
    return t;
  };

  useEffect(() => {
    const terms = termsRef.current;
    const offData = window.tanacode.pty.onData(({ sessionId: id, data }) => termFor(id).term.write(data));
    const observer = new ResizeObserver(() => {
      for (const t of terms.values()) if (t.opened && !t.element.hidden) t.fit.fit();
    });
    observer.observe(hostRef.current!);
    return () => {
      observer.disconnect();
      offData();
      for (const t of terms.values()) {
        t.term.dispose();
        t.element.remove();
      }
      terms.clear();
    };
  }, []);

  useEffect(() => {
    for (const [id, t] of termsRef.current) t.element.hidden = !open || id !== sessionId;
    if (fitted.current && (!open || fitted.current !== sessionId)) {
      window.tanacode.pty.resetSize(fitted.current);
      fitted.current = null;
    }
    if (!open || !sessionId) return;
    const t = termFor(sessionId);
    t.element.hidden = false;
    if (!t.opened) {
      t.term.open(t.element);
      t.opened = true;
    }
    t.fit.fit();
    // 大きさが前に開いたときと同じだと onResize が来ないので、ここでも pty に伝える
    window.tanacode.pty.resize(sessionId, t.term.cols, t.term.rows);
    fitted.current = sessionId;
    t.term.focus();
  }, [open, sessionId]);

  return <div className="terminal-host" hidden={!open} ref={hostRef} />;
}
