import type { Meta, StoryObj } from '@storybook/react-vite';
import { fireEvent, userEvent } from 'storybook/test';
import { elicitationFieldsOf, type PendingElicitation } from '@shared/elicitation';
import { mockApi } from '../../../../.storybook/mockApi';
import { ElicitationCard } from './ElicitationCard';

// MCP サーバーから人への質問（Claude Code の elicitation）のカード。フォームの形は項目の入力欄を並べ、URL の形はページを開くかを聞く

const SCHEMA = {
  type: 'object',
  properties: {
    target: { type: 'string', title: '出す先', description: '本番に出すときは、先にステージングで確かめてください', oneOf: [{ const: 'stg', title: 'ステージング' }, { const: 'prod', title: '本番' }] },
    replicas: { type: 'integer', title: '台数', minimum: 1, maximum: 5, default: 2 },
    owner: { type: 'string', title: '担当者のメール', format: 'email' },
    when: { type: 'string', title: '出す日時', format: 'date-time' },
    day: { type: 'string', title: '確かめる日', format: 'date' },
    note: { type: 'string', title: 'メモ', maxLength: 40 },
    notify: { type: 'boolean', title: '終わったら Slack に知らせる', default: true },
    regions: { type: 'array', title: '地域', items: { anyOf: [{ const: 'jp', title: '日本' }, { const: 'us', title: 'アメリカ' }, { const: 'eu', title: 'ヨーロッパ' }] }, minItems: 1 },
  },
  required: ['target', 'owner', 'regions'],
};

const form = (over: Partial<PendingElicitation> = {}): PendingElicitation => ({
  id: 'e1',
  server: 'deploy',
  message: 'どこに出しますか？',
  title: null,
  description: null,
  mode: 'form',
  url: null,
  openable: false,
  ...elicitationFieldsOf(SCHEMA),
  opened: false,
  ...over,
});

const url = (over: Partial<PendingElicitation> = {}): PendingElicitation => ({
  ...form(),
  id: 'u1',
  server: 'github',
  message: 'GitHub のアカウントをつなぐため、ログインしてください。',
  mode: 'url',
  url: 'https://github.com/login/oauth/authorize?client_id=Iv1.8a61f9b3a7aba766&state=4f2c',
  openable: true,
  fields: [],
  unsupported: [],
  ...over,
});

const meta = {
  title: 'チャット/MCP サーバーの質問のカード',
  component: ElicitationCard,
  args: { sessionId: 'story', elicitation: form() },
  // 送ると、待っている質問が無くなってカードが消える（ここでは、送れたことにして何も変えない）
  beforeEach: () => mockApi({ 'elicitation.reply': () => Promise.resolve(true) }),
} satisfies Meta<typeof ElicitationCard>;

export default meta;
type Story = StoryObj<typeof meta>;

// 項目の種類をひととおり（選択肢・整数・メール・日時・日付・文字・はい／いいえ・複数選択）。必須には印、既定値は入れておく
export const フォーム: Story = {};

// 送ろうとしたときの入力の誤り（必須の空欄・メールの形・上限を超えた数）。項目ごとに赤くして、送らない
export const 入力の誤り: Story = {
  // 打つのではなく値を入れる（キーの入力は、窓に焦点が無いと届かない。アプリ内ブラウザは裏で動く）
  play: async ({ canvasElement }) => {
    fireEvent.change(canvasElement.querySelector<HTMLInputElement>('input[type="email"]')!, { target: { value: 'tanaka' } });
    fireEvent.change(canvasElement.querySelector<HTMLInputElement>('input[type="number"]')!, { target: { value: '9' } });
    await userEvent.click(canvasElement.querySelector<HTMLButtonElement>('button.menu-option.submit')!);
  },
};

// MCP サーバーが見出しと説明を付けた質問
export const 見出しと説明: Story = {
  args: {
    elicitation: form({
      title: '本番に出す前の確認',
      description: 'この答えは deploy サーバーにだけ渡ります',
      ...elicitationFieldsOf({ type: 'object', properties: { reason: { type: 'string', title: '出す理由' } }, required: ['reason'] }),
    }),
  },
};

// 項目の無い質問。確かめるだけで、送ると空の中身で accept
export const 確かめるだけ: Story = { args: { elicitation: form({ message: 'キャッシュを消してから続けますか？', fields: [], unsupported: [] }) } };

// tanacode が出せない形の項目（入れ子など）がある。断ることだけできる
export const 出せない項目: Story = {
  args: { elicitation: form({ ...elicitationFieldsOf({ type: 'object', properties: { address: { type: 'object', properties: {} }, tags: { type: 'array' } } }) }) },
};

// URL の形。開くページのホストを目立たせ、ふだんのブラウザで開く
export const URL: Story = { args: { elicitation: url() } };

// user@host の形の URL。本当に開くホストのほうを目立たせる
export const 見せかけのホスト: Story = { args: { elicitation: url({ url: 'https://github.com@login.example-evil.com/oauth' }) } };

// http・https でないページは開かない
export const 開けないページ: Story = { args: { elicitation: url({ url: 'javascript:alert(document.cookie)', openable: false }) } };

// ページを開いたあと、MCP サーバーが完了を知らせるまで（もう一度開く・閉じる）
export const 完了待ち: Story = { args: { elicitation: url({ id: 'opened:u1', opened: true }) } };

// 送ろうとしたときに、もう答えられなかった（スマホで答えた・Claude Code が取り下げた）
export const 答えられなかったとき: Story = {
  args: { elicitation: form({ fields: [], unsupported: [] }) },
  beforeEach: () => mockApi({ 'elicitation.reply': () => Promise.resolve(false) }),
  play: async ({ canvasElement }) => {
    await userEvent.click(canvasElement.querySelector<HTMLButtonElement>('button.menu-option.submit')!);
  },
};
