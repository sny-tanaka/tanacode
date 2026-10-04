import { useCallback, useEffect, useRef, useState } from 'react';
import logo from '../../assets/logo.png';
import { CloseIcon } from '../../icons';
import { TOUR_INFO, type TourInfo } from '../tourInfo';
import { isStageMessage, type Phase, type ShellMessage, STAGE, stageUrl } from './messages';

// デモのサイトの親のページ。上の帯（機能一覧・説明・再生の操作）と、アプリの画面を描く iframe。
// アプリの画面は iframe の中で決まった大きさのまま描き（app.tsx）、ここでは iframe ごと縮小して画面に収めるだけにする。
// ツアーを選ぶと、iframe の中で台本どおりに作り物のカーソルが動き、帯に操作の説明が出る。終わったら、そのまま自由に触れる

const REPO = 'https://github.com/sny-tanaka/tanacode';

function captionFor(phase: Phase, caption: string): string {
  switch (phase) {
    case 'playing':
      return caption || '準備しています…';
    case 'done':
      return 'ツアーが終わりました。このまま自由に触れます';
    case 'failed':
      return 'ツアーが途中で止まりました。このまま自由に触れます';
    case 'free':
      return '自由に触れます。チャットに送っても、本物の Claude には繋がりません';
  }
}

export function DemoSite({ tour }: { tour: TourInfo | null }) {
  const [phase, setPhase] = useState<Phase>(tour ? 'playing' : 'free');
  const [caption, setCaption] = useState('');
  const [paused, setPaused] = useState(false);
  const [menu, setMenu] = useState(!tour);
  const [blocked, setBlocked] = useState(false);
  const closeMenu = useCallback(() => setMenu(false), []);
  const frame = useRef<HTMLIFrameElement>(null);

  // アプリの画面からの知らせ（操作の説明・状態・再生中に触ろうとした）
  const hideBlocked = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow || !isStageMessage(e.data)) return;
      const message = e.data;
      if (message.type === 'demo:caption') setCaption(message.text);
      else if (message.type === 'demo:phase') setPhase(message.phase);
      else {
        setBlocked(true);
        if (hideBlocked.current) clearTimeout(hideBlocked.current);
        hideBlocked.current = setTimeout(() => setBlocked(false), 2500);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // 一時停止。機能一覧を開いている間も、ツアーを止めておく（iframe を読み込み直したときにも送る）
  const pauseNow = phase === 'playing' && (paused || menu);
  const sendPause = useCallback(() => {
    frame.current?.contentWindow?.postMessage({ type: 'demo:pause', paused: pauseNow } satisfies ShellMessage, '*');
  }, [pauseNow]);
  useEffect(sendPause, [sendPause]);

  const index = tour ? TOUR_INFO.indexOf(tour) : -1;
  const next = index >= 0 ? TOUR_INFO[index + 1] : undefined;
  const text = captionFor(phase, caption);

  return (
    <>
      <div className="demo-site">
        <div className="demo-frame">
          <iframe ref={frame} className="demo-stage" src={stageUrl(tour?.id ?? null)} title="tanacode の画面" onLoad={sendPause} />
        </div>
      </div>
      <ScreenLayer>
        <header className="demo-bar demo-ui">
          <span className="demo-badge">デモ</span>
          <button type="button" className="demo-button" onClick={() => setMenu(true)}>
            機能一覧
          </button>
          <div className="demo-caption" aria-live="polite">
            {tour && <span className="demo-tour-title">{tour.title}</span>}
            <span key={text} className="demo-caption-text">
              {text}
            </span>
          </div>
          {phase === 'playing' && (
            <button type="button" className="demo-button" aria-pressed={paused} onClick={() => setPaused((p) => !p)}>
              {paused ? '再開' : '一時停止'}
            </button>
          )}
          {tour && (
            <button type="button" className="demo-button" onClick={() => location.reload()}>
              {phase === 'playing' ? '最初から' : 'もう一度'}
            </button>
          )}
          {(phase === 'done' || phase === 'failed') && next && (
            <a className="demo-button primary" href={tourHref(next)} onClick={(e) => openTour(e, next)}>
              次へ: {next.title}
            </a>
          )}
          <a className="demo-link" href={REPO} target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
        </header>
        {blocked && (
          <div className="demo-blocked demo-ui" role="status">
            ツアーの再生中は操作できません。終わると自由に触れます
          </div>
        )}
        {menu && <TourMenu current={tour} onClose={closeMenu} />}
      </ScreenLayer>
    </>
  );
}

// ツアーの行き先（ハッシュが変わると main.tsx が読み込み直す）
const tourHref = (tour: TourInfo) => `#${tour.id}`;

// 今と同じツアーを選んだときはハッシュが変わらないので、自分で読み込み直す
function openTour(e: React.MouseEvent, tour: TourInfo): void {
  if (location.hash !== tourHref(tour)) return;
  e.preventDefault();
  location.reload();
}

// 帯をこの幅より狭く出すときは、2 段にする（上の段に操作、下の段に説明）
const COMPACT_WIDTH = 760;

// アプリの画面のまわりに空ける幅
const STAGE_MARGIN = 16;

