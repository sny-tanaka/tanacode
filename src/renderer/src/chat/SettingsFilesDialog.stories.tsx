import type { Meta, StoryObj } from '@storybook/react-vite';
import type { SessionSummary } from '@shared/ipc';
import type { SettingsFile } from '@shared/settings-file';
import { mockApi } from '../../../../.storybook/mockApi';
import { SettingsFilesDialog } from './SettingsFilesDialog';

// 設定ファイルの管理ダイアログ。追加・名前の変更・削除は、ストーリーの中の登録に反映される（main の代わりに返事を決めている）

const noop = () => {};

const FILES: SettingsFile[] = [
  { id: 'f1', name: 'litellm', path: '/Users/me/.claude/settings-litellm.json', error: null, model: 'sonnet' },
  { id: 'f2', name: 'bedrock', path: '/Users/me/.claude/settings-bedrock.json', error: null, model: null },
  {
    id: 'f3',
    name: 'ゲートウェイ（検証用のとても長い名前をつけた設定ファイル、折り返さずに省略されるか）',
    path: '/Users/me/work/clients/example-company/infrastructure/claude-code/gateways/staging/settings.gateway.json',
    error: 'ファイルが見つかりません',
    model: null,
  },
];

// 使っているセッション（f1 を 2 件。削除の確認に件数が出る）
const SESSIONS = [{ settingsFile: 'f1' }, { settingsFile: 'f1' }, { settingsFile: null }] as SessionSummary[];

// main の代わりに、登録を持って list / add / rename / remove に答える。変わったら onChanged で知らせる
function registry(initial: SettingsFile[]) {
  let files = initial;
  let seq = 0;
  const listeners = new Set<(files: SettingsFile[]) => void>();
  const set = (next: SettingsFile[]) => {
    files = next;
    listeners.forEach((listener) => listener(files));
  };
  // main の失敗は「Error invoking remote method '…': Error: <本文>」の形で届く
  const fail = (reason: string) => Promise.reject(new Error(`Error invoking remote method 'settings-files': Error: ${reason}`));
  mockApi({
    'settingsFiles.list': () => Promise.resolve(files),
    'settingsFiles.onChanged': (listener) => {
      listeners.add(listener as (files: SettingsFile[]) => void);
      return () => listeners.delete(listener as (files: SettingsFile[]) => void);
    },
    'settingsFiles.pick': () => Promise.resolve(`/Users/me/.claude/settings-new-${++seq}.json`),
    'settingsFiles.add': (path) => {
      const file: SettingsFile = { id: `n${seq}`, name: `new-${seq}`, path: String(path), error: null, model: null };
      set([...files, file]);
      return Promise.resolve(file);
    },
    'settingsFiles.rename': (id, name) => {
      if (!String(name).trim()) return fail('名前が空です');
      if (files.some((f) => f.id !== id && f.name === name)) return fail(`「${String(name)}」はもう使われています`);
      set(files.map((f) => (f.id === id ? { ...f, name: String(name) } : f)));
      return Promise.resolve();
    },
    'settingsFiles.remove': (id) => {
      set(files.filter((f) => f.id !== id));
      return Promise.resolve();
    },
    'sessions.list': () => Promise.resolve(SESSIONS),
  });
}

const meta = {
  title: 'チャット/設定ファイルの管理',
  component: SettingsFilesDialog,
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
} satisfies Meta<typeof SettingsFilesDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

// 登録した設定ファイルの一覧。名前をクリックすると、その場で直せる（Enter か枠の外で確定・Escape で取り消し）。読めないものは理由が赤で出る
export const 登録あり: Story = { beforeEach: () => registry(FILES) };

// まだ登録していないとき
export const 登録なし: Story = { beforeEach: () => registry([]) };
