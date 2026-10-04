import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { App } from '../App';
import './site/app.css';
import { runShowcase } from './story/showcase';
import { prepareStory } from './story/story';

// README の紹介画像（design/screenshot.png）。デモのサイトのツアーを、画面の要素がいちばん多い場面まで早送りで流して止める。
// scripts/capture-screenshot.mjs（npm run screenshot）が、この画面を 1440×900 の 1.5 倍で撮る。場面ができると window.__showcaseReady が true になる

declare global {
  interface Window {
    __showcaseReady?: boolean;
  }
}

function ShowcaseApp() {
  const [story] = useState(() => {
    window.__showcaseReady = false;
    return prepareStory();
  });
  useEffect(() => {
    const start = setTimeout(() => {
      runShowcase(story)
        .then(() => {
          // ぐるぐるや差分の色付けが落ち着いてから、チャットを末尾まで送って撮る
          setTimeout(() => {
            document.querySelector('.claude .chat-list')?.scrollTo({ top: Number.MAX_SAFE_INTEGER });
            window.__showcaseReady = true;
          }, 1500);
        })
        .catch((error) => console.error('demo failed', error));
    }, 600);
    return () => clearTimeout(start);
  }, [story]);
  return (
    <div className="demo-app" style={{ height: '100vh' }}>
      <App />
    </div>
  );
}

const meta = {
  title: '紹介画像',
  // 余白や幅の制限を付けず、画面いっぱいに出す（.storybook/preview.tsx）
  parameters: { bare: true },
} satisfies Meta;

export default meta;

export const 紹介画像: StoryObj = { render: () => <ShowcaseApp /> };
