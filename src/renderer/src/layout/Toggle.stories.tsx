import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { RemoteIcon } from './icons';
import { Toggle } from './Toggle';

// オン・オフのスイッチ。クリックで切り替わる。切り替えの途中（busy）はぐるぐるを出して押せなくする
function Demo() {
  const [on, setOn] = useState(true);
  const [busy, setBusy] = useState(false);
  const icon = <RemoteIcon size={15} />;
  const row = (title: string, node: React.ReactNode) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
      <div style={{ width: 160, fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{title}</div>
      {node}
    </div>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {row('クリックで切り替え', <Toggle label={icon} name="Remote Control" on={on} title={'Remote Control\nホバーで名前と説明を出す'} onChange={setOn} />)}
      {row(
        '切り替えに 1.5 秒かかる',
        <Toggle
          label={icon} name="Remote Control"
          on={on}
          busy={busy}
          onChange={(next) => {
            setBusy(true);
            setTimeout(() => {
              setOn(next);
              setBusy(false);
            }, 1500);
          }}
        />,
      )}
      {row('オフ', <Toggle label={icon} name="Remote Control" on={false} onChange={() => {}} />)}
      {row('オン', <Toggle label={icon} name="Remote Control" on onChange={() => {}} />)}
      {row('使えない（開発版）', <Toggle label={icon} name="Remote Control" on={false} disabled title={'Remote Control\n押せないときも、ホバーで理由を出す'} onChange={() => {}} />)}
      {row('切り替えの途中', <Toggle label={icon} name="Remote Control" on busy onChange={() => {}} />)}
      {row('文字のとき', <Toggle label="Remote Control" on={on} onChange={setOn} />)}
      {row(
        'ヘッダーのボタンと並べる',
        <div className="claude-header" style={{ borderBottom: 'none', padding: 0, flex: 1 }}>
          <div className="spacer" />
          <Toggle label={icon} name="Remote Control" on={on} onChange={setOn} />
          <button className="ghost-button">圧縮</button>
          <button className="ghost-button">再起動</button>
          <button className="ghost-button">ターミナル</button>
        </div>,
      )}
    </div>
  );
}

const meta = {
  title: 'カタログ/スイッチ',
  parameters: { width: 640, background: '--bg-panel' },
} satisfies Meta;

export default meta;

export const 一覧: StoryObj = { render: () => <Demo /> };
