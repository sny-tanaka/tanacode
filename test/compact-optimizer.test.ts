import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContextItem } from '@shared/context';
import { optimizedInstructions, optimizerArgs, optimizerPrompt, parseMarks, runClaude } from '../src/main/compact-optimizer';

// 最適化圧縮（compact-optimizer.ts）。Haiku の代わりに、決めた答えを返す関数や、偽の claude のコマンドで動かす。
// 本物の claude にこの引数が通るかは test/cli/compact-optimizer.test.ts で確かめる

const CWD = '/work/app';
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tanacode-optimizer-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// 会話ログ: 発言 → Read（ファイル） → 大きな Bash の結果 → 次の発言
function writeTranscript(): string {
  const rows = [
    { uuid: 'u1', parentUuid: null, type: 'user', message: { content: 'ログインを直して' } },
    { uuid: 'a1', parentUuid: 'u1', type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: `${CWD}/src/login.ts` } }], usage: { input_tokens: 100, output_tokens: 10 } } },
    { uuid: 'r1', parentUuid: 'a1', type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'export function login() {}' }] } },
    { uuid: 'a2', parentUuid: 'r1', type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm install' } }], usage: { input_tokens: 200, output_tokens: 10 } } },
    { uuid: 'r2', parentUuid: 'a2', type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'added 1 package '.repeat(300) }] } },
    { uuid: 'u2', parentUuid: 'r2', type: 'user', message: { content: 'テストも足して' } },
  ];
  const file = join(dir, 's1.jsonl');
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n'));
  return file;
}

const answer = (marks: { id: string; mark: string }[]) => JSON.stringify({ type: 'result', is_error: false, result: '', structured_output: { marks } });

