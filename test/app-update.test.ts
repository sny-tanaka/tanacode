import { describe, expect, it } from 'vitest';
import { AppUpdateMonitor, appUpdateOf, parseLatestRelease, type Fetcher } from '../src/main/app-update';

// タイトルバーで知らせる、tanacode の新しい版（GitHub の Releases の latest）
describe('parseLatestRelease', () => {
  it('タグから版を取り出す', () => {
    expect(parseLatestRelease({ tag_name: 'v0.1.5' })).toBe('0.1.5');
    expect(parseLatestRelease({ tag_name: '1.2.3' })).toBe('1.2.3');
  });

  it('形が違えば null', () => {
    expect(parseLatestRelease({ tag_name: 'v0.1.5-beta' })).toBeNull();
    expect(parseLatestRelease({ message: 'Not Found' })).toBeNull();
    expect(parseLatestRelease(null)).toBeNull();
    expect(parseLatestRelease('v0.1.5')).toBeNull();
  });
});

describe('appUpdateOf', () => {
  it('今の版より新しいときだけ available', () => {
    expect(appUpdateOf('0.1.4', '0.1.5').available).toBe(true);
    expect(appUpdateOf('0.1.4', '0.1.4').available).toBe(false);
    // 開発中の版が、公開済みの版より新しいとき
    expect(appUpdateOf('0.2.0', '0.1.5').available).toBe(false);
  });

  it('開くページは、その版の Releases のページ', () => {
    expect(appUpdateOf('0.1.4', '0.1.5').url).toBe('https://github.com/sny-tanaka/tanacode/releases/tag/v0.1.5');
  });
});

describe('AppUpdateMonitor', () => {
  const reply = (status: number, body: unknown): Fetcher => () => Promise.resolve(new Response(JSON.stringify(body), { status }));

  it('確かめた結果を知らせる。同じ結果は二度知らせない', async () => {
    const changes: unknown[] = [];
    const monitor = new AppUpdateMonitor('0.1.4', (u) => changes.push(u), reply(200, { tag_name: 'v0.1.5' }));
    monitor.start();
    await monitor.refresh();
    await monitor.refresh();
    monitor.stop();
    expect(changes).toEqual([{ latest: '0.1.5', available: true, url: 'https://github.com/sny-tanaka/tanacode/releases/tag/v0.1.5' }, null]);
  });

  it('確かめられなかったときは、何も知らせない', async () => {
    const changes: unknown[] = [];
    const failing = new AppUpdateMonitor('0.1.4', (u) => changes.push(u), () => Promise.reject(new Error('offline')));
    failing.start();
    await failing.refresh();
    const notFound = new AppUpdateMonitor('0.1.4', (u) => changes.push(u), reply(404, { message: 'Not Found' }));
    notFound.start();
    await notFound.refresh();
    expect(changes).toEqual([]);
    expect(failing.get()).toBeNull();
    failing.stop();
    notFound.stop();
  });

  it('問い合わせのあいだに止めたら、結果を捨てる', async () => {
    const changes: unknown[] = [];
    let answer: (res: Response) => void = () => {};
    const monitor = new AppUpdateMonitor('0.1.4', (u) => changes.push(u), () => new Promise((resolve) => (answer = resolve)));
    monitor.start();
    const pending = monitor.refresh();
    monitor.stop();
    answer(new Response(JSON.stringify({ tag_name: 'v0.1.5' })));
    await pending;
    expect(changes).toEqual([]);
    expect(monitor.get()).toBeNull();
  });
});
