import type { Meta, StoryObj } from '@storybook/react-vite';
import { fireEvent, userEvent, within } from 'storybook/test';
import { t } from '@shared/i18n';
import { applyPromptChanges, type CustomPrompts, type PromptChanges } from '@shared/prompts';
import { mockApi } from '../../../../.storybook/mockApi';
import { PromptsDialog } from './PromptsDialog';

// tanacode が人の代わりに Claude に送る文（メニューの「Claude に送る文…」から開く）。
// 保存は、ストーリーの中で覚える（main の代わりに返事を決めている）

const noop = () => {};

// fail: 保存できない（save）・読めない（load）
function registry(initial: CustomPrompts, fail?: 'save' | 'load') {
  let saved = initial;
  mockApi({
    // main の失敗は「Error invoking remote method '…': Error: <本文>」の形で届く
    'prompts.get': () =>
      fail === 'load' ? Promise.reject(new Error("Error invoking remote method 'prompts:get': Error: EACCES: permission denied, open 'settings.json'")) : Promise.resolve(saved),
    'prompts.update': (changes) => {
      if (fail === 'save') return Promise.reject(new Error("Error invoking remote method 'prompts:update': Error: EACCES: permission denied, open 'settings.json.tmp'"));
      saved = applyPromptChanges(saved, changes as PromptChanges);
      return Promise.resolve(saved);
    },
  });
}

const tab = (canvas: HTMLElement, group: 'usageResume' | 'handoff' | 'resume') => within(canvas).findByRole('tab', { name: new RegExp(t(`prompts.group.${group}`)) });

const meta = {
  title: '設定/Claude に送る文',
  component: PromptsDialog,
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
} satisfies Meta<typeof PromptsDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

// 何も変えていない。欄には既定の文（画面の言語）が入っていて、そこから直す
export const 既定のまま: Story = { beforeEach: () => registry({}) };

// 仕上げの頼み。会話を消したあとに残るものの注意と、差し込みの印（{trigger}・{chars}）の説明が出る（再開の文のタブにも、待ち方の注意が出る）
export const 仕上げの頼み: Story = {
  beforeEach: () => registry({}),
  play: async ({ canvasElement }) => {
    await userEvent.click(await tab(canvasElement, 'handoff'));
  },
};

// 再開の文を変えてある。左の文の種類と欄に「変更済み」が出て、「既定の文」を開くと見比べられる
export const 変えた文あり: Story = {
  beforeEach: () =>
    registry({
      resume: 'tanacode は、会話を圧縮する代わりに消しました{trigger}。\n- まず checklist_overview で全部のリストを読んでください。\n- 作業は続けず、引き継いだことを短く伝えて、ユーザーの指示を待ってください。',
      usageResume: '利用枠が戻りました。止まったところを確かめて、作業を続けてください。',
    }),
  play: async ({ canvasElement }) => {
    await userEvent.click(await tab(canvasElement, 'resume'));
    await userEvent.click(within(canvasElement).getAllByText(t('prompts.showDefault'))[0]);
  },
};

// 欄を空にした。理由が出て、保存できない
export const 空の欄: Story = {
  beforeEach: () => registry({}),
  play: async ({ canvasElement }) => {
    // 入力欄は fireEvent で変える（userEvent で打った文字は、Storybook では部品の状態に届かないことがある）
    fireEvent.change(await within(canvasElement).findByLabelText(t('prompts.label.usageResume')), { target: { value: '' } });
  },
};

// 保存できなかった（設定のファイルに書けない）。理由を出し、ダイアログは開いたまま
export const 保存に失敗: Story = {
  beforeEach: () => registry({}, 'save'),
  play: async ({ canvasElement }) => {
    const field = await within(canvasElement).findByLabelText<HTMLTextAreaElement>(t('prompts.label.usageResume'));
    fireEvent.change(field, { target: { value: `${field.value}\n- 続ける前に、変更が残っていないか確かめてください。` } });
    await userEvent.click(within(canvasElement).getByRole('button', { name: t('common.save') }));
  },
};

// 保存した文を読めなかった。欄は出さずに理由を出す（分からないまま直させると、保存で上書きしてしまう）
export const 読めない: Story = { beforeEach: () => registry({}, 'load') };
