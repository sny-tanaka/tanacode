import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { t } from '@shared/i18n';
import { MAX_TRANSLATE_CHARS, MAX_TRANSLATE_TEXTS, type TranslateError, type TranslateResult } from '@shared/translate';

// チャットの思考・応答の翻訳。macOS 標準の翻訳を、同梱の補助プログラム（native/translate/main.swift）で呼ぶ。
// 訳すのは Mac の中だけで、外へは送らない。
// テストで Electron を読まずに済むよう、electron は import しない（パスと OS のバージョンは index.ts から渡す）

export const TRANSLATE_HELPER = 'tanacode-translate';
// システム設定の「言語と地域」（翻訳データの入れ方を案内するときに開く）
export const LANGUAGE_SETTINGS_URL = 'x-apple.systempreferences:com.apple.Localization-Settings.extension';

const MAX_BUFFER = 16 * 1024 * 1024;
const ERRORS: readonly TranslateError[] = ['same-language', 'not-installed', 'unsupported', 'failed'];

// パッケージ後は Contents/Resources に、開発中は scripts/build-translate-helper.mjs の出力先にある
export function translateHelperPath(o: { packaged: boolean; resourcesPath: string; appPath: string }): string {
  return o.packaged ? join(o.resourcesPath, TRANSLATE_HELPER) : join(o.appPath, 'build/native', TRANSLATE_HELPER);
}

// Translation フレームワークは macOS 15 以降。systemVersion は process.getSystemVersion()（例: 26.6.2）
export function translateAvailable(systemVersion: string, helperExists: boolean): boolean {
  return helperExists && Number(systemVersion.split('.')[0]) >= 15;
}

// 画面から来た値が、訳せる文字の配列か。違えば例外（呼んだ画面に返る）
export function translateTexts(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((text) => typeof text === 'string')) throw new Error(t('main.translate.invalidTexts'));
  if (value.length > MAX_TRANSLATE_TEXTS || value.reduce((n: number, text: string) => n + text.length, 0) > MAX_TRANSLATE_CHARS) {
    throw new Error(t('main.translate.tooLong'));
  }
  return value as string[];
}

// 補助プログラムの返事（JSON 1 行）を読む。形が違えば failed
export function parseTranslateOutput(stdout: string, count: number): TranslateResult {
  try {
    const data = JSON.parse(stdout) as Record<string, unknown>;
    const source = typeof data.source === 'string' ? data.source : undefined;
    if (data.ok === true && Array.isArray(data.texts) && data.texts.length === count && data.texts.every((t) => typeof t === 'string')) {
      return { ok: true, texts: data.texts as string[], source };
    }
    if (data.ok === false && ERRORS.includes(data.error as TranslateError)) {
      return { ok: false, error: data.error as TranslateError, source, message: typeof data.message === 'string' ? data.message : undefined };
    }
  } catch {
    // 下で failed にする
  }
  return { ok: false, error: 'failed', message: t('main.translate.unreadable') };
}

// 補助プログラムを 1 回動かす。訳す文字は標準入力で渡す。
// 補助プログラムも自分で止まる（20 秒 + 1 行 0.1 秒）が、それより少し長く待っても返事が無ければ止める
export function runTranslateHelper(path: string, texts: string[], timeoutMs = 30_000 + 150 * texts.length): Promise<TranslateResult> {
  return new Promise((resolve) => {
    const child = execFile(path, [], { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: MAX_BUFFER }, (err, stdout) => {
      if (err && !stdout) resolve({ ok: false, error: 'failed', message: err.killed ? t('main.translate.timeout') : err.message });
      else resolve(parseTranslateOutput(stdout, texts.length));
    });
    // 補助プログラムが先に終わっていたときの EPIPE は、上の結果で分かるので捨てる
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify({ texts }));
  });
}

// 訳す依頼を 1 つずつ順に動かす（続けて押されても、補助プログラムを一度にたくさん起動しない）
export class Translator {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly run: typeof runTranslateHelper = runTranslateHelper,
  ) {}

  translate(texts: string[]): Promise<TranslateResult> {
    const result = this.queue.then(() => this.run(this.path, texts));
    this.queue = result.catch(() => undefined);
    return result;
  }
}