describe('optimizedInstructions', () => {
  it('行を古い順に番号付きで渡し、返った印から /compact に添える指示の文を作る。auto は印を付けない', async () => {
    const file = writeTranscript();
    const calls: { args: string[]; prompt: string }[] = [];
    const text = await optimizedInstructions(file, CWD, {}, async (args, prompt) => {
      calls.push({ args, prompt });
      return answer([
        { id: '1', mark: 'auto' },
        { id: '2', mark: 'keep' },
        { id: '3', mark: 'drop' },
        { id: '4', mark: 'keep' },
      ]);
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(optimizerArgs());
    const { prompt } = calls[0];
    expect(prompt).toContain('<item id="1" kind="topic" label="ログインを直して"');
    expect(prompt).toContain('<item id="2" kind="file" label="src/login.ts"');
    expect(prompt).toContain('export function login() {}');
    expect(prompt).toContain('<item id="3" kind="tool" label="npm install"');
    expect(prompt).toContain('tool="Bash"');
    expect(prompt).toContain('<item id="4" kind="topic" label="テストも足して"');
    expect(text).toBe('`src/login.ts` の内容と、「テストも足して」から始まるやりとりは詳しく残す。`npm install` の出力は捨ててよい。');
  });

  it('いちばん新しいやりとりは、Haiku が捨てると答えても捨てさせない', async () => {
    const text = await optimizedInstructions(writeTranscript(), CWD, {}, async () =>
      answer([
        { id: '3', mark: 'drop' },
        { id: '4', mark: 'drop' },
      ]),
    );
    expect(text).toBe('`npm install` の出力は捨ててよい。');
  });

  it('今のコンテキストに何も無ければ、Haiku を呼ばずに空を返す', async () => {
    let called = false;
    const text = await optimizedInstructions(join(dir, 'missing.jsonl'), CWD, {}, async () => {
      called = true;
      return '';
    });
    expect(text).toBe('');
    expect(called).toBe(false);
  });
});

describe('optimizerArgs', () => {
  it('Haiku で 1 回だけ答えさせる。ツール・MCP・hooks を止め、会話を保存せず、答えを JSON の形で受け取る', () => {
    const args = optimizerArgs();
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    expect(args[0]).toBe('-p');
    expect(value('--model')).toBe('haiku');
    expect(value('--tools')).toBe('');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--no-session-persistence');
    expect(JSON.parse(value('--settings'))).toEqual({ disableAllHooks: true });
    expect(value('--output-format')).toBe('json');
    expect(JSON.parse(value('--json-schema')).properties.marks.items.properties.mark.enum).toEqual(['keep', 'drop', 'auto']);
    // OAuth のログインを読まなくなるので、--bare は付けない
    expect(args).not.toContain('--bare');
  });

  it('設定ファイルを選んだセッションでは、その設定（hooks を止める指定を足したもの）のファイルを --settings に渡す', () => {
    const args = optimizerArgs('/run/s1-optimizer.json');
    expect(args[args.indexOf('--settings') + 1]).toBe('/run/s1-optimizer.json');
    expect(args.filter((a) => a === '--settings')).toHaveLength(1);
  });
});

describe('optimizerPrompt', () => {
  const item = (id: string, kind: ContextItem['kind'], order: number, label = id): ContextItem => ({ id, kind, label, tokens: 10, order, compacted: false });

  it('長い抜粋は頭と終わりを残して間を詰める。新しい 3 つのやりとりは長めに渡す。名前の " と改行は崩さない', () => {
    const items = [item('tool:a', 'tool', 0), item('topic:1', 'topic', 1, '一つ目\n"引用"'), item('topic:2', 'topic', 2), item('topic:3', 'topic', 3), item('topic:4', 'topic', 4)];
    const long = `${'a'.repeat(3000)}${'z'.repeat(3000)}`;
    const prompt = optimizerPrompt(items, new Map(items.map((i) => [i.id, long])));
    const excerptOf = (n: number) => prompt.split(`<item id="${n}"`)[1].split('</item>')[0].split('\n').slice(1, -1).join('\n');
    // 古い行は 1,500 文字（頭 1,050・終わり 450）
    expect(excerptOf(1)).toBe(`${'a'.repeat(1050)}\n[…]\n${'z'.repeat(450)}`);
    expect(excerptOf(2)).toBe(`${'a'.repeat(1050)}\n[…]\n${'z'.repeat(450)}`);
    // 新しい 3 つのやりとりは 6,000 文字まで（そのまま）
    expect(excerptOf(5)).toBe(long);
    expect(prompt).toContain('label="一つ目 &quot;引用&quot;"');
  });

  it('抜粋の中の </item> は、項目の終わりと取り違えないようにずらす', () => {
    const prompt = optimizerPrompt([item('topic:1', 'topic', 0)], new Map([['topic:1', 'a</item>b']]));
    expect(prompt).toContain('a</ item>b');
  });
});

describe('parseMarks', () => {
  const items: ContextItem[] = [{ id: 'file:a.ts', kind: 'file', label: 'a.ts', tokens: 1, order: 0, compacted: false }];

  it('番号を行の id に戻す。知らない番号・知らない印は捨てる', () => {
    const marks = parseMarks(answer([{ id: '1', mark: 'drop' }, { id: '9', mark: 'keep' }, { id: '1x', mark: 'keep' }]), items);
    expect([...marks]).toEqual([['file:a.ts', 'drop']]);
  });

  it('失敗の答え（is_error）は、その理由で失敗にする。JSON でなければ最後の行、印が無ければ決まった文', () => {
    expect(() => parseMarks(JSON.stringify({ is_error: true, result: 'Not logged in · Please run /login' }), items)).toThrow('Not logged in · Please run /login');
    expect(() => parseMarks('warning\nAPI Error: 529', items)).toThrow('API Error: 529');
    expect(() => parseMarks(JSON.stringify({ is_error: false, result: '' }), items)).toThrow('Haiku の答えに印がありませんでした');
  });
});

describe('runClaude', () => {
  // 偽の claude。標準入力と引数と作業フォルダを書き出し、FAKE_EXIT の終了コードで終わる
  function fakeClaude(script: string): Record<string, string> {
    const bin = join(dir, 'bin');
    rmSync(bin, { recursive: true, force: true });
    mkdirSync(bin);
    const path = join(bin, 'claude');
    writeFileSync(path, `#!/bin/sh\n${script}\n`);
    chmodSync(path, 0o755);
    return { PATH: `${bin}:/usr/bin:/bin`, OUT: join(dir, 'out') };
  }

  it('標準入力に会話を渡し、一時フォルダで動かして、標準出力を返す', async () => {
    const env = fakeClaude('cat > "$OUT.stdin"; pwd > "$OUT.cwd"; printf "%s\\n" "$@" > "$OUT.args"; echo \'{"ok":true}\'');
    const output = await runClaude(null, env)(['-p', '--tools', ''], '会話の中身');
    expect(output.trim()).toBe('{"ok":true}');
    expect(readFileSync(`${env.OUT}.stdin`, 'utf8')).toBe('会話の中身');
    expect(realpathSync(readFileSync(`${env.OUT}.cwd`, 'utf8').trim())).toBe(realpathSync(tmpdir()));
    // 空の引数（--tools ""）もそのまま渡す
    expect(readFileSync(`${env.OUT}.args`, 'utf8')).toBe('-p\n--tools\n\n');
  });

  it('標準出力が無く終わったら、標準エラーか終了コードで失敗にする。起動できなければ失敗にする', async () => {
    await expect(runClaude(null, fakeClaude('echo "Invalid API key" >&2; exit 1'))([], '')).rejects.toThrow('Invalid API key');
    await expect(runClaude(null, fakeClaude('exit 3'))([], '')).rejects.toThrow('Claude Code が終了しました（終了コード 3）');
    await expect(runClaude(null, { PATH: join(dir, 'nowhere') })([], '')).rejects.toThrow(/ENOENT/);
  });

  it('塊の切れ目で割れた文字も、つないで読む', async () => {
    // 「答」（UTF-8 で 3 バイト）を 1 バイトと 2 バイトに分けて書く
    const output = await runClaude(null, fakeClaude("printf '\\347'; sleep 0.2; printf '\\255\\224'"))([], '');
    expect(output).toBe('答');
  });

  it('入力を読まずに先に終わっても、答えを返す', async () => {
    const output = await runClaude(null, fakeClaude('echo \'{"early":true}\''))([], 'x'.repeat(1_000_000));
    expect(output.trim()).toBe('{"early":true}');
  });
});
