import { DemoBackend, type DemoProject } from './backend';
import { cafeProject, DEMO_CATALOG, demoUsage, taxedProject } from './data';
import type { Director } from './director';
import { TOUR_INFO, type TourInfo } from './tourInfo';
import { BASIC_SESSION, runBasic, setupBasic } from './scenarios/basic';
import { MULTI_SESSION, runMulti, setupMulti } from './scenarios/multi';
import { PREVIEW_SESSION, runPreview, setupPreview } from './scenarios/preview';
import { REVIEW_SESSION, runReview, setupReview } from './scenarios/review';
import { runVisibility, setupVisibility, VISIBILITY_SESSION } from './scenarios/visibility';
import { runWorkflow, setupWorkflow, WORKFLOW_SESSION } from './scenarios/workflow';

// 機能紹介のツアー。README のデモ動画（Demo.stories.tsx）と、デモのサイト（site/）の両方で使う。
// どれもアプリの画面全体を、作り物のデータ（DemoBackend）と台本（scenarios/）で動かす

export type Tour = TourInfo & {
  session: string;
  // 始まりのプロジェクト（省略すると、手を付ける前のもの）
  project?: () => DemoProject;
  // 列の幅（省略すると、チャットとエディタのどちらも読める幅）
  columns?: { sessions: number; claude: number; side: number };
  setup: (backend: DemoBackend) => void;
  run: (backend: DemoBackend, director: Director) => Promise<void>;
};

const info = (id: string): TourInfo => TOUR_INFO.find((t) => t.id === id)!;

export const TOURS: Tour[] = [
  {
    ...info('basic'),
    session: BASIC_SESSION,
    setup: setupBasic,
    run: runBasic,
  },
  {
    ...info('review'),
    session: REVIEW_SESSION,
    project: taxedProject,
    columns: { sessions: 170, claude: 460, side: 240 },
    setup: setupReview,
    run: runReview,
  },
  {
    ...info('workflow'),
    session: WORKFLOW_SESSION,
    project: taxedProject,
    columns: { sessions: 200, claude: 410, side: 240 },
    setup: setupWorkflow,
    run: runWorkflow,
  },
  {
    ...info('multi'),
    session: MULTI_SESSION,
    project: taxedProject,
    columns: { sessions: 270, claude: 540, side: 220 },
    setup: setupMulti,
    run: runMulti,
  },
  {
    ...info('preview'),
    session: PREVIEW_SESSION,
    project: taxedProject,
    columns: { sessions: 180, claude: 440, side: 200 },
    setup: setupPreview,
    run: runPreview,
  },
  {
    ...info('visibility'),
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
