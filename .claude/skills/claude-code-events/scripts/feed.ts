// record.mjs で録った行を、tanacode の読み取りにそのまま流す。esbuild でまとめてから node で動かす（SKILL.md の 4）。
// - StreamClient: 読めない行・知らない種類の数（毎日の確認の unreadableStreamLines と同じ数え方）
// - PartialText: チャットの書いている途中の文。応答の行が届いたところで会話ログの同じ応答を渡し、ターンの終わりの直前に残っている文を出す
// 使い方: node feed.mjs <stream.jsonl> [transcript.jsonl]
import { readFileSync } from 'node:fs';
import type { TranscriptEntry } from '@shared/chat';
import type { PipeHandle } from '../../../../src/main/pty-host-client';
import { StreamClient } from '../../../../src/main/stream/client';
import { PartialText } from '../../../../src/main/stream/partial';

const [streamFile, transcriptFile] = process.argv.slice(2);
if (!streamFile) {
  console.error('使い方: node feed.mjs <stream.jsonl> [transcript.jsonl]');
  process.exit(1);
}
const readLines = (file: string) => readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
const lines = readLines(streamFile);
const transcript = transcriptFile ? readLines(transcriptFile).map((l) => JSON.parse(l) as TranscriptEntry) : [];

// StreamClient に、パイプの代わりに行を渡す
let listener: ((line: string, seq: number) => void) | null = null;
const pipe = {
  onLine: (l: (line: string, seq: number) => void) => (listener = l),
  onExit: () => {},
  send: () => {},
  end: () => {},
  kill: () => {},
  replay: () => {},
  onReplayed: () => {},
  detach: () => {},
} as unknown as PipeHandle;
const client = new StreamClient(pipe, { onMessage: () => {}, onPermission: () => {}, onCancel: () => {}, onExit: () => {} });
client.start();
lines.forEach((line, i) => listener?.(line, i + 1));

// PartialText に、書いている途中の行と会話ログの応答を渡す
const partial = new PartialText();
const covered = new Set<string>();
let leftover: unknown = null;
for (const line of lines) {
  const v = JSON.parse(line) as { type?: string; event?: Parameters<PartialText['event']>[0]; message?: { id?: string } };
  if (v.type === 'stream_event' && v.event) partial.event(v.event);
  if (v.type === 'assistant' && v.message?.id && !covered.has(v.message.id)) {
    covered.add(v.message.id);
    for (const entry of transcript) if (entry.message?.id === v.message.id) partial.cover(entry);
  }
  if (v.type === 'result') leftover = partial.view();
}

console.log(JSON.stringify({ malformed: client.malformed, unknown: Object.fromEntries(client.unknown), partialBeforeResult: leftover }, null, 2));
