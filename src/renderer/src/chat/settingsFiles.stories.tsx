import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import type { SettingsFile } from '@shared/settings-file';
import { SettingsFilesDialog } from './SettingsFilesDialog';
import { closeSettingsFilesDialog, SettingsFileSelect, useSettingsFilesDialogOpen } from './settingsFiles';

// 設定ファイルの選択欄（チャットの入力欄の下と、新規セッションの画面にある）。標準以外を選ぶと色が付く。
// 末尾の「管理…」を選ぶと管理ダイアログが開く（アプリでは App が 1 つだけ置いている）

const FILES: SettingsFile[] = [
  { id: 'f1', name: 'litellm', path: '/Users/me/.claude/settings-litellm.json', error: null, model: 'sonnet' },
  { id: 'f2', name: 'bedrock', path: '/Users/me/.claude/settings-bedrock.json', error: null, model: null },
  { id: 'f3', name: 'ゲートウェイ', path: '/Users/me/work/gateway.json', error: 'ファイルが見つかりません', model: null },
];

// 選んだ設定ファイルが、そのまま選択欄に出る
function Demo({ files, initial }: { files: SettingsFile[]; initial: string | null }) {
  const [value, setValue] = useState(initial);
  const open = useSettingsFilesDialogOpen();
  return (
    <div className="chat-options">
      <SettingsFileSelect value={value} files={files} title="設定ファイル" onChange={setValue} />
      {open && <SettingsFilesDialog onClose={closeSettingsFilesDialog} />}
    </div>
  );
}

const meta = {
  title: 'チャット/設定ファイルの選択欄',
  component: Demo,
  parameters: { width: 360 },
  args: { files: FILES, initial: null },
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

// 標準のとき。色は付かない
export const 標準: Story = {};

// 登録した設定ファイルを選んでいるとき。別の設定で動いていると分かるよう、黄色になる
export const 選んでいる: Story = { args: { initial: 'f1' } };

// 選んでいた設定ファイルを登録から外したとき。黙って標準に見せず、「（登録なし）」と出す
export const 登録なし: Story = { args: { initial: 'gone' } };

// 登録が 0 件でも選択欄は出る（「管理…」から最初の 1 件を登録する）
export const 登録が0件: Story = { args: { files: [] } };
