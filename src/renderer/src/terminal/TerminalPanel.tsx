import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { t } from '@shared/i18n';
import { terminalLabel } from '@shared/terminal-tools';
import type { ShellSnapshot } from '@shared/ipc';
import { insertIntoChat } from '../chat/insertInput';
import { AddIcon, CloseIcon, IconButton, SendIcon } from '../icons';
import { Busy } from '../layout/Busy';
import { codeBlock, stripControlChars } from '../chat/sanitize';
import { readSharedPref, useSharedPrefChange, writeSharedPref } from '../sharedPrefs';
import { useRunInTerminal } from './runInTerminal';
import { xtermOptions } from './xterm';

// task: アプリが開いたコマンドのタブ（worktree の npm install・yarn install など）。終わってもタブは残し、exitCode に終了コードを入れる
type ShellTab = { id: string; name: string; title: string | null; task?: boolean; exitCode?: number };
type Xterm = { term: Terminal; fit: FitAddon; element: HTMLDivElement };

const HEIGHT_KEY = 'tanacode.terminalHeight';
const DEFAULT_HEIGHT = 280;
const MIN_HEIGHT = 120;

function loadHeight(): number {
  const saved = Number(readSharedPref(HEIGHT_KEY));
  return saved >= MIN_HEIGHT ? saved : DEFAULT_HEIGHT;
}

type Props = {
  // 持ち主（セッション。新規セッションの画面では、そこで開いているフォルダ）
  sessionId: string | null;
  // フォルダがまだ無い（worktree を作っている）あいだの文言。シェルは開かずに、これを出して待つ。null なら待っていない
  waiting?: string | null;
  // シェルを持っておく持ち主（アーカイブしていないセッションと、新規セッションの画面のフォルダ）。ほかの持ち主のシェルは、止めて片付ける。
  // null・省略は、まだ分からない（一覧を読む前）ので片付けない
  liveOwners?: readonly string[] | null;
  open: boolean;
  // パネルを開く（チャットのコードブロックの「実行」など、閉じている間にコマンドを実行するとき）
  onOpen: () => void;
  onClose: () => void;
};

