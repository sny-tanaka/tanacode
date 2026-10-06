import { runApp } from './chapters/app';
import { CHAPTER_INFO, type ChapterInfo } from './chapterInfo';
import { runBrowser } from './chapters/browser';
import { runChecklist } from './chapters/checklist';
import { runDelegate } from './chapters/delegate';
import { runKnowledge } from './chapters/knowledge';
import { runParallel } from './chapters/parallel';
import { runReview } from './chapters/review';
import { runStart } from './chapters/start';
import { runWrapup } from './chapters/wrapup';
import type { Story } from './story';

// ツアーの章と台本。章は前の章の続きなので、途中の章から始めるときは、それまでの章を早送りで流す（site/Stage.tsx）

export type Chapter = ChapterInfo & { run: (story: Story) => Promise<void> };

const RUNS: Record<string, (story: Story) => Promise<void>> = {
  start: runStart,
  delegate: runDelegate,
  knowledge: runKnowledge,
  checklist: runChecklist,
  browser: runBrowser,
  review: runReview,
  parallel: runParallel,
  wrapup: runWrapup,
  app: runApp,
};

export const CHAPTERS: Chapter[] = CHAPTER_INFO.map((info) => ({ ...info, run: RUNS[info.id] }));
