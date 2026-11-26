import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '@shared/i18n';
import type { BrowserMirrorInput, BrowserMirrorTab } from '@shared/ipc';
import { ArrowLeftIcon, ArrowRightIcon, IconButton, ReloadIcon } from '../icons';
import { traffic } from '../remote/mode';
import { normalizeUrl } from './PreviewPane';

// スマホの画面のブラウザ（Issue #464）。Mac のアプリ内ブラウザのタブを映す（ミラーリング）。決めたこと:
// - 開いただけでは映さない。タブだけ出し、「ミラーリング」を押したときだけ、そのタブを映す（間違って開いて通信量を使わないように）
// - 映すのは、このタブを見ていて、画面が前に出ている間だけ（ほかのタブ・セッションへ移った・裏に回ったら止める）
// - 絵は、変わったときだけ届く JPEG。描き終えたら Mac に知らせ、次を受け取る。節約モードは、枚数と画質を下げる
// - 押した・なぞった・打ったものを、Mac のページに送る（押した位置は、絵の中の割合で送る）

type Props = {
  sessionId: string | null;
  // ブラウザのタブを見ているか
  visible: boolean;
};

// なぞったと見なす動き（CSS の px）。これより小さければ押した
const TAP_SLOP = 8;
const MB = 1024 * 1024;

