import { closeSync, ftruncateSync, openSync, readFileSync, writeSync } from 'node:fs';

// Claude Code（2.1.302）が、取り消した応答（tombstone）の行を会話ログから消すのと同じ消し方（本体の performRemoveByUuid）。
// その uuid の最後の行の頭で切り詰め、後ろの行を詰めて書き戻す（同じファイルのまま。大きさは消した行の分だけ短くなる）
export function removeLine(file: string, uuid: string): void {
  const data = readFileSync(file);
  const at = data.lastIndexOf(`"uuid":"${uuid}"`);
  if (at === -1) throw new Error(`会話ログに ${uuid} の行がありません`);
  const start = data.lastIndexOf(0x0a, at) + 1;
  const newline = data.indexOf(0x0a, at);
  const end = newline === -1 ? data.length : newline + 1;
  const fd = openSync(file, 'r+');
  try {
    ftruncateSync(fd, start);
    writeSync(fd, data, end, data.length - end, start);
  } finally {
    closeSync(fd);
  }
}
