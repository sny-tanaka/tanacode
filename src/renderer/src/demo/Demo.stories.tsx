import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { App } from '../App';
import { Director } from './director';
import { prepareTour, type Tour, TOURS } from './tours';

// README のデモ動画。アプリの画面全体を、作り物のデータ（DemoBackend）と台本（scenarios/）で動かす。
// scripts/record-demo.mjs が、この画面を録画して MP4 にする。台本が終わると window.__demoDone が true になる

declare global {
  interface Window {
    __demoDone?: boolean;
  }
}

function DemoApp({ tour }: { tour: Tour }) {
  const [backend] = useState(() => {
    const b = prepareTour(tour);
    window.__demoDone = false;
    return b;
  });
  useEffect(() => {
    let director: Director | null = null;
    const start = setTimeout(() => {
      backend.select(tour.session);
      director = new Director();
      void tour
        .run(backend, director)
        .catch((error) => console.error('demo failed', error))
        .finally(() => {
          window.__demoDone = true;
        });
    }, 600);
    return () => {
      clearTimeout(start);
      director?.dispose();
    };
  }, [backend, tour]);
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <App />
    </div>
  );
}

const meta = {
  title: 'デモ',
  // 余白や幅の制限を付けず、画面いっぱいに出す（.storybook/preview.tsx）
  parameters: { bare: true },
} satisfies Meta;

export default meta;

const story = (id: string): StoryObj => {
  const tour = TOURS.find((t) => t.id === id)!;
  return { name: tour.title, render: () => <DemoApp tour={tour} /> };
};

// ストーリー名（scripts/record-demo.mjs に渡す名前）は、ツアーの名前と同じ
export const 基本 = story('basic');
export const レビュー = story('review');
export const ワークフロー = story('workflow');
export const 複数のセッション = story('multi');
export const プレビュー = story('preview');
export const 見える化 = story('visibility');
