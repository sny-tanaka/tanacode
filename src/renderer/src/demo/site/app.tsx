import { createRoot } from 'react-dom/client';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '../../global.css';
import { prepareTour, TOURS } from '../tours';
import './app.css';
import { installInputGuard } from './inputGuard';
import { Stage } from './Stage';

// デモのサイトの、iframe の中のアプリの画面（親のページは main.tsx）。#<id> でツアーを選ぶ。
// 無ければ、最初のツアーの始まりの状態のまま触れるようにする

const id = location.hash.slice(1);
const tour = TOURS.find((t) => t.id === id) ?? null;
const backend = prepareTour(tour ?? TOURS[0]);

installInputGuard();
createRoot(document.getElementById('root')!).render(<Stage tour={tour} backend={backend} />);
