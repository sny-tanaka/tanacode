import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ClaudeAccount } from '@shared/account';
import type { UsageLimits } from '@shared/usage';
import { mockApi } from '../../../../.storybook/mockApi';
import { SettingsFilesDialog } from '../chat/SettingsFilesDialog';
import { closeSettingsFilesDialog, useSettingsFilesDialogOpen } from '../chat/settingsFiles';
import { AccountPanel } from './AccountPanel';

// セッション一覧の最下部の、アカウントと利用枠。どの状態でも 3 行（名前・5 時間・週）で、高さは変わらない。
// メールアドレスは、マウスを乗せたときと、押して開くメニューの中にだけ出る。メニューの「設定ファイルの管理…」で管理ダイアログが開く

const TEAM: ClaudeAccount = { email: 'taro@corp.example', organization: 'Acme 株式会社', plan: 'Claude Team' };
const PERSONAL: ClaudeAccount = { email: 'taro@example.com', organization: "taro@example.com's Organization", plan: 'Claude Max' };

const MINUTE = 60_000;
const usage = (five: number | null, week: number | null, { ago = 0, fiveResetIn = 133 * MINUTE } = {}): UsageLimits => ({
  limits: [
    five === null ? null : { label: '5時間', percent: five, resetsAt: Date.now() + fiveResetIn },
    week === null ? null : { label: '週', percent: week, resetsAt: Date.now() + (4 * 24 + 18) * 60 * MINUTE },
  ].filter((l) => l !== null),
  updatedAt: Date.now() - ago,
  source: 'statusline',
});

// セッション一覧の下と同じ幅・地の色に置く。上の空きは、メニューが上に開く場所
function Demo() {
  const open = useSettingsFilesDialogOpen();
  return (
    <>
      <div style={{ width: 248, height: 360, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', background: 'var(--bg-chrome)', border: '1px solid var(--border-subtle)' }}>
        <AccountPanel />
      </div>
      {open && <SettingsFilesDialog onClose={closeSettingsFilesDialog} />}
    </>
  );
}

const story = (account: ClaudeAccount | null, value: UsageLimits | null): Story => ({
  beforeEach: () =>
    mockApi({
      'account.get': () => Promise.resolve(account),
      'usage.get': () => Promise.resolve(value),
    }),
});

const meta = {
  title: 'セッション/アカウントと利用枠',
  component: Demo,
  parameters: { width: 300, background: '--bg-chrome' },
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

// Team プラン。組織の名前もプランの横に出る
export const チームのプラン: Story = story(TEAM, usage(32, 10));

// 個人のプラン。組織の名前がメールアドレスを含むので、欄には出さない
export const 個人のプラン: Story = story(PERSONAL, usage(18, 37));

// 使用率が 70% 以上は黄色、90% 以上は赤
export const 残りわずか: Story = story(TEAM, usage(76, 93));

// 起動した直後など、まだ利用枠が届いていない。ゲージは消さず、灰色の 0% と「未取得」で場所を取っておく
export const 未取得: Story = story(PERSONAL, null);

// 片方の枠だけ届いている（届いていない方は灰色の 0%）
export const 片方だけ: Story = story(TEAM, usage(32, null));

// 30 分以上前の値は、名前の行の右端に、いつの値かを出す
export const 古い値: Story = story(TEAM, usage(55, 20, { ago: 95 * MINUTE }));

// 5 時間枠のリセット時刻を過ぎた。新しい値が届くまで 0%
export const リセット済み: Story = story(TEAM, usage(88, 20, { ago: 20 * MINUTE, fiveResetIn: -5 * MINUTE }));

// Claude Code にログインしていない（API キーだけで使っているときも、ここに入る）
export const ログインしていない: Story = story(null, null);
