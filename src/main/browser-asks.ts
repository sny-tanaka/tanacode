import { randomUUID } from 'node:crypto';
import { BROWSER_ASK_TIMEOUT_MS } from '@shared/browser-tools';
import { t } from '@shared/i18n';
import type { BrowserAsk, BrowserAskChange } from '@shared/ipc';
import { textResult, type ToolResult } from './mcp-bridge';

// Claude がユーザーに頼んでいる操作（ask_user_to_act）。セッションごとに 1 つ。
// ユーザーが「終わった」「できない」を押すか、上限（10 分）を過ぎるか、Claude Code が呼び出しを取り消す（Esc で中断した）まで待つ。
// ユーザーが入れた値は返さない。返すのは、押したボタン（「できない」なら理由）と、今のページだけ。
// Claude に返す文は英語。帯のボタンの名前だけ、t() で画面の言語にする

// 頼む内容と、「できない」の理由の長さの上限
const MAX_MESSAGE = 1000;
const MAX_REASON = 500;

type Pending = { ask: BrowserAsk; page: () => string[]; finish: (result: ToolResult) => void };

export class BrowserAsks {
  private readonly pending = new Map<string, Pending>();

  constructor(
    // 頼んだ・終わった（ask が null）。画面の帯・一覧の印・通知に使う
    private readonly onChange: (sessionId: string, ask: BrowserAsk | null) => void,
    private readonly timeoutMs = BROWSER_ASK_TIMEOUT_MS,
  ) {}

  has(sessionId: string): boolean {
    return this.pending.has(sessionId);
  }

  // 今頼んでいるもの（画面を作り直したとき用）
  list(): BrowserAskChange[] {
    return [...this.pending].map(([sessionId, { ask }]) => ({ sessionId, ask }));
  }

  // 頼んで、返事を待つ。page: 返事をするときの今のページ（Claude に返す行）。signal: Claude Code が呼び出しを取り消した
  wait(sessionId: string, message: unknown, page: () => string[], signal?: AbortSignal): Promise<ToolResult> {
    const text = typeof message === 'string' ? message.trim() : '';
    if (!text) return Promise.resolve(textResult('Provide message (what to ask the user to do).', true));
    if (this.pending.has(sessionId)) return Promise.resolve(textResult('You have already asked the user to act. Wait for that answer.', true));
    if (signal?.aborted) return Promise.resolve(textResult('Canceled.', true));
    return new Promise((resolve) => {
      const ask: BrowserAsk = { id: randomUUID(), message: clip(text, MAX_MESSAGE) };
      const finish = (result: ToolResult) => {
        if (this.pending.get(sessionId)?.ask !== ask) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        this.pending.delete(sessionId);
        this.onChange(sessionId, null);
        resolve(result);
      };
      const cancel = () => finish(textResult('Canceled.', true));
      const minutes = Math.max(1, Math.round(this.timeoutMs / 60_000));
      const timer = setTimeout(
        () => {
          const within = `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
          const head = `Timed out (the user did not press "${t('preview.ask.done')}" or "${t('preview.ask.decline')}" within ${within}).`;
          finish(textResult([head, ...page()].join('\n')));
        },
        this.timeoutMs,
      );
      signal?.addEventListener('abort', cancel, { once: true });
      this.pending.set(sessionId, { ask, page, finish });
      this.onChange(sessionId, ask);
    });
  }

  // ユーザーの返事。今頼んでいるものへの返事でなければ（もう終わった・前の頼み）何もしない
  answer(sessionId: string, askId: unknown, answer: unknown): void {
    const pending = this.pending.get(sessionId);
    if (!pending || pending.ask.id !== askId || !answer || typeof answer !== 'object') return;
    const { done, reason } = answer as { done?: unknown; reason?: unknown };
    const why = typeof reason === 'string' ? clip(reason.replace(/\s+/g, ' ').trim(), MAX_REASON) : '';
    const head = done === true ? `The user pressed "${t('preview.ask.done')}".` : `The user pressed "${t('preview.ask.decline')}". Reason: ${why || '(none given)'}`;
    pending.finish(textResult([head, ...pending.page()].join('\n')));
  }

  // セッションを消した・アーカイブした
  cancel(sessionId: string): void {
    this.pending.get(sessionId)?.finish(textResult('The request was withdrawn because the session was closed.', true));
  }

  // 頼んでいるものを、すべてやめる（Claude に返す理由を添えて）
  cancelAll(reason: string): void {
    for (const { finish } of [...this.pending.values()]) finish(textResult(reason, true));
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
