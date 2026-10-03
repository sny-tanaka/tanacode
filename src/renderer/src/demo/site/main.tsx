import { createRoot } from 'react-dom/client';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '../../global.css';
import { prepareTour, TOURS } from '../tours';
import { DemoSite } from './DemoSite';
import { installInputGuard } from './inputGuard';
import './site.css';

// デモのサイトの入り口。?tour=<id> でツアーを選ぶ。無ければ、最初のツアーの始まりの状態を背景に機能一覧を出す。
// ツアーを変えるときはページを読み込み直す（アプリの状態を持ち越さず、まっさらから始める）

const id = new URLSearchParams(location.search).get('tour');
const tour = TOURS.find((t) => t.id === id) ?? null;
const backend = prepareTour(tour ?? TOURS[0]);

installInputGuard();
createRoot(document.getElementById('root')!).render(<DemoSite tour={tour} backend={backend} />);
