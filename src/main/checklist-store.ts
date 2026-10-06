import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChecklistBook, emptyChecklistDoc, type ChecklistDoc } from '@shared/checklist-book';
import type { Checklist } from '@shared/checklist';

export { ChecklistError } from '@shared/checklist-book';

// チェックリストの保存。書き換えは ChecklistBook（@shared/checklist-book）が受け持つ。
// セッションごとに userData/checklists/<セッションの id>.json に置く（tmp に書いてから rename。500ms ずつまとめて書く）

const SAVE_DELAY_MS = 500;

export class ChecklistStore extends ChecklistBook {
  private readonly timers = new Map<string, NodeJS.Timeout>();

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
    rmSync(this.file(sessionId), { force: true });
  }

  flush(): void {
    for (const [id, timer] of this.timers) {
      clearTimeout(timer);
      this.write(id);
    }
    this.timers.clear();
  }

  protected override load(sessionId: string): ChecklistDoc {
    try {
      const raw = JSON.parse(readFileSync(this.file(sessionId), 'utf8')) as Partial<ChecklistDoc>;
      if (raw && raw.version === 1 && Array.isArray(raw.lists)) {
        return { version: 1, lists: raw.lists, activity: Array.isArray(raw.activity) ? raw.activity : [], claudeSeenAt: raw.claudeSeenAt ?? 0 };
      }
    } catch {
      // 無い・壊れたファイルは、空から始める
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
    if (!doc) return;
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
