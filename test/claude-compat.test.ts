import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VERIFIED_CLAUDE_CODE_VERSION } from '@shared/claude-code';
import { parseCompatTable, verifiedFor } from '@shared/claude-compat';
import { ClaudeCompatMonitor, COMPAT_URL } from '../src/main/claude-compat';
import type { Fetcher } from '../src/main/app-update';

// tanacode のバージョンと、動作確認済の Claude Code のバージョンの対応表（compat.json）
describe('parseCompatTable', () => {
  it('範囲と、動作確認済のバージョンを読む', () => {
    expect(
      parseCompatTable({
        rows: [
          { app: '>=2.2.0 <2.2.4', claudeCode: '2.1.305' },
          { app: '>=2.2.4', claudeCode: '2.1.306' },
        ],
      }),
    ).toEqual([
      { from: '2.2.0', below: '2.2.4', claudeCode: '2.1.305' },
      { from: '2.2.4', below: null, claudeCode: '2.1.306' },
    ]);
  });

  it.each([
    ['null', null],
    ['配列', []],
    ['rows が無い', {}],
    ['行が空', { rows: [] }],
    ['バージョンの形が違う', { rows: [{ app: '>=2.2.0', claudeCode: '2.1.305-beta' }] }],
    ['範囲の形が違う', { rows: [{ app: '^2.2.0', claudeCode: '2.1.305' }] }],
    ['範囲の上限が下限以下', { rows: [{ app: '>=2.2.4 <2.2.4', claudeCode: '2.1.305' }] }],
    ['行が重なる', { rows: [{ app: '>=2.2.0 <2.3.0', claudeCode: '2.1.305' }, { app: '>=2.2.4', claudeCode: '2.1.306' }] }],
    ['上限の無い行のあとに行がある', { rows: [{ app: '>=2.2.0', claudeCode: '2.1.305' }, { app: '>=2.3.0', claudeCode: '2.1.306' }] }],
    ['古い順でない', { rows: [{ app: '>=2.3.0 <2.4.0', claudeCode: '2.1.306' }, { app: '>=2.2.0 <2.3.0', claudeCode: '2.1.305' }] }],
    ['行が多すぎる', { rows: Array.from({ length: 1001 }, (_, i) => ({ app: `>=0.0.${i} <0.0.${i + 1}`, claudeCode: '2.1.305' })) }],
  ])('形が違えば null（%s）', (_label, body) => {
    expect(parseCompatTable(body)).toBeNull();
  });
});

describe('verifiedFor', () => {
  const rows = parseCompatTable({
    rows: [
      { app: '>=2.2.0 <2.2.4', claudeCode: '2.1.305' },
      { app: '>=2.2.4', claudeCode: '2.1.306' },
    ],
  })!;

  it('アプリのバージョンを含む行のバージョン（下限は含み、上限は含まない）', () => {
    expect(verifiedFor(rows, '2.2.0')).toBe('2.1.305');
    expect(verifiedFor(rows, '2.2.3')).toBe('2.1.305');
    expect(verifiedFor(rows, '2.2.4')).toBe('2.1.306');
    expect(verifiedFor(rows, '3.0.0')).toBe('2.1.306');
  });

  it('行が無ければ null', () => {
    expect(verifiedFor(rows, '2.1.9')).toBeNull();
  });
});

// リポジトリの表は、アプリが読める形で、次にリリースするバージョンの行が、組み込んだバージョンと同じ
// （毎日の互換性の確認が、組み込んだバージョンと一緒に書き換える。scripts/update-verified-version.mjs）
describe('compat.json', () => {
  const rows = parseCompatTable(JSON.parse(readFileSync('compat.json', 'utf8')));
  const app = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
  const next = app.replace(/\d+$/, (n) => String(Number(n) + 1));

  it('アプリが読める形', () => {
    expect(rows).not.toBeNull();
  });

  it(`次にリリースするバージョン（${next} 以上）の行は、組み込んだバージョン（${VERIFIED_CLAUDE_CODE_VERSION}）`, () => {
    expect(verifiedFor(rows!, next)).toBe(VERIFIED_CLAUDE_CODE_VERSION);
    expect(rows!.at(-1)!.below).toBeNull();
  });
});

