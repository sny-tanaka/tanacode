import type { Meta, StoryObj } from '@storybook/react-vite';
import type { DirEntry, FileChange } from '@shared/ipc';
import { t } from '@shared/i18n';
import { mockApi } from '../../../../.storybook/mockApi';
import { AddIcon, IconButton } from '../icons';
import { Explorer } from './Explorer';

// エクスプローラー。セッションのフォルダのツリーの下に、ワークスペースに追加したフォルダのツリーを並べる。
// 見出しの ＋ でフォルダを追加し、追加したフォルダの行にマウスを乗せると出る × で外す（操作は何もしないモック）。
// 追加したフォルダの行は絶対パスで持ち、git の色とブランチの変更の印は出さない（src/renderer/src/explorer）

const ROOT = '/Users/me/work/shop';
const API = '/Users/me/work/shop-api';
const DESIGN = '/Users/me/work/design-tokens';

const dir = (parent: string, name: string): DirEntry => ({ name, path: parent ? `${parent}/${name}` : name, isDir: true });
const file = (parent: string, name: string): DirEntry => ({ name, path: parent ? `${parent}/${name}` : name, isDir: false });

const DIRS: Record<string, DirEntry[]> = {
  '': [dir('', 'src'), file('', 'package.json'), file('', 'README.md')],
  src: [file('src', 'cart.ts'), file('src', 'tax.ts')],
  [API]: [dir(API, 'routes'), file(API, 'package.json')],
  [`${API}/routes`]: [file(`${API}/routes`, 'orders.ts'), file(`${API}/routes`, 'prices.ts')],
  [DESIGN]: [file(DESIGN, 'colors.json'), file(DESIGN, 'spacing.json')],
};

const CHANGES: Record<string, FileChange> = { 'src/tax.ts': { kind: 'modified', added: 4, removed: 1 } };

function Demo({ folders, editable = true, activePath = null }: { folders: string[]; editable?: boolean; activePath?: string | null }) {
  return (
    <div className="explorer" style={{ height: 520, border: '1px solid var(--border-subtle)' }}>
      <div className="side-panel">
        <div className="side-panel-title">
          {t('app.sidePanel.filesLabel')}
          {editable && <IconButton size="sm" icon={AddIcon} label={t('app.sidePanel.addFolder')} tip={t('app.sidePanel.addFolderTip')} onClick={() => {}} />}
        </div>
        <div className="side-body">
          <Explorer
            sessionId="s1"
            root={ROOT}
            rootName="shop"
            activePath={activePath}
            changes={CHANGES}
            knowledge={{ 'src/tax.ts': 'edited', [`${API}/routes/prices.ts`]: 'read' }}
            gitMarks={{ 'src/tax.ts': 'modified' }}
            onOpenFile={() => {}}
            folders={folders}
            onRemoveFolder={editable ? () => {} : undefined}
          />
        </div>
      </div>
    </div>
  );
}

const meta = {
  title: 'サイドパネル/エクスプローラー',
  component: Demo,
  parameters: { width: 300 },
  beforeEach: () => {
    mockApi({ 'workspace.listDir': (_id, path) => Promise.resolve(DIRS[path as string] ?? []) });
  },
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const 追加したフォルダなし: Story = { args: { folders: [] } };
// 開いているファイル（prices.ts）が追加したフォルダの中なら、そのツリーで親を開いて選ぶ。Claude が読んだ印も出る
export const 追加したフォルダあり: Story = { args: { folders: [API, DESIGN], activePath: `${API}/routes/prices.ts` } };
// アーカイブしたセッション（と worktree の準備を待っている間）は、追加も外すこともできない
export const 変えられないとき: Story = { args: { folders: [API, DESIGN], editable: false } };