// アプリの画面を、上の帯の下の残りに横も縦も収める倍率（大きくはしない）。
// ピンチでの拡大・縮小では変えないよう、見えている範囲ではなくページの大きさ（clientWidth・clientHeight）で求める
function stageScale(barHeight: number): number {
  const { clientWidth, clientHeight } = document.documentElement;
  const margin = Math.min(STAGE_MARGIN, clientWidth * 0.02);
  return Math.min(1, (clientWidth - margin * 2) / STAGE.width, (clientHeight - barHeight - margin * 2) / STAGE.height);
}

// 上の帯・知らせ・機能一覧を、いま見えている範囲に重ねる層。スマホでピンチで拡大しても、画面の上に同じ大きさで出す。
// ピンチで拡大すると fixed の要素は見えている範囲に付いてこないので、visualViewport（見えている範囲）の位置と倍率に合わせて動かす。
// 描き直しを避けるため、React の状態にはせず直に書き換える
function ScreenLayer({ children }: { children: React.ReactNode }) {
  const layer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = layer.current;
    if (!el) return;
    const place = () => {
      const vv = window.visualViewport;
      const scale = vv?.scale ?? 1;
      const width = vv ? vv.width * scale : document.documentElement.clientWidth;
      const height = vv ? vv.height * scale : window.innerHeight;
      el.style.width = `${width}px`;
      el.style.height = `${height}px`;
      el.style.transform = `translate(${vv?.offsetLeft ?? 0}px, ${vv?.offsetTop ?? 0}px) scale(${1 / scale})`;
      el.classList.toggle('compact', width < COMPACT_WIDTH);
      space();
    };
    // 帯の高さと、アプリの画面を帯の下に収める倍率
    const bar = el.querySelector<HTMLElement>('.demo-bar');
    const space = () => {
      const height = bar?.offsetHeight ?? 48;
      const root = document.documentElement.style;
      root.setProperty('--demo-bar-height', `${height}px`);
      root.setProperty('--demo-scale', String(stageScale(height)));
    };
    place();
    const observer = new ResizeObserver(space);
    if (bar) observer.observe(bar);
    const vv = window.visualViewport;
    vv?.addEventListener('resize', place);
    vv?.addEventListener('scroll', place);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place);
    return () => {
      observer.disconnect();
      vv?.removeEventListener('resize', place);
      vv?.removeEventListener('scroll', place);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place);
    };
  }, []);
  return (
    <div ref={layer} className="demo-layer">
      {children}
    </div>
  );
}

function TourMenu({ current, onClose }: { current: TourInfo | null; onClose: () => void }) {
  // 開いたら一覧にフォーカスを移す（最初の項目には移さない。選んである項目に見えないように）
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialog.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // アプリの画面を縮小して見せているときは、細かいところの見方を先に伝える
  const shrunk = stageScale(Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--demo-bar-height')) || 48) < 0.75;
  const touch = window.matchMedia('(pointer: coarse)').matches;
  return (
    <div className="demo-menu-backdrop demo-ui" onClick={onClose}>
      <div ref={dialog} className="demo-menu" role="dialog" aria-modal="true" aria-label="機能一覧" tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="demo-menu-head">
          <img className="demo-menu-logo" src={logo} alt="tanacode" />
          <span className="demo-badge">デモ</span>
          <span className="spacer" />
          <button type="button" className="demo-icon-button" aria-label="閉じる" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <p className="demo-menu-lead">
          Claude Code と IDE をひとつにした macOS アプリ、tanacode のデモ。見たい機能を選ぶと、実際の画面で操作の流れを紹介します。
        </p>
        <p className="demo-menu-note">作り物のデータで動くため、本物の Claude には繋がりません。ツアーが終わると、そのまま自由に触れます。</p>
        {shrunk && (
          <p className="demo-menu-warn">
            {touch
              ? '画面に収まるよう、アプリの画面を縮小しています。ピンチで拡大すると、細かいところまで読めます。'
              : 'ウインドウに収まるよう、アプリの画面を縮小しています。ウインドウを広げると、大きく表示されます。'}
          </p>
        )}
        <ol className="demo-tour-list">
          {TOUR_INFO.map((t, i) => (
            <li key={t.id}>
              <a className={`demo-tour${current?.id === t.id ? ' current' : ''}`} href={tourHref(t)} onClick={(e) => openTour(e, t)}>
                <span className="demo-tour-num">{i + 1}</span>
                <span className="demo-tour-body">
                  <span className="demo-tour-name">{t.title}</span>
                  <span className="demo-tour-summary">{t.summary}</span>
                </span>
              </a>
            </li>
          ))}
        </ol>
        <div className="demo-menu-foot">
          <button type="button" className="demo-button" onClick={onClose}>
            {current ? 'ツアーに戻る' : '自由に触る'}
          </button>
          <span className="spacer" />
          <a className="demo-link" href={`${REPO}#インストール`} target="_blank" rel="noopener noreferrer">
            インストール
          </a>
          <a className="demo-link" href={`${REPO}/blob/develop/GUIDE.md`} target="_blank" rel="noopener noreferrer">
            使い方
          </a>
          <a className="demo-link" href={REPO} target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
        </div>
      </div>
    </div>
  );
}
