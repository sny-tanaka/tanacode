import { AUTO_COMPACT_PERCENTS, DEFAULT_AUTO_COMPACT_PERCENT } from '@shared/optimized-compact';
import { AWAY_WAIT_MINUTES, DEFAULT_AWAY_WAIT_MINUTES } from '@shared/away-mode';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isLanguageSetting, type LanguageSetting } from '@shared/i18n';
import { customPromptsOf, type CustomPrompts } from '@shared/prompts';

// 登録した Claude Code の設定ファイル。覚えるのは名前とパスだけ（中身は預からない）
export type StoredSettingsFile = { id: string; name: string; path: string };

// notifications: macOS の通知を出すか / updateCheck: GitHub の Releases で新しいバージョンが出たら通知するか /
// updateOnQuit: Homebrew で入れたとき、終了するときに新しいバージョンを入れるか /
// settingsFiles: セッションごとに選んで、標準の設定に重ねて起動する設定ファイル /
// browserControl: Claude にアプリ内ブラウザを操作させるか（起動する Claude Code に MCP サーバーを足すか）/
// browserHosts: アプリ内ブラウザで Claude に許す先（localhost などの既定に足すもの）/
// sessionsControl: Claude にほかのセッションを扱わせるか（起動する Claude Code に、セッションの MCP サーバーを足すか）/
// sessionsStartConfirm: Claude がセッションを始める前に、人に許可を求めるか（アプリ全体で 1 つ。既定のプロファイルの設定のファイルに置く）/
// checklistControl: Claude にチェックリストを扱わせるか（起動する Claude Code に、チェックリストの MCP サーバーを足すか）/
// walkthroughControl: Claude にウォークスルーさせるか（起動する Claude Code に、ウォークスルーの MCP サーバーを足すか）/
// terminalControl: Claude に人のターミナルを使わせるか（起動する Claude Code に、ターミナルの MCP サーバーを足すか）/
// autoCompactPercent: 最適化圧縮を自動で始める大きさ（コンテキストの割合。40・60・80）/
// awayWaitMinutes: 離席モードで、人に回った許可の確認・質問の答えを待つ時間（分。@shared/away-mode）/
// usageLimitResume: 利用枠で止まったセッションに、枠が戻ったら続きを頼む予約を入れるか（usage-limit-resume.ts）/
// prompts: tanacode が人の代わりに Claude に送る文のうち、利用者が変えた欄（アプリ全体で 1 つ。既定のプロファイルの設定のファイルに置く。shared/prompts.ts）/
// language: 画面の言語（system は Mac の言語の設定に合わせる）
type Values = {
  notifications: boolean;
  updateCheck: boolean;
  updateOnQuit: boolean;
  settingsFiles: StoredSettingsFile[];
  browserControl: boolean;
  browserHosts: string[];
  sessionsControl: boolean;
  sessionsStartConfirm: boolean;
  checklistControl: boolean;
  walkthroughControl: boolean;
  terminalControl: boolean;
  autoCompactPercent: number;
  awayWaitMinutes: number;
  usageLimitResume: boolean;
  prompts: CustomPrompts;
  language: LanguageSetting;
};

// アプリ自身の設定（Claude Code の設定ではない）
export class AppSettings {
  private values: Values;

  constructor(private readonly file: string) {
    this.values = load(file);
  }

  notificationsEnabled(): boolean {
    return this.values.notifications;
  }

  setNotificationsEnabled(on: boolean): void {
    this.update({ notifications: on });
  }

  updateCheckEnabled(): boolean {
    return this.values.updateCheck;
  }

  setUpdateCheckEnabled(on: boolean): void {
    this.update({ updateCheck: on });
  }

  updateOnQuitEnabled(): boolean {
    return this.values.updateOnQuit;
  }

  setUpdateOnQuitEnabled(on: boolean): void {
    this.update({ updateOnQuit: on });
  }

  settingsFiles(): StoredSettingsFile[] {
    return this.values.settingsFiles;
  }

  setSettingsFiles(files: StoredSettingsFile[]): void {
    this.update({ settingsFiles: files });
  }

  browserControlEnabled(): boolean {
    return this.values.browserControl;
  }

  setBrowserControlEnabled(on: boolean): void {
    this.update({ browserControl: on });
  }

  browserHosts(): string[] {
    return this.values.browserHosts;
  }

  sessionsControlEnabled(): boolean {
    return this.values.sessionsControl;
  }

  setSessionsControlEnabled(on: boolean): void {
    this.update({ sessionsControl: on });
  }

  sessionsStartConfirmEnabled(): boolean {
    return this.values.sessionsStartConfirm;
  }

  setSessionsStartConfirmEnabled(on: boolean): void {
    this.update({ sessionsStartConfirm: on });
  }

  checklistControlEnabled(): boolean {
    return this.values.checklistControl;
  }

  // 最適化圧縮を自動で始める大きさ（コンテキストの割合）
  autoCompactPercent(): number {
    return this.values.autoCompactPercent;
  }

