import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BrowserActivity, BrowserAnswer, BrowserAsk, BrowserRect } from '@shared/ipc';
import { insertIntoChat } from '../chat/insertInput';
import { Busy } from '../layout/Busy';
import { AddIcon, ArrowLeftIcon, ArrowRightIcon, CloseIcon, CodeIcon, ExternalLinkIcon, IconButton, PointerIcon, ReloadIcon, StopIcon, WarningIcon } from '../icons';
import { codeBlock } from '../chat/sanitize';
import { CANCEL_PICKER_SCRIPT, describePicked, pickerScript, type PickedElement } from './picker';

// Electron の <webview> のうち、ここで使うもの
type Webview = HTMLElement & {
  src: string;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  getURL(): string;
  focus(): void;
  openDevTools(): void;
  getWebContentsId(): number;
  executeJavaScript<T>(code: string, userGesture?: boolean): Promise<T>;
  capturePage(rect?: { x: number; y: number; width: number; height: number }): Promise<{ isEmpty(): boolean; toDataURL(): string }>;
};

type PageState = {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  // 読み込めなかったとき（サーバーが止まっているなど）
  error: string | null;
  consoleErrors: string[];
};

const PARTITION = 'persist:tanacode-preview';
const MAX_CONSOLE_ERRORS = 50;
const WIDTHS = [
  { value: 0, label: '全幅' },
  { value: 390, label: 'スマホ' },
  { value: 768, label: 'タブレット' },
];
const EMPTY_PAGE: PageState = { url: '', title: '', loading: false, canGoBack: false, canGoForward: false, error: null, consoleErrors: [] };

type Props = {
  // 見せるセッション（選んでいるセッション。無ければ null）
  sessionId: string | null;
  visible: boolean;
  // 今あるセッション（アーカイブしていないもの）。消えたセッションのタブは閉じる
  liveSessionIds: readonly string[];
  onClose: () => void;
};

// Claude がそのセッションのブラウザを操作している様子（main の browser-control から）
type ClaudeActivity = Omit<BrowserActivity, 'sessionId'>;

