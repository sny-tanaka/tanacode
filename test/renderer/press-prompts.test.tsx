// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyPromptChanges, defaultPrompt, type CustomPrompts, type PromptChanges } from '@shared/prompts';
import { PromptsDialog } from '../../src/renderer/src/prompts/PromptsDialog';
import './dom';
import { mockApi } from './mock-api';

// Claude に送る文のダイアログ（PromptsDialog。メニューの「Claude に送る文…」から開く）のボタン・入力を押して、効いたことを確かめる

let api: ReturnType<typeof mockApi>;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function open(saved: CustomPrompts = {}, update: (changes: PromptChanges) => Promise<CustomPrompts> = (changes) => Promise.resolve(applyPromptChanges(saved, changes))) {
  const onClose = vi.fn();
  api = mockApi({ 'prompts.get': () => Promise.resolve(saved), 'prompts.update': update as never });
  api.install();
  render(<PromptsDialog onClose={onClose} />);
  await screen.findByLabelText('本文');
  return onClose;
}

const field = (label: string) => screen.getByLabelText(label) as HTMLTextAreaElement;
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const tab = (name: string) => screen.getByRole('tab', { name: new RegExp(name) });
const type = (label: string, text: string) => fireEvent.change(field(label), { target: { value: text } });

describe('PromptsDialog', () => {
  it('欄には既定の文が入っている。変えて保存すると、変えた欄だけを送って閉じる（変えるまでは保存できない。触っていない欄は送らないので、ほかの窓で変えた欄を消さない）', async () => {
    const onClose = await open();
    expect(field('本文').value).toBe(defaultPrompt('usageResume'));
    // メニューの項目の名前は、メニューと同じ文言を差し込む
    expect(document.querySelector('.prompts-about')?.textContent).toContain('メニューの「tanacode → 利用枠で止まったら、戻ったときに自動で再開する」がオンのとき');
    expect(button('保存').disabled).toBe(true);
    expect(button('既定に戻す').disabled).toBe(true);
    expect(screen.queryByText('変更済み')).toBeNull();
    type('本文', '枠が戻りました。続けてください。');
    expect(field('本文').value).toBe('枠が戻りました。続けてください。');
    // 文の種類と欄の両方に「変更済み」
    expect(screen.getAllByText('変更済み')).toHaveLength(2);
    expect(button('保存').disabled).toBe(false);
    fireEvent.click(button('保存'));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(api.argsOf('prompts.update')).toEqual([[{ usageResume: '枠が戻りました。続けてください。' }]]);
  });

  it('文の種類を切り替えると、その文の欄が出る。仕上げの頼みには注意と差し込みの印の説明、再開の文には {trigger} の説明', async () => {
    await open();
    expect(tab('利用枠からの再開').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('<tanacode-usage-limit-reset>')).toBeTruthy();
    expect(screen.queryByText('差し込みの印（送るときに、tanacode が値に置き換えます）')).toBeNull();
    // 利用枠からの再開は、ツールの使い方で見分けていないので、注意は出さない
    expect(screen.queryByText(/待つときにほかのツールを使わせる/)).toBeNull();

    fireEvent.click(tab('最適化圧縮の仕上げの頼み'));
    expect(tab('最適化圧縮の仕上げの頼み').getAttribute('aria-selected')).toBe('true');
    expect(field('本文（手動・自動とも）').value).toBe(defaultPrompt('handoff'));
    expect(field('自動（ターンの終わり）のときに足す文').value).toBe(defaultPrompt('handoffAutoTurnEnd'));
    expect(field('自動（ターンの途中で止めた）ときに足す文').value).toBe(defaultPrompt('handoffAutoMidTurn'));
    expect(screen.getByText(/会話を消したあとに残るのは、ここでチェックリストに書かせたことと/)).toBeTruthy();
    expect(screen.getByText('<tanacode-handoff>')).toBeTruthy();
    expect(screen.getByText(/どう始まったか。手動は「（ユーザーが「最適化圧縮」のボタンを押しました）」、自動は「（自動・コンテキスト 80%）」のように入ります。/)).toBeTruthy();
    expect(screen.getByText(/1 枚のカードの長さの目安（3,000 文字）/)).toBeTruthy();

    fireEvent.click(tab('最適化圧縮のあとの再開'));
    expect(field('本文（手動・ターンの終わりの自動）').value).toBe(defaultPrompt('resume'));
    expect(screen.getByText(/待つときにほかのツールを使わせる文にすると、報告して待っただけでも作業を続けたものとして扱い/)).toBeTruthy();
    expect(screen.queryByText(/会話を消したあとに残るのは/)).toBeNull();
    expect(field('本文（ターンの途中で止めた自動）').value).toBe(defaultPrompt('resumeMidTurn'));
    expect(field('仕上げができなかったときに足す文').value).toBe(defaultPrompt('resumeSkipped'));
    expect(screen.getByText('ターンの途中で止めて切り替えたときは、上の本文の代わりに、この文を送ります。')).toBeTruthy();
    expect(screen.getAllByText(/どう始まったか/)).toHaveLength(2);
    expect(screen.queryByText(/1 枚のカードの長さの目安/)).toBeNull();
  });

  it('変えた欄には「既定の文」が出て見比べられる。「既定に戻す」で既定の文に戻し、保存すると、その欄だけを既定に戻す（null を送る）', async () => {
    const onClose = await open({ resume: '報告して待ってください。{trigger}', usageResume: '続けてください。' });
    fireEvent.click(tab('最適化圧縮のあとの再開'));
    expect(field('本文（手動・ターンの終わりの自動）').value).toBe('報告して待ってください。{trigger}');
    expect(screen.getAllByText('既定の文')).toHaveLength(1);
    expect(screen.getByText('既定の文').closest('details')!.querySelector('pre')!.textContent).toBe(defaultPrompt('resume'));
    const resets = screen.getAllByRole('button', { name: '既定に戻す' }) as HTMLButtonElement[];
    expect(resets.map((b) => b.disabled)).toEqual([false, true, true]);
    // 開いたときのままなので、まだ保存できない
    expect(button('保存').disabled).toBe(true);
    fireEvent.click(resets[0]);
    expect(field('本文（手動・ターンの終わりの自動）').value).toBe(defaultPrompt('resume'));
    expect(screen.queryByText('既定の文')).toBeNull();
    expect((screen.getAllByRole('button', { name: '既定に戻す' })[0] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button('保存'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    // ほかの文で変えた欄は、送らない（main が今の保存の値に重ねるので、そのまま残る）
    expect(api.argsOf('prompts.update')).toEqual([[{ resume: null }]]);
  });

  it('既定の文と同じに打ち直した欄は、既定に戻す', async () => {
    const onClose = await open({ usageResume: '続けてください。' });
    type('本文', `${defaultPrompt('usageResume')}\n`);
    fireEvent.click(button('保存'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.argsOf('prompts.update')).toEqual([[{ usageResume: null }]]);
  });

  it('保存した文を読めなかったら、欄を出さずに理由を出す（保存もできない。キャンセルで閉じられる）', async () => {
    const onClose = vi.fn();
    api = mockApi({ 'prompts.get': () => Promise.reject(new Error("Error invoking remote method 'prompts:get': Error: 読めません")) });
    api.install();
    render(<PromptsDialog onClose={onClose} />);
    expect(await screen.findByText('保存した文を読めませんでした: 読めません')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(button('保存').disabled).toBe(true);
    fireEvent.click(button('キャンセル'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('欄を空にすると、理由を出して保存できない', async () => {
    await open();
    type('本文', '  \n');
    expect(screen.getByText('空にはできません。既定の文に戻すときは「既定に戻す」を押してください。')).toBeTruthy();
    expect(button('保存').disabled).toBe(true);
    type('本文', 'x');
    expect(screen.queryByText(/空にはできません/)).toBeNull();
    expect(button('保存').disabled).toBe(false);
  });

  it('保存に失敗したら理由を出し、開いたまま（打った文も残る）', async () => {
    const onClose = await open({}, () => Promise.reject(new Error("Error invoking remote method 'prompts:update': Error: 書き込めません")));
    type('本文', '続けて');
    fireEvent.click(button('保存'));
    expect(await screen.findByText('保存できませんでした: 書き込めません')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(field('本文').value).toBe('続けて');
    expect(button('保存').disabled).toBe(false);
  });

  it('外側を押す・Esc・キャンセルで閉じる。ダイアログの中を押しても、変換中の Esc でも閉じない', async () => {
    const onClose = await open();
    const dialog = screen.getByRole('dialog');
    expect(document.activeElement).toBe(dialog);
    fireEvent.mouseDown(dialog);
    fireEvent.mouseDown(field('本文'));
    fireEvent.keyDown(field('本文'), { key: 'Escape', isComposing: true });
    fireEvent.keyDown(field('本文'), { key: 'Enter' });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(field('本文'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(dialog.parentElement!);
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(button('キャンセル'));
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(api.argsOf('prompts.update')).toEqual([]);
  });

  it('保存していない変更があるときは、閉じる前に捨ててよいかを聞く。断ったら開いたまま', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const onClose = await open();
    type('本文', '続けて');
    fireEvent.click(button('キャンセル'));
    expect(confirm).toHaveBeenCalledWith('保存していない変更を捨てて閉じますか？');
    expect(onClose).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(api.argsOf('prompts.update')).toEqual([]);
  });

  it('保存の返事を待つあいだは、閉じられない', async () => {
    let resolve: (value: CustomPrompts) => void = () => {};
    const onClose = await open({}, () => new Promise((r) => (resolve = r)));
    type('本文', '続けて');
    fireEvent.click(button('保存'));
    expect(button('保存').disabled).toBe(true);
    expect(button('キャンセル').disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => resolve({ usageResume: '続けて' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