describe('ClaudeCompatMonitor', () => {
  let dir: string;
  const cacheOf = () => join(dir, 'claude-compat.json');
  const table = (claudeCode: string) => ({ rows: [{ app: '>=1.0.0', claudeCode }] });
  const reply =
    (status: number, body: unknown, urls: string[] = []): Fetcher =>
    (url) => {
      urls.push(url);
      return Promise.resolve(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));
    };
  const offline: Fetcher = () => Promise.reject(new Error('offline'));
  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), 'tanacode-compat-'));
  };
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('表を読めたら、このアプリの行のバージョンを知らせ、控えに残す。止めたら組み込んだバージョンに戻す', async () => {
    setup();
    const changes: string[] = [];
    const urls: string[] = [];
    const monitor = new ClaudeCompatMonitor('1.2.0', cacheOf(), (v) => changes.push(v), reply(200, table('9.9.9'), urls));
    expect(monitor.get()).toBe(VERIFIED_CLAUDE_CODE_VERSION);
    monitor.start();
    await monitor.refresh();
    expect(monitor.get()).toBe('9.9.9');
    expect(urls[0]).toBe(COMPAT_URL);
    expect(JSON.parse(readFileSync(cacheOf(), 'utf8'))).toEqual({ app: '1.2.0', table: table('9.9.9') });
    monitor.stop();
    expect(changes).toEqual(['9.9.9', VERIFIED_CLAUDE_CODE_VERSION]);
    // 止めているあいだは読まない
    await monitor.refresh();
    expect(urls).toHaveLength(1);
  });

  it('読めないときは、最後に読めた表を使う', async () => {
    setup();
    writeFileSync(cacheOf(), JSON.stringify({ app: '1.2.0', table: table('9.9.8') }));
    const monitor = new ClaudeCompatMonitor('1.2.0', cacheOf(), () => {}, offline);
    monitor.start();
    await monitor.refresh();
    expect(monitor.get()).toBe('9.9.8');
    monitor.stop();
  });

  it('控えが無い・別のバージョンのアプリが読んだ・壊れているときは、組み込んだバージョン', async () => {
    setup();
    const check = async () => {
      const monitor = new ClaudeCompatMonitor('1.2.0', cacheOf(), () => {}, offline);
      monitor.start();
      await monitor.refresh();
      const verified = monitor.get();
      monitor.stop();
      return verified;
    };
    expect(await check()).toBe(VERIFIED_CLAUDE_CODE_VERSION);
    writeFileSync(cacheOf(), JSON.stringify({ app: '1.1.0', table: table('9.9.8') }));
    expect(await check()).toBe(VERIFIED_CLAUDE_CODE_VERSION);
    writeFileSync(cacheOf(), '{');
    expect(await check()).toBe(VERIFIED_CLAUDE_CODE_VERSION);
  });

  it.each([
    ['見つからない', reply(404, 'Not Found')],
    ['JSON でない', reply(200, '<html>')],
    ['形が違う', reply(200, { rows: [{ app: '>=1.0.0', claudeCode: 'latest' }] })],
    ['長すぎる', reply(200, `{"rows":[{"app":">=1.0.0","claudeCode":"9.9.9"}]}${' '.repeat(64 * 1024)}`)],
  ])('返事が使えないとき（%s）は、前のまま（控えも書き換えない）', async (_label, fetcher) => {
    setup();
    writeFileSync(cacheOf(), JSON.stringify({ app: '1.2.0', table: table('9.9.8') }));
    const monitor = new ClaudeCompatMonitor('1.2.0', cacheOf(), () => {}, fetcher);
    monitor.start();
    await monitor.refresh();
    expect(monitor.get()).toBe('9.9.8');
    expect(JSON.parse(readFileSync(cacheOf(), 'utf8'))).toEqual({ app: '1.2.0', table: table('9.9.8') });
    monitor.stop();
  });

  it('表にこのアプリの行が無ければ、組み込んだバージョン', async () => {
    setup();
    const monitor = new ClaudeCompatMonitor('0.9.0', cacheOf(), () => {}, reply(200, table('9.9.9')));
    monitor.start();
    await monitor.refresh();
    expect(monitor.get()).toBe(VERIFIED_CLAUDE_CODE_VERSION);
    monitor.stop();
  });

  it('控えを保存できなくても、読めた表を使う。2 度 start しても、読むのは 1 回', async () => {
    setup();
    const urls: string[] = [];
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const monitor = new ClaudeCompatMonitor('1.2.0', join(dir, 'missing', 'claude-compat.json'), () => {}, reply(200, table('9.9.9'), urls));
    monitor.start();
    monitor.start();
    await monitor.refresh();
    expect(monitor.get()).toBe('9.9.9');
    expect(urls).toHaveLength(1);
    expect(errors).toHaveBeenCalledTimes(1);
    errors.mockRestore();
    monitor.stop();
  });

  it('読んでいるあいだに止めたら、結果を捨てる', async () => {
    setup();
    const monitor = new ClaudeCompatMonitor('1.2.0', cacheOf(), () => {}, reply(200, table('9.9.9')));
    monitor.start();
    const reading = monitor.refresh();
    monitor.stop();
    await reading;
    expect(monitor.get()).toBe(VERIFIED_CLAUDE_CODE_VERSION);
  });
});