export function RemoteBrowser({ sessionId, visible }: Props) {
  const [tabs, setTabs] = useState<BrowserMirrorTab[] | null>(null);
  const [tabId, setTabId] = useState<string | null>(null);
  const [mirroring, setMirroring] = useState(false);
  const [saver, setSaver] = useState(false);
  const [frame, setFrame] = useState<{ data: string; width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [address, setAddress] = useState('');
  const [text, setText] = useState('');
  const [used, setUsed] = useState(() => traffic());
  const screenRef = useRef<HTMLDivElement>(null);
  // 押し始めた位置と、なぞったか
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  const loadTabs = useCallback(() => {
    if (!sessionId) return;
    void window.tanacode.browser.mirrorTabs(sessionId).then((loaded) => {
      // 返事が無いとき（つなぎ直しの途中など）は、タブが無いものとして扱う
      const list = loaded ?? [];
      setTabs(list);
      setTabId((current) => (current && list.some((tab) => tab.tabId === current) ? current : (list.find((tab) => tab.active) ?? list[0])?.tabId ?? null));
    });
  }, [sessionId]);

  // タブを見たとき・セッションを替えたときに、タブの一覧を読み直す（映すのは押してから）
  useEffect(() => {
    setMirroring(false);
    setFrame(null);
    setTabs(null);
    if (visible) loadTabs();
  }, [visible, sessionId, loadTabs]);

  // 映している間: 絵を受け取り、描き終えたら知らせる。見なくなったら・裏に回ったら止める
  useEffect(() => {
    if (!mirroring || !visible || !sessionId || !tabId) return;
    let alive = true;
    const off = window.tanacode.browser.onMirrorFrame((next) => {
      if (!alive) return;
      if ('stopped' in next) {
        setMirroring(false);
        setFrame(null);
        loadTabs();
        return;
      }
      setFrame(next);
    });
    const box = screenRef.current?.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.round((box?.width || window.innerWidth) * ratio);
    const height = Math.round((box?.height || window.innerHeight) * ratio);
    void window.tanacode.browser.mirrorStart(sessionId, tabId, { width, height, saver }).then((started) => {
      if (!alive || started) return;
      setFailed(true);
      setMirroring(false);
    });
    const hide = () => {
      if (document.visibilityState === 'hidden') setMirroring(false);
    };
    document.addEventListener('visibilitychange', hide);
    const meter = setInterval(() => setUsed(traffic()), 1000);
    return () => {
      alive = false;
      off();
      clearInterval(meter);
      document.removeEventListener('visibilitychange', hide);
      void window.tanacode.browser.mirrorStop();
    };
  }, [mirroring, visible, sessionId, tabId, saver, loadTabs]);

  const tab = tabs?.find((item) => item.tabId === tabId) ?? null;
  useEffect(() => setAddress(tab?.url ?? ''), [tab?.url]);

  if (!sessionId) return null;

  const send = (input: BrowserMirrorInput) => window.tanacode.browser.mirrorInput(input);
  const navigate = (navigation: Parameters<typeof window.tanacode.browser.mirrorNavigate>[2]) => {
    if (!tabId) return;
    void window.tanacode.browser.mirrorNavigate(sessionId, tabId, navigation).then(() => loadTabs());
  };

  // 押した・なぞった位置を、絵の中の割合にする
  const position = (clientX: number, clientY: number) => {
    const box = screenRef.current?.querySelector('img')?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return null;
    const clamp = (n: number) => Math.min(1, Math.max(0, n));
    return { x: clamp((clientX - box.left) / box.width), y: clamp((clientY - box.top) / box.height), width: box.width, height: box.height };
  };

  return (
    <section className="remote-browser">
      <div className="remote-browser-bar">
        <select aria-label={t('mobile.mirror.tab')} value={tabId ?? ''} disabled={!tabs || tabs.length === 0} onChange={(e) => setTabId(e.target.value || null)}>
          {(tabs ?? []).map((item) => (
            <option key={item.tabId} value={item.tabId}>
              {item.title || item.url || t('mobile.mirror.untitled')}
            </option>
          ))}
        </select>
        {mirroring && (
          <button type="button" className="ghost-button" onClick={() => setMirroring(false)}>
            {t('mobile.mirror.stop')}
          </button>
        )}
      </div>
      {mirroring && (
        <form
          className="remote-browser-nav"
          onSubmit={(e) => {
            e.preventDefault();
            const url = normalizeUrl(address);
            if (url) navigate({ kind: 'open', url });
          }}
        >
          <IconButton icon={ArrowLeftIcon} label={t('common.back')} onClick={() => navigate({ kind: 'back' })} />
          <IconButton icon={ArrowRightIcon} label={t('preview.toolbar.forward')} onClick={() => navigate({ kind: 'forward' })} />
          <IconButton icon={ReloadIcon} label={t('preview.toolbar.reload')} onClick={() => navigate({ kind: 'reload' })} />
          <input aria-label={t('preview.toolbar.address')} value={address} inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => setAddress(e.target.value)} />
        </form>
      )}
      <div className="remote-browser-screen" ref={screenRef}>
        {!mirroring && (
          <div className="remote-browser-start">
            {tabs && tabs.length === 0 ? (
              <p>{t('mobile.mirror.noTabs')}</p>
            ) : (
              <>
                <button
                  type="button"
                  className="send-button"
                  disabled={!tabId}
                  onClick={() => {
                    setFailed(false);
                    setMirroring(true);
                  }}
                >
                  {t('mobile.mirror.start')}
                </button>
                <p>{failed ? t('mobile.mirror.failed') : t('mobile.mirror.note')}</p>
              </>
            )}
          </div>
        )}
        {mirroring && frame && (
          <img
            alt={tab?.title ?? ''}
            src={`data:image/jpeg;base64,${frame.data}`}
            draggable={false}
            onLoad={() => window.tanacode.browser.mirrorDone()}
            onPointerDown={(e) => {
              drag.current = { x: e.clientX, y: e.clientY, moved: false };
            }}
            onPointerMove={(e) => {
              const start = drag.current;
              if (!start) return;
              const dx = e.clientX - start.x;
              const dy = e.clientY - start.y;
              if (!start.moved && Math.hypot(dx, dy) < TAP_SLOP) return;
              const at = position(start.x, start.y);
              if (!at) return;
              // なぞった向きと逆に送る（指で下へなぞると、ページは上へ戻る）
              send({ type: 'scroll', x: at.x, y: at.y, deltaX: -dx / at.width, deltaY: -dy / at.height });
              drag.current = { x: e.clientX, y: e.clientY, moved: true };
            }}
            onPointerUp={(e) => {
              const start = drag.current;
              drag.current = null;
              if (!start || start.moved) return;
              const at = position(e.clientX, e.clientY);
              if (at) send({ type: 'tap', x: at.x, y: at.y });
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
          />
        )}
      </div>
      {mirroring && (
        <div className="remote-browser-input">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!text) return;
              send({ type: 'text', text });
              setText('');
            }}
          >
            <input aria-label={t('mobile.mirror.text')} placeholder={t('mobile.mirror.text')} value={text} onChange={(e) => setText(e.target.value)} />
            <button type="submit" className="send-button">
              {t('mobile.keys.send')}
            </button>
          </form>
          <div className="remote-browser-keys">
            {(['Enter', 'Backspace', 'Tab', 'Escape'] as const).map((key) => (
              <button key={key} type="button" onClick={() => send({ type: 'key', key })}>
                {t(`mobile.mirror.key.${key}`)}
              </button>
            ))}
            <label className="remote-browser-saver">
              <input type="checkbox" checked={saver} onChange={(e) => setSaver(e.target.checked)} />
              {t('mobile.mirror.saver')}
            </label>
          </div>
          <p className="remote-browser-traffic">{t('mobile.mirror.traffic', { session: (used.session / MB).toFixed(1), today: (used.today / MB).toFixed(1) })}</p>
        </div>
      )}
    </section>
  );
}
