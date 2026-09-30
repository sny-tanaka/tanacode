import type { Meta, StoryObj } from '@storybook/react-vite';
import type { Menu, MenuOption } from '@shared/screen';
import { MenuCard } from './MenuCard';

const option = (id: string, label: string, extra: Partial<MenuOption> = {}): MenuOption => ({
  id,
  label,
  description: '',
  pointed: false,
  checked: null,
  textInput: false,
  ...extra,
});

const question: Menu = {
  kind: 'question',
  tabs: [],
  title:
    '新規指摘 D1-1（staging.yml に注記を足す案）は、どう扱いますか？ 私の判断は次 PR メモ送りです。指摘の趣旨は今回の修正で満たされており、この注記は本 PR の目的の範囲外なので、PR 本文に残すだけにします。',
  context: [],
  options: [
    option('1', '次 PR メモ送り（推奨）', { description: '差分は変えず、PR 本文の「次 PR メモ」欄に 1 行記録して先へ進む', pointed: true }),
    option('2', '今修正する', { description: 'staging.yml:46 付近に注記を 1〜2 行足してコミットする' }),
    option('3', '不要として捨てる', { description: '記録せずに先へ進む' }),
    option('4', 'Type something.', { textInput: true }),
    option('5', 'Chat about this'),
  ],
  multiSelect: false,
  hint: 'Enter to select · ↑/↓ to navigate · Esc to cancel',
};

const meta = {
  title: 'チャット/質問のカード',
  component: MenuCard,
  args: { sessionId: 'story', menu: question },
} satisfies Meta<typeof MenuCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const 質問: Story = {};

export const 複数選択: Story = {
  args: {
    menu: {
      ...question,
      title: '直したい箇所をすべて選んでください',
      tabs: [
        { label: '直す箇所', answered: false },
        { label: '進め方', answered: true },
      ],
      multiSelect: true,
      options: [
        option('1', '送信ボタンの色', { checked: true, pointed: true }),
        option('2', 'インラインコード', { checked: false }),
        option('3', 'ターミナルの配色', { checked: true }),
        option('4', 'Type something.', { checked: false, textInput: true }),
        option('submit', 'Next'),
        option('5', 'Chat about this'),
      ],
    },
  },
};

export const 実行の許可: Story = {
  args: {
    menu: {
      kind: 'permission',
      tabs: [],
      title: 'Do you want to proceed?',
      context: ['Bash command', 'python3 -c "import time; time.sleep(30); print(42)"', '30秒待機してから42を出力'],
      options: [option('1', 'Yes', { pointed: true }), option('2', 'Yes, and don’t ask again for: python3 *'), option('3', 'No')],
      multiSelect: false,
      hint: 'Esc to cancel · Tab to amend',
    },
  },
};

// 選択肢にプレビューがある質問。ホバーした選択肢のプレビューが下に出る
export const プレビュー付き: Story = {
  args: {
    menu: {
      ...question,
      title: '今回の移行はワークスペース全体の移行ですか？',
      tabs: [
        { label: '移行範囲', answered: false },
        { label: 'Chatbot認可状況', answered: false },
      ],
      previewLayout: true,
      options: [
        option('1', 'ワークスペース全体を新アカウントへ移行（こちらの想定に近い）', {
          pointed: true,
          preview: '新ワークスペース\n├─ #dev\n├─ #dev-notify-deploy\n└─ #grp_パーソナリティ開発部\n\n旧ワークスペース: 廃止',
        }),
        option('2', '一部のチャンネルのみ新ワークスペースへ移行', {
          preview: '新ワークスペース\n└─ #grp_パーソナリティ開発部\n\n旧ワークスペース\n├─ #dev\n└─ #dev-notify-deploy',
        }),
        option('3', 'まだ決めていない'),
      ],
    },
  },
};
