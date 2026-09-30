import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { App } from '../App';
import { DemoBackend, type DemoProject } from './backend';
import { cafeProject, DEMO_CATALOG, demoUsage, taxedProject } from './data';
import { Director } from './director';
import { BASIC_SESSION, runBasic, setupBasic } from './scenarios/basic';
import { MULTI_SESSION, runMulti, setupMulti } from './scenarios/multi';
import { PREVIEW_SESSION, runPreview, setupPreview } from './scenarios/preview';
import { REVIEW_SESSION, runReview, setupReview } from './scenarios/review';
import { runVisibility, setupVisibility, VISIBILITY_SESSION } from './scenarios/visibility';
import { runWorkflow, setupWorkflow, WORKFLOW_SESSION } from './scenarios/workflow';

// README のデモ動画。アプリの画面全体を、作り物のデータ（DemoBackend）と台本（scenarios/）で動かす。
// scripts/record-demo.mjs が、この画面を録画して MP4 にする。台本が終わると window.__demoDone が true になる

type Scenario = {
  session: string;
  // 始まりのプロジェクト（省略すると、手を付ける前のもの）
  project?: () => DemoProject;
  // 列の幅（省略すると、チャットとエディタのどちらも読める幅）
  columns?: { sessions: number; claude: number; side: number };
  setup: (backend: DemoBackend) => void;
  run: (backend: DemoBackend, director: Director) => Promise<void>;
};

declare global {
  interface Window {
    __demoDone?: boolean;
  }
}

function DemoApp({ scenario }: { scenario: Scenario }) {
  // App より先に window.tanacode を差し替える（App は最初の描画で API を呼ぶ）
  const [backend] = useState(() => {
    // 動画（1440×900）で、チャットとエディタのどちらも読める幅にする（アプリは列の幅を localStorage から読む）
    // 前に開いたファイル・選んでいたパネルなど、アプリが保存した状態（tanacode. で始まるもの）は持ち越さない
    try {
      for (const key of Object.keys(localStorage)) if (key.startsWith('tanacode.')) localStorage.removeItem(key);
      localStorage.setItem('tanacode.columns', JSON.stringify(scenario.columns ?? { sessions: 210, claude: 480, side: 210 }));
    } catch {
      // 保存できなくても既定の幅で動く
    }
    const b = new DemoBackend((scenario.project ?? cafeProject)(), demoUsage(), DEMO_CATALOG);
    scenario.setup(b);
    window.tanacode = b.api();
    window.__demoDone = false;
    return b;
  });
  useEffect(() => {
    let director: Director | null = null;
    const start = setTimeout(() => {
      backend.select(scenario.session);
      director = new Director();
      void scenario
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
  }, [backend, scenario]);
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

export const 基本: StoryObj = {
  render: () => <DemoApp scenario={{ session: BASIC_SESSION, setup: setupBasic, run: runBasic }} />,
};

export const レビュー: StoryObj = {
  render: () => <DemoApp scenario={{ session: REVIEW_SESSION, project: taxedProject, columns: { sessions: 170, claude: 460, side: 240 }, setup: setupReview, run: runReview }} />,
};

export const ワークフロー: StoryObj = {
  render: () => (
    <DemoApp
      scenario={{ session: WORKFLOW_SESSION, project: taxedProject, columns: { sessions: 200, claude: 410, side: 240 }, setup: setupWorkflow, run: runWorkflow }}
    />
  ),
};

export const 複数のセッション: StoryObj = {
  render: () => (
    <DemoApp scenario={{ session: MULTI_SESSION, project: taxedProject, columns: { sessions: 270, claude: 540, side: 220 }, setup: setupMulti, run: runMulti }} />
  ),
};

export const プレビュー: StoryObj = {
  render: () => (
    <DemoApp scenario={{ session: PREVIEW_SESSION, project: taxedProject, columns: { sessions: 180, claude: 440, side: 200 }, setup: setupPreview, run: runPreview }} />
  ),
};

export const 見える化: StoryObj = {
  render: () => (
    <DemoApp scenario={{ session: VISIBILITY_SESSION, columns: { sessions: 200, claude: 560, side: 280 }, setup: setupVisibility, run: runVisibility }} />
  ),
};
