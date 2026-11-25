// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadFile } from '../../src/renderer/src/remote/download';

// スマホの画面で、書き出したファイルをスマホにダウンロードする（Mac の保存のダイアログの代わり。Issue #464）

afterEach(() => vi.useRealTimers());

describe('downloadFile', () => {
  it('ファイルの名前を付けたリンクを押してダウンロードし、名前を返す。しばらくしてから URL を外す', () => {
    vi.useFakeTimers();
    const urls: Blob[] = [];
    URL.createObjectURL = vi.fn((blob: Blob) => (urls.push(blob), 'blob:download'));
    URL.revokeObjectURL = vi.fn();
    const clicked: { href: string; download: string }[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download });
    });
    expect(downloadFile('<html></html>', '作業.html')).toBe('作業.html');
    expect(clicked).toEqual([{ href: 'blob:download', download: '作業.html' }]);
    expect(urls[0].type).toBe('text/html');
    expect(document.querySelector('a[download]')).toBeNull();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:download');
    click.mockRestore();
  });
});
