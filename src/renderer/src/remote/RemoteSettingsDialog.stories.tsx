import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { t } from '@shared/i18n';
import type { RemoteSettingsInput, RemoteSettingsState, RemoteStatus } from '@shared/remote-settings';
import { mockApi } from '../../../../.storybook/mockApi';
import { RemoteSettingsDialog } from './RemoteSettingsDialog';

// 遠隔操作の設定（メニューバーの「遠隔操作の設定…」から開く）。保存は、ストーリーの中で覚える（main の代わりに返事を決めている）

const noop = () => {};

function registry(initial: RemoteSettingsState, fail?: 'save') {
  let state = initial;
  mockApi({
    'remote.settings': () => Promise.resolve(state),
    'remote.setSettings': (input) => {
      if (fail === 'save') return Promise.reject(new Error(`Error invoking remote method 'remote:settings-set': Error: ${t('main.error.remotePublicUrl')}`));
      state = { ...state, settings: { ...state.settings, ...(input as RemoteSettingsInput) } };
      return Promise.resolve(state);
    },
  });
}

const stateOf = (publicUrl: string, status: RemoteStatus, connections = 0): RemoteSettingsState => ({
  settings: { enabled: status.state !== 'off', port: 47413, publicUrl },
  status,
  connections,
});

const meta = {
  title: '設定/遠隔操作',
  component: RemoteSettingsDialog,
  parameters: { bare: true },
  args: { onClose: noop },
  decorators: [
    (Story) => (
      <div style={{ minHeight: '100vh', background: 'var(--bg-panel)' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof RemoteSettingsDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

// はじめて開いた。公開する URL はまだ無く、止まっている
export const はじめて: Story = { beforeEach: () => registry(stateOf('', { state: 'off' })) };

// 待ち受けていて、2 つつながっている
export const 待ち受け中: Story = { beforeEach: () => registry(stateOf('https://mac.example.ts.net', { state: 'listening', port: 47413 }, 2)) };

// ポートが使われていて、待ち受けられない
export const ポートが使われている: Story = { beforeEach: () => registry(stateOf('https://mac.example.ts.net', { state: 'in-use', port: 47413 })) };

// 保存できなかった（形の違う URL など）。理由を出し、ダイアログは閉じない
export const 保存できない: Story = {
  beforeEach: () => registry(stateOf('', { state: 'off' }), 'save'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const url = await canvas.findByRole('textbox', { name: new RegExp(t('remote.publicUrl')) });
    await userEvent.type(url, 'http://mac.example.ts.net/path');
    // 打った文字が欄に入り、保存を押せるようになってから押す
    await waitFor(() => expect(canvas.getByRole('button', { name: t('common.save') })).toBeEnabled());
    await userEvent.click(canvas.getByRole('button', { name: t('common.save') }));
    await canvas.findByText((text) => text.includes(t('main.error.remotePublicUrl')));
  },
};
