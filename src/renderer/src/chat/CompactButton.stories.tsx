import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { IDLE_COMPACT_STATUS, type CompactPhase, type CompactStatus } from '@shared/optimized-compact';
import { ExportIcon, IconButton, MonitorIcon, ReloadIcon } from '../icons';
import { CompactButton } from './CompactButton';

// チャットのヘッダーの「最適化圧縮」。押すと、仕上げ → 会話を消す → 再開の文、と進む間（ここでは 1.5 秒ずつ）ぐるぐるを出す。
// 再開の文を送れずに待っている・取りやめたことは、ボタンの左に短く出す（理由はツールチップ）
const PHASES: CompactPhase[] = ['finalizing', 'clearing', 'resuming'];

function Demo() {
  const [status, setStatus] = useState<CompactStatus>(IDLE_COMPACT_STATUS);
  const press = () => {
    PHASES.forEach((phase, i) => setTimeout(() => setStatus({ ...IDLE_COMPACT_STATUS, phase }), i * 1500));
    setTimeout(() => setStatus(IDLE_COMPACT_STATUS), PHASES.length * 1500);
  };
  const row = (title: string, node: React.ReactNode) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
      <div style={{ width: 200, fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{title}</div>
      <div className="claude-header" style={{ borderBottom: 'none', padding: 0, flex: 1 }}>
        <div className="spacer" />
        {node}
        <IconButton size="md" icon={ReloadIcon} label="再起動" />
        <IconButton size="md" icon={ExportIcon} label="書き出す" />
        <IconButton size="md" icon={MonitorIcon} label="ターミナルモード" />
      </div>
    </div>
  );
  const fixed = (over: Partial<CompactStatus>, canStart = true) => <CompactButton canStart={canStart} status={{ ...IDLE_COMPACT_STATUS, ...over }} onStart={() => {}} />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {row('押して試す', <CompactButton canStart status={status} onStart={press} />)}
      {row('待機中（押せる）', fixed({}))}
      {row('作業中（押せない）', fixed({}, false))}
      {row('仕上げ中', fixed({ phase: 'finalizing' }))}
      {row('再開の文を送るのを待っている', fixed({ phase: 'waiting' }))}
      {row('取りやめた', fixed({ failure: 'interrupted' }))}
      {row('チェックリストがオフ（押せない）', fixed({ unavailable: 'checklist-off' }))}
    </div>
  );
}

const meta = {
  title: 'チャット/最適化圧縮のボタン',
  parameters: { width: 640, background: '--bg-panel' },
} satisfies Meta;

export default meta;

export const 状態: StoryObj = { render: () => <Demo /> };
