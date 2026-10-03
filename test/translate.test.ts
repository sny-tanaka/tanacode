import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseTranslateOutput, runTranslateHelper, translateAvailable, translateHelperPath, translateTexts, Translator } from '../src/main/translate';
import type { TranslateResult } from '@shared/translate';

// チャットの翻訳の main 側。補助プログラム（Swift）の代わりに、sh の作り物を動かして確かめる

const dir = mkdtempSync(join(tmpdir(), 'tanacode-translate-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// 作り物の補助プログラムを置く（中身は sh）
function fakeHelper(name: string, script: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe('補助プログラムの場所と、使えるか', () => {
  it('パッケージ後は Resources、開発中は build/native', () => {
    expect(translateHelperPath({ packaged: true, resourcesPath: '/App/Contents/Resources', appPath: '/repo' })).toBe('/App/Contents/Resources/tanacode-translate');
    expect(translateHelperPath({ packaged: false, resourcesPath: '/x', appPath: '/repo' })).toBe('/repo/build/native/tanacode-translate');
  });

  it('macOS 15 以降で、補助プログラムがあるときだけ使える', () => {
    expect(translateAvailable('15.0.0', true)).toBe(true);
    expect(translateAvailable('26.6.2', true)).toBe(true);
    expect(translateAvailable('14.7.1', true)).toBe(false);
    expect(translateAvailable('26.6.2', false)).toBe(false);
  });
});

describe('画面から来た値の検査', () => {
  it('文字列の配列だけを通す', () => {
    expect(translateTexts(['a', 'b'])).toEqual(['a', 'b']);
    expect(() => translateTexts('a')).toThrow('形が違います');
    expect(() => translateTexts(['a', 1])).toThrow('形が違います');
  });

  it('多すぎる・長すぎるものは断る', () => {
    expect(() => translateTexts(Array.from({ length: 1001 }, () => 'a'))).toThrow('長すぎて');
    expect(() => translateTexts(['a'.repeat(100_001)])).toThrow('長すぎて');
  });
});

describe('補助プログラムの返事を読む', () => {
  it('訳せた・訳せなかったを読む', () => {
    expect(parseTranslateOutput('{"ok":true,"texts":["こんにちは"],"source":"en"}\n', 1)).toEqual({ ok: true, texts: ['こんにちは'], source: 'en' });
    expect(parseTranslateOutput('{"ok":false,"error":"not-installed","source":"en"}', 1)).toEqual({ ok: false, error: 'not-installed', source: 'en', message: undefined });
  });

  it('壊れている・数が合わない・知らないわけは failed にする', () => {
    expect(parseTranslateOutput('not json', 1)).toMatchObject({ ok: false, error: 'failed' });
    expect(parseTranslateOutput('{"ok":true,"texts":["a"]}', 2)).toMatchObject({ ok: false, error: 'failed' });
    expect(parseTranslateOutput('{"ok":false,"error":"boom"}', 1)).toMatchObject({ ok: false, error: 'failed' });
  });
});

describe('補助プログラムを動かす', () => {
  it('訳す文字を標準入力で JSON にして渡す', async () => {
    // 受け取ったものをファイルに書き、決まった返事をする
    const received = join(dir, 'received.json');
    const helper = fakeHelper('echo', `cat > '${received}'; printf '{"ok":true,"texts":["訳"],"source":"en"}'`);
    expect(await runTranslateHelper(helper, ['Hello "world"'])).toEqual({ ok: true, texts: ['訳'], source: 'en' });
    expect(JSON.parse(readFileSync(received, 'utf8'))).toEqual({ texts: ['Hello "world"'] });
  });

  it('返事が無いまま終わったら failed', async () => {
    const helper = fakeHelper('crash', 'cat > /dev/null; echo oops >&2; exit 3');
    expect(await runTranslateHelper(helper, ['a'])).toMatchObject({ ok: false, error: 'failed' });
  });

  it('時間内に終わらなければ止めて failed', async () => {
    const helper = fakeHelper('hang', 'exec sleep 30');
    const start = Date.now();
    expect(await runTranslateHelper(helper, ['a'], 300)).toEqual({ ok: false, error: 'failed', message: '時間内に訳し終わりませんでした' });
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it('無いときは failed', async () => {
    expect(await runTranslateHelper(join(dir, 'missing'), ['a'])).toMatchObject({ ok: false, error: 'failed' });
  });
});

describe('依頼を順に 1 つずつ動かす', () => {
  it('前の依頼が終わってから、次を動かす（失敗しても続ける）', async () => {
    const log: string[] = [];
    let running = 0;
    const run = async (_path: string, texts: string[]): Promise<TranslateResult> => {
      running++;
      log.push(`start ${texts[0]} (${running})`);
      await new Promise((r) => setTimeout(r, 20));
      running--;
      log.push(`end ${texts[0]}`);
      if (texts[0] === 'b') throw new Error('boom');
      return { ok: true, texts };
    };
    const translator = new Translator('/fake', run);
    const results = await Promise.allSettled([translator.translate(['a']), translator.translate(['b']), translator.translate(['c'])]);
    expect(log).toEqual(['start a (1)', 'end a', 'start b (1)', 'end b', 'start c (1)', 'end c']);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  });
});
