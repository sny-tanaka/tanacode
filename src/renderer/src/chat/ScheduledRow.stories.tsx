import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ScheduledMessage } from '@shared/scheduled';
import { usageResumeText } from '@shared/usage-limit';
import { ScheduledRow } from './ScheduledRow';

// チャットの末尾に出す、予約したメッセージの行。ふつうの予約・予約のファイルを読めず保存しない予約・利用枠で止まったときの再開の予約
// （送る前にアプリを終えると消えるので、「保存できません」を添える）
const later = (minutes: number) => Date.now() + minutes * 60_000;
const MESSAGE: ScheduledMessage = {
  id: 'm1',
  sessionId: 's1',
  text: '昨日の変更のテストを流して、落ちたものを直してください。',
  attachments: [],
  pastes: [],
  at: later(90),
  createdAt: 0,
  state: 'scheduled',
  error: null,
};

const meta = {
  title: 'チャット/予約したメッセージ',
  component: ScheduledRow,
  args: { message: MESSAGE, onSendNow: () => {}, onReschedule: () => {}, onTake: () => {} },
  decorators: [(Story) => <div style={{ maxWidth: 560 }}>{Story()}</div>],
} satisfies Meta<typeof ScheduledRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ふつう: Story = {};

export const 保存できない: Story = {
  args: { message: { ...MESSAGE, unsaved: true } },
};

export const Claude_の予約で保存できない: Story = {
  args: { message: { ...MESSAGE, text: '子セッションの状態を get_session で確かめる。', at: later(5), by: 'claude', unsaved: true } },
};

// 利用枠で止まったので、アプリが入れた再開の予約。本文は囲みを外して出す
const USAGE_RESUME: ScheduledMessage = { ...MESSAGE, text: usageResumeText(), at: later(61), by: 'usage-limit', limitResetsAt: later(60) };

export const 利用枠の再開: Story = {
  args: { message: USAGE_RESUME },
};

// Mac が寝ていたなどで、時刻を 5 分以上過ぎてから気づいた（送らずに、人に任せる）
export const 利用枠の再開を時刻に送れなかった: Story = {
  args: { message: { ...USAGE_RESUME, at: later(-30), state: 'missed' } },
};
