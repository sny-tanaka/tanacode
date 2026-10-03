import { DemoBackend, type DemoProject } from './backend';
import { cafeProject, DEMO_CATALOG, demoUsage, taxedProject } from './data';
import type { Director } from './director';
import { BASIC_SESSION, runBasic, setupBasic } from './scenarios/basic';
import { MULTI_SESSION, runMulti, setupMulti } from './scenarios/multi';
import { PREVIEW_SESSION, runPreview, setupPreview } from './scenarios/preview';
import { REVIEW_SESSION, runReview, setupReview } from './scenarios/review';
import { runVisibility, setupVisibility, VISIBILITY_SESSION } from './scenarios/visibility';
import { runWorkflow, setupWorkflow, WORKFLOW_SESSION } from './scenarios/workflow';

// 機能紹介のツアー。README のデモ動画（Demo.stories.tsx）と、デモのサイト（site/）の両方で使う。
// どれもアプリの画面全体を、作り物のデータ（DemoBackend）と台本（scenarios/）で動かす

export type Tour = {
  id: string;
  // Storybook のストーリー名と、デモのサイトの機能一覧に出す名前
  title: string;
  // 機能一覧に出す、1〜2 文の説明
  summary: string;
  session: string;
  // 始まりのプロジェクト（省略すると、手を付ける前のもの）
  project?: () => DemoProject;
  // 列の幅（省略すると、チャットとエディタのどちらも読める幅）
  columns?: { sessions: number; claude: number; side: number };
  setup: (backend: DemoBackend) => void;
  run: (backend: DemoBackend, director: Director) => Promise<void>;
};

export const TOURS: Tour[] = [
  {
    id: 'basic',
    title: '基本',
    summary: '指示を送ると、ツール・質問・書き換えたファイル・サブエージェントが、それぞれ見やすい形で並びます。',
    session: BASIC_SESSION,
    setup: setupBasic,
    run: runBasic,
  },
  {
    id: 'review',
    title: 'レビュー',
    summary: 'ブランチの変更を PR のように見て、差分の行にコメント。まとめて Claude に直してもらえます。',
    session: REVIEW_SESSION,
    project: taxedProject,
    columns: { sessions: 170, claude: 460, side: 240 },
    setup: setupReview,
    run: runReview,
  },
  {
    id: 'workflow',
    title: 'ワークフロー',
    summary: 'Claude が動かしたワークフローを図で表示。並列に動くエージェントの進み具合と会話を追えます。',
    session: WORKFLOW_SESSION,
    project: taxedProject,
    columns: { sessions: 200, claude: 410, side: 240 },
    setup: setupWorkflow,
    run: runWorkflow,
  },
  {
    id: 'multi',
    title: '複数のセッション',
    summary: 'いくつものセッションを並行して動かし、一覧の印で「作業中」「回答待ち」「新しい応答」を見分けます。',
    session: MULTI_SESSION,
    project: taxedProject,
    columns: { sessions: 270, claude: 540, side: 220 },
    setup: setupMulti,
    run: runMulti,
  },
  {
    id: 'preview',
    title: 'プレビュー',
    summary: '開発中のページをアプリ内のブラウザで開き、崩れている要素をクリックで選んで直してもらいます。',
    session: PREVIEW_SESSION,
    project: taxedProject,
    columns: { sessions: 180, claude: 440, side: 200 },
    setup: setupPreview,
    run: runPreview,
  },
  {
    id: 'visibility',
    title: '見える化',
    summary: 'Claude が読んだファイル・コンテキストの量・hooks・利用枠を、作業に合わせて表示します。',
    session: VISIBILITY_SESSION,
    columns: { sessions: 200, claude: 560, side: 280 },
    setup: setupVisibility,
    run: runVisibility,
  },
];

// ツアーの作り物の API を用意して、window.tanacode を差し替える（App の最初の描画より先に呼ぶ。App は最初の描画で API を呼ぶ）
export function prepareTour(tour: Tour): DemoBackend {
  // 列の幅を決める（アプリは列の幅を localStorage から読む）。
  // 前に開いたファイル・選んでいたパネルなど、アプリが保存した状態（tanacode. で始まるもの）は持ち越さない
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith('tanacode.')) localStorage.removeItem(key);
    localStorage.setItem('tanacode.columns', JSON.stringify(tour.columns ?? { sessions: 210, claude: 480, side: 210 }));
  } catch {
    // 保存できなくても既定の幅で動く
  }
  const backend = new DemoBackend((tour.project ?? cafeProject)(), demoUsage(), DEMO_CATALOG);
  tour.setup(backend);
  window.tanacode = backend.api();
  return backend;
}
