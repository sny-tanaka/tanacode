import { createRoot } from 'react-dom/client';
import '../../global.css';
import { TOUR_INFO } from '../tourInfo';
import { DemoSite } from './DemoSite';
import './site.css';

// デモのサイトの入り口（親のページ）。#<id>（?tour=<id> でもよい）でツアーを選ぶ。無ければ機能一覧を出す。
// アプリの画面は iframe（app.html）の中で動かす。ツアーを変えるときはページごと読み込み直す（アプリの状態を持ち越さない）。
// 選ぶのはハッシュで行う。クエリはアーティファクトなど、置き場所によってはページに届かないため

const id = location.hash.slice(1) || new URLSearchParams(location.search).get('tour');
const tour = TOUR_INFO.find((t) => t.id === id) ?? null;

window.addEventListener('hashchange', () => location.reload());

createRoot(document.getElementById('root')!).render(<DemoSite tour={tour} />);
