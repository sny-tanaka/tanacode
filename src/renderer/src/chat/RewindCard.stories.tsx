import type { Meta, StoryObj } from '@storybook/react-vite';
import { RewindCard } from './RewindCard';

// 発言の横の「ここまで戻す」を押したときの確かめのカード。コードを戻すと変わるファイルを先に調べて出し、
// 会話とコード・会話だけ・コードだけのどれを戻すかを選ぶ
const CWD = '/Users/me/work/app';

const meta = {
  title: 'チャット/巻き戻しのカード',
  component: RewindCard,
  args: {
    preview: { files: [`${CWD}/src/Login.tsx`, `${CWD}/test/login.test.tsx`, `${CWD}/README.md`], insertions: 24, deletions: 7, codeError: null },
    cwd: CWD,
    busy: false,
    onChoose: () => {},
    onCancel: () => {},
  },
  decorators: [(Story) => <div style={{ maxWidth: 560 }}>{Story()}</div>],
} satisfies Meta<typeof RewindCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const 会話とコード: Story = {};

// 変わるファイルが多いときは 8 個まで出し、残りは数だけ。作業フォルダの外のファイルはそのままのパス
export const ファイルが多い: Story = {
  args: {
    preview: {
      files: [...Array.from({ length: 11 }, (_, i) => `${CWD}/src/pages/Page${i + 1}.tsx`), '/Users/me/.zshrc'],
      insertions: 310,
      deletions: 96,
      codeError: null,
    },
  },
};

// その発言のあと、Claude がファイルを変えていない
export const 変わるファイルが無い: Story = {
  args: { preview: { files: [], insertions: 0, deletions: 0, codeError: null } },
};

// ファイルの控えが無いなど、コードを戻せないときは会話だけ
export const コードを戻せない: Story = {
  args: { preview: { files: null, insertions: 0, deletions: 0, codeError: 'No file checkpoint found for this message.' } },
};

// 巻き戻している途中は押せない
export const 戻している途中: Story = {
  args: { busy: true },
};
