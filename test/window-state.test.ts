import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadWindowState, placeWindow, saveWindowState } from '../src/main/window-state';

// 次の起動で戻す、ウインドウの位置と大きさ
const FALLBACK = { width: 1600, height: 960 };
const MAIN = { x: 0, y: 25, width: 1728, height: 1050 };
const SIDE = { x: 1728, y: 0, width: 2560, height: 1415 };

describe('placeWindow', () => {
  it('覚えていなければ既定の大きさ（位置は決めない）', () => {
    expect(placeWindow(null, [MAIN], FALLBACK)).toEqual(FALLBACK);
  });

  it('画面に収まっていれば、そのまま戻す', () => {
    const saved = { x: 100, y: 80, width: 1200, height: 800 };
    expect(placeWindow(saved, [MAIN], FALLBACK)).toEqual(saved);
  });

  it('もう一つの画面に置いていたら、その画面に戻す', () => {
    const saved = { x: 2000, y: 100, width: 1400, height: 900 };
    expect(placeWindow(saved, [MAIN, SIDE], FALLBACK)).toEqual(saved);
  });

  it('はみ出していたら、いちばん重なる画面の中に入れ直す', () => {
    expect(placeWindow({ x: 1000, y: -50, width: 1200, height: 800 }, [MAIN], FALLBACK)).toEqual({
      x: 528,
      y: 25,
      width: 1200,
      height: 800,
    });
  });

  it('画面より大きければ、画面の大きさに縮める', () => {
    expect(placeWindow({ x: 0, y: 0, width: 3000, height: 2000 }, [MAIN], FALLBACK)).toEqual(MAIN);
  });

  it('外したディスプレイにあったら、位置は決めずに大きさだけ戻す', () => {
    const saved = { x: 2000, y: 100, width: 1400, height: 900 };
    expect(placeWindow(saved, [MAIN], FALLBACK)).toEqual({ width: 1400, height: 900 });
  });
});

describe('loadWindowState / saveWindowState', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });
  const fileIn = () => {
    dir = mkdtempSync(join(tmpdir(), 'tanacode-window-'));
    return join(dir, 'sub', 'window-state.json');
  };

  it('保存したものを読み戻せる', () => {
    const file = fileIn();
    const state = { bounds: { x: 10, y: 20, width: 1300, height: 700 }, maximized: true, fullScreen: false };
    saveWindowState(file, state);
    expect(loadWindowState(file)).toEqual(state);
  });

  it('無い・壊れている・形が違うときは null', () => {
    const file = fileIn();
    expect(loadWindowState(file)).toBeNull();
    saveWindowState(file, { bounds: { x: 0, y: 0, width: 1, height: 1 }, maximized: false, fullScreen: false });
    writeFileSync(file, '{');
    expect(loadWindowState(file)).toBeNull();
    writeFileSync(file, JSON.stringify({ bounds: { x: 0, y: 0, width: 0, height: 700 } }));
    expect(loadWindowState(file)).toBeNull();
    writeFileSync(file, JSON.stringify({ bounds: { x: '0', y: 0, width: 100, height: 700 } }));
    expect(loadWindowState(file)).toBeNull();
  });
});
