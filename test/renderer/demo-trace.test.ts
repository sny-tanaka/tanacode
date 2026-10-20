// @vitest-environment jsdom
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
});
