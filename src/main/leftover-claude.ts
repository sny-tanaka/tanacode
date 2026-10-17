import { execFile } from 'node:child_process';

// 常駐のホストが止める間もなく落ちた（SIGKILL など）ときに残った、チャットの claude（stream-json）を止める。
// パイプの claude は自分のプロセスグループで動いているので、ホストが消えても止まらない。残ったまま同じ会話を --resume すると、
// 2 つのプロセスが同じ会話ログを書く（設計書 5 節）。そこで、initialize の返事の pid を記録しておき、開き直す前にここで確かめる

// 止めてから、終わるのを待つ上限（過ぎたら SIGKILL）
const STOP_WAIT_MS = 3000;

// 記録しておく、動いていた claude（pid と、起動したときの会話の ID。/clear で記録の会話の ID が変わっても、起動の引数は変わらない）
export type ClaudeProcess = { pid: number; conversation: string };

type Listed = { pid: number; pgid: number; command: string };

// pid のプロセスが、その会話の claude（起動の引数に会話の ID がある）なら、プロセスグループごと止めて、終わるのを待つ。
// pid は使い回されるので、ほかのプロセスは止めない。止めたら true（残っていなかった・別のプロセスだったら false）
export async function stopLeftoverClaude(claude: ClaudeProcess, waitMs = STOP_WAIT_MS): Promise<boolean> {
  const { pid, conversation } = claude;
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid || !conversation) return false;
  const [found, self] = await list([pid, process.pid]);
  if (!found || !found.command.includes(conversation)) return false;
  // グループで止める（裏で動くタスクも一緒に）。グループが分からない・アプリと同じグループのときは、そのプロセスだけ
  const target = found.pgid > 1 && found.pgid !== self?.pgid ? -found.pgid : pid;
  send(target, 'SIGTERM');
  if (await gone(pid, waitMs)) return true;
  send(target, 'SIGKILL');
  await gone(pid, waitMs);
  return true;
}

// ps でプロセスの pid・グループ・コマンドを読む（無いプロセスは undefined）
function list(pids: number[]): Promise<(Listed | undefined)[]> {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'pid=,pgid=,command=', '-p', pids.join(',')], { encoding: 'utf8' }, (_error, stdout) => {
      const rows = (stdout ?? '')
        .split('\n')
        .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
        .filter((m): m is RegExpMatchArray => m !== null)
        .map((m) => ({ pid: Number(m[1]), pgid: Number(m[2]), command: m[3] }));
      resolve(pids.map((pid) => rows.find((row) => row.pid === pid)));
    });
  });
}

function send(target: number, signal: NodeJS.Signals): void {
  try {
    process.kill(target, signal);
  } catch {
    // もう終わっている
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gone(pid: number, waitMs: number): Promise<boolean> {
  const until = Date.now() + waitMs;
  while (alive(pid)) {
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}
