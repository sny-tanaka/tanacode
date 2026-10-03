import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { mockApi } from '../../../../.storybook/mockApi';
import { chatFromEvents, todoSteps } from '../chat/chatState';
import { DEFAULT_EXPORT_OPTIONS, prepareExport, promptsOf, sliceRange, type ExportOptions } from './exportContent';
import { buildExportHtml } from './exportHtml';
import { SAMPLE_BRANCHES, SAMPLE_CWD, SAMPLE_EVENTS, SAMPLE_HOME, SAMPLE_IMAGES } from './sampleSession';

// 書き出した HTML。本物と同じく、CSS を集めて 1 枚にしたものを iframe で開く（中の CSP で、外へは何も読みにいかない）。
// 畳んだ「N件の操作」・ツールのカード・hooks・画像は、押すと開く（JavaScript は入れていない）

const ITEMS = chatFromEvents(SAMPLE_EVENTS).items;
const PROMPTS = promptsOf(ITEMS);

// from / to: 書き出す発言の範囲（0 から）
function Preview({ options, from, to }: { options: ExportOptions; from: number; to: number }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const end = Math.min(to, PROMPTS.length - 1);
    const start = Math.min(from, end);
    const { items, todoSteps: steps, meta } = prepareExport(
      sliceRange(ITEMS, PROMPTS, start, end),
      todoSteps(SAMPLE_EVENTS),
      { title: '季節限定のバッジ', cwd: SAMPLE_CWD, branches: SAMPLE_BRANCHES, home: SAMPLE_HOME },
      options,
      { start, end, total: PROMPTS.length },
      Date.parse('2026-10-03T15:00:00+09:00'),
    );
    void buildExportHtml({ meta, items, todoSteps: steps, withImages: options.images }).then((value) => alive && setHtml(value));
    return () => {
      alive = false;
    };
  }, [options, from, to]);
  if (!html) return <p style={{ padding: 24, color: 'var(--text-secondary)' }}>作っています…</p>;
  return <iframe title="書き出した HTML" srcDoc={html} style={{ display: 'block', width: '100%', height: '100vh', border: 'none' }} />;
}

const meta = {
  title: '書き出し/書き出した HTML',
  component: Preview,
  parameters: { bare: true },
  args: { options: DEFAULT_EXPORT_OPTIONS, from: 0, to: Number.MAX_SAFE_INTEGER },
  beforeEach: () => mockApi({ 'sessions.image': (key) => Promise.resolve(SAMPLE_IMAGES[key as string] ?? null) }),
} satisfies Meta<typeof Preview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const 全体: Story = {};

// ツールの結果・差分・画像・思考を入れず、ホームフォルダのパスもそのまま
export const 中身を省いたもの: Story = {
  args: { options: { toolOutput: false, diffs: false, images: false, thinking: false, homeToTilde: false } },
};

// 2 番目の発言だけ
export const 発言の範囲: Story = { args: { from: 1, to: 1 } };
