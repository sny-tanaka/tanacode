import { afterEach, describe, expect, it, vi } from 'vitest';
import { IpcChannel, type BrowserMirroring } from '@shared/ipc';
import { realTime, setup } from './helpers/browser-control';

// BrowserControl のミラーリングの口（スマホの画面に、アプリ内ブラウザのタブを映す。Issue #464）

vi.mock('electron', async () => (await import('./helpers/fake-electron')).electronModule);

afterEach(() => vi.useRealTimers());

describe('BrowserControl のミラーリングの口', () => {
  it('タブの一覧は、URL・題名・Mac で選んでいるかを返す（ポップアップは除く）。知らないセッションは空', () => {
    realTime();
    const { control, open } = setup();
    open('https://example.com/a', { title: 'A' });
    open('https://example.com/b', { title: 'B', activate: false });
    expect(control.mirrorTabs('S1')).toEqual([
      { tabId: 'tab-1', url: 'https://example.com/a', title: 'A', active: true },
      { tabId: 'tab-2', url: 'https://example.com/b', title: 'B', active: false },
    ]);
    expect(control.mirrorTabs('nope')).toEqual([]);
    expect(control.mirrorGuest('S1', 'tab-1')).not.toBeNull();
    expect(control.mirrorGuest('S1', 'tab-9')).toBeNull();
  });

  it('移動: 戻る・進むは履歴があるときだけ。再読み込み。開く先は http(s) だけ。形が違えば false', () => {
    realTime();
    const { control, open } = setup();
    const page = open('https://example.com/a');
    page.history = { entries: ['https://example.com/0', 'https://example.com/a'], index: 1 };
    expect(control.mirrorNavigate('S1', 'tab-1', { kind: 'forward' })).toBe(false);
    expect(control.mirrorNavigate('S1', 'tab-1', { kind: 'back' })).toBe(true);
    expect(control.mirrorNavigate('S1', 'tab-1', { kind: 'back' })).toBe(false);
    expect(control.mirrorNavigate('S1', 'tab-1', { kind: 'forward' })).toBe(true);
    expect(control.mirrorNavigate('S1', 'tab-1', { kind: 'reload' })).toBe(true);
    expect(page.calls).toEqual(expect.arrayContaining(['goBack', 'goForward']));
    expect(control.mirrorNavigate('S1', 'tab-1', { kind: 'open', url: 'https://example.com/next' })).toBe(true);
    for (const bad of [{ kind: 'open', url: 'javascript:alert(1)' }, { kind: 'open', url: 'file:///etc/passwd' }, { kind: 'open', url: 'not a url' }, { kind: 'open' }, { kind: 'jump' }, null])
      expect(control.mirrorNavigate('S1', 'tab-1', bad)).toBe(false);
    expect(control.mirrorNavigate('S1', 'tab-9', { kind: 'reload' })).toBe(false);
  });

  it('描かせ続ける: 始めると Mac の画面に知らせ、やめると戻して知らせる。同じものを重ねて頼んでも 1 回だけ', async () => {
    realTime();
    const { control, open, sentOn } = setup();
    open('https://example.com/a');
    await control.mirrorConnect('S1', 'tab-1');
    await control.mirrorConnect('S1', 'tab-9');
    control.mirrorDraw('S1', 'tab-1', true);
    control.mirrorDraw('S1', 'tab-1', true);
    control.mirrorDraw('S1', 'tab-1', false);
    control.mirrorDraw('S1', 'tab-1', false);
    expect(sentOn<BrowserMirroring>(IpcChannel.BrowserMirroring)).toEqual([
      { sessionId: 'S1', tabId: 'tab-1', on: true },
      { sessionId: 'S1', tabId: 'tab-1', on: false },
    ]);
  });
});
