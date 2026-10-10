// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsFile } from '@shared/settings-file';
import { SettingsFilesDialog } from '../../src/renderer/src/chat/SettingsFilesDialog';
import { closeSettingsFilesDialog, SettingsFileSelect, useSettingsFilesDialogOpen } from '../../src/renderer/src/chat/settingsFiles';
import './dom';
import { mockApi } from './mock-api';

// 登録した設定ファイルの選択欄と管理のダイアログ。登録・名前の変更・登録から外す・閉じる、を押して、main に正しく頼むかを確かめる

const file = (id: string, name: string, over: Partial<SettingsFile> = {}): SettingsFile => ({ id, name, path: `/Users/me/.claude/${id}.json`, error: null, model: null, ...over });
const LITELLM = file('f1', 'LiteLLM');
const BEDROCK = file('f2', 'Bedrock', { error: 'ファイルがありません' });

let api: ReturnType<typeof mockApi>;
let alerts: string[];
let confirms: string[];
let confirmAnswer: boolean;
function install(responses: Parameters<typeof mockApi>[0] = {}) {
  api = mockApi({ 'settingsFiles.list': () => Promise.resolve([LITELLM]), ...responses });
  api.install();
}
beforeEach(() => {
  install();
  alerts = [];
  confirms = [];
  confirmAnswer = true;
  vi.spyOn(window, 'alert').mockImplementation((message) => void alerts.push(String(message)));
  vi.spyOn(window, 'confirm').mockImplementation((message) => {
    confirms.push(String(message));
    return confirmAnswer;
  });
});
afterEach(() => {
  cleanup();
  closeSettingsFilesDialog();
  vi.restoreAllMocks();
});

// IPC の返事を待つ
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));
// 名前の欄。出たらすぐ打てる（届いた名前への合わせ直しが、あとから打った名前を戻さない）
const nameInput = async (name: string) => (await screen.findByDisplayValue(name)) as HTMLInputElement;

