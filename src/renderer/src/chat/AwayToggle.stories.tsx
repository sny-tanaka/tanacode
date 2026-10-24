import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { IDLE_COMPACT_STATUS } from '@shared/optimized-compact';
import { ContextMeter } from '../knowledge/ContextMeter';
import { ExportIcon, IconButton, MonitorIcon, ParentIcon, ReloadIcon } from '../icons';
import { AwayToggle } from './AwayToggle';
import { CompactButton } from './CompactButton';
import { RemoteControlToggle } from './RemoteControlToggle';

// チャットのヘッダーの離席モードのスイッチ。Remote Control のスイッチの右に並ぶ。ホバーで説明と今の状態を出す
function Demo() {
  const [on, setOn] = useState(false);
  const row = (title: string, node: React.ReactNode) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
      <div style={{ width: 200, fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{title}</div>
      <div className="claude-header" style={{ borderBottom: 'none', padding: 0, flex: 1 }}>
        <div className="spacer" />
        <RemoteControlToggle on connected onChange={() => {}} />
        {node}
        <IconButton size="md" icon={ReloadIcon} label="再起動" />
        <IconButton size="md" icon={ExportIcon} label="書き出す" />
        <IconButton size="md" icon={MonitorIcon} label="ターミナルモード" />
      </div>
    </div>
  );
  // チャットの欄の幅ごとの、ヘッダーの全体（ClaudePane と同じ並び）。狭いときは、Remote Control と離席モードのスイッチを
  // アイコンだけにして（オンは色と背景で見せる）、タイトルの幅を残し、右端のボタンを欄の外に出さない
  const header = (width: number) => (
    <div key={width} style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
      <div style={{ width: 200, fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{`チャットの欄 ${width}px`}</div>
      <div className="claude-header" style={{ width, flex: 'none', border: '1px solid var(--border-subtle)', boxSizing: 'border-box' }}>
        <span className="claude-mark" />
        <span className="claude-title">操作を試すセッション</span>
        <div className="spacer" />
        <ContextMeter tokens={3100} limit={200_000} onClick={() => {}} />
        <RemoteControlToggle on={false} connected onChange={() => {}} />
        <AwayToggle on onChange={() => {}} />
        <CompactButton canStart auto status={IDLE_COMPACT_STATUS} onStart={() => {}} onAutoChange={() => {}} />
        <IconButton size="md" icon={ParentIcon} label="親にする" />
        <IconButton size="md" icon={ReloadIcon} label="再起動" />
        <IconButton size="md" icon={ExportIcon} label="書き出す" />
        <IconButton size="md" icon={MonitorIcon} label="ターミナルモード" />
      </div>
    </div>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {row('押して試す', <AwayToggle on={on} onChange={setOn} />)}
      {row('オフ', <AwayToggle on={false} onChange={() => {}} />)}
      {row('オン', <AwayToggle on onChange={() => {}} />)}
      {row('オン（ターミナルモード）', <AwayToggle on terminal onChange={() => {}} />)}
      {[360, 400, 470, 520, 600].map(header)}
    </div>
  );
}

const meta = {
  title: 'チャット/離席モードのスイッチ',
  parameters: { width: 860, background: '--bg-panel' },
} satisfies Meta;

export default meta;

export const 状態: StoryObj = { render: () => <Demo /> };
