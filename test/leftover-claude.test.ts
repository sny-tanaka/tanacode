import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { stopLeftoverClaude } from '../src/main/leftover-claude';

// 常駐のホストが止める間もなく落ちたときに残った claude を、開き直す前に止める（leftover-claude.ts）。
// claude の代わりに、起動の引数に会話の ID を持つ Node のプロセスを、自分のプロセスグループで起動する（ホストと同じ）

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      process.kill(-child.pid!, 'SIGKILL');
    } catch {
      // もう終わっている
    }
  }
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// 会話の ID を引数に持つ、止まらないプロセス。ignoreTerm: SIGTERM では終わらない
async function leftover(conversation: string, ignoreTerm = false): Promise<number> {
  const script = `${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''} process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['-e', script, '--', '-p', '--resume', conversation], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  children.push(child);
  // 起動し終える（SIGTERM の受け手を付ける）のを待つ
  await new Promise((resolve) => child.stdout!.once('data', resolve));
  return child.pid!;
}

describe('stopLeftoverClaude', () => {
  it('その会話の claude（起動の引数に会話の ID がある）なら、プロセスグループごと止めて、終わるのを待つ', async () => {
    const pid = await leftover('conv-abc');
    expect(await stopLeftoverClaude({ pid, conversation: 'conv-abc' })).toBe(true);
    expect(alive(pid)).toBe(false);
  });

  it('SIGTERM で終わらなければ、SIGKILL で止める', async () => {
    const pid = await leftover('conv-stubborn', true);
    expect(await stopLeftoverClaude({ pid, conversation: 'conv-stubborn' }, 300)).toBe(true);
    expect(alive(pid)).toBe(false);
  });

  it('別の会話のプロセス・無いプロセス・このアプリ自身・pid 1 は止めない（pid は使い回されるため）', async () => {
    const pid = await leftover('conv-other');
    expect(await stopLeftoverClaude({ pid, conversation: 'conv-abc' })).toBe(false);
    expect(alive(pid)).toBe(true);
    expect(await stopLeftoverClaude({ pid: 99_999_999, conversation: 'conv-abc' })).toBe(false);
    expect(await stopLeftoverClaude({ pid: process.pid, conversation: 'vitest' })).toBe(false);
    expect(await stopLeftoverClaude({ pid: 1, conversation: 'launchd' })).toBe(false);
    expect(await stopLeftoverClaude({ pid, conversation: '' })).toBe(false);
  });
});
