import type { Meta, StoryObj } from '@storybook/react-vite';
import { UnsavedDialog } from './UnsavedDialog';

// 別のフォルダへ移る前の、保存していない変更の確認。「保存して移る」は 1 秒かけて終わる（保存している間の表示を見るため）

const meta = {
  title: 'エディタ/保存していない変更の確認',
  component: UnsavedDialog,
  parameters: { bare: true },
  args: {
    files: ['src/menu/prices.ts'],
    onSave: () => new Promise((resolve) => setTimeout(resolve, 1000)),
    onDiscard: () => {},
    onCancel: () => {},
  },
} satisfies Meta<typeof UnsavedDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ファイルが1つ: Story = {};

// 長いパスと、いくつものファイル
export const ファイルがいくつも: Story = {
  args: { files: ['src/menu/prices.ts', 'README.md', 'docs/guides/how-to-add-a-new-seasonal-drink-to-the-menu.md'] },
};

// ディスク側（Claude など）でも変わったファイルがある（分けて示し、「保存して移る」は押せない）
export const 衝突中のファイルがある: Story = {
  args: { files: ['README.md'], conflicts: ['src/menu/prices.ts'] },
};

// 保存に失敗する（理由を出し、ダイアログは開いたまま）
export const 保存に失敗する: Story = {
  args: { onSave: () => Promise.reject(new Error('EACCES: permission denied')) },
};
