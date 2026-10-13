import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { IDLE_COMPACT_STATUS, type CompactPhase, type CompactStatus } from '@shared/optimized-compact';
import { ExportIcon, IconButton, MonitorIcon, ReloadIcon } from '../icons';
import { CompactButton } from './CompactButton';

// チャットのヘッダーの「最適化圧縮」。1 つの枠の中に、今すぐ始めるボタン（左のアイコン）と、自動で始めるかのスイッチ（右）がある。
// ボタンを押すと、仕上げ → 会話を消す → 再開の文、と進む間（ここでは 1.5 秒ずつ）ぐるぐるを出す。
// 再開の文を送れずに待っている・取りやめたことは、枠の左に短く出す（理由はツールチップ）
const PHASES: CompactPhase[] = ['finalizing', 'clearing', 'resuming'];

function Demo() {
  const [status, setStatus] = useState<CompactStatus>(IDLE_COMPACT_STATUS);
  const [auto, setAuto] = useState(true);
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
  const fixed = (over: Partial<CompactStatus>, canStart = true, auto = true) => (
    <CompactButton canStart={canStart} auto={auto} status={{ ...IDLE_COMPACT_STATUS, ...over }} onStart={() => {}} onAutoChange={() => {}} />
  );
  // チャットの欄が狭いとき（ヘッダーの全体）。札は枠の下に浮かせて、右端のボタンを欄の外に出さない
  const narrow = (title: string, over: Partial<CompactStatus>) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, height: 80 }}>
      <div style={{ width: 200, fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{title}</div>
      <div className="claude-header" style={{ width: 400, flex: 'none', border: '1px solid var(--border-subtle)' }}>
        <span className="claude-mark" />
        <span className="claude-title">税率を可変にしてください</span>
        <div className="spacer" />
        {fixed(over)}
        <IconButton size="md" icon={ReloadIcon} label="再起動" />
        <IconButton size="md" icon={ExportIcon} label="書き出す" />
        <IconButton size="md" icon={MonitorIcon} label="ターミナルモード" />
      </div>
    </div>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {row('押して試す', <CompactButton canStart auto={auto} status={status} onStart={press} onAutoChange={setAuto} />)}
      {row('待機中（押せる）', fixed({}))}
      {row('作業中（押せない）', fixed({}, false))}
      {row('仕上げ中', fixed({ phase: 'finalizing' }))}
      {row('再開の文を送るのを待っている', fixed({ phase: 'waiting' }))}
      {row('取りやめた', fixed({ failure: 'interrupted' }))}
      {row('自動がオフ', fixed({}, true, false))}
      {row('自動で始める大きさが 40%', fixed({ autoPercent: 40 }))}
      {row('自動を休んでいる', fixed({ autoPaused: true }))}
      {row('チェックリストがオフ（押せない）', fixed({ unavailable: 'checklist-off' }))}
      {narrow('狭い幅: 取りやめた', { failure: 'interrupted' })}
      {narrow('狭い幅: 自動を休んでいる', { autoPaused: true })}
      {narrow('狭い幅: 再開の文を待っている', { phase: 'waiting' })}
    </div>
  );
}

const meta = {
  title: 'チャット/最適化圧縮のボタンと自動のスイッチ',
  parameters: { width: 940, background: '--bg-panel' },
} satisfies Meta;

export default meta;

export const 状態: StoryObj = { render: () => <Demo /> };