// エディタの下のターミナル。セッションごとに、そのフォルダでシェルを好きなだけ開ける。
// セッションを切り替えてもシェルは動き続け、戻ると同じ画面が出る
export function TerminalPanel({ sessionId, waiting = null, liveOwners = null, open, onOpen, onClose }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const xterms = useRef(new Map<string, Xterm>());
  // xterm を用意する前に届いた出力
  const pending = useRef(new Map<string, string[]>());
  const [shells, setShells] = useState<Record<string, ShellTab[]>>({});
  const [active, setActive] = useState<Record<string, string>>({});
  const [hasSelection, setHasSelection] = useState(false);
  // 高さは、どのプロファイルの画面でも同じにする（sharedPrefs）
  const [height, setHeight] = useState(loadHeight);
  useSharedPrefChange(HEIGHT_KEY, () => setHeight(loadHeight()));
  const creating = useRef(false);
  // 開いている間にほかのセッションへ移って、開いたシェルを片付けた回数（切り替えた先に 1 つも無ければ、開き直すため）
  const [discarded, setDiscarded] = useState(0);
  // 見ているセッション（シェルを開き終えたときに、開き始めたときと比べる）
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  // main が持っているターミナルを引き継いだ（画面を読み込み直したとき。引き継ぐまでは、新しいシェルを開かない）
  const [attached, setAttached] = useState(false);
  // 引き継ぐ前に終わったと知らせが来たもの（引き継ぐ返事より先に届くことがある）。id → 終了コード。引き継いだあとは控えない（null）
  const exitedEarly = useRef<Map<string, number> | null>(new Map());
  // 次に開くシェルで実行するコマンド（チャットのコードブロックの「実行」）
  const queued = useRef<{ owner: string; command: string } | null>(null);

  const tabs = sessionId ? (shells[sessionId] ?? []) : [];
  const activeShell = sessionId ? tabs.find((t) => t.id === active[sessionId]) ?? tabs[0] ?? null : null;

  // アプリが開いたコマンドのタブのうち、終わってもタブを残すもの（× で止めたものは外し、終わったら閉じる）
  const taskIds = useRef(new Set<string>());

  // xterm を作ってパネルに置く（まだ見せない）
  const makeXterm = useCallback((): Xterm => {
    const element = document.createElement('div');
    element.className = 'terminal-instance';
    element.hidden = true;
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
    return { term, fit, element };
  }, []);

  // 開いた pty（id）と xterm をつなぐ。xterm を用意する前に届いていた出力も流す
  const attachXterm = useCallback(
    (id: string, x: Xterm = makeXterm()): Xterm => {
      const { term } = x;
      xterms.current.set(id, x);
      term.onData((data) => window.tanacode.shell.write(id, data));
      term.onResize(({ cols, rows }) => window.tanacode.shell.resize(id, cols, rows));
      term.onSelectionChange(() => setHasSelection(term.hasSelection()));
      for (const data of pending.current.get(id) ?? []) term.write(data);
      pending.current.delete(id);
      return x;
    },
    [makeXterm],
  );

  // シェルが付けたタイトルを、タブの名前にする
  const followTitle = useCallback(
    (owner: string, id: string, term: Terminal) =>
      term.onTitleChange((title) =>
        setShells((prev) => ({ ...prev, [owner]: (prev[owner] ?? []).map((t) => (t.id === id ? { ...t, title: title || null } : t)) })),
      ),
    [],
  );

  useEffect(() => {
    const offData = window.tanacode.shell.onData(({ id, data }) => {
      const x = xterms.current.get(id);
      if (x) x.term.write(data);
      else pending.current.set(id, [...(pending.current.get(id) ?? []), data]);
    });
    // シェルが終わったら（exit など）タブを閉じる。アプリが開いたコマンドのタブは、出力を見られるよう残す
    const offExit = window.tanacode.shell.onExit(({ id, exitCode }) => {
      if (taskIds.current.has(id)) {
        setShells((prev) =>
          Object.fromEntries(Object.entries(prev).map(([owner, list]) => [owner, list.map((t) => (t.id === id ? { ...t, exitCode } : t))])),
        );
        return;
      }
      const x = xterms.current.get(id);
      if (!x) exitedEarly.current?.set(id, exitCode);
      x?.term.dispose();
      x?.element.remove();
      xterms.current.delete(id);
      pending.current.delete(id);
      setShells((prev) => Object.fromEntries(Object.entries(prev).map(([owner, list]) => [owner, list.filter((t) => t.id !== id)])));
    });
    // アプリがタブを開いた。そのセッションで選んでおく（「ターミナルで見る」で出す）。
    // コマンドのタブ（task）のほかに、Claude が打つために開いたシェルがある。こちらは、人が開いたシェルと同じに扱う（終わったらタブを閉じる）
    const offOpened = window.tanacode.shell.onOpened(({ owner, id, name, task }) => {
      if (task) taskIds.current.add(id);
      const { term } = attachXterm(id);
      if (!task) followTitle(owner, id, term);
      setShells((prev) => ({ ...prev, [owner]: [...(prev[owner] ?? []), { id, name, title: null, ...(task ? { task: true } : {}) }] }));
      setActive((prev) => ({ ...prev, [owner]: id }));
    });
    const observer = new ResizeObserver(() => {
      for (const x of xterms.current.values()) if (!x.element.hidden) x.fit.fit();
    });
    observer.observe(hostRef.current!);
    // 画面を読み込み直したとき（⌘R）、main で動き続けているターミナルを引き継ぐ。xterm を前と同じ大きさにして、今の画面を書き、
    // 返事より先に届いた出力（main が画面を控えたあとのもの）をそのあとに書く。返事より先に終わったシェルは出さない
    let alive = true;
    const restore = (list: ShellSnapshot[]) => {
      if (!alive) return;
      const early = exitedEarly.current ?? new Map<string, number>();
      exitedEarly.current = null;
      const restored: Record<string, ShellTab[]> = {};
      try {
        for (const s of list) {
          if (xterms.current.has(s.id)) continue;
          const earlyExit = early.get(s.id);
          if (earlyExit !== undefined && !s.task) continue;
          const exitCode = earlyExit ?? s.exitCode;
          const x = makeXterm();
          try {
            x.term.resize(s.cols, s.rows);
            x.term.write(s.screen);
          } catch {
            // 画面を書き直せなかったシェルは、見えないまま動かし続けないよう、止めて片付ける
            x.term.dispose();
            x.element.remove();
            pending.current.delete(s.id);
            window.tanacode.shell.kill(s.id);
            continue;
          }
          attachXterm(s.id, x);
          if (s.task) {
            taskIds.current.add(s.id);
          } else {
            followTitle(s.owner, s.id, x.term);
          }
          (restored[s.owner] ??= []).push({ id: s.id, name: s.name, title: s.title, ...(s.task ? { task: true } : {}), ...(exitCode !== null ? { exitCode } : {}) });
        }
      } finally {
        // 引き継いだタブを先に、返事より先に開いたタブをそのあとに並べる
        setShells((prev) => {
          const next = { ...prev };
          for (const [owner, tabs] of Object.entries(restored)) next[owner] = [...tabs, ...(prev[owner] ?? []).filter((t) => !tabs.some((r) => r.id === t.id))];
          return next;
        });
        // 途中で投げても、パネルがシェルを開けるようにする
        setAttached(true);
      }
    };
    // 断られたら一度だけ頼み直す（main が引き継ぎの頼みを受ける前に断られると、動いているシェルが見えないまま残り、
    // 知らせも止まったままになるため）。それでも引き継げなければ、引き継ぐものが無かったとして、ふだんどおりシェルを開けるようにする
    const attach = () => window.tanacode.shell.attach().then((list) => list ?? []);
    attach()
      .catch(attach)
      .then(restore, () => restore([]));
    return () => {
      alive = false;
      offData();
      offExit();
      offOpened();
      observer.disconnect();
    };
  }, []);

  const newShell = useCallback(async (owner: string) => {
    if (creating.current) return;
    creating.current = true;
    let moved = false;
    for (const x of xterms.current.values()) x.element.hidden = true;
    const x = makeXterm();
    x.element.hidden = false;
    x.fit.fit();
    const { term } = x;
    const discard = () => {
      term.dispose();
      x.element.remove();
    };
    try {
      const { id, name } = await window.tanacode.shell.create(owner, term.cols, term.rows);
      // 開いている間にほかのセッションへ移ったら、出さずに止めて片付ける（見えたまま残ると、打った文字が前のフォルダのシェルに届く）。
      // 待っていたコマンド（チャットの「実行」）も、見ていない間には打たない
      if (sessionIdRef.current !== owner) {
        moved = true;
        window.tanacode.shell.kill(id);
        discard();
        pending.current.delete(id);
        if (queued.current?.owner === owner) queued.current = null;
        return;
      }
      attachXterm(id, x);
      followTitle(owner, id, term);
      if (queued.current?.owner === owner) {
        // 見えない制御文字で、見えているコマンドと違うものが動かないようにする
        window.tanacode.shell.write(id, `${stripControlChars(queued.current.command)}\r`);
        queued.current = null;
      }
      setShells((prev) => ({ ...prev, [owner]: [...(prev[owner] ?? []), { id, name, title: null }] }));
      setActive((prev) => ({ ...prev, [owner]: id }));
    } catch {
      // 開けなかった（フォルダが無いなど）。作った xterm を残さない
      discard();
    } finally {
      creating.current = false;
      if (moved) setDiscarded((n) => n + 1);
    }
  }, [makeXterm, attachXterm, followTitle]);

  // 一覧から消した・アーカイブしたセッションと、閉じた新規セッションの画面のフォルダのシェルを、止めて片付ける
  // （xterm を残さない。画面から見えないシェルを、main で動かし続けない）
  useEffect(() => {
    if (!liveOwners) return;
    const live = new Set(liveOwners);
    const gone = Object.keys(shells).filter((owner) => !live.has(owner));
    if (gone.length === 0) return;
    for (const owner of gone) {
      for (const tab of shells[owner]) {
        window.tanacode.shell.kill(tab.id);
        const x = xterms.current.get(tab.id);
        x?.term.dispose();
        x?.element.remove();
        xterms.current.delete(tab.id);
        taskIds.current.delete(tab.id);
        pending.current.delete(tab.id);
      }
    }
    const drop = <T,>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).filter(([owner]) => live.has(owner)));
    setShells(drop);
    setActive(drop);
  }, [liveOwners, shells]);

  // 終わったコマンドのタブを閉じる。pty はもう無いので、画面のタブを片付け、メインプロセスに出力の控え（Claude が読むもの）を捨てさせる
  const closeTask = (id: string) => {
    window.tanacode.shell.kill(id);
    const x = xterms.current.get(id);
    x?.term.dispose();
    x?.element.remove();
    xterms.current.delete(id);
    taskIds.current.delete(id);
    setShells((prev) => Object.fromEntries(Object.entries(prev).map(([owner, list]) => [owner, list.filter((t) => t.id !== id)])));
  };

  // パネルを開き、新しいシェルのタブでコマンドを実行する。パネルが見えてから作る（隠れたままだと大きさを測れない）。
  // パネルを開いたことで「1 つも無ければ開く」が先にシェルを作っても、そちらで実行される
  useRunInTerminal((requested, command) => {
    // null は今見ているもの
    const owner = requested ?? sessionId;
    if (!owner || owner !== sessionId) return false;
    queued.current = { owner, command };
    onOpen();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (queued.current) void newShell(owner);
    }));
    return true;
  });

  // シェルを出すのに 1 つも無ければ開く。フォルダがまだ無ければ、できるまで待つ（無いフォルダではシェルがすぐ終わり、開き直しを繰り返してしまう）。
  // main が持っているターミナルを引き継ぐまでも待つ（引き継ぐものがあるかもしれない）
  // 開いている間に移って片付けたあと（discarded）も、切り替えた先に 1 つも無ければ開く
  useEffect(() => {
    if (attached && open && sessionId && !waiting && tabs.length === 0) void newShell(sessionId);
  }, [attached, open, sessionId, waiting, tabs.length, newShell, discarded]);

  // 表示するシェルだけを出す。選んでいるかどうかも、出しているシェルで読み直す
  // （シェルがまだ無いセッションに切り替えたときに、前のセッションで選んでいた出力の分の「Claude へ送る」を残さない）
  useEffect(() => {
    for (const [id, x] of xterms.current) x.element.hidden = !open || id !== activeShell?.id;
    const x = open && activeShell ? xterms.current.get(activeShell.id) : undefined;
    if (!x) {
      setHasSelection(false);
      return;
    }
    x.fit.fit();
    x.term.focus();
    setHasSelection(x.term.hasSelection());
  }, [open, activeShell, height]);

  const sendSelection = () => {
    const x = activeShell && xterms.current.get(activeShell.id);
    const text = x?.term.getSelection().trimEnd();
    if (!sessionId || !text) return;
    // 出力に ``` があってもコードブロックから抜けないよう、フェンスは中身より長くする
    insertIntoChat(sessionId, codeBlock(text));
  };

  const drag = useRef<{ y: number; height: number } | null>(null);
  const saveHeight = () => writeSharedPref(HEIGHT_KEY, String(height));

  return (
    <div className="terminal-panel" hidden={!open || !sessionId} style={{ height }}>
      <div
        className="terminal-resizer"
        role="separator"
        aria-orientation="horizontal"
        title={t('terminal.panel.resize')}
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
          {tabs.map((tab, i) => (
            <div
              key={tab.id}
              role="tab"
              aria-selected={tab.id === activeShell?.id}
              className={`terminal-tab${tab.id === activeShell?.id ? ' active' : ''}`}
              onClick={() => sessionId && setActive((prev) => ({ ...prev, [sessionId]: tab.id }))}
              title={tab.title ?? tab.name}
            >
              <span>{terminalLabel({ task: !!tab.task, name: tab.name, title: tab.title, exitCode: tab.exitCode ?? null, position: i + 1 })}</span>
              <IconButton
                icon={CloseIcon}
                size="sm"
                label={t('terminal.tabs.close')}
                tip={tab.task && tab.exitCode === undefined ? t('terminal.tabs.stopAndClose') : t('terminal.tabs.close')}
                onClick={(e) => {
                  e.stopPropagation();
                  if (tab.task && tab.exitCode !== undefined) closeTask(tab.id);
                  else {
                    // 動いているコマンドを止めて閉じる。出力を見られるようタブを残すのは、ひとりでに終わったときだけ
                    taskIds.current.delete(tab.id);
                    window.tanacode.shell.kill(tab.id);
                  }
                }}
              />
            </div>
          ))}
          <IconButton
            icon={AddIcon}
            size="sm"
            label={t('terminal.tabs.new')}
            disabled={!!waiting}
            onClick={() => sessionId && void newShell(sessionId)}
          />
        </div>
        <IconButton
          icon={SendIcon}
          label={t('terminal.panel.sendToClaude')}
          tip={t('terminal.panel.sendToClaudeTip')}
          disabled={!hasSelection}
          onClick={sendSelection}
        />
        <IconButton icon={CloseIcon} label={t('terminal.panel.close')} tip={t('terminal.panel.closeTip')} onClick={onClose} />
      </div>
      <div className="terminal-panel-body">
        {waiting && tabs.length === 0 && (
          <div className="terminal-waiting">
            <Busy>{waiting}…</Busy>
          </div>
        )}
        <div className="terminal-host" ref={hostRef} />
      </div>
    </div>
  );
}
