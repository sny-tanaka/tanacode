import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ExportSource, SessionSummary } from '@shared/ipc';
import { mockApi } from '../../../../.storybook/mockApi';
import { TooltipLayer } from '../layout/Tooltip';
import { ExportDialog } from './ExportDialog';
import { SAMPLE_BRANCHES, SAMPLE_CWD, SAMPLE_EVENTS, SAMPLE_HOME, SAMPLE_IMAGES } from './sampleSession';

// 作業を書き出す前の確認。範囲と入れるものを選び、会話に社内の情報や API キーが入りうることを伝える。
// 「書き出す…」を押すと、HTML を作って保存したことにする（保存のダイアログは出ない）

const SESSION: SessionSummary = {
  id: 's1',
  title: '季節限定のバッジ',
  cwd: SAMPLE_CWD,
  archived: false,
  createdAt: 0,
  updatedAt: 0,
  running: false,
  unread: false,
  attention: null,
  backgroundTasks: 0,
  model: null,
  effort: null,
  settingsFile: null,
  remoteControl: false,
  worktree: null,
};

const SOURCE: ExportSource = { events: SAMPLE_EVENTS, branches: SAMPLE_BRANCHES, home: SAMPLE_HOME };

// source: 会話ログから読んだ材料（'loading' は読み終わらない・'error' は読めない）
function Dialog(_: { source: ExportSource | 'loading' | 'error' }) {
  return (
    <>
      <ExportDialog session={SESSION} onClose={() => {}} />
      <TooltipLayer />
    </>
  );
}

const meta = {
  title: '書き出し/確認の画面',
  component: Dialog,
  parameters: { bare: true },
  args: { source: SOURCE },
  beforeEach: ({ args }) =>
    mockApi({
      'sessions.exportSource': () =>
        args.source === 'loading'
          ? new Promise(() => {})
          : args.source === 'error'
            ? Promise.reject(new Error('会話ログが見つかりません'))
            : Promise.resolve(args.source),
      'sessions.image': (key) => Promise.resolve(SAMPLE_IMAGES[key as string] ?? null),
      'sessions.saveExport': () => new Promise((resolve) => setTimeout(() => resolve(`${SAMPLE_HOME}/Downloads/季節限定のバッジ 2026-10-03.html`), 600)),
    }),
} satisfies Meta<typeof Dialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const 範囲と入れるもの: Story = {};

// 画像・思考・差分の無い会話では、その欄は押せない
export const 入らないものがある: Story = {
  args: {
    source: {
      ...SOURCE,
      events: SAMPLE_EVENTS.filter((e) => e.type !== 'thinking').map((e) =>
        e.type === 'user' ? { ...e, images: undefined } : e.type === 'tool-result' ? { ...e, images: undefined, patch: undefined } : e,
      ),
    },
  },
};

export const 読んでいる: Story = { args: { source: 'loading' } };

export const 読めなかった: Story = { args: { source: 'error' } };

export const 会話がまだ無い: Story = { args: { source: { events: [{ type: 'turn-end' }], branches: [], home: SAMPLE_HOME } } };
