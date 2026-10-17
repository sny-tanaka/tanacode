import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChecklistBook, emptyChecklistDoc, type ChecklistDoc } from '@shared/checklist-book';
import type { Checklist } from '@shared/checklist';
import { readSavedJson, unreadable } from './saved-json';

export { ChecklistError } from '@shared/checklist-book';

// チェックリストの保存。書き換えは ChecklistBook（@shared/checklist-book）が受け持つ。
// セッションごとに userData/checklists/<セッションの id>.json に置く（tmp に書いてから rename。500ms ずつまとめて書く）。
// 読めない・形の分からないファイルは、空から始めても上書きしない（saved-json.ts）

const SAVE_DELAY_MS = 500;

export class ChecklistStore extends ChecklistBook {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  // 保存しないセッション（読めない・形の分からないファイル。上書きも削除もしない）
  private readonly unsaved = new Set<string>();
  // 保存しないセッションと分かったとき（ファイルを読んだとき。profile.ts がつなぎ、画面の一覧の印を送り直す）
  onUnsaved: (sessionId: string) => void = () => {};

  constructor(
    private readonly dir: string,
    onChange: (sessionId: string, lists: Checklist[]) => void = () => {},
    clock: () => number = Date.now,
  ) {
    super(onChange, clock);
  }

  // セッションを一覧から消した。チェックリストも消す
  remove(sessionId: string): void {
    clearTimeout(this.timers.get(sessionId));
    this.timers.delete(sessionId);
    this.docs.delete(sessionId);
    if (!this.unsaved.delete(sessionId)) rmSync(this.file(sessionId), { force: true });
  }

  // 変更を保存しないセッションか（画面の知らせと、Claude への一言に使う）。まだ読んでいないセッションは false
  unsavable(sessionId: string): boolean {
    return this.unsaved.has(sessionId);
  }

  flush(): void {
    for (const [id, timer] of this.timers) {
      clearTimeout(timer);
      this.write(id);
    }
    this.timers.clear();
  }

  protected override load(sessionId: string): ChecklistDoc {
    const file = this.file(sessionId);
    let { data, writable } = readSavedJson(file, 'チェックリスト');
    const raw = data as Partial<ChecklistDoc> | null;
    if (raw && raw.version === 1 && Array.isArray(raw.lists)) {
      return { version: 1, lists: raw.lists, activity: Array.isArray(raw.activity) ? raw.activity : [], claudeSeenAt: raw.claudeSeenAt ?? 0 };
    }
    if (data !== null) ({ writable } = unreadable(file, 'チェックリスト'));
    if (!writable) {
      this.unsaved.add(sessionId);
      // 読んでいる途中（書き換えや一覧の読み出しの中）で知らせないよう、読み終えてから
      queueMicrotask(() => this.onUnsaved(sessionId));
    }
    return emptyChecklistDoc();
  }

  protected override save(sessionId: string): void {
    clearTimeout(this.timers.get(sessionId));
    this.timers.set(
      sessionId,
      setTimeout(() => {
        this.timers.delete(sessionId);
        this.write(sessionId);
      }, SAVE_DELAY_MS),
    );
  }

  private file(sessionId: string): string {
    return join(this.dir, `${sessionId}.json`);
  }

  private write(sessionId: string): void {
    const doc = this.docs.get(sessionId);
    if (!doc || this.unsaved.has(sessionId)) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      const file = this.file(sessionId);
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(doc), { mode: 0o600 });
      renameSync(tmp, file);
    } catch (error) {
      console.error('チェックリストを保存できませんでした', error);
    }
  }
}
