import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ScheduledMessage } from '@shared/scheduled';
import { ScheduledRow } from './ScheduledRow';

// チャットの末尾に出す、予約したメッセージの行。ふつうの予約と、予約のファイルを読めず保存しない予約
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
