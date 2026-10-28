import { appendFile, rename, stat } from 'node:fs/promises';

// チャットの入力欄から、人の操作でないのにフォーカスが外れたときのログ（userData/focus.log）。画面（chat/focusWatch.ts）が知らせたものを、
// 1 行ずつ「時刻 JSON」で足す。原因を突き止められなかった「打っている途中で急にフォーカスが外れる」不具合を、次に起きたときに読むため。
// 大きくなりすぎたら、ひとつ前のもの（focus.log.1）に回して書き直す
const MAX_BYTES = 256 * 1024;
// 1 行の長さの上限（スタックが長いときなど。画面から来たものなので、大きすぎるものは切る）
const MAX_LINE = 8 * 1024;

// 書き込みは順に並べる（いくつかのプロファイルの画面から同時に来ても、回す（rename）のと書くのがぶつからないように）
let queue: Promise<void> = Promise.resolve();

export function appendFocusLog(path: string, report: unknown, now = new Date()): Promise<void> {
  const run = queue.then(() => write(path, report, now));
  queue = run.catch(() => undefined);
  return run;
}

async function write(path: string, report: unknown, now: Date): Promise<void> {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return;
  let json = JSON.stringify(report);
  if (json.length > MAX_LINE) json = JSON.stringify({ truncated: json.slice(0, MAX_LINE) });
  const size = await stat(path).then((s) => s.size, () => 0);
  if (size > MAX_BYTES) await rename(path, `${path}.1`).catch(() => undefined);
  await appendFile(path, `${now.toISOString()} ${json}\n`);
}
