import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { ScriptedApp } from './helpers/scripted-claude';

// アプリが起動する claude の引数が、Claude が自分の裏の処理を止めるつもりで実行する pkill -f（引数のどこかに含む文字での指定）に当たらないか。
// 前は --settings に設定の JSON をそのまま渡していて、その中のフックのプログラム（worktree-guard.ts の awk）にある pushd が、
// pkill -f p.sh の p.sh（. は任意の 1 文字）に当たり、アプリの claude がすべて止まった。
// アプリが渡すのと同じ引数で、claude の代わりのプロセス（stub）を起動し、pgrep -f（pkill -f と同じ当て方で、止めずに探す）で確かめる

let app: ScriptedApp | null = null;
let stub: ChildProcess | null = null;
afterEach(() => {
  stub?.kill('SIGKILL');
  stub = null;
  app?.dispose();
  app = null;
});

// pattern に引数が当たるプロセスの pid（当たるものが無ければ空）
function pgrep(pattern: string): number[] {
  try {
    return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).trim().split('\n').map(Number);
  } catch {
    // 当たるものが無いと、終了コード 1
    return [];
  }
}

// 引数を args にして、何もせずに待つプロセスを起動する（node -e <待つだけ> -- <args>）
async function startStub(args: string[]): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', ...args], { stdio: 'ignore' });
  stub = child;
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', reject);
  });
  return child.pid!;
}

const launch = (name: string) => ({ command: '/Apps/tanacode Helper', script: `/Apps/out/main/${name}.js`, socketPath: `/u/${name}.sock`, version: '1.0.0' });

describe('claude の引数と pkill -f', () => {
  it('アプリと同じ引数の stub は、pgrep -f p.sh・pgrep -f pushd に当たらない', async () => {
    app = new ScriptedApp({ browser: () => launch('browser-mcp'), sessionsMcp: () => launch('sessions-mcp'), checklistMcp: () => launch('checklist-mcp') });
    const { pipe } = app.create();
    const pid = await startStub(pipe.request.args);
    // 当て方が働いていることを、引数にある会話の ID で先に確かめる（pgrep が使えない・引数が見えないのに、当たらないと誤って通らないように）
    const conversation = pipe.arg('--session-id')!;
    expect(pgrep(conversation)).toContain(pid);
    expect(pgrep('p.sh')).not.toContain(pid);
    expect(pgrep('pushd')).not.toContain(pid);
  });
});
