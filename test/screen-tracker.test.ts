import { afterEach, expect, it } from 'vitest';
import type { PermissionMode } from '@shared/screen';
import { ScreenTracker } from '../src/main/screen-tracker';

// 画面を読みながらキーを送る操作（権限モードの切り替え）

const MODES: [PermissionMode, string][] = [
  ['manual', '⏸ manual mode on'],
  ['acceptEdits', '⏵⏵ accept edits on'],
  ['plan', '⏸ plan mode on'],
  ['auto', '⏵⏵ auto mode on'],
];
const RULE = '─'.repeat(120);
const screen = (mode: number) => `\x1b[2J\x1b[H${RULE}\r\n❯ \r\n${RULE}\r\n  ${MODES[mode][1]} (shift+tab to cycle)\r\n`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let tracker: ScreenTracker | null = null;
afterEach(() => tracker?.dispose());

it('権限モードを切り替えるとき、キーを送る前から描いていた画面の読み取りで、次のキーを重ねて送らない', async () => {
  let mode = 0;
  const writes: string[] = [];
  // Claude Code の代わり。Shift+Tab を受け取ると、少しあとで次のモードを描く
  const write = (data: string) => {
    writes.push(data);
    setTimeout(() => {
      mode = (mode + 1) % MODES.length;
      tracker!.feed(screen(mode));
    }, 150);
  };
  tracker = new ScreenTracker(120, 40, write, () => {});
  tracker.feed(screen(0));
  for (let i = 0; i < 40 && tracker.current.mode !== 'manual'; i++) await sleep(25);
  expect(tracker.current).toMatchObject({ mode: 'manual', state: { kind: 'prompt' } });
  const switching = tracker.setMode('acceptEdits');
  // キーを送った直後に、送る前の画面の描き直し（作業中の表示など）が届く
  tracker.feed(screen(0));
  expect(await switching).toBe(true);
  await sleep(400);
  expect(writes).toEqual(['\x1b[Z']);
  expect(tracker.current.mode).toBe('acceptEdits');
});
