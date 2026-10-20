import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ASK_FILE_ENV } from '@shared/chat';
import { appHookOutput, SUPPRESS_OUTPUT } from '../src/main/hook-output';
import { sessionsGateCommand, SESSIONS_NO_ASK_ENV } from '../src/main/sessions-bridge';
import { AUTO_COMPACT_STOP_COMMAND, IDLE_FILE_COMMAND, NOTIFICATION_FILE_COMMAND, PERMISSION_FILE_COMMAND } from '../src/main/statusline';
import { worktreeGuardCommand } from '../src/main/worktree-guard';

// アプリが --settings に足すフックの標準出力（hook-output.ts）。どれにも suppressOutput: true を付け、チャットでユーザーのフックと見分ける

describe('appHookOutput', () => {
  it('何も決めないとき（空・空の JSON）は、suppressOutput だけを書く', () => {
    expect(SUPPRESS_OUTPUT).toBe('{"suppressOutput":true}');
    expect(appHookOutput('')).toBe(SUPPRESS_OUTPUT);
    expect(appHookOutput('  \n')).toBe(SUPPRESS_OUTPUT);
    expect(appHookOutput('{}')).toBe(SUPPRESS_OUTPUT);
  });

  it('答えの JSON には、中身を変えずに suppressOutput を足す', () => {
    const ask = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: '確かめます' } };
    expect(JSON.parse(appHookOutput(JSON.stringify(ask)))).toEqual({ ...ask, suppressOutput: true });
    expect(JSON.parse(appHookOutput('{"continue":false,"stopReason":"止めます"}\n'))).toEqual({ continue: false, stopReason: '止めます', suppressOutput: true });
  });

  it('JSON のオブジェクトでないものは、そのまま書く（Claude Code に渡す中身を変えない）', () => {
    expect(appHookOutput('ただの文')).toBe('ただの文');
    expect(appHookOutput('[1,2]')).toBe('[1,2]');
  });
});

// シェルで動くアプリのフック。何も決めないときも、suppressOutput を書く（書かないと、何も出力しなかったフックとして、チャットに出てしまう）
describe('シェルで動くアプリのフック', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tanacode-hook-output-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // 子セッションの起動の確認を省く印のファイルは、既定では置かない（アプリを動かしている環境の値を受け継がない）
  const sh = (command: string, input: Record<string, unknown>, noAskFile = join(dir, 'sessions-start-no-ask')) =>
    execFileSync('sh', ['-c', command], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      env: { ...process.env, [ASK_FILE_ENV]: join(dir, 's1.ask.json'), [SESSIONS_NO_ASK_ENV]: noAskFile, PATH: [process.env.TANACODE_AWK, process.env.PATH].filter(Boolean).join(':') },
    });

  it('書くだけのフック（許可の確認の直前・知らせ・ターンの終わり）は、入力をファイルに書き、suppressOutput を書く', () => {
    const input = { hook_event_name: 'Stop', session_id: 'x' };
    for (const [command, suffix] of [
      [PERMISSION_FILE_COMMAND, 'permission'],
      [NOTIFICATION_FILE_COMMAND, 'notification'],
      [IDLE_FILE_COMMAND, 'idle'],
    ] as const) {
      expect(sh(command, input).trim()).toBe(SUPPRESS_OUTPUT);
      expect(JSON.parse(readFileSync(join(dir, `s1.${suffix}.json`), 'utf8'))).toEqual(input);
    }
  });

  it('ツールの切れ目で止めるフックは、止めるファイルが無い・サブエージェントの中でも、suppressOutput を書く', () => {
    expect(sh(AUTO_COMPACT_STOP_COMMAND, { hook_event_name: 'PostToolUse', tool_name: 'Bash' }).trim()).toBe(SUPPRESS_OUTPUT);
    writeFileSync(join(dir, 's1.auto-compact.json'), '{"continue":false,"stopReason":"止めます","suppressOutput":true}');
    expect(sh(AUTO_COMPACT_STOP_COMMAND, { hook_event_name: 'PostToolUse', agent_id: 'a1', tool_name: 'Bash' }).trim()).toBe(SUPPRESS_OUTPUT);
    expect(JSON.parse(sh(AUTO_COMPACT_STOP_COMMAND, { hook_event_name: 'PostToolUse', tool_name: 'Bash' }))).toEqual({ continue: false, stopReason: '止めます', suppressOutput: true });
  });

  // Claude Code（2.1.302）は、フックの入力を書き終える前にフックが標準入力を閉じると（EPIPE）、そのフックを失敗として扱い、
  // 標準出力も捨てる。ツールの結果は大きいことがある（PostToolUse の入力に入る）ので、パイプに入りきらない大きさの入力で確かめる
  // （読まずに終わるフックは、必ず EPIPE になる）
  it('どのフックも、何もしないときも入力を最後まで読む（読まずに閉じると、Claude Code がフックの失敗として扱う）', () => {
    const input = JSON.stringify({ session_id: 'x', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_response: 'x'.repeat(1 << 20) });
    // 子セッションの起動の確認は、印のファイルがあるとき（allow）と無いとき（ask）の両方で
    const noAsk = join(dir, 'sessions-start-no-ask');
    writeFileSync(noAsk, '');
    for (const [command, noAskFile] of [
      [AUTO_COMPACT_STOP_COMMAND, ''],
      [sessionsGateCommand(), ''],
      [sessionsGateCommand(), noAsk],
      [worktreeGuardCommand(), ''],
      [PERMISSION_FILE_COMMAND, ''],
      [NOTIFICATION_FILE_COMMAND, ''],
      [IDLE_FILE_COMMAND, ''],
    ]) {
      const result = spawnSync('sh', ['-c', command], {
        input,
        encoding: 'utf8',
        env: { ...process.env, [ASK_FILE_ENV]: join(dir, 's1.ask.json'), [SESSIONS_NO_ASK_ENV]: noAskFile, PATH: [process.env.TANACODE_AWK, process.env.PATH].filter(Boolean).join(':') },
      });
      expect({ command, noAskFile, error: result.error?.message, status: result.status }).toEqual({ command, noAskFile, error: undefined, status: 0 });
    }
  });

  it('Bash の前の確認・子セッションの起動の前の確認は、確認を出させるときも、許すときも、何もしないときも、suppressOutput を付ける', () => {
    const bash = (command: string) => sh(worktreeGuardCommand(), { session_id: 'x', cwd: '/r/proj', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
    expect(bash('ls -la').trim()).toBe(SUPPRESS_OUTPUT);
    expect(JSON.parse(bash('git worktree remove --force .claude/worktrees/a'))).toMatchObject({ hookSpecificOutput: { permissionDecision: 'ask' }, suppressOutput: true });
    expect(JSON.parse(sh(sessionsGateCommand(), { hook_event_name: 'PreToolUse' }))).toMatchObject({ hookSpecificOutput: { permissionDecision: 'ask' }, suppressOutput: true });
    // 確認を省くとき（allow）も
    const noAsk = join(dir, 'no-ask');
    writeFileSync(noAsk, '');
    expect(JSON.parse(sh(sessionsGateCommand(), { hook_event_name: 'PreToolUse' }, noAsk))).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' }, suppressOutput: true });
  });
});
