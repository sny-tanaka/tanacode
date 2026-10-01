import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isTranscriptEntry, toChatEvents } from '@shared/chat';
import { VERIFIED_CLAUDE_CODE_VERSION } from '@shared/claude-code';
import type { ScreenLine } from '@shared/screen';
import { transcriptPath } from '../src/main/claude-session';
import { applyQuestions, askQuestionsOf, findEffort, findMode, parseMenu, promptRange } from '../src/main/screen-parser';
import { parseStatusLine } from '../src/main/statusline';
import { FIXTURE_ROOT, checkAskInput, checkChat, checkPermission, checkPrompt, checkQuestion, checkStatusLine, type ScreenName } from './scenario';

// 本物の Claude Code から取った控え（test/fixtures/claude-code/<版>/）を、アプリの読み取りにかける。
// 控えは、互換性の確認（npm run test:cli）に TANACODE_RECORD=1 を付けて取る。古い版の控えも残し、読めるままかを確かめ続ける

const DIR = join(__dirname, 'fixtures', 'claude-code');
const versions = existsSync(DIR) ? readdirSync(DIR) : [];

if (versions.length === 0) it.skip('控えがまだありません（TANACODE_RECORD=1 npm run test:cli で取る）', () => {});
// ステータスバーで「動作確認済のバージョン」とする版（VERIFIED_CLAUDE_CODE_VERSION）は、控えで確かめられる版にする
else it('動作確認済のバージョンの控えがある', () => expect(versions).toContain(VERIFIED_CLAUDE_CODE_VERSION));

describe.each(versions)('Claude Code %s の控え', (version) => {
  const dir = join(DIR, version);
  const screen = (name: ScreenName) => JSON.parse(readFileSync(join(dir, 'screens', `${name}.json`), 'utf8')) as ScreenLine[];
  const askInput = () => (JSON.parse(readFileSync(join(dir, 'ask.json'), 'utf8')) as { tool_input?: unknown }).tool_input;
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

  it('入力欄と、入力欄のまわりの表示が読める', () => {
    const lines = screen('prompt');
    expect(promptRange(lines)).not.toBeNull();
    checkPrompt({ mode: findMode(lines), effort: findEffort(lines) });
  });

  it('Bash の許可の確認が読める', () => {
    checkPermission(parseMenu(screen('bash-permission')), 'mkdir checked');
  });

  it('AskUserQuestion の質問が読める', () => {
    const menu = parseMenu(screen('question'));
    const questions = askQuestionsOf(askInput());
    expect(menu).not.toBeNull();
    expect(questions).not.toBeNull();
    checkQuestion(applyQuestions(menu!, questions!, new Map()));
  });

  it('フックが書いた AskUserQuestion の入力が読める', () => {
    checkAskInput(askInput());
  });

  it('Write の許可の確認が読める', () => {
    checkPermission(parseMenu(screen('write-permission')), 'hello.txt');
  });

  it('会話ログからチャットを組み立てられる', () => {
    checkChat(entries, entries.flatMap((e) => toChatEvents(e, cwd)), cwd);
  });

  it('statusLine の JSON が読める', () => {
    const sessionId = (entries.find((e) => e.type === 'user') as { sessionId?: string } | undefined)?.sessionId;
    expect(sessionId).toBeTruthy();
    checkStatusLine(parseStatusLine(readFileSync(join(dir, 'statusline.json'), 'utf8'), Date.now()), version, transcriptPath(cwd, sessionId!));
  });
});
