import { useCallback, useEffect, useRef, useState } from 'react';
import { App } from '../../App';
import logo from '../../assets/logo.png';
import { CloseIcon } from '../../icons';
import type { DemoBackend } from '../backend';
import { Director, setPaused } from '../director';
import { Claude } from '../scenarios/claude';
import { type Tour, TOURS } from '../tours';
import { INPUT_BLOCKED, setInputBlocked } from './inputGuard';

// デモのサイトの画面。上の帯（機能一覧・説明・再生の操作）と、その下のアプリの画面。
// ツアーを選ぶと、台本どおりに作り物のカーソルが動き、帯に操作の説明が出る。終わったら、そのまま自由に触れる

const REPO = 'https://github.com/sny-tanaka/tanacode';

// playing: ツアーの再生中 / done: ツアーが終わった / failed: ツアーが途中で止まった / free: ツアーを選ばずに触っている
type Phase = 'playing' | 'done' | 'failed' | 'free';

const FREE_REPLY = [
  'これはデモです。本物の Claude には繋がっていないので、指示は実行されません。',
  '',
  '上の「機能一覧」から機能を選ぶと、実際の画面で操作の流れを紹介します。',
].join('\n');

// 自由に触るときの返事。送った発言には、デモであることを知らせる決まった返事をする（本物の Claude には繋がない）
function enterFreeMode(backend: DemoBackend): void {
  const claudes = new Map<string, Claude>();
  backend.onUserMessage = (id, text, images) => {
    let claude = claudes.get(id);
    if (!claude) {
      claude = new Claude(backend, id, 'free-');
      claudes.set(id, claude);
    }
    const c = claude;
    backend.push(id, { type: 'user', id: c.next('u'), text, images });
    c.startWorking();
    setTimeout(() => {
      c.stopWorking();
      c.say(FREE_REPLY);
      backend.push(id, { type: 'turn-end' });
    }, 1200);
  };
  // 質問のカードが残っていたら、答えたところで閉じる
  backend.onChoose = (id) => {
    backend.setScreen(id, { state: { kind: 'prompt' } });
    backend.update(id, { attention: null });
  };
}

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

export function DemoSite({ tour, backend }: { tour: Tour | null; backend: DemoBackend }) {
  const [phase, setPhase] = useState<Phase>(tour ? 'playing' : 'free');
  const [caption, setCaption] = useState('');
  const [paused, setPausedState] = useState(false);
  const [menu, setMenu] = useState(!tour);
  const [blocked, setBlocked] = useState(false);
  const closeMenu = useCallback(() => setMenu(false), []);

  // ツアーを流す（ツアーを選んでいなければ、最初のツアーの始まりの状態のまま触れるようにする）
  useEffect(() => {
    let director: Director | null = null;
    let cancelled = false;
    const start = setTimeout(() => {
      if (!tour) {
        backend.select(TOURS[0].session);
        enterFreeMode(backend);
        return;
      }
      backend.select(tour.session);
      const d = new Director();
      director = d;
      d.onCaption = setCaption;
      tour
        .run(backend, d)
        .then(
          () => !cancelled && setPhase('done'),
          (error: unknown) => {
            console.error('demo failed', error);
            if (!cancelled) setPhase('failed');
          },
        )
        .finally(() => {
          d.dispose();
          enterFreeMode(backend);
        });
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(start);
      director?.dispose();
    };
  }, [backend, tour]);

  // 再生中は見ている人の操作を止める。機能一覧を開いている間は、ツアーも止めておく
  useEffect(() => {
    setInputBlocked(phase === 'playing');
    setPaused(phase === 'playing' && (paused || menu));
  }, [phase, paused, menu]);

  // 再生中に触ろうとしたら、しばらく知らせを出す
  const hideBlocked = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const show = () => {
      setBlocked(true);
      if (hideBlocked.current) clearTimeout(hideBlocked.current);
      hideBlocked.current = setTimeout(() => setBlocked(false), 2500);
    };
    window.addEventListener(INPUT_BLOCKED, show);
    return () => window.removeEventListener(INPUT_BLOCKED, show);
  }, []);

  const index = tour ? TOURS.indexOf(tour) : -1;
  const next = index >= 0 ? TOURS[index + 1] : undefined;
  const text = captionFor(phase, caption);

  return (
    <div className="demo-site">
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
          <button type="button" className="demo-button" aria-pressed={paused} onClick={() => setPausedState((p) => !p)}>
            {paused ? '再開' : '一時停止'}
          </button>
        )}
        {tour && (
          <button type="button" className="demo-button" onClick={() => location.reload()}>
            {phase === 'playing' ? '最初から' : 'もう一度'}
          </button>
        )}
        {(phase === 'done' || phase === 'failed') && next && (
          <a className="demo-button primary" href={`?tour=${next.id}`}>
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
      <div className="demo-app">
        <App />
      </div>
      {menu && <TourMenu current={tour} onClose={closeMenu} />}
    </div>
  );
}

function TourMenu({ current, onClose }: { current: Tour | null; onClose: () => void }) {
  // 開いたら一覧にフォーカスを移す（最初の項目には移さない。選んである項目に見えないように）
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialog.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // アプリの画面は横に広いので、狭い画面では崩れることを先に伝える
  const narrow = window.innerWidth < 1200;
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
        {narrow && <p className="demo-menu-warn">画面の幅が狭いため、表示が崩れることがあります。PC の広い画面でご覧ください。</p>}
        <ol className="demo-tour-list">
          {TOURS.map((t, i) => (
            <li key={t.id}>
              <a className={`demo-tour${current?.id === t.id ? ' current' : ''}`} href={`?tour=${t.id}`}>
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
