import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { App } from '../App';
import '../demo/site/app.css';
import { runShowcase } from '../demo/story/showcase';
import { prepareStory } from '../demo/story/story';
import { setRemoteMode } from '../remote/mode';

// スマホの画面の配置（Issue #464）。体験版のデータで画面を埋め、スマホの画面（遠隔の接続）の印を立てて描く。
// 幅が 760px 以下のときだけ、スマホの配置（上の帯・セッションの引き出し・下のタブ）になる。アプリ内ブラウザを iPhone の大きさにして見る

function MobileApp() {
  const [story] = useState(() => {
    setRemoteMode(true);
    return prepareStory();
  });
  useEffect(() => {
    const start = setTimeout(() => void runShowcase(story).catch((error) => console.error('demo failed', error)), 600);
    return () => {
      clearTimeout(start);
      setRemoteMode(false);
    };
  }, [story]);
  return (
    <div className="demo-app" style={{ height: '100vh' }}>
      <App />
    </div>
  );
}

const meta = {
  title: '遠隔操作/スマホの画面',
  parameters: { bare: true },
} satisfies Meta;

export default meta;

export const スマホの配置: StoryObj = { render: () => <MobileApp /> };