export function normalizeUrl(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  // 「localhost:3000」の localhost: はスキームではない。// が続くときだけスキームが付いているとみなす
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

let tabSeq = 0;

// 開発中のページをアプリの中で開く。セッションごとにタブ（webview）を持ち、切り替えても読み込み直さない。
// ページが新しいウィンドウで開くもの（target=_blank・window.open）は、同じセッションの新しいタブで開く（main が知らせてくる）。
// Claude が操作したセッションの今のタブは、見ていない間も描かせたままにする（display: none だと大きさが 0 になり、撮れず、押せない）。
// 透明にして画面の後ろに置き、ブラウザを開いたときと同じ大きさで描かせる
export function PreviewPane({ sessionId, visible, liveSessionIds, onClose }: Props) {
  const paneRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  // タブの ID → webview
  const views = useRef(new Map<string, Webview>());
  // セッションごとのタブ（並び順）と、今のタブ。購読の中からも読むので ref に持ち、変えたら描き直す
  const tabsRef = useRef(new Map<string, string[]>());
  const activeRef = useRef(new Map<string, string>());
  const [, setVersion] = useState(0);
  const rerender = () => setVersion((v) => v + 1);
  // タブの ID → ページの様子
  const [pages, setPages] = useState<Record<string, PageState>>({});
  const [picking, setPicking] = useState(false);
  // セッションごとの表示幅（0 は全幅）。Claude も変える
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [claude, setClaude] = useState<Record<string, ClaudeActivity>>({});
  // Claude がユーザーに頼んでいる操作（ask_user_to_act）
  const [asks, setAsks] = useState<Record<string, BrowserAsk>>({});
  // Claude が操作したことのあるセッション。見ていない間も今のタブを描かせておく
  const [operated, setOperated] = useState<ReadonlySet<string>>(() => new Set());
  // 見ていない間の大きさ（ブラウザを開いたときの場所の大きさ）
  const [offstageSize, setOffstageSize] = useState<{ width: number; height: number } | null>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const sessionTabs = sessionId ? (tabsRef.current.get(sessionId) ?? []) : [];
  const activeTab = sessionId ? (activeRef.current.get(sessionId) ?? null) : null;
  const page = activeTab ? pages[activeTab] : undefined;
  // 空のタブ（「＋」で開いたもの）は、まだ何も開いていないのと同じに扱う
  const url = page?.url && page.url !== 'about:blank' ? page.url : null;
  const [address, setAddress] = useState(url ?? '');
  const width = sessionId ? (widths[sessionId] ?? 0) : 0;
  const activity = sessionId ? claude[sessionId] : undefined;
  const ask = sessionId ? asks[sessionId] : undefined;

  const update = (tabId: string, patch: Partial<PageState>) =>
    setPages((prev) => ({ ...prev, [tabId]: { ...(prev[tabId] ?? EMPTY_PAGE), ...patch } }));

  // 今のタブを変えて、main に知らせる（Claude の操作は今のタブに対して行う）
  const activate = (sid: string, tabId: string | null) => {
    if (tabId) activeRef.current.set(sid, tabId);
    else activeRef.current.delete(sid);
    window.tanacode.browser.activate(sid, tabId);
    rerender();
  };

  // タブを開く。url が null なら空のタブ。いつも右端に足す（タブの番号を、Claude の list_tabs と同じ並びにする）
  const openTab = (sid: string, url: string | null, options: { activate?: boolean } = {}) => {
    const tabId = `tab-${++tabSeq}`;
    const wv = document.createElement('webview') as Webview;
    wv.setAttribute('partition', PARTITION);
    // allowpopups が無いと、新しいウィンドウで開くもの（target=_blank・window.open）は main に届かずに捨てられる。
    // 届いたものは、main がウィンドウを作らずに新しいタブで開かせる（setWindowOpenHandler）
    wv.setAttribute('allowpopups', '');
    wv.className = 'preview-webview';
    const sync = () => update(tabId, { url: wv.getURL(), canGoBack: wv.canGoBack(), canGoForward: wv.canGoForward() });
    // 中身（webContents）ができたら main に知らせる。Claude の操作は、main がこれを直接動かす。
    // getWebContentsId は dom-ready の前に呼ぶと例外になる。ページを移るたびに届くが、main は同じ中身なら何もしない
    wv.addEventListener('dom-ready', () => {
      if (typeof wv.getWebContentsId === 'function') window.tanacode.browser.attach(sid, tabId, wv.getWebContentsId());
    });
    wv.addEventListener('did-start-loading', () => update(tabId, { loading: true, error: null }));
    wv.addEventListener('did-stop-loading', () => {
      update(tabId, { loading: false });
      sync();
    });
    wv.addEventListener('did-navigate', sync);
    wv.addEventListener('did-navigate-in-page', sync);
    wv.addEventListener('page-title-updated', (e) => update(tabId, { title: (e as unknown as { title: string }).title }));
    wv.addEventListener('did-fail-load', (e) => {
      const { errorCode, errorDescription, isMainFrame, validatedURL } = e as unknown as {
        errorCode: number;
        errorDescription: string;
        isMainFrame: boolean;
        validatedURL: string;
      };
      // -3 は別のページへ移ったための中断
      if (isMainFrame && errorCode !== -3) update(tabId, { error: `${validatedURL} を読み込めませんでした（${errorDescription}）`, loading: false });
    });
    wv.addEventListener('console-message', (e) => {
      const { level, message, sourceId, line } = e as unknown as { level: number | string; message: string; sourceId?: string; line?: number };
      if (level !== 3 && level !== 'error') return;
      const where = sourceId ? ` (${sourceId.replace(/^https?:\/\/[^/]+/, '') || sourceId}${line ? `:${line}` : ''})` : '';
      setPages((prev) => {
        const current = prev[tabId];
        if (!current) return prev;
        return { ...prev, [tabId]: { ...current, consoleErrors: [...current.consoleErrors, message + where].slice(-MAX_CONSOLE_ERRORS) } };
      });
    });
    wv.src = url ?? 'about:blank';
    views.current.set(tabId, wv);
    update(tabId, { url: url ?? '', loading: !!url });
    tabsRef.current.set(sid, [...(tabsRef.current.get(sid) ?? []), tabId]);
    hostRef.current!.appendChild(wv);
    if (options.activate !== false || !activeRef.current.has(sid)) activate(sid, tabId);
    else rerender();
    return tabId;
  };

  // タブを閉じる。今のタブなら、右（無ければ左）のタブに移る
  const closeTab = (sid: string, tabId: string) => {
    const list = tabsRef.current.get(sid) ?? [];
    const index = list.indexOf(tabId);
    if (index < 0) return;
    views.current.get(tabId)?.remove();
    views.current.delete(tabId);
    setPages((prev) => {
      const { [tabId]: _, ...rest } = prev;
      return rest;
    });
    const next = list.filter((id) => id !== tabId);
    if (next.length > 0) tabsRef.current.set(sid, next);
    else tabsRef.current.delete(sid);
    if (activeRef.current.get(sid) === tabId) activate(sid, next[Math.min(index, next.length - 1)] ?? null);
    else rerender();
  };

  const closeSession = (sid: string) => {
    for (const tabId of [...(tabsRef.current.get(sid) ?? [])]) closeTab(sid, tabId);
  };

  // main からの知らせ: Claude の操作の様子・表示幅・タブを開く／選ぶ／閉じる
  useEffect(() => {
    const offs = [
      window.tanacode.browser.onActivity(({ sessionId: id, ...rest }) => {
        setClaude((prev) => ({ ...prev, [id]: rest }));
        if (rest.active) setOperated((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
      }),
      window.tanacode.browser.onViewport(({ sessionId: id, width: w }) => setWidths((prev) => ({ ...prev, [id]: w }))),
      // Claude が、まだタブの無いセッションでページを開く
      window.tanacode.browser.onOpen(({ sessionId: id, url: next }) => {
        const current = activeRef.current.get(id);
        const wv = current ? views.current.get(current) : undefined;
        if (wv) wv.src = next;
        else openTab(id, next);
      }),
      // ページが新しいウィンドウで開こうとした（target=_blank・window.open）か、Claude が新しいタブで開く
      window.tanacode.browser.onNewTab(({ sessionId: id, url: next, background }) => openTab(id, next, { activate: !background })),
      window.tanacode.browser.onSelectTab(({ sessionId: id, tabId }) => {
        if (tabsRef.current.get(id)?.includes(tabId)) activate(id, tabId);
      }),
      window.tanacode.browser.onCloseTab(({ sessionId: id, tabId }) => closeTab(id, tabId)),
      window.tanacode.browser.onAsk(({ sessionId: id, ask: next }) =>
        setAsks((prev) => {
          if (next) return { ...prev, [id]: next };
          const { [id]: _, ...rest } = prev;
          return rest;
        }),
      ),
    ];
    // 画面を作り直したとき（ウィンドウを閉じて開き直した）も、頼まれている操作の帯を出す
    void window.tanacode.browser.asks().then((list) =>
      setAsks((prev) => ({ ...Object.fromEntries(list.flatMap((c) => (c.ask ? [[c.sessionId, c.ask]] : []))), ...prev })),
    );
    return () => offs.forEach((off) => off());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 消した・アーカイブしたセッションのタブは閉じる
  const liveKey = liveSessionIds.join(',');
  useEffect(() => {
    const live = new Set(liveSessionIds);
    for (const sid of [...tabsRef.current.keys()]) if (!live.has(sid)) closeSession(sid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveKey]);

  // 見せるセッションの今のタブだけを出す。Claude が操作したセッションの今のタブは、透明にして描かせたままにする。
  // 描く前に決める（裏で開いたタブが、一瞬見えないように）
  useLayoutEffect(() => {
    for (const [sid, list] of tabsRef.current) {
      const current = activeRef.current.get(sid);
      for (const tabId of list) {
        const wv = views.current.get(tabId);
        if (!wv) continue;
        const shown = visible && sid === sessionId && tabId === current;
        const background = !shown && tabId === current && operated.has(sid);
        const w = widths[sid] ?? 0;
        Object.assign(wv.style, {
          display: shown || background ? '' : 'none',
          opacity: background ? '0' : '',
          pointerEvents: background ? 'none' : '',
          zIndex: background ? '-1' : '',
          // ほかのセッションの表示幅は、そのセッションのもの（見せているセッションは枠の幅に合わせる）
          width: background && sid !== sessionId && w ? `${w}px` : '',
        });
      }
    }
  });

  // 見ていない間の大きさを、ブラウザを開いたときの場所（中央の列）に合わせる
  const offstage = !visible && [...operated].some((sid) => activeRef.current.has(sid));
  useEffect(() => {
    const parent = paneRef.current?.parentElement;
    if (!offstage || !parent) return;
    const measure = () => setOffstageSize({ width: parent.clientWidth, height: parent.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [offstage]);

  useEffect(() => setAddress(url ?? ''), [sessionId, activeTab, url]);

  // まだ何も開いていなければ（空のタブも）、すぐ URL を貼れるようにアドレス欄にカーソルを置く
  useEffect(() => {
    if (visible && !url) addressRef.current?.focus();
  }, [visible, url, sessionId, activeTab]);

  // セッションやタブを切り替えたり閉じたりしたら、要素選びをやめる
  useEffect(() => {
    if (picking) cancelPick();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, sessionId, activeTab]);

  const current = () => (activeTab ? views.current.get(activeTab) : undefined);

  const go = (input: string) => {
    const next = normalizeUrl(input);
    if (!next || !sessionId) return;
    const wv = current();
    if (wv) wv.src = next;
    else openTab(sessionId, next);
  };

  const newTab = () => {
    if (!sessionId) return;
    openTab(sessionId, null);
    addressRef.current?.focus();
  };

  const cancelPick = () => {
    setPicking(false);
    for (const wv of views.current.values()) void wv.executeJavaScript(CANCEL_PICKER_SCRIPT).catch(() => undefined);
  };

  const pick = async () => {
    const wv = current();
    if (!wv || !sessionId) return;
    if (picking) {
      cancelPick();
      return;
    }
    setPicking(true);
    wv.focus();
    const id = sessionId;
    try {
      const picked = await wv.executeJavaScript<PickedElement | null>(pickerScript(), true);
      if (!picked) return;
      const attachments: string[] = [];
      const shot = await capture(wv, picked).catch(() => null);
      if (shot) attachments.push(shot);
      insertIntoChat(id, describePicked(picked), attachments);
    } finally {
      setPicking(false);
    }
  };

  const sendErrors = () => {
    if (!page || !activeTab || !sessionId || page.consoleErrors.length === 0) return;
    // エラーの文はページが書けるので、中に ``` があってもブロックから抜けないようにする
    insertIntoChat(sessionId, `アプリ内ブラウザ（${page.url}）のコンソールに出たエラー:\n${codeBlock(page.consoleErrors.join('\n'))}\n`);
    update(activeTab, { consoleErrors: [] });
  };

  const wv = current();
  const shown = !!url && !!wv;

  return (
    <div
      ref={paneRef}
      className={`preview-pane${offstage ? ' offstage' : ''}`}
      hidden={!visible && !offstage}
      aria-hidden={!visible}
      style={offstage && offstageSize ? { width: offstageSize.width, height: offstageSize.height } : undefined}
    >
      {sessionId && sessionTabs.length > 0 && (
        <TabStrip
          tabs={sessionTabs.map((id) => ({ id, title: pages[id]?.title ?? '', url: pages[id]?.url ?? '', loading: pages[id]?.loading ?? false }))}
          active={activeTab}
          onSelect={(tabId) => activate(sessionId, tabId)}
          onClose={(tabId) => closeTab(sessionId, tabId)}
          onNew={newTab}
        />
      )}
      <div className="preview-toolbar">
        <IconButton icon={ArrowLeftIcon} label="戻る" disabled={!page?.canGoBack} onClick={() => wv?.goBack()} />
        <IconButton icon={ArrowRightIcon} label="進む" disabled={!page?.canGoForward} onClick={() => wv?.goForward()} />
        <IconButton
          icon={page?.loading ? StopIcon : ReloadIcon}
          label={page?.loading ? '読み込みを止める' : '読み込み直す'}
          disabled={!shown}
          onClick={() => (page?.loading ? wv?.stop() : wv?.reload())}
        />
        <form
          className="preview-address"
          onSubmit={(e) => {
            e.preventDefault();
            go(address);
          }}
        >
          <input
            ref={addressRef}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onFocus={(e) => e.target.select()}
            placeholder="http://localhost:3000"
            spellCheck={false}
            aria-label="開く URL"
          />
        </form>
        <select
          className="preview-width"
          value={width}
          onChange={(e) => sessionId && setWidths((prev) => ({ ...prev, [sessionId]: Number(e.target.value) }))}
          title="表示幅"
        >
          {WIDTHS.map((w) => (
            <option key={w.value} value={w.value}>
              {w.label}
            </option>
          ))}
        </select>
        <IconButton
          icon={PointerIcon}
          label={picking ? '選ぶのをやめる' : '要素を選ぶ'}
          tip={picking ? undefined : 'ページの要素をクリックして、その情報と画像をチャットの入力欄に添える'}
          pressed={picking}
          disabled={!shown}
          onClick={() => void pick()}
        />
        {page && page.consoleErrors.length > 0 && (
          <button
            className="ghost-button preview-errors"
            onClick={sendErrors}
            aria-label={`エラー ${page.consoleErrors.length} 件`}
            data-tip={`クリックで、コンソールのエラーをチャットの入力欄に貼る\n\n${page.consoleErrors.slice(-5).join('\n')}`}
          >
            <WarningIcon size={14} />
            {page.consoleErrors.length}
          </button>
        )}
        <IconButton
          icon={ExternalLinkIcon}
          label="ふだんのブラウザで開く"
          disabled={!shown}
          onClick={() => url && void window.tanacode.browser.openExternal(url)}
        />
        <IconButton icon={CodeIcon} label="開発者ツール" disabled={!shown} onClick={() => wv?.openDevTools()} />
        <IconButton icon={CloseIcon} label="ブラウザを閉じる" onClick={onClose} />
      </div>
      {ask && sessionId ? (
        <AskBar key={ask.id} message={ask.message} onAnswer={(answer) => window.tanacode.browser.answer(sessionId, ask.id, answer)} />
      ) : (
        activity?.active && <ClaudeBar label={activity.label} />
      )}
      {picking && <div className="preview-hint">ページの要素をクリックしてください（Esc でやめる）</div>}
      {page?.error && (
        <div className="preview-hint error">
          <span>{page.error}</span>
          <IconButton icon={ReloadIcon} label="もう一度" onClick={() => wv?.reload()} />
        </div>
      )}
      <div className={`preview-body${width ? ' framed' : ''}`} style={{ '--preview-width': width ? `${width}px` : '100%' } as React.CSSProperties}>
        <div className="preview-frame" ref={hostRef}>
          {activity?.box && visible && <ClickBox rect={activity.box} />}
        </div>
        {!url && (
          <div className="preview-empty">
            <p>上のアドレス欄に URL を入れて Enter で開きます</p>
          </div>
        )}
      </div>
    </div>
  );
}

type TabInfo = { id: string; title: string; url: string; loading: boolean };

// ブラウザのタブの並び。中ボタンのクリックでも閉じる
export function TabStrip({
  tabs,
  active,
  onSelect,
  onClose,
  onNew,
}: {
  tabs: TabInfo[];
  active: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <div className="preview-tabs" role="tablist" aria-label="ブラウザのタブ">
      {tabs.map((tab) => {
        const label = tab.title || (tab.url && tab.url !== 'about:blank' ? tab.url.replace(/^https?:\/\//, '') : '新しいタブ');
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.id === active}
            className={`preview-tab reveal-host${tab.id === active ? ' active' : ''}`}
            title={tab.url && tab.url !== 'about:blank' ? `${tab.title ? `${tab.title}\n` : ''}${tab.url}` : undefined}
            onMouseDown={(e) => {
              if (e.button === 0) onSelect(tab.id);
            }}
            onAuxClick={(e) => {
              if (e.button === 1) onClose(tab.id);
            }}
          >
            {tab.loading && <span className="tool-dot running" />}
            <span className="preview-tab-title">{label}</span>
            <IconButton icon={CloseIcon} size="sm" reveal label="タブを閉じる" onMouseDown={(e) => e.stopPropagation()} onClick={() => onClose(tab.id)} />
          </div>
        );
      })}
      <IconButton icon={AddIcon} size="sm" className="preview-tab-new" label="新しいタブ" onClick={onNew} />
    </div>
  );
}

// 「Claude が操作中」の帯。label: 今の操作（スクリーンショット・クリックなど）
export function ClaudeBar({ label }: { label: string | null }) {
  return (
    <div className="preview-claude" role="status">
      <Busy>Claude が操作中</Busy>
      {label && <span className="preview-claude-label">{label}</span>}
    </div>
  );
}

// 「あなたの番です」の帯。Claude がユーザーに頼んだ操作（ask_user_to_act）と、「終わった」「できない」のボタン。
// 「できない」は、ひとこと理由を書いて送る（書かなくてもよい）。押すまで、Claude はブラウザを使わずに待っている
export function AskBar({ message, onAnswer }: { message: string; onAnswer: (answer: BrowserAnswer) => void }) {
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  return (
    <div className="preview-ask" role="region" aria-label="Claude からの操作の依頼">
      <div className="preview-ask-text" role="status">
        <span className="preview-ask-title">あなたの番です</span>
        <span className="preview-ask-message">{message}</span>
      </div>
      {declining ? (
        <form
          className="preview-ask-actions"
          onSubmit={(e) => {
            e.preventDefault();
            onAnswer({ done: false, reason: reason.trim() });
          }}
        >
          <input
            className="preview-ask-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Escape') setDeclining(false);
            }}
            placeholder="理由（任意・パスワードは書かない）"
            aria-label="できない理由"
            autoFocus
          />
          <button type="submit" className="send-button">
            送る
          </button>
          <button type="button" className="ghost-button" onClick={() => setDeclining(false)}>
            戻る
          </button>
        </form>
      ) : (
        <div className="preview-ask-actions">
          <button className="send-button" onClick={() => onAnswer({ done: true, reason: '' })}>
            終わった
          </button>
          <button className="ghost-button" onClick={() => setDeclining(true)}>
            できない
          </button>
        </div>
      )}
    </div>
  );
}

// Claude がこれから押す要素の枠（ページの上に重ねる。ページの中には描かない）
export function ClickBox({ rect }: { rect: BrowserRect }) {
  return <div className="preview-click-box" style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }} />;
}

// 選んだ要素のまわりを切り出して画像にし、添付として保存する
async function capture(wv: Webview, picked: PickedElement): Promise<string | null> {
  const pad = 8;
  const x = Math.max(0, Math.floor(picked.rect.x - pad));
  const y = Math.max(0, Math.floor(picked.rect.y - pad));
  const width = Math.min(picked.viewport.width - x, Math.ceil(picked.rect.width + pad * 2));
  const height = Math.min(picked.viewport.height - y, Math.ceil(picked.rect.height + pad * 2));
  if (width <= 0 || height <= 0) return null;
  const image = await wv.capturePage({ x, y, width, height });
  if (image.isEmpty()) return null;
  const base64 = image.toDataURL().split(',')[1] ?? '';
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return window.tanacode.attachments.save('preview-element.png', bytes);
}