describe('設定ファイルの選択欄（SettingsFileSelect）', () => {
  function Harness({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) {
    const open = useSettingsFilesDialogOpen();
    return (
      <>
        <SettingsFileSelect value={value} files={[LITELLM, BEDROCK]} title="設定ファイル" onChange={onChange} />
        {open && <div>管理のダイアログ</div>}
      </>
    );
  }
  const select = () => screen.getByTitle('設定ファイル') as HTMLSelectElement;

  it('設定ファイルを選ぶとその ID を、「標準」を選ぶと null を渡す。「管理…」は選んでいるものを変えずに、管理のダイアログを開く', () => {
    const onChange = vi.fn();
    render(<Harness value={null} onChange={onChange} />);
    // 読めない設定ファイルは選べない
    expect([...select().options].map((o) => [o.textContent, o.disabled])).toEqual([
      ['標準', false],
      ['LiteLLM', false],
      ['Bedrock（読めません）', true],
      ['──────', true],
      ['管理…', false],
    ]);
    fireEvent.change(select(), { target: { value: 'f1' } });
    expect(onChange).toHaveBeenLastCalledWith('f1');
    fireEvent.change(select(), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(screen.queryByText('管理のダイアログ')).toBeNull();
    fireEvent.change(select(), { target: { value: '__manage__' } });
    expect(screen.getByText('管理のダイアログ')).toBeTruthy();
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('登録から外した設定ファイルを選んでいるときは、「（登録なし）」と出す（黙って標準に見せない）', () => {
    render(<Harness value="gone" onChange={() => {}} />);
    expect(select().value).toBe('gone');
    expect(select().selectedOptions[0].textContent).toBe('（登録なし）');
  });
});

describe('設定ファイルの管理（SettingsFilesDialog）', () => {
  it('外側を押すと閉じ、ダイアログの中を押しても閉じない', async () => {
    const onClose = vi.fn();
    const { container } = render(<SettingsFilesDialog onClose={onClose} />);
    await nameInput('LiteLLM');
    fireEvent.mouseDown(screen.getByRole('dialog', { name: '設定ファイル' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(container.querySelector('.overlay')!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Esc で閉じる（変換中の Esc では閉じない）。「閉じる」でも閉じる', async () => {
    const onClose = vi.fn();
    render(<SettingsFilesDialog onClose={onClose} />);
    const dialog = screen.getByRole('dialog', { name: '設定ファイル' });
    // 開くとダイアログにフォーカスを移す（Esc を受けられるように）
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(dialog, { key: 'Escape', isComposing: true });
    fireEvent.keyDown(dialog, { key: 'Enter' });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('名前を打って欄を離れると、その設定ファイルの名前を変える。変えていなければ頼まない。Enter でも確定する', async () => {
    render(<SettingsFilesDialog onClose={() => {}} />);
    const input = await nameInput('LiteLLM');
    input.focus();
    fireEvent.blur(input);
    expect(api.argsOf('settingsFiles.rename')).toEqual([]);
    fireEvent.change(input, { target: { value: 'LiteLLM（社内）' } });
    expect(input.value).toBe('LiteLLM（社内）');
    fireEvent.blur(input);
    expect(api.argsOf('settingsFiles.rename')).toEqual([['f1', 'LiteLLM（社内）']]);
    input.focus();
    fireEvent.change(input, { target: { value: 'プロキシ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(document.activeElement).not.toBe(input);
    expect(api.argsOf('settingsFiles.rename')).toEqual([
      ['f1', 'LiteLLM（社内）'],
      ['f1', 'プロキシ'],
    ]);
  });

  it('名前の欄の Esc は、打った名前を戻すだけで、名前を変えず、ダイアログも閉じない', async () => {
    const onClose = vi.fn();
    render(<SettingsFilesDialog onClose={onClose} />);
    const input = await nameInput('LiteLLM');
    input.focus();
    fireEvent.change(input, { target: { value: '書きかけ' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('LiteLLM');
    expect(document.activeElement).not.toBe(input);
    expect(api.argsOf('settingsFiles.rename')).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
    // 戻したあとは、ふだんどおり名前を変えられる
    input.focus();
    fireEvent.change(input, { target: { value: '本番' } });
    fireEvent.blur(input);
    expect(api.argsOf('settingsFiles.rename')).toEqual([['f1', '本番']]);
  });

  it('名前を変えられなかったら、名前を戻してわけを出す', async () => {
    install({ 'settingsFiles.rename': () => Promise.reject(new Error("Error invoking remote method 'settings-files:rename': Error: 同じ名前があります")) });
    render(<SettingsFilesDialog onClose={() => {}} />);
    const input = await nameInput('LiteLLM');
    fireEvent.change(input, { target: { value: 'Bedrock' } });
    fireEvent.blur(input);
    await waitFor(() => expect(input.value).toBe('LiteLLM'));
    expect(alerts).toEqual(['名前を変えられませんでした: 同じ名前があります']);
  });

  it('名前を直している途中に「閉じる」を押すと、名前を確定してから閉じる', async () => {
    const onClose = vi.fn();
    render(<SettingsFilesDialog onClose={onClose} />);
    const input = await nameInput('LiteLLM');
    input.focus();
    fireEvent.change(input, { target: { value: 'ステージング' } });
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(api.argsOf('settingsFiles.rename')).toEqual([['f1', 'ステージング']]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('「追加」でファイルを選んで登録し、増えた行の名前の欄にフォーカスを移す。選ぶのをやめたら登録しない', async () => {
    const added = file('f3', 'settings-proxy');
    let pick: (path: string | null) => void = () => {};
    install({
      'settingsFiles.pick': () => new Promise((resolve) => (pick = resolve)),
      'settingsFiles.add': () => {
        // 一覧の知らせが、登録の返事より先に届く
        api.emit('settingsFiles.onChanged', [LITELLM, added]);
        return Promise.resolve(added);
      },
    });
    render(<SettingsFilesDialog onClose={() => {}} />);
    await nameInput('LiteLLM');
    const add = screen.getByRole('button', { name: '追加' }) as HTMLButtonElement;
    fireEvent.click(add);
    // ファイルを選んでいる間は押せない
    expect(add.disabled).toBe(true);
    await act(async () => pick('/Users/me/.claude/settings-proxy.json'));
    await settle();
    expect(api.argsOf('settingsFiles.add')).toEqual([['/Users/me/.claude/settings-proxy.json']]);
    expect(document.activeElement).toBe(await nameInput('settings-proxy'));
    expect(add.disabled).toBe(false);
    fireEvent.click(add);
    await act(async () => pick(null));
    await settle();
    expect(api.argsOf('settingsFiles.add')).toHaveLength(1);
    expect(add.disabled).toBe(false);
  });

  it('登録できなかったら、わけを出す', async () => {
    install({ 'settingsFiles.pick': () => Promise.resolve('/tmp/broken.json'), 'settingsFiles.add': () => Promise.reject(new Error('JSON として読めません')) });
    render(<SettingsFilesDialog onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '追加' }));
    await waitFor(() => expect(alerts).toEqual(['登録できませんでした: JSON として読めません']));
  });

  it('「削除」は、使っているセッションの数を添えて確かめてから、その設定ファイルを登録から外す。やめたら外さない', async () => {
    install({
      'sessions.list': () => Promise.resolve([{ id: 's1', settingsFile: 'f1' }, { id: 's2', settingsFile: null }]),
    });
    render(<SettingsFilesDialog onClose={() => {}} />);
    await nameInput('LiteLLM');
    confirmAnswer = false;
    fireEvent.click(screen.getByRole('button', { name: '削除' }));
    await settle();
    expect(confirms).toEqual(['「LiteLLM」を登録から外します（ファイル自体は消えません）。\n使っているセッションが 1 件あります。次に起動するときに断られます。']);
    expect(api.argsOf('settingsFiles.remove')).toEqual([]);
    confirmAnswer = true;
    fireEvent.click(screen.getByRole('button', { name: '削除' }));
    await settle();
    expect(api.argsOf('settingsFiles.remove')).toEqual([['f1']]);
    // 押した行が消えても、Esc で閉じられるよう、ダイアログにフォーカスを戻す
    expect(document.activeElement).toBe(screen.getByRole('dialog', { name: '設定ファイル' }));
  });
});
