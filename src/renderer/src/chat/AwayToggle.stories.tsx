import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { ExportIcon, IconButton, MonitorIcon, ReloadIcon } from '../icons';
import { AwayToggle } from './AwayToggle';
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
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {row('押して試す', <AwayToggle on={on} onChange={setOn} />)}
      {row('オフ', <AwayToggle on={false} onChange={() => {}} />)}
      {row('オン', <AwayToggle on onChange={() => {}} />)}
      {row('オン（ターミナルモード）', <AwayToggle on terminal onChange={() => {}} />)}
    </div>
  );
}

const meta = {
  title: 'チャット/離席モードのスイッチ',
  parameters: { width: 760, background: '--bg-panel' },
} satisfies Meta;

export default meta;

export const 状態: StoryObj = { render: () => <Demo /> };
