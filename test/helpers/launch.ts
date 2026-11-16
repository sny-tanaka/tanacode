import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeArgs, prepareLaunch } from '../../src/main/claude-session';
import { LaunchFiles, type PreparedLaunch } from '../../src/main/launch-files';

// claude の起動の引数を、アプリと同じく --settings・--mcp-config のファイルを書いてから作る（session-manager の start と同じ prepareLaunch）。
// ファイルは、テストごとの一時フォルダに書く

type ArgsOptions = Parameters<typeof claudeArgs>[0];
type LaunchOptions = Parameters<typeof prepareLaunch>[1];

let shared: LaunchFiles | null = null;
function launchFiles(): LaunchFiles {
  return (shared ??= new LaunchFiles(mkdtempSync(join(tmpdir(), 'tanacode-launch-'))));
}

// 登録した設定ファイルを選んでいない起動の用意（アプリの設定だけ）
export function testLaunch(options: Partial<LaunchOptions> = {}, files = launchFiles()): PreparedLaunch {
  return prepareLaunch(files, { sessionId: 's1', ...options }, null);
}

// claudeArgs を、用意したファイルで作る。settings を渡せば、それを使う（登録した設定ファイルを選んだときなど）
export function launchArgs(options: Omit<ArgsOptions, 'settings'> & Partial<Pick<LaunchOptions, 'claudeDir' | 'instructions'>> & { settings?: PreparedLaunch }): string[] {
  const { claudeDir, instructions, settings, ...rest } = options;
  return claudeArgs({ ...rest, settings: settings ?? testLaunch({ ...rest, sessionId: rest.sessionId ?? 's1', claudeDir, instructions }) });
}

// 引数の flag の値（ファイルのパス）を読んで、JSON として返す（型を指定しなければ、JSON.parse と同じく形を決めない）
export function fileArg<T = ReturnType<typeof JSON.parse>>(args: string[], flag: '--settings' | '--mcp-config'): T {
  const at = args.indexOf(flag);
  if (at < 0) throw new Error(`${flag} がありません`);
  return JSON.parse(readFileSync(args[at + 1], 'utf8')) as T;
}
