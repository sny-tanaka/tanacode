// @vitest-environment jsdom
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// デモのツアーの台本の操作の足あと（src/renderer/src/demo/trace.ts）。ツアーの確かめ（URL に ?demo-trace）のときだけコンソールに出し、
// ふだんのデモのサイトでは出さない。確かめは、行の頭（[demo-trace]）で足あとを見分ける（scripts/demo-tour-evidence.mjs）

afterEach(() => {
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
  vi.resetModules();
});

// URL を変えてから読み込み直す（出すかどうかは、読み込んだときの URL で決まる）
async function load(path: string) {
  window.history.replaceState(null, '', path);
  vi.resetModules();
  return import('../../src/renderer/src/demo/trace');
}

describe('デモの台本の操作の足あと', () => {
  it('URL に ?demo-trace があるときだけ、頭に [demo-trace] を付けてコンソールに出す', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const quiet = await load('/#start');
    quiet.trace('押す: .send-button');
    expect(debug).not.toHaveBeenCalled();
    const traced = await load('/?demo-trace#start');
    traced.trace('押す: .send-button');
    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug.mock.calls[0][0]).toMatch(/^\[demo-trace\] \d+ms 押す: \.send-button$/);
    // 確かめのスクリプトと同じ頭
    const evidence = await import('../../scripts/demo-tour-evidence.mjs');
    expect(traced.DEMO_TRACE_PREFIX).toBe(evidence.TRACE_PREFIX);
    expect(evidence.TRACE_QUERY).toBe('?demo-trace');
  });

  it('描き直しの足あとは、?demo-trace のときだけ、描き直しの始まり（前）と描き終えたあとのタスク（後）を出す', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => frames.push(cb));
    (await load('/#start')).startFrameTrace();
    expect(frames).toHaveLength(0);
    const traced = await load('/?demo-trace#start');
    traced.startFrameTrace();
    frames.shift()!(0);
    expect(debug.mock.calls.map((c) => c[0])).toEqual([expect.stringMatching(/^\[demo-frame\] \d+ms 1 前$/)]);
    // 「後」は、描き直しのあとのタスク（MessageChannel）で出す
    await vi.waitFor(() => expect(debug).toHaveBeenCalledTimes(2));
    expect(debug.mock.calls[1][0]).toMatch(/^\[demo-frame\] \d+ms 1 後$/);
    // 次の描き直しも待つ
    expect(frames).toHaveLength(1);
    const evidence = await import('../../scripts/demo-tour-evidence.mjs');
    expect(traced.DEMO_FRAME_PREFIX).toBe(evidence.FRAME_PREFIX);
  });

  it('操作の相手は、セレクタ・要素（タグとクラス）・関数で、短い名前にする', async () => {
    const { describeTarget } = await load('/');
    const el = document.createElement('button');
    el.className = 'send-button primary';
    expect(describeTarget('.chat-input textarea')).toBe('.chat-input textarea');
    expect(describeTarget(el)).toBe('button.send-button.primary');
    expect(describeTarget(() => null)).toBe('(要素を探す関数)');
  });
});

describe('確かめの足あとの控え（scripts/demo-tour-evidence.mjs の traceLog）', () => {
  it('足あとの行だけを、新しい 40 行まで控える', async () => {
    const { traceLog } = await import('../../scripts/demo-tour-evidence.mjs');
    const log = traceLog();
    expect(log.add('ふつうのコンソールの行')).toBe(false);
    for (let i = 0; i < 45; i++) expect(log.add(`[demo-trace] ${i}ms 押す: ${i}`)).toBe(true);
    const lines = log.lines();
    expect(lines).toHaveLength(40);
    expect(lines[0]).toMatch(/^\d+\.\ds 5ms 押す: 5$/);
    expect(lines.at(-1)).toMatch(/44ms 押す: 44$/);
    // 止まったと決めたあとに届いた足あとは控えない（足あとの行とは見分ける）
    log.freeze();
    expect(log.add('[demo-trace] 99ms 押す: 99')).toBe(true);
    expect(log.lines()).toEqual(lines);
  });

  it('描き直しの足あとは、台本の足あととは分けて、新しい 6 行まで控える', async () => {
    const { traceLog } = await import('../../scripts/demo-tour-evidence.mjs');
    const log = traceLog();
    expect(log.add('[demo-trace] 1ms 押す: a')).toBe(true);
    for (let i = 1; i <= 5; i++) {
      expect(log.add(`[demo-frame] ${i}ms ${i} 前`)).toBe(true);
      expect(log.add(`[demo-frame] ${i}ms ${i} 後`)).toBe(true);
    }
    expect(log.add('[demo-frame] 9ms 6 前')).toBe(true);
    expect(log.lines()).toHaveLength(1);
    const frames = log.frames();
    expect(frames).toHaveLength(6);
    expect(frames[0]).toMatch(/3ms 3 後$/);
    expect(frames.at(-1)).toMatch(/9ms 6 前$/);
  });
});

describe('WebKit の出力の控え（keepBrowserLog・browserLogTail）', () => {
  const env = { DEBUG: process.env.DEBUG, DEBUG_FILE: process.env.DEBUG_FILE };
  afterEach(() => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('Playwright に、ブラウザの出力（pw:browser）をファイルに書かせる。もとの DEBUG は残す', async () => {
    const { keepBrowserLog } = await import('../../scripts/demo-tour-evidence.mjs');
    process.env.DEBUG = 'pw:api';
    keepBrowserLog('/tmp/webkit.log');
    expect(process.env.DEBUG).toBe('pw:api,pw:browser');
    expect(process.env.DEBUG_FILE).toBe('/tmp/webkit.log');
  });

  it('最後の n 行を返す。ファイルが無ければ空', async () => {
    const { browserLogTail } = await import('../../scripts/demo-tour-evidence.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'tanacode-demo-trace-'));
    try {
      const file = join(dir, 'webkit.log');
      expect(browserLogTail(file, 2)).toEqual([]);
      writeFileSync(file, 'a\nb\n\nc\n');
      expect(browserLogTail(file, 2)).toEqual(['b', 'c']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
