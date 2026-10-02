import type { Meta, StoryObj } from '@storybook/react-vite';
import { normalizeHostPattern } from '@shared/browser-tools';
import { mockApi } from '../../../../.storybook/mockApi';
import { BrowserHostsDialog } from './BrowserHostsDialog';

// アプリ内ブラウザで Claude に許す先（メニューの「アプリ内ブラウザで Claude に許す先…」から開く）。
// 追加・削除は、ストーリーの中の一覧に反映される（main の代わりに返事を決めている）

const noop = () => {};

function registry(initial: string[]) {
  let hosts = initial;
  mockApi({
    'browser.hosts': () => Promise.resolve(hosts),
    'browser.setHosts': (next) => {
      const list = next as string[];
      const bad = list.filter((h) => !normalizeHostPattern(h));
      // main の失敗は「Error invoking remote method '…': Error: <本文>」の形で届く
      if (bad.length > 0) return Promise.reject(new Error(`Error invoking remote method 'browser:hosts-set': Error: 書き方が違います: ${bad.join('、')}`));
      hosts = [...new Set(list.map((h) => normalizeHostPattern(h)!))];
      return Promise.resolve(hosts);
    },
  });
}

const meta = {
  title: 'ブラウザ/Claude に許す先',
  component: BrowserHostsDialog,
  parameters: { bare: true },
  args: { onClose: noop },
  // ダイアログの後ろに、アプリの地の色を敷く
  decorators: [
    (Story) => (
      <div style={{ minHeight: '100vh', background: 'var(--bg-panel)' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof BrowserHostsDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

// 足した先がある。既定（localhost・127.0.0.1・*.local）は消せない
export const 足した先あり: Story = { beforeEach: () => registry(['myapp.test', '*.staging.example.test', '192.168.0.10']) };

// 既定だけ。書き方の違う先（「*」など）を足そうとすると、赤で理由が出る
export const 既定だけ: Story = { beforeEach: () => registry([]) };
