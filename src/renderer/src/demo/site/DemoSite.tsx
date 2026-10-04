import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import logo from '../../assets/logo.png';
import { CheckIcon, CloseIcon } from '../../icons';
import { CHAPTER_INFO, type ChapterInfo } from '../story/chapterInfo';
import { type CaptionBox, isStageMessage, type Phase, type ShellMessage, STAGE, stageUrl } from './messages';

// デモのサイトの親のページ。上の帯（目次・いまの章・再生の操作）と、アプリの画面を描く iframe、操作の説明の吹き出し。
// アプリの画面は iframe の中で決まった大きさのまま描き（app.tsx）、ここでは iframe ごと縮小して画面に収めるだけにする。
// ツアーは 1 本で、章に分かれる。目次から章を選ぶと、iframe の中でそれまでの章を早送りで流し、その章から始める

const REPO = 'https://github.com/sny-tanaka/tanacode';

// 最後まで見た章（このブラウザにだけ覚える。目次にチェックの印を出す）
const WATCHED_KEY = 'tanacode-demo.watched';

function loadWatched(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(WATCHED_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function saveWatched(watched: Set<string>): void {
  try {
    localStorage.setItem(WATCHED_KEY, JSON.stringify([...watched]));
  } catch {
    // 覚えられなくても、印が出ないだけ
  }
}

// 帯に出す状態の文言（再生中は、説明は吹き出しに出すので、帯には出さない）
function statusFor(phase: Phase): string {
  switch (phase) {
    case 'playing':
      return '';
    case 'done':
      return 'ツアーが終わりました。このまま自由に触れます';
    case 'failed':
      return 'ツアーが途中で止まりました。このまま自由に触れます';
    case 'free':
      return '自由に触れます。チャットに送っても、本物の Claude には繋がりません';
  }
}

// start: ツアーを始める章（ハッシュで選んだもの。無ければツアーを流さず、目次を出す）
export function DemoSite({ start }: { start: ChapterInfo | null }) {
  const [phase, setPhase] = useState<Phase>(start ? 'playing' : 'free');
  const [caption, setCaption] = useState<{ text: string; box: CaptionBox | null }>({ text: '', box: null });
  const [chapter, setChapter] = useState(start ? CHAPTER_INFO.indexOf(start) : -1);
  const [preparing, setPreparing] = useState(!!start && CHAPTER_INFO.indexOf(start) > 0);
  const [paused, setPaused] = useState(false);
  const [menu, setMenu] = useState(!start);
  const [blocked, setBlocked] = useState(false);
  const [watched, setWatched] = useState(loadWatched);
  // 書き出した HTML（ツアーの最後の章で、アプリの画面の上に重ねて見せる）
  const [exported, setExported] = useState<string | null>(null);
  const closeMenu = useCallback(() => setMenu(false), []);
  const frame = useRef<HTMLIFrameElement>(null);

  // アプリの画面からの知らせ（操作の説明・状態・章・再生中に触ろうとした）
  const hideBlocked = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow || !isStageMessage(e.data)) return;
      const message = e.data;
      switch (message.type) {
        case 'demo:caption':
          setCaption({ text: message.text, box: message.box });
          break;
        case 'demo:phase':
          setPhase(message.phase);
          if (message.phase !== 'playing') setPreparing(false);
          break;
        case 'demo:chapter':
          setChapter(message.index);
          setPreparing(message.preparing);
          if (!message.preparing) setCaption({ text: '', box: null });
          break;
        case 'demo:watched':
          setWatched((prev) => {
            const next = new Set(prev).add(CHAPTER_INFO[message.index].id);
            saveWatched(next);
            return next;
          });
          break;
        case 'demo:export':
          setExported(message.html);
          break;
        case 'demo:blocked':
          setBlocked(true);
          if (hideBlocked.current) clearTimeout(hideBlocked.current);
          hideBlocked.current = setTimeout(() => setBlocked(false), 2500);
          break;
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const send = useCallback((message: ShellMessage) => frame.current?.contentWindow?.postMessage(message, '*'), []);

  // 一時停止。目次を開いている間も、ツアーを止めておく（iframe を読み込み直したときにも送る）
  const pauseNow = phase === 'playing' && (paused || menu);
  const sendPause = useCallback(() => send({ type: 'demo:pause', paused: pauseNow }), [send, pauseNow]);
  useEffect(sendPause, [sendPause]);

  const current = chapter >= 0 ? CHAPTER_INFO[chapter] : null;
  const last = chapter === CHAPTER_INFO.length - 1;
  const text = preparing ? `「${current?.title ?? ''}」の手前まで進めています…` : statusFor(phase);
  const callout = phase === 'playing' && !preparing && caption.text ? caption : null;

  return (
    <>
      <div className="demo-site">
        <div className="demo-frame-wrap">
        <div className="demo-frame">
          <iframe ref={frame} className="demo-stage" src={stageUrl(start?.id ?? null)} title="tanacode の画面" onLoad={sendPause} />
          {exported !== null && (
            <div className="demo-export">
              <div className="demo-export-head">書き出した HTML（ブラウザで開いたところ）</div>
              <iframe className="demo-export-page" srcDoc={exported} title="書き出した HTML" sandbox="" />
            </div>
          )}
          {preparing && (
            <div className="demo-preparing" role="status">
              <span className="demo-spinner" />
              <span>「{current?.title}」の手前まで進めています…</span>
            </div>
          )}
        </div>
        {callout && <Callout text={callout.text} box={callout.box} />}
        </div>
      </div>
      <ScreenLayer>
        <header className="demo-bar demo-ui">
          <span className="demo-badge">デモ</span>
          <button type="button" className="demo-button" onClick={() => setMenu(true)}>
            目次
          </button>
          <div className="demo-caption" aria-live="polite">
            {current && phase === 'playing' && (
              <span className="demo-tour-title">
                {chapter + 1} / {CHAPTER_INFO.length}　{current.title}
              </span>
            )}
            {text && (
              <span key={text} className="demo-caption-text">
                {text}
              </span>
            )}
          </div>
          {phase === 'playing' && !preparing && (
            <button type="button" className="demo-button" aria-pressed={paused} onClick={() => setPaused((p) => !p)}>
              {paused ? '再開' : '一時停止'}
            </button>
          )}
          {phase === 'playing' && !preparing && !last && (
            <button type="button" className="demo-button" onClick={() => send({ type: 'demo:next' })}>
              次の章へ
            </button>
          )}
          {phase !== 'playing' && (
            <a className="demo-button primary" href={chapterHref(CHAPTER_INFO[0])} onClick={(e) => openChapter(e, CHAPTER_INFO[0])}>
              {phase === 'free' ? 'ツアーを見る' : 'もう一度'}
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
        {menu && <ChapterMenu current={phase === 'playing' ? current : null} watched={watched} onClose={closeMenu} />}
      </ScreenLayer>
    </>
  );
}

// 章の行き先（ハッシュが変わると main.tsx が読み込み直す）
const chapterHref = (chapter: ChapterInfo) => `#${chapter.id}`;

// 今と同じ章を選んだときはハッシュが変わらないので、自分で読み込み直す
function openChapter(e: React.MouseEvent, chapter: ChapterInfo): void {
  if (location.hash !== chapterHref(chapter)) return;
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
      // 狭い画面では、アプリの画面を帯のすぐ下に寄せ、下の空きに説明の吹き出しを出す（site.css）
      document.documentElement.classList.toggle('demo-compact', width < COMPACT_WIDTH);
      space();
    };
    // 帯の高さと、アプリの画面を帯の下に収める倍率
    const bar = el.querySelector<HTMLElement>('.demo-bar');
    const space = () => {
      const height = bar?.offsetHeight ?? 48;
      const root = document.documentElement.style;
      root.setProperty('--demo-stage-width', `${STAGE.width}px`);
      root.setProperty('--demo-stage-height', `${STAGE.height}px`);
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

// 操作の説明の吹き出し。アプリの画面の外（縮小しない親のページ）に描くので、スマホでも字が小さくならない。
// 広い画面では、説明が指す場所（box。アプリの画面の座標）のそばに、矢印を向けて出す。場所が無ければ、アプリの画面の下の方に出す。
// 狭い画面（スマホ）では、アプリの画面のすぐ下の空きに出し、矢印を指す場所の横の位置に向ける
// arrow: 矢印の向き（up は吹き出しの上に付けて上を指す）。arrowAt: 矢印の位置（上下の矢印は横の位置、左右の矢印は縦の位置）
type CalloutPlace = { left: number; top: number; width?: number; arrow: 'up' | 'down' | 'left' | 'right' | 'none'; arrowAt: number };

function Callout({ text, box }: { text: string; box: CaptionBox | null }) {
  const bubble = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<CalloutPlace | null>(null);
  const layout = useCallback(() => {
    const el = bubble.current;
    const wrap = el?.parentElement;
    if (!el || !wrap) return;
    const frameW = wrap.offsetWidth;
    const frameH = wrap.offsetHeight;
    const scale = frameW / STAGE.width;
    const rect = wrap.getBoundingClientRect();
    const pageW = document.documentElement.clientWidth;
    const compact = pageW < COMPACT_WIDTH;
    const gap = 12;
    const edge = 8;
    const target = box && { x: box.x * scale, y: box.y * scale, width: box.width * scale, height: box.height * scale };
    const centerX = target ? target.x + target.width / 2 : frameW / 2;
    if (compact) {
      // アプリの画面と同じ幅で、すぐ下に出す
      const arrowAt = Math.min(frameW - 18, Math.max(18, centerX));
      setPlace({ left: 0, top: frameH + gap, width: frameW, arrow: target ? 'up' : 'none', arrowAt });
      return;
    }
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    // 横はページからはみ出さない範囲で、指す場所の真ん中にそろえる
    const minLeft = edge - rect.left;
    const maxLeft = pageW - edge - rect.left - w;
    const left = Math.min(maxLeft, Math.max(minLeft, centerX - w / 2));
    const arrowAt = Math.min(w - 18, Math.max(18, centerX - left));
    if (!target) {
      setPlace({ left, top: frameH - h - Math.max(36, 48 * scale), arrow: 'none', arrowAt });
      return;
    }
    // 指す場所の下、上の順に入るところへ出す。縦に長い場所（一覧・パネル）は、上下に出すとアプリの画面の端に寄ってしまうので、横に出す
    const below = target.y + target.height + gap;
    const above = target.y - gap - h;
    const tall = target.height > frameH * 0.4;
    if (below + h <= frameH - edge) return setPlace({ left, top: below, arrow: 'up', arrowAt });
    if (!tall && above >= edge) return setPlace({ left, top: above, arrow: 'down', arrowAt });
    // 横に出すときは、指す場所の上の方にそろえる
    const top = Math.min(frameH - h - edge, Math.max(edge, target.y + 12));
    const side = { top, arrowAt: Math.min(h - 18, Math.max(18, target.y + 30 - top)) };
    if (target.x + target.width + gap + w <= frameW - edge) return setPlace({ left: target.x + target.width + gap, arrow: 'left', ...side });
    if (target.x - gap - w >= edge) return setPlace({ left: target.x - gap - w, arrow: 'right', ...side });
    if (above >= edge) return setPlace({ left, top: above, arrow: 'down', arrowAt });
    setPlace({ left, top: Math.min(frameH - h - edge, target.y + target.height - h - edge), arrow: 'none', arrowAt });
  }, [box]);
  useLayoutEffect(layout, [layout, text]);
  useEffect(() => {
    window.addEventListener('resize', layout);
    const observer = new ResizeObserver(layout);
    if (bubble.current?.parentElement) observer.observe(bubble.current.parentElement);
    return () => {
      window.removeEventListener('resize', layout);
      observer.disconnect();
    };
  }, [layout]);
  return (
    <div
      ref={bubble}
      className={`demo-callout ${place?.arrow ?? 'none'}`}
      role="status"
      aria-live="polite"
      style={{
        left: place?.left ?? 0,
        top: place?.top ?? 0,
        width: place?.width,
        visibility: place ? 'visible' : 'hidden',
        ['--arrow-at' as string]: `${place?.arrowAt ?? 0}px`,
      }}
    >
      <span key={text} className="demo-callout-text">
        {text}
      </span>
    </div>
  );
}

function ChapterMenu({ current, watched, onClose }: { current: ChapterInfo | null; watched: Set<string>; onClose: () => void }) {
  // 開いたら目次にフォーカスを移す（最初の項目には移さない。選んである項目に見えないように）
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
      <div ref={dialog} className="demo-menu" role="dialog" aria-modal="true" aria-label="目次" tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="demo-menu-head">
          <img className="demo-menu-logo" src={logo} alt="tanacode" />
          <span className="demo-badge">デモ</span>
          <span className="spacer" />
          <button type="button" className="demo-icon-button" aria-label="閉じる" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <p className="demo-menu-lead">
          Claude Code と IDE をひとつにした macOS アプリ、tanacode のデモ。ひとつのセッションの作業を通して、実際の画面で機能を紹介します。章を選ぶと、そこから始まります。
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
          {CHAPTER_INFO.map((c, i) => (
            <li key={c.id}>
              <a className={`demo-tour${current?.id === c.id ? ' current' : ''}`} href={chapterHref(c)} onClick={(e) => openChapter(e, c)}>
                <span className="demo-tour-num">{i + 1}</span>
                <span className="demo-tour-body">
                  <span className="demo-tour-name">
                    {c.title}
                    {c.isNew && <span className="demo-tour-new">新</span>}
                    {watched.has(c.id) && (
                      <span className="demo-tour-watched" aria-label="見た章">
                        <CheckIcon size={12} />
                      </span>
                    )}
                  </span>
                  <span className="demo-tour-summary">{c.summary}</span>
                </span>
              </a>
            </li>
          ))}
        </ol>
        <div className="demo-menu-foot">
          <a className="demo-button primary" href={chapterHref(CHAPTER_INFO[0])} onClick={(e) => openChapter(e, CHAPTER_INFO[0])}>
            最初から見る
          </a>
          <button type="button" className="demo-button" onClick={onClose}>
            {current ? 'ツアーに戻る' : '自由に触る'}
          </button>
          {/* 狭い画面では、リンクはまとめて次の行へ送る */}
          <span className="demo-menu-links">
            <a className="demo-link" href={`${REPO}#インストール`} target="_blank" rel="noopener noreferrer">
              インストール
            </a>
            <a className="demo-link" href={`${REPO}/blob/develop/GUIDE.md`} target="_blank" rel="noopener noreferrer">
              使い方
            </a>
            <a className="demo-link" href={REPO} target="_blank" rel="noopener noreferrer">
              GitHub
            </a>
          </span>
        </div>
      </div>
    </div>
  );
}
