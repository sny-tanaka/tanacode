import type { Meta, StoryObj } from '@storybook/react-vite';
import type { HookRun } from '@shared/chat';
import { HookRuns } from './chat/HookRuns';
import { SentFilesCard } from './chat/SentFilesCard';

// ホバーで明るくなるか（ふだんが明るく、ホバーで沈むものが無いか）を見比べる。
// 枠を指定していないボタンは、ブラウザの既定の明るい枠が出るので、ここに並べて確かめる
const run = (event: string, outcome: HookRun['outcome'], command: string): HookRun => ({
  event,
  name: event,
  command,
  outcome,
  exitCode: outcome === 'error' ? 1 : 0,
  durationMs: 120,
  stdout: '',
  stderr: '',
  message: '',
  toolUseId: null,
});

const noop = () => {};

function Place({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{title}</div>
      {children}
    </div>
  );
}

function Catalog() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <Place title="hooks の実行">
        <HookRuns
          runs={[
            run('Stop', 'success', 'npm run lint'),
            run('PostToolUse', 'context', '.claude/hooks/notify.sh'),
            run('PreToolUse', 'blocked', '.claude/hooks/guard.sh'),
          ]}
        />
      </Place>
      <Place title="Claude から届いたファイル">
        <SentFilesCard files={{ paths: ['/x/docs/report.md', '/x/out/chart.png'], caption: null }} failed={false} onOpenFile={noop} />
      </Place>
      <Place title="新規セッションのボタン（セッション一覧の上）">
        <div style={{ background: 'var(--bg-chrome)', padding: '4px 0' }}>
          <button className="new-session-button" style={{ margin: '4px 10px' }}>
            <span className="new-session-plus">＋</span>新規セッション
          </button>
        </div>
      </Place>
    </div>
  );
}

const meta = {
  title: 'カタログ/ホバー',
  parameters: { width: 520, background: '--bg-panel' },
} satisfies Meta;

export default meta;

export const 一覧: StoryObj = { render: () => <Catalog /> };
