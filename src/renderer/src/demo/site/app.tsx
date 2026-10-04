import { createRoot } from 'react-dom/client';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '../../global.css';
import { CHAPTER_INFO } from '../story/chapterInfo';
import { prepareStory } from '../story/story';
import './app.css';
import { installInputGuard } from './inputGuard';
import { Stage } from './Stage';

// デモのサイトの、iframe の中のアプリの画面（親のページは main.tsx）。#<章の id> で、ツアーをその章から始める。
// 無ければツアーを流さず、ツアーの始まりの状態のまま触れるようにする

const id = location.hash.slice(1);
const start = CHAPTER_INFO.findIndex((c) => c.id === id);
const story = prepareStory();

installInputGuard();
createRoot(document.getElementById('root')!).render(<Stage story={story} start={start} />);
