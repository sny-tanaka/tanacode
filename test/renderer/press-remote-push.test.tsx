// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PushToggle } from '../../src/renderer/src/remote/PushToggle';
import './dom';
import { mockApi } from './mock-api';

// スマホの画面を閉じている間の通知（Web Push）を受け取るかのボタン（Issue #464）。ブラウザの通知の口は作り物にする

type Permission = 'default' | 'granted' | 'denied';
let permission: Permission;
type FakeSubscription = { toJSON: () => unknown; unsubscribe: ReturnType<typeof vi.fn>; options: { applicationServerKey: ArrayBuffer | null } };
let subscription: FakeSubscription | null;
let subscribe: ReturnType<typeof vi.fn>;
let requestPermission: ReturnType<typeof vi.fn>;
let workerInstalled: boolean;

const KEY = Buffer.alloc(65, 4).toString('base64url');
const keyBuffer = (key: string) => new Uint8Array(Buffer.from(key, 'base64url')).buffer;
const fakeSubscription = (key: string | null): FakeSubscription => ({ toJSON: () => JSON_SUB, unsubscribe: vi.fn(async () => true), options: { applicationServerKey: key ? keyBuffer(key) : null } });
const JSON_SUB = { endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: 'p', auth: 'a' } };

beforeEach(() => {
  workerInstalled = true;
  permission = 'default';
  subscription = null;
  subscribe = vi.fn(async (options: { applicationServerKey: Uint8Array }) => {
    subscription = fakeSubscription(Buffer.from(options.applicationServerKey).toString('base64url'));
    return subscription;
  });
  requestPermission = vi.fn(async () => {
    permission = 'granted';
    return permission;
  });
  const registration = { pushManager: { getSubscription: async () => subscription, subscribe } };
  vi.stubGlobal('navigator', { ...navigator, serviceWorker: { getRegistration: async (scope: string) => (scope === '/app/' && workerInstalled ? registration : undefined) } });
  vi.stubGlobal('PushManager', class {});
  vi.stubGlobal('Notification', {
    get permission() {
      return permission;
    },
    requestPermission,
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const settle = () => act(async () => {
  await new Promise((done) => setTimeout(done, 0));
});

describe('PushToggle', () => {
  it('押すと許可を聞き、送り主の鍵で購読して Mac に渡す。もう一度押すと止める', async () => {
    const api = mockApi({ 'remote.pushKey': () => Promise.resolve(KEY), 'remote.pushSubscribe': () => Promise.resolve(true), 'remote.pushUnsubscribe': () => Promise.resolve() });
    api.install();
    render(<PushToggle />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: '通知を受け取る' }));
    await settle();
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(Buffer.from(subscribe.mock.calls[0][0].applicationServerKey as Uint8Array).toString('base64url')).toBe(KEY);
    expect(subscribe.mock.calls[0][0].userVisibleOnly).toBe(true);
    expect(api.argsOf('remote.pushSubscribe')).toEqual([[JSON_SUB]]);
    const on = screen.getByRole('button', { name: '通知を受け取っています（押すと止める）' });
    expect(on.getAttribute('aria-pressed')).toBe('true');
    const current = subscription!;
    fireEvent.click(on);
    await settle();
    expect(api.argsOf('remote.pushUnsubscribe')).toHaveLength(1);
    expect(current.unsubscribe).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '通知を受け取る' })).toBeTruthy();
  });

  it('購読済みなら、開いたときに Mac に送り直して「受け取っています」から始める。許可されなければ押せない', async () => {
    const api = mockApi({ 'remote.pushKey': () => Promise.resolve(KEY), 'remote.pushSubscribe': () => Promise.resolve(true) });
    api.install();
    subscription = fakeSubscription(KEY);
    const view = render(<PushToggle />);
    await settle();
    expect(screen.getByRole('button', { name: '通知を受け取っています（押すと止める）' })).toBeTruthy();
    expect(api.argsOf('remote.pushSubscribe')).toEqual([[JSON_SUB]]);
    expect(subscribe).not.toHaveBeenCalled();
    view.unmount();
    subscription = null;
    requestPermission.mockResolvedValueOnce('denied');
    render(<PushToggle />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: '通知を受け取る' }));
    await settle();
    expect((screen.getByRole('button', { name: '通知が許可されていません' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('購読の鍵が今の送り主の鍵と違えば（Mac の登録をやり直した）、作り直して送る。Mac が受けなければ「受け取る」に戻す', async () => {
    const NEW_KEY = Buffer.alloc(65, 7).toString('base64url');
    const api = mockApi({ 'remote.pushKey': () => Promise.resolve(NEW_KEY), 'remote.pushSubscribe': () => Promise.resolve(true) });
    api.install();
    const old = fakeSubscription(KEY);
    subscription = old;
    const view = render(<PushToggle />);
    await settle();
    expect(old.unsubscribe).toHaveBeenCalledTimes(1);
    expect(Buffer.from(subscribe.mock.calls[0][0].applicationServerKey as Uint8Array).toString('base64url')).toBe(NEW_KEY);
    expect(screen.getByRole('button', { name: '通知を受け取っています（押すと止める）' })).toBeTruthy();
    view.unmount();
    // 鍵が読めない・Mac が受けない
    mockApi({ 'remote.pushKey': () => Promise.resolve(null) }).install();
    subscription = fakeSubscription(null);
    const second = render(<PushToggle />);
    await settle();
    expect(screen.getByRole('button', { name: '通知を受け取る' })).toBeTruthy();
    second.unmount();
    mockApi({ 'remote.pushKey': () => Promise.resolve(KEY), 'remote.pushSubscribe': () => Promise.reject(new Error('切れた')) }).install();
    subscription = fakeSubscription(KEY);
    render(<PushToggle />);
    await settle();
    expect(screen.getByRole('button', { name: '通知を受け取る' })).toBeTruthy();
  });

  it('鍵が無い・Mac が受けない・購読に失敗したら、受け取らないまま', async () => {
    const api = mockApi({ 'remote.pushKey': () => Promise.resolve(null) });
    api.install();
    const view = render(<PushToggle />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: '通知を受け取る' }));
    await settle();
    expect(subscribe).not.toHaveBeenCalled();
    view.unmount();
    mockApi({ 'remote.pushKey': () => Promise.resolve(KEY), 'remote.pushSubscribe': () => Promise.resolve(false) }).install();
    const second = render(<PushToggle />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: '通知を受け取る' }));
    await settle();
    expect(screen.getByRole('button', { name: '通知を受け取る' })).toBeTruthy();
    second.unmount();
    subscription = null;
    subscribe.mockRejectedValueOnce(new Error('no'));
    mockApi({ 'remote.pushKey': () => Promise.resolve(KEY) }).install();
    render(<PushToggle />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: '通知を受け取る' }));
    await settle();
    expect(screen.getByRole('button', { name: '通知を受け取る' })).toBeTruthy();
  });

  it('Service Worker が入っていなければ、待ち続けずに「受け取る」にする（押しても購読しない）', async () => {
    workerInstalled = false;
    mockApi({ 'remote.pushKey': () => Promise.resolve(KEY) }).install();
    render(<PushToggle />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: '通知を受け取る' }));
    await settle();
    expect(subscribe).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '通知を受け取る' })).toBeTruthy();
  });

  it('購読の鍵が違って作り直すときに、Service Worker が無くなっていれば「受け取る」にする', async () => {
    mockApi({ 'remote.pushKey': () => Promise.resolve(Buffer.alloc(65, 7).toString('base64url')) }).install();
    const old = fakeSubscription(KEY);
    subscription = old;
    old.unsubscribe.mockImplementation(async () => {
      workerInstalled = false;
      return true;
    });
    render(<PushToggle />);
    await settle();
    expect(subscribe).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '通知を受け取る' })).toBeTruthy();
  });

  it('通知の口が無いブラウザ（Safari のタブ）では出さない', () => {
    vi.stubGlobal('PushManager', undefined);
    delete (window as unknown as { PushManager?: unknown }).PushManager;
    const view = render(<PushToggle />);
    expect(view.container.innerHTML).toBe('');
  });
});
