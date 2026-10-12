import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { ExportIcon, IconButton, MonitorIcon, ReloadIcon } from '../icons';
import { CompactButton, type CompactMode } from './CompactButton';

// チャットのヘッダーの「圧縮」。右の ▾ で通常圧縮と最適化圧縮を切り替える。最適化圧縮のときはアイコンの色を変える。
// 押すと、最適化圧縮は Haiku が選ぶ間（ここでは 2 秒）、通常圧縮とどちらも圧縮が終わるまで（ここでは 2 秒）ぐるぐるを出す
function Demo({ initial }: { initial: CompactMode }) {
  const [mode, setMode] = useState<CompactMode>(initial);
  const [optimizing, setOptimizing] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const compact = () => {
    setCompacting(true);
    setTimeout(() => setCompacting(false), 2000);
  };
  const press = () => {
    if (mode === 'plain') return compact();
    setOptimizing(true);
    setTimeout(() => {
      setOptimizing(false);
      compact();
    }, 2000);
  };
  const row = (title: string, node: React.ReactNode) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
      <div style={{ width: 160, fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{title}</div>
      <div className="claude-header" style={{ borderBottom: 'none', padding: 0, flex: 1 }}>
        <div className="spacer" />
        {node}
        <IconButton size="md" icon={ReloadIcon} label="再起動" />
        <IconButton size="md" icon={ExportIcon} label="書き出す" />
        <IconButton size="md" icon={MonitorIcon} label="ターミナルモード" />
      </div>
    </div>
  );
  const fixed = (m: CompactMode, over: Partial<{ canCompact: boolean; compacting: boolean; optimizing: boolean }>) => (
    <CompactButton mode={m} onModeChange={() => {}} canCompact compacting={false} optimizing={false} onCompact={() => {}} {...over} />
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingBottom: 140 }}>
      {row('押して試す', <CompactButton mode={mode} onModeChange={setMode} canCompact={!optimizing && !compacting} compacting={compacting} optimizing={optimizing} onCompact={press} />)}
      {row('通常圧縮', fixed('plain', {}))}
      {row('最適化圧縮', fixed('optimized', {}))}
      {row('作業中（押せない）', fixed('optimized', { canCompact: false }))}
      {row('Haiku が選んでいる', fixed('optimized', { canCompact: false, optimizing: true }))}
      {row('圧縮中', fixed('plain', { canCompact: false, compacting: true }))}
    </div>
  );
}

const meta = {
  title: 'チャット/圧縮のボタン',
  parameters: { width: 640, background: '--bg-panel' },
} satisfies Meta;

export default meta;

export const 通常圧縮から: StoryObj = { render: () => <Demo initial="plain" /> };
export const 最適化圧縮から: StoryObj = { render: () => <Demo initial="optimized" /> };
