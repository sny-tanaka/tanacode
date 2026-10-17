import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isTranscriptEntry, toChatEvents } from '@shared/chat';
import { VERIFIED_CLAUDE_CODE_VERSION } from '@shared/claude-code';
import { transcriptPath } from '../src/main/claude-session';
import { parseStatusLine } from '../src/main/statusline';
import { FIXTURE_ROOT, checkChat, checkStatusLine, unreadableStreamLines } from './scenario';

// 本物の Claude Code から取った控え（test/fixtures/claude-code/<バージョン>/）を、アプリの読み取りにかける。
// 控えは、互換性の確認（npm run test:cli）に TANACODE_RECORD=1 を付けて取る（会話ログは basic.test.ts、statusLine は
// terminal-mode.test.ts）。古いバージョンの控えも残し、読めるままかを確かめ続ける

const DIR = join(__dirname, 'fixtures', 'claude-code');
const versions = existsSync(DIR) ? readdirSync(DIR) : [];

// 控えを確かめる部品が、読めない行を数えられるか（Claude Code の更新で形が変わったときに、気づけるように）
it('stream-json の読めない行（知らない種類・形の違う行・JSON でない行）を数える', () => {
  expect(unreadableStreamLines(['{"type":"brand_new"}', '{"type":"system","subtype":"init"}', 'JSON でない'])).toEqual({ malformed: 2, unknown: { brand_new: 1 } });
  // Claude Code からの制御の要求・返事も（使わない種類の要求・形の違う can_use_tool・形の違う返事）
  const control = [
    { type: 'control_request', request_id: 'h1', request: { subtype: 'brand_new_request' } },
    { type: 'control_request', request_id: 'p1', request: { subtype: 'can_use_tool', tool_name: 'Bash' } },
    { type: 'control_response', response: { subtype: 'success', request_id: 1 } },
  ];
  expect(unreadableStreamLines(control.map((l) => JSON.stringify(l)))).toEqual({ malformed: 2, unknown: { 'control_request/brand_new_request': 1 } });
});

if (versions.length === 0) it.skip('控えがまだありません（TANACODE_RECORD=1 npm run test:cli で取る）', () => {});
// ステータスバーで「動作確認済のバージョン」とするもの（VERIFIED_CLAUDE_CODE_VERSION）は、控えで確かめられるバージョンにする
else it('動作確認済のバージョンの控えがある', () => expect(versions).toContain(VERIFIED_CLAUDE_CODE_VERSION));

describe.each(versions)('Claude Code %s の控え', (version) => {
  const dir = join(DIR, version);
  const entries = readFileSync(join(dir, 'transcript.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown)
    .filter(isTranscriptEntry);
  const cwd = join(FIXTURE_ROOT, 'work');
  // transcriptPath は homedir() を見るので、控えを取ったときの HOME にする
  const oldHome = process.env.HOME;
  beforeAll(() => {
    process.env.HOME = join(FIXTURE_ROOT, 'home');
  });
  afterAll(() => {
    process.env.HOME = oldHome;
  });

  it('会話ログからチャットを組み立てられる', () => {
    // TUI で取った控え（2.1.301 まで）には turn_duration の行があり、ターンの終わりが会話ログからも出る。
    // チャット（-p）で取る控えには無い（ターンの終わりは stream の result から出す）
    const turnEnd = entries.some((e) => e.type === 'system' && e.subtype === 'turn_duration');
    checkChat(entries, entries.flatMap((e) => toChatEvents(e, cwd)), cwd, { turnEnd });
  });

  // stream-json の行の控えは 2.1.302 から（それより前は TUI で取っていた）
  it.runIf(existsSync(join(dir, 'stream.jsonl')))('stream-json の行が、どれも読める（知らない種類・形の違う行が無い）', () => {
    const lines = readFileSync(join(dir, 'stream.jsonl'), 'utf8').split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    expect(unreadableStreamLines(lines)).toEqual({ malformed: 0, unknown: {} });
  });

  it('statusLine の JSON が読める', () => {
    const json = readFileSync(join(dir, 'statusline.json'), 'utf8');
    // statusLine は、会話ログの控えと別の会話（ターミナルモードの TUI）で取ることがあるので、JSON の session_id の会話ログを指すかを見る
    const sessionId = (JSON.parse(json) as { session_id?: string }).session_id;
    expect(sessionId).toBeTruthy();
    checkStatusLine(parseStatusLine(json, Date.now()), version, transcriptPath(cwd, sessionId!));
  });
});
