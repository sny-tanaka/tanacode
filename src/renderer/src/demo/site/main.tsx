import { createRoot } from 'react-dom/client';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '../../global.css';
import { prepareTour, TOURS } from '../tours';
import { DemoSite } from './DemoSite';
import { installInputGuard } from './inputGuard';
import './site.css';

// デモのサイトの入り口。#<id>（?tour=<id> でもよい）でツアーを選ぶ。無ければ、最初のツアーの始まりの状態を背景に機能一覧を出す。
// ツアーを変えるときはページを読み込み直す（アプリの状態を持ち越さず、まっさらから始める）。
// 選ぶのはハッシュで行う。クエリはアーティファクトなど、置き場所によってはページに届かないため

const id = location.hash.slice(1) || new URLSearchParams(location.search).get('tour');
const tour = TOURS.find((t) => t.id === id) ?? null;
const backend = prepareTour(tour ?? TOURS[0]);

// 見えている範囲（スクロールバーを除く）の高さ。アプリの画面の高さに使う。
// スマホの Chrome はページの幅に合わせて縦の基準（100%）まで広げるので、CSS の % では決められない
const measure = () => document.documentElement.style.setProperty('--demo-viewport-height', `${document.documentElement.clientHeight}px`);
measure();
window.addEventListener('resize', measure);

window.addEventListener('hashchange', () => location.reload());

installInputGuard();
createRoot(document.getElementById('root')!).render(<DemoSite tour={tour} backend={backend} />);
