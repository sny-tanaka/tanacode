import { useEffect, useRef, useState } from 'react';
import { insertIntoChat } from '../chat/insertInput';
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
  executeJavaScript<T>(code: string, userGesture?: boolean): Promise<T>;
  capturePage(rect?: { x: number; y: number; width: number; height: number }): Promise<{ isEmpty(): boolean; toDataURL(): string }>;
};

type PageState = {
  url: string;
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

type Props = {
  sessionId: string;
  visible: boolean;
  // このセッションで開いているページ（まだ開いていなければ null）
  url: string | null;
  onNavigate: (url: string) => void;
  onClose: () => void;
};

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

// 開発中のページをアプリの中で開く。セッションごとに webview を持ち、切り替えても読み込み直さない
export function PreviewPane({ sessionId, visible, url, onNavigate, onClose }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const views = useRef(new Map<string, Webview>());
  const [pages, setPages] = useState<Record<string, PageState>>({});
  const [address, setAddress] = useState(url ?? '');
  const [picking, setPicking] = useState(false);
  const [width, setWidth] = useState(0);
  const addressRef = useRef<HTMLInputElement>(null);
  const page = pages[sessionId];

  const update = (id: string, patch: Partial<PageState>) =>
    setPages((prev) => {
      const base = prev[id] ?? { url: '', loading: false, canGoBack: false, canGoForward: false, error: null, consoleErrors: [] };
      return { ...prev, [id]: { ...base, ...patch } };
    });

  // セッションの webview を用意し、表示するものだけを出す
  useEffect(() => {
    if (url && !views.current.has(sessionId)) {
      const id = sessionId;
      const wv = document.createElement('webview') as Webview;
      wv.setAttribute('partition', PARTITION);
      wv.className = 'preview-webview';
      const sync = () =>
        update(id, { url: wv.getURL(), canGoBack: wv.canGoBack(), canGoForward: wv.canGoForward() });
      wv.addEventListener('did-start-loading', () => update(id, { loading: true, error: null }));
      wv.addEventListener('did-stop-loading', () => {
        update(id, { loading: false });
        sync();
      });
      wv.addEventListener('did-navigate', sync);
      wv.addEventListener('did-navigate-in-page', sync);
      wv.addEventListener('did-fail-load', (e) => {
        const { errorCode, errorDescription, isMainFrame, validatedURL } = e as unknown as {
          errorCode: number;
          errorDescription: string;
          isMainFrame: boolean;
          validatedURL: string;
        };
        // -3 は別のページへ移ったための中断
        if (isMainFrame && errorCode !== -3) update(id, { error: `${validatedURL} を読み込めませんでした（${errorDescription}）`, loading: false });
      });
      wv.addEventListener('console-message', (e) => {
        const { level, message, sourceId, line } = e as unknown as { level: number | string; message: string; sourceId?: string; line?: number };
        if (level !== 3 && level !== 'error') return;
        const where = sourceId ? ` (${sourceId.replace(/^https?:\/\/[^/]+/, '') || sourceId}${line ? `:${line}` : ''})` : '';
        setPages((prev) => {
          const current = prev[id];
          if (!current) return prev;
          return { ...prev, [id]: { ...current, consoleErrors: [...current.consoleErrors, message + where].slice(-MAX_CONSOLE_ERRORS) } };
        });
      });
      wv.src = url;
      views.current.set(id, wv);
      update(id, { url, loading: true });
      hostRef.current!.appendChild(wv);
    }
    for (const [id, wv] of views.current) wv.style.display = id === sessionId ? '' : 'none';
  }, [sessionId, url]);

  // 開く URL が変わったら移る（アドレス欄や見つけたサーバーから）
  useEffect(() => {
    const wv = views.current.get(sessionId);
    if (wv && url && url !== pages[sessionId]?.url && url !== wv.src) wv.src = url;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  useEffect(() => setAddress(page?.url || url || ''), [sessionId, page?.url, url]);

  // まだ何も開いていなければ、すぐ URL を貼れるようにアドレス欄にカーソルを置く
  useEffect(() => {
    if (visible && !url) addressRef.current?.focus();
  }, [visible, url, sessionId]);

  // セッションを切り替えたり閉じたりしたら、要素選びをやめる
  useEffect(() => {
    if (picking && !visible) cancelPick();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, sessionId]);

  const current = () => views.current.get(sessionId);

  const go = (input: string) => {
    const next = normalizeUrl(input);
    if (!next) return;
    onNavigate(next);
    const wv = current();
    if (wv) wv.src = next;
  };

  const cancelPick = () => {
    setPicking(false);
    for (const wv of views.current.values()) void wv.executeJavaScript(CANCEL_PICKER_SCRIPT).catch(() => undefined);
  };

  const pick = async () => {
    const wv = current();
    if (!wv) return;
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
    if (!page || page.consoleErrors.length === 0) return;
    // エラーの文はページが書けるので、中に ``` があってもブロックから抜けないようにする
    insertIntoChat(sessionId, `アプリ内ブラウザ（${page.url}）のコンソールに出たエラー:\n${codeBlock(page.consoleErrors.join('\n'))}\n`);
    update(sessionId, { consoleErrors: [] });
  };

  const wv = current();
  const shown = !!url && !!wv;

  return (
    <div className="preview-pane" hidden={!visible}>
      <div className="preview-toolbar">
        <button className="preview-nav" disabled={!page?.canGoBack} onClick={() => wv?.goBack()} data-tip="戻る" aria-label="戻る">
          ←
        </button>
        <button className="preview-nav" disabled={!page?.canGoForward} onClick={() => wv?.goForward()} data-tip="進む" aria-label="進む">
          →
        </button>
        <button
          className="preview-nav"
          disabled={!shown}
          onClick={() => (page?.loading ? wv?.stop() : wv?.reload())}
          data-tip={page?.loading ? '読み込みを止める' : '読み込み直す'}
          aria-label={page?.loading ? '読み込みを止める' : '読み込み直す'}
        >
          {page?.loading ? '×' : '↻'}
        </button>
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
        <select className="preview-width" value={width} onChange={(e) => setWidth(Number(e.target.value))} title="表示幅">
          {WIDTHS.map((w) => (
            <option key={w.value} value={w.value}>
              {w.label}
            </option>
          ))}
        </select>
        <button className={`ghost-button${picking ? ' on' : ''}`} disabled={!shown} onClick={() => void pick()} title="ページの要素をクリックして、その情報と画像をチャットの入力欄に添える">
          {picking ? '選ぶのをやめる' : '要素を選ぶ'}
        </button>
        {page && page.consoleErrors.length > 0 && (
          <button className="ghost-button preview-errors" onClick={sendErrors} title={`クリックで、コンソールのエラーをチャットの入力欄に貼る\n\n${page.consoleErrors.slice(-5).join('\n')}`}>
            エラー {page.consoleErrors.length} 件
          </button>
        )}
        <button className="preview-nav" disabled={!shown} onClick={() => wv?.openDevTools()} data-tip="開発者ツール" aria-label="開発者ツール">
          ⚙
        </button>
        <button className="preview-nav" onClick={onClose} data-tip="ブラウザを閉じる" aria-label="ブラウザを閉じる">
          ✕
        </button>
      </div>
      {picking && <div className="preview-hint">ページの要素をクリックしてください（Esc でやめる）</div>}
      {page?.error && (
        <div className="preview-hint error">
          <span>{page.error}</span>
          <button className="ghost-button" onClick={() => wv?.reload()}>
            もう一度
          </button>
        </div>
      )}
      <div className={`preview-body${width ? ' framed' : ''}`} style={{ '--preview-width': width ? `${width}px` : '100%' } as React.CSSProperties}>
        <div className="preview-frame" ref={hostRef} />
        {!url && (
          <div className="preview-empty">
            <p>上のアドレス欄に URL を入れて Enter で開きます</p>
          </div>
        )}
      </div>
    </div>
  );
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
