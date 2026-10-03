import type { Meta, StoryObj } from '@storybook/react-vite';
import { ICON_GROUPS } from './catalog';
import { DisclosureIcon, IconButton, ReloadIcon, TrashIcon, CloseIcon, TerminalIcon, type IconSize } from './index';

// アプリのアイコンの一覧。意味ごとに、使う 4 つの大きさで並べる。アイコンを足す・直すときは、ここで見た目を確かめる

const SIZES: IconSize[] = [22, 16, 14, 12];

const cell: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr',
  gap: 8,
  padding: '10px 12px',
  border: '1px solid var(--border-strong)',
  borderRadius: 8,
  background: 'var(--bg-surface)',
};

function Catalog({ zoom = 1 }: { zoom?: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {ICON_GROUPS.map((group) => (
        <section key={group.title} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h3 style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary)', fontWeight: 500 }}>{group.title}</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 8 }}>
            {group.items.map(({ name, meaning, Icon }) => (
              <div key={name} style={cell}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, color: 'var(--text-primary)', zoom: zoom > 1 ? zoom : undefined }}>
                  {(zoom > 1 ? ([22, 14] as IconSize[]) : SIZES).map((size) => (
                    <Icon key={size} size={size} />
                  ))}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-heading)' }}>{meaning}</div>
                <code style={{ fontSize: 10.5, color: 'var(--text-tertiary)' }}>{name}</code>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

const meta = {
  title: 'カタログ/アイコン',
  component: Catalog,
  parameters: { width: 920 },
} satisfies Meta<typeof Catalog>;

export default meta;
type Story = StoryObj<typeof meta>;

// 全アイコン。左から 22px（アクティビティバー）・16px・14px（ボタン）・12px（行の中）
export const 一覧: Story = {};

// 絵の細部を見るための拡大（3 倍）。小さい大きさで潰れていないかは、「一覧」で確かめる
export const 拡大: Story = { args: { zoom: 3 }, parameters: { width: 1100 } };

// アイコンだけのボタン。名前（読み上げ）とツールチップは、必ず同じ文字が付く
export const アイコンのボタン: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <IconButton icon={ReloadIcon} label="更新" />
        <IconButton icon={ReloadIcon} label="押している間" pressed />
        <IconButton icon={ReloadIcon} label="押せない" disabled />
        <IconButton icon={ReloadIcon} label="実行中" busy />
        <IconButton icon={TrashIcon} label="削除（hover で赤）" danger />
        <IconButton icon={TerminalIcon} label="ツールチップに補足を添える" tip={'ターミナルを開く\n⌘J'} />
        <span style={{ color: 'var(--text-tertiary)', fontSize: 11 }}>md（26px の枠・14px の絵）</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <IconButton icon={CloseIcon} label="閉じる" size="sm" />
        <IconButton icon={CloseIcon} label="押せない" size="sm" disabled />
        <IconButton icon={TrashIcon} label="削除" size="sm" danger />
        <span style={{ color: 'var(--text-tertiary)', fontSize: 11 }}>sm（20px の枠・12px の絵。タブ・行の中）</span>
      </div>
      <div className="reveal-host" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 8, border: '1px dashed var(--border-strong)', borderRadius: 6 }}>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>この行にマウスを乗せるか、Tab で入ると出る</span>
        <IconButton icon={CloseIcon} label="外す" size="sm" reveal />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, color: 'var(--text-secondary)', fontSize: 12 }}>
        <DisclosureIcon open={false} /> 閉じている
        <DisclosureIcon open /> 開いている（右向きが回る）
      </div>
    </div>
  ),
};
