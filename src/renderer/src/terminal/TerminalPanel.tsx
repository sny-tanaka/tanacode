import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { insertIntoChat } from '../chat/insertInput';
import { ClaudeScreen } from './ClaudeScreen';
import { codeBlock, stripControlChars } from '../chat/sanitize';
import { useRunInTerminal } from './runInTerminal';
import { xtermOptions } from './xterm';

// パネルに出すもの: ユーザーのシェルか、Claude Code の生の画面か
export type TerminalView = 'shell' | 'claude';

type ShellTab = { id: string; name: string; title: string | null };
type Xterm = { term: Terminal; fit: FitAddon; element: HTMLDivElement };

const HEIGHT_KEY = 'tanacode.terminalHeight';
const DEFAULT_HEIGHT = 280;
const MIN_HEIGHT = 120;

function loadHeight(): number {
  try {
    const saved = Number(localStorage.getItem(HEIGHT_KEY));
    return saved >= MIN_HEIGHT ? saved : DEFAULT_HEIGHT;
  } catch {
    return DEFAULT_HEIGHT;
  }
}

type Props = {
  sessionId: string | null;
  open: boolean;
  view: TerminalView;
  onView: (view: TerminalView) => void;
  onClose: () => void;
};

// エディタの下のターミナル。セッションごとに、そのフォルダでシェルを好きなだけ開ける。
// セッションを切り替えてもシェルは動き続け、戻ると同じ画面が出る
export function TerminalPanel({ sessionId, open, view, onView, onClose }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const xterms = useRef(new Map<string, Xterm>());
  // xterm を用意する前に届いた出力
  const pending = useRef(new Map<string, string[]>());
  const [shells, setShells] = useState<Record<string, ShellTab[]>>({});
  const [active, setActive] = useState<Record<string, string>>({});
  const [hasSelection, setHasSelection] = useState(false);
  const [height, setHeight] = useState(loadHeight);
  const creating = useRef(false);
  // 次に開くシェルで実行するコマンド（チャットのコードブロックの「実行」）
  const queued = useRef<{ owner: string; command: string } | null>(null);

  const tabs = sessionId ? (shells[sessionId] ?? []) : [];
  const activeShell = sessionId ? tabs.find((t) => t.id === active[sessionId]) ?? tabs[0] ?? null : null;
  const showShell = open && view === 'shell';

  useEffect(() => {
    const offData = window.tanacode.shell.onData(({ id, data }) => {
      const x = xterms.current.get(id);
      if (x) x.term.write(data);
      else pending.current.set(id, [...(pending.current.get(id) ?? []), data]);
    });
    // シェルが終わったら（exit など）タブを閉じる
    const offExit = window.tanacode.shell.onExit(({ id }) => {
      const x = xterms.current.get(id);
      x?.term.dispose();
      x?.element.remove();
      xterms.current.delete(id);
      pending.current.delete(id);
      setShells((prev) => Object.fromEntries(Object.entries(prev).map(([owner, list]) => [owner, list.filter((t) => t.id !== id)])));
    });
    const observer = new ResizeObserver(() => {
      for (const x of xterms.current.values()) if (!x.element.hidden) x.fit.fit();
    });
    observer.observe(hostRef.current!);
    return () => {
      offData();
      offExit();
      observer.disconnect();
    };
  }, []);

  const newShell = useCallback(async (owner: string) => {
    if (creating.current) return;
    creating.current = true;
    try {
      const element = document.createElement('div');
      element.className = 'terminal-instance';
      for (const x of xterms.current.values()) x.element.hidden = true;
      hostRef.current!.appendChild(element);
      const term = new Terminal(xtermOptions());
      const fit = new FitAddon();
      term.loadAddon(fit);
      // URL は ⌘ クリックでブラウザで開く
      term.loadAddon(new WebLinksAddon((event, uri) => event.metaKey && window.open(uri)));
      // ⌘K で画面を消す（macOS のターミナルと同じ）
      term.attachCustomKeyEventHandler((e) => {
        if (e.type === 'keydown' && e.metaKey && e.key === 'k') {
          term.clear();
          return false;
        }
        return true;
      });
      term.open(element);
      fit.fit();
      const { id, name } = await window.tanacode.shell.create(owner, term.cols, term.rows);
      xterms.current.set(id, { term, fit, element });
      term.onData((data) => window.tanacode.shell.write(id, data));
      term.onResize(({ cols, rows }) => window.tanacode.shell.resize(id, cols, rows));
      term.onSelectionChange(() => setHasSelection(term.hasSelection()));
      term.onTitleChange((title) =>
        setShells((prev) => ({ ...prev, [owner]: (prev[owner] ?? []).map((t) => (t.id === id ? { ...t, title: title || null } : t)) })),
      );
      for (const data of pending.current.get(id) ?? []) term.write(data);
      pending.current.delete(id);
      if (queued.current?.owner === owner) {
        // 見えない制御文字で、見えているコマンドと違うものが動かないようにする
        window.tanacode.shell.write(id, `${stripControlChars(queued.current.command)}\r`);
        queued.current = null;
      }
      setShells((prev) => ({ ...prev, [owner]: [...(prev[owner] ?? []), { id, name, title: null }] }));
      setActive((prev) => ({ ...prev, [owner]: id }));
    } finally {
      creating.current = false;
    }
  }, []);

  // パネルを開き、新しいシェルのタブでコマンドを実行する。パネルが見えてから作る（隠れたままだと大きさを測れない）。
  // パネルを開いたことで「1 つも無ければ開く」が先にシェルを作っても、そちらで実行される
  useRunInTerminal((owner, command) => {
    if (owner !== sessionId) return;
    queued.current = { owner, command };
    onView('shell');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (queued.current) void newShell(owner);
    }));
  });

  // シェルを出すのに 1 つも無ければ開く
  useEffect(() => {
    if (showShell && sessionId && tabs.length === 0) void newShell(sessionId);
  }, [showShell, sessionId, tabs.length, newShell]);

  // 表示するシェルだけを出す
  useEffect(() => {
    for (const [id, x] of xterms.current) x.element.hidden = !showShell || id !== activeShell?.id;
    const x = showShell && activeShell ? xterms.current.get(activeShell.id) : undefined;
    if (!x) return;
    x.fit.fit();
    x.term.focus();
    setHasSelection(x.term.hasSelection());
  }, [showShell, activeShell, height]);

  const sendSelection = () => {
    const x = activeShell && xterms.current.get(activeShell.id);
    const text = x?.term.getSelection().trimEnd();
    if (!sessionId || !text) return;
    // 出力に ``` があってもコードブロックから抜けないよう、フェンスは中身より長くする
    insertIntoChat(sessionId, codeBlock(text));
  };

  const drag = useRef<{ y: number; height: number } | null>(null);
  const saveHeight = () => {
    try {
      localStorage.setItem(HEIGHT_KEY, String(height));
    } catch {
      // 保存できなくても今の表示には影響しない
    }
  };

  return (
    <div className="terminal-panel" hidden={!open || !sessionId} style={{ height }}>
      <div
        className="terminal-resizer"
        role="separator"
        aria-orientation="horizontal"
        title="ドラッグで高さを変更"
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { y: e.clientY, height };
          document.body.classList.add('resizing-rows');
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const max = window.innerHeight - 200;
          setHeight(Math.round(Math.max(MIN_HEIGHT, Math.min(max, drag.current.height + drag.current.y - e.clientY))));
        }}
        onPointerUp={(e) => {
          if (!drag.current) return;
          e.currentTarget.releasePointerCapture(e.pointerId);
          drag.current = null;
          document.body.classList.remove('resizing-rows');
          saveHeight();
        }}
      />
      <div className="terminal-panel-head">
        <div className="terminal-tabs" role="tablist">
          {tabs.map((t, i) => (
            <div
              key={t.id}
              role="tab"
              aria-selected={view === 'shell' && t.id === activeShell?.id}
              className={`terminal-tab${view === 'shell' && t.id === activeShell?.id ? ' active' : ''}`}
              onClick={() => {
                if (sessionId) setActive((prev) => ({ ...prev, [sessionId]: t.id }));
                onView('shell');
              }}
              title={t.title ?? t.name}
            >
              <span>{t.title ?? `${t.name} ${i + 1}`}</span>
              <button
                className="terminal-tab-close"
                aria-label="このターミナルを閉じる"
                data-tip="このターミナルを閉じる"
                onClick={(e) => {
                  e.stopPropagation();
                  window.tanacode.shell.kill(t.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
          <button
            className="terminal-add"
            data-tip="新しいターミナル"
            aria-label="新しいターミナル"
            onClick={() => {
              onView('shell');
              if (sessionId) void newShell(sessionId);
            }}
          >
            ＋
          </button>
        </div>
        {view === 'shell' && (
          <button className="ghost-button" disabled={!hasSelection} onClick={sendSelection} title="ターミナルで選んだ出力を、チャットの入力欄に貼る">
            Claude へ送る
          </button>
        )}
        <button
          role="tab"
          aria-selected={view === 'claude'}
          className={`terminal-tab claude-screen-tab${view === 'claude' ? ' active' : ''}`}
          onClick={() => onView(view === 'claude' ? 'shell' : 'claude')}
          title="Claude Code の画面をそのまま表示して操作する"
        >
          Claude Code
        </button>
        <button className="terminal-panel-close" onClick={onClose} data-tip="パネルを閉じる（⌃`）" aria-label="パネルを閉じる">
          ×
        </button>
      </div>
      <div className="terminal-panel-body">
        <div className="terminal-host" hidden={view !== 'shell'} ref={hostRef} />
        <ClaudeScreen sessionId={sessionId} open={open && view === 'claude'} />
      </div>
    </div>
  );
}
