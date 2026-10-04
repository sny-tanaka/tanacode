import { createRoot } from 'react-dom/client';
import '../../global.css';
import { CHAPTER_INFO } from '../story/chapterInfo';
import { DemoSite } from './DemoSite';
import './site.css';

// デモのサイトの入り口（親のページ）。#<章の id> で、ツアーをその章から始める。無ければ目次を出す。
// アプリの画面は iframe（app.html）の中で動かす。章を変えるときはページごと読み込み直す（アプリの状態を持ち越さない）。
// 選ぶのはハッシュで行う。クエリはアーティファクトなど、置き場所によってはページに届かないため

const id = location.hash.slice(1);
const start = CHAPTER_INFO.find((c) => c.id === id) ?? null;

window.addEventListener('hashchange', () => location.reload());

createRoot(document.getElementById('root')!).render(<DemoSite start={start} />);
