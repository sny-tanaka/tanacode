// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { guardLinks } from '../../src/renderer/src/remote/links';

// スマホの画面のリンクの守り（src/renderer/src/remote/links.ts）

function setup() {
  const opened = vi.fn();
  const win = { open: opened, location: { href: 'https://mac.example.ts.net/app/' }, listeners: [] as ((e: unknown) => void)[] } as unknown as Window & { listeners: ((e: unknown) => void)[] };
  (win as unknown as { addEventListener: (type: string, fn: (e: unknown) => void) => void }).addEventListener = (_type, fn) => win.listeners.push(fn);
  guardLinks(win);
  const click = (attrs: Record<string, string> | null, handled = false) => {
    const anchor = document.createElement('a');
    for (const [k, v] of Object.entries(attrs ?? {})) anchor.setAttribute(k, v);
    const span = document.createElement('span');
    anchor.append(span);
    const event = { target: attrs ? span : document.createElement('div'), defaultPrevented: handled, preventDefault: vi.fn() };
    for (const fn of win.listeners) fn(event);
    return event;
  };
  return { win, opened, click };
}

describe('guardLinks', () => {
  it('window.open は、http(s) だけを、新しいタブに noopener・noreferrer で開く', () => {
    const { win, opened } = setup();
    expect(win.open('https://example.com/a')).toBeNull();
    win.open('javascript:alert(1)');
    win.open('/app/other');
    win.open();
    win.open('http://[bad');
    expect(opened.mock.calls).toEqual([
      ['https://example.com/a', '_blank', 'noopener,noreferrer'],
      ['https://mac.example.ts.net/app/other', '_blank', 'noopener,noreferrer'],
    ]);
  });

  it('画面が作ったファイルのダウンロード（download の付いた blob: のリンク）は止めない。download の無い blob: や、download の付いた外のリンクは止める', () => {
    const { opened, click } = setup();
    expect(click({ href: 'blob:https://mac.example.ts.net/1234', download: '作業.html' }).preventDefault).not.toHaveBeenCalled();
    expect(click({ href: 'blob:https://mac.example.ts.net/1234' }).preventDefault).toHaveBeenCalled();
    expect(click({ href: 'https://example.com/x.zip', download: 'x.zip' }).preventDefault).toHaveBeenCalled();
    expect(opened.mock.calls).toEqual([['https://example.com/x.zip', '_blank', 'noopener,noreferrer']]);
  });

  it('押したリンクは、画面そのものを移らせない。拾われなかったものだけ新しいタブに開く。# とリンクでないものは触らない', () => {
    const { opened, click } = setup();
    expect(click({ href: 'https://example.com/' }).preventDefault).toHaveBeenCalled();
    expect(click({ href: 'https://example.com/handled' }, true).preventDefault).toHaveBeenCalled();
    expect(click({ 'xlink:href': 'https://example.com/svg' }).preventDefault).toHaveBeenCalled();
    expect(click({ href: '#top' }).preventDefault).not.toHaveBeenCalled();
    expect(click({}).preventDefault).not.toHaveBeenCalled();
    expect(click(null).preventDefault).not.toHaveBeenCalled();
    expect(opened.mock.calls.map((c) => c[0])).toEqual(['https://example.com/', 'https://example.com/svg']);
  });
});
