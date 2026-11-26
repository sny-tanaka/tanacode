import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { t } from '@shared/i18n';
import type { RemoteDevicesState, RemoteSettingsInput, RemoteSettingsState, RemoteStatus } from '@shared/remote-settings';
import { mockApi } from '../../../../.storybook/mockApi';
import { RemoteSettingsDialog } from './RemoteSettingsDialog';

// 遠隔操作の設定（メニューバーの「遠隔操作の設定…」から開く）。保存は、ストーリーの中で覚える（main の代わりに返事を決めている）

const noop = () => {};

// 承認のときに選べるプロファイル（ストーリーでは 2 つ開いていることにする）
const profiles = [
  { id: 'default', name: '個人' },
  { id: 'work', name: '仕事' },
];

const noDevices: RemoteDevicesState = { devices: [], pairing: null, problem: null, profiles, log: [] };

// スマホに出たことにする確認の数字（ストーリーで承認するときは、これを打つ）
const DEMO_NUMBER = '123456';

// 端末の登録の受付を、main の代わりに動かす。「端末を追加」から 2 秒でスマホ（iPhone）の頼みが届いたことにし、
// DEMO_NUMBER を打って承認すると一覧に載る。違う数字・断る・取り消す・やり直すも、Mac の main と同じに返す
function devicesOf(initial: RemoteDevicesState) {
  let devices = initial;
  let listener: ((state: RemoteDevicesState) => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const change = (next: RemoteDevicesState) => {
    devices = next;
    listener?.(devices);
    return Promise.resolve(devices);
  };
  const withoutPending = (requestId: string) =>
    devices.pairing ? { ...devices, pairing: { ...devices.pairing, pending: devices.pairing.pending.filter((p) => p.requestId !== requestId) } } : devices;
  return {
    'remote.devices': () => Promise.resolve(devices),
    'remote.onDevicesChanged': (next: unknown) => {
      listener = next as (state: RemoteDevicesState) => void;
      return () => (listener = null);
    },
    'remote.startPairing': () => {
      if (timer) clearTimeout(timer);
      const code = String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0');
      timer = setTimeout(() => {
        if (devices.pairing?.code === code) void change({ ...devices, pairing: { ...devices.pairing, pending: [{ requestId: `q-${code}`, name: 'iPhone' }] } });
      }, 2000);
      return change({ ...devices, pairing: { code, url: `https://mac.example.ts.net/#pair=${code}`, until: Date.now() + 10 * 60 * 1000, pending: [] } });
    },
    'remote.cancelPairing': () => change({ ...devices, pairing: null }),
    'remote.rejectPairing': (requestId: unknown) => change(withoutPending(String(requestId))),
    'remote.approvePairing': (requestId: unknown, number: unknown, profileIds: unknown) => {
      const request = devices.pairing?.pending.find((p) => p.requestId === requestId);
      const allowed = Array.isArray(profileIds) ? devices.profiles.map((p) => p.id).filter((id) => profileIds.includes(id)) : [];
      if (allowed.length === 0) return Promise.resolve(false);
      if (!request || String(number).trim() !== DEMO_NUMBER) {
        void change(withoutPending(String(requestId)));
        return Promise.resolve(false);
      }
      void change({ ...devices, pairing: null, devices: [...devices.devices, { id: `d-${Date.now()}`, name: request.name, createdAt: Date.now(), lastUsedAt: null, profileIds: allowed }] });
      return Promise.resolve(true);
    },
    'remote.removeDevice': (id: unknown) => change({ ...devices, devices: devices.devices.filter((d) => d.id !== id) }),
    'remote.resetDevices': () => change({ ...devices, devices: [], problem: null }),
  };
}

function registry(initial: RemoteSettingsState, fail?: 'save', devices: RemoteDevicesState = noDevices) {
  let state = initial;
  mockApi({
    'remote.settings': () => Promise.resolve(state),
    ...devicesOf(devices),
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
        { id: 'd1', name: 'iPhone', createdAt: day(0), lastUsedAt: day(5), profileIds: ['default', 'work'] },
        { id: 'd2', name: 'iPad', createdAt: day(1), lastUsedAt: null, profileIds: ['default'] },
      ],
      pairing: null,
      problem: null,
      // 遠隔操作の記録（新しいものから）
      log: [
        { at: day(5), kind: 'login', name: 'iPhone' },
        { at: day(4), kind: 'ticket-failures', name: 'iPhone' },
        { at: day(1), kind: 'pairing-approved', name: 'iPad' },
        { at: day(0), kind: 'pairing-approved', name: 'iPhone' },
      ],
      profiles,
    }),
};

// 端末の登録を受け付けていて、スマホからの頼みが承認を待っている（スマホに出た数字を打って承認する）
export const 端末を追加中: Story = {
  beforeEach: () =>
    registry(listeningState, undefined, {
      devices: [],
      pairing: { code: '48203917', url: 'https://mac.example.ts.net/#pair=48203917', until: Date.now() + 9 * 60 * 1000, pending: [{ requestId: 'q1', name: 'iPhone' }] },
      problem: null,
      log: [],
      profiles,
    }),
};

// 登録した端末の一覧が、前のものに戻されていた（遠隔操作は止めている）
export const 一覧が戻されていた: Story = {
  beforeEach: () => registry(stateOf('https://mac.example.ts.net', { state: 'off' }), undefined, { devices: [], pairing: null, problem: 'rolled-back', profiles, log: [] }),
};