  setAutoCompactPercent(percent: number): void {
    this.update({ autoCompactPercent: percent });
  }

  // 離席モードで答えを待つ時間（分）
  awayWaitMinutes(): number {
    return this.values.awayWaitMinutes;
  }

  setAwayWaitMinutes(minutes: number): void {
    this.update({ awayWaitMinutes: minutes });
  }

  setChecklistControlEnabled(on: boolean): void {
    this.update({ checklistControl: on });
  }

  walkthroughControlEnabled(): boolean {
    return this.values.walkthroughControl;
  }

  setWalkthroughControlEnabled(on: boolean): void {
    this.update({ walkthroughControl: on });
  }

  terminalControlEnabled(): boolean {
    return this.values.terminalControl;
  }

  setTerminalControlEnabled(on: boolean): void {
    this.update({ terminalControl: on });
  }

  usageLimitResumeEnabled(): boolean {
    return this.values.usageLimitResume;
  }

  setUsageLimitResumeEnabled(on: boolean): void {
    this.update({ usageLimitResume: on });
  }

  // 利用者が変えた、Claude に送る文（無い欄は既定の文）
  prompts(): CustomPrompts {
    return this.values.prompts;
  }

  setPrompts(prompts: CustomPrompts): void {
    this.update({ prompts: customPromptsOf(prompts) });
  }

  setBrowserHosts(hosts: string[]): void {
    this.update({ browserHosts: hosts });
  }

  languageSetting(): LanguageSetting {
    return this.values.language;
  }

  setLanguageSetting(language: LanguageSetting): void {
    this.update({ language });
  }

  // 保存できなかったら、値を元に戻して例外を投げる（画面の表示と食い違わせない）
  private update(change: Partial<Values>): void {
    const before = this.values;
    this.values = { ...before, ...change };
    try {
      this.save();
    } catch (error) {
      this.values = before;
      throw error;
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, ...this.values }, null, 2));
    renameSync(tmp, this.file);
  }
}

// 無い・読めない値は、オン（通知は、この設定ができる前のバージョンと同じく出す）。設定ファイルと許す先は、無ければ無し。Claude に送る文は、無ければ既定の文。
// 言語は、無ければ Mac に合わせる
function load(file: string): Values {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as {
      notifications?: unknown;
      updateCheck?: unknown;
      updateOnQuit?: unknown;
      settingsFiles?: unknown;
      browserControl?: unknown;
      browserHosts?: unknown;
      sessionsControl?: unknown;
      sessionsStartConfirm?: unknown;
      checklistControl?: unknown;
      walkthroughControl?: unknown;
      terminalControl?: unknown;
      autoCompactPercent?: unknown;
      awayWaitMinutes?: unknown;
      usageLimitResume?: unknown;
      prompts?: unknown;
      language?: unknown;
    };
    return {
      notifications: data.notifications !== false,
      updateCheck: data.updateCheck !== false,
      updateOnQuit: data.updateOnQuit !== false,
      settingsFiles: storedFiles(data.settingsFiles),
      browserControl: data.browserControl !== false,
      browserHosts: Array.isArray(data.browserHosts) ? data.browserHosts.filter((h): h is string => typeof h === 'string') : [],
      sessionsControl: data.sessionsControl !== false,
      sessionsStartConfirm: data.sessionsStartConfirm !== false,
      checklistControl: data.checklistControl !== false,
      walkthroughControl: data.walkthroughControl !== false,
      terminalControl: data.terminalControl !== false,
      autoCompactPercent: (AUTO_COMPACT_PERCENTS as readonly unknown[]).includes(data.autoCompactPercent) ? (data.autoCompactPercent as number) : DEFAULT_AUTO_COMPACT_PERCENT,
      awayWaitMinutes: (AWAY_WAIT_MINUTES as readonly unknown[]).includes(data.awayWaitMinutes) ? (data.awayWaitMinutes as number) : DEFAULT_AWAY_WAIT_MINUTES,
      usageLimitResume: data.usageLimitResume !== false,
      prompts: customPromptsOf(data.prompts),
      language: isLanguageSetting(data.language) ? data.language : 'system',
    };
  } catch {
    return { notifications: true, updateCheck: true, updateOnQuit: true, settingsFiles: [], browserControl: true, browserHosts: [], sessionsControl: true, sessionsStartConfirm: true, checklistControl: true, walkthroughControl: true, terminalControl: true, autoCompactPercent: DEFAULT_AUTO_COMPACT_PERCENT, awayWaitMinutes: DEFAULT_AWAY_WAIT_MINUTES, usageLimitResume: true, prompts: {}, language: 'system' };
  }
}

function storedFiles(value: unknown): StoredSettingsFile[] {
  if (!Array.isArray(value)) return [];
  const files: StoredSettingsFile[] = [];
  for (const item of value as { id?: unknown; name?: unknown; path?: unknown }[]) {
    if (typeof item?.id === 'string' && typeof item.name === 'string' && typeof item.path === 'string') {
      files.push({ id: item.id, name: item.name, path: item.path });
    }
  }
  return files;
}
