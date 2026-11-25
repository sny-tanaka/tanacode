import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { t } from '@shared/i18n';
import type { RemoteDevicesState, RemoteSettingsInput, RemoteSettingsState, RemoteStatus } from '@shared/remote-settings';
import { mockApi } from '../../../../.storybook/mockApi';
import { RemoteSettingsDialog } from './RemoteSettingsDialog';

// 遠隔操作の設定（メニューバーの「遠隔操作の設定…」から開く）。保存は、ストーリーの中で覚える（main の代わりに返事を決めている）

const noop = () => {};

const noDevices: RemoteDevicesState = { devices: [], pairing: null, problem: null };

function registry(initial: RemoteSettingsState, fail?: 'save', devices: RemoteDevicesState = noDevices) {
  let state = initial;
  mockApi({
    'remote.settings': () => Promise.resolve(state),
    'remote.devices': () => Promise.resolve(devices),
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

const listeningState = stateOf('https://mac.example.ts.net', { state: 'listening', port: 47413 }, 1);
const day = (offset: number) => Date.UTC(2026, 10, 20 + offset, 3, 0);

// 登録した端末が 2 つある
export const 登録した端末あり: Story = {
  beforeEach: () =>
    registry(listeningState, undefined, {
      devices: [
        { id: 'd1', name: 'iPhone', createdAt: day(0), lastUsedAt: day(5) },
        { id: 'd2', name: 'iPad', createdAt: day(1), lastUsedAt: null },
      ],
      pairing: null,
      problem: null,
    }),
};

// 端末の登録を受け付けていて、スマホからの頼みが承認を待っている（スマホに出た数字を打って承認する）
export const 端末を追加中: Story = {
  beforeEach: () =>
    registry(listeningState, undefined, {
      devices: [],
      pairing: { code: '48203917', url: 'https://mac.example.ts.net/#pair=48203917', until: Date.now() + 9 * 60 * 1000, pending: [{ requestId: 'q1', name: 'iPhone' }] },
      problem: null,
    }),
};

// 登録した端末の一覧が、前のものに戻されていた（遠隔操作は止めている）
export const 一覧が戻されていた: Story = {
  beforeEach: () => registry(stateOf('https://mac.example.ts.net', { state: 'off' }), undefined, { devices: [], pairing: null, problem: 'rolled-back' }),
};
