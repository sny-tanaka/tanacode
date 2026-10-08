import { vi } from 'vitest';
import type { Session, WebContents } from 'electron';
import { IpcChannel, type BrowserActivity, type BrowserAsk } from '../../src/shared/ipc';
import { BrowserControl } from '../../src/main/browser-control';
import type { ToolResult } from '../../src/main/mcp-bridge';
import { FakeContents, FakeSession, HOST } from './fake-electron';

// アプリ内ブラウザの操作（BrowserControl）を、Electron の作り物（fake-electron.ts）の上で組み立てる。
// 使うテストのファイルでは、先に vi.mock('electron', ...) で Electron を差し替えておく。
// 時間は vi.useFakeTimers で進める（操作の間の待ち・時間切れを、待たずに確かめる）

// タブ 1 つ（webview の中身と、画面が付けたタブの ID）
export type Tab = FakeContents & { tabId: string };

// 呼び出しが終わるまで、時間を少しずつ進める
export async function finish<T>(promise: Promise<T>, step = 50): Promise<T> {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; !done && i < 20_000; i++) await vi.advanceTimersByTimeAsync(step);
  return promise;
}

// 待っている約束の続き（マイクロタスク）を進める。時間は進めない
export async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

// 結果の文（画像を除く）
export function textOf(result: ToolResult): string {
  return result.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

export function setup() {
  const sent: { channel: string; payload: unknown }[] = [];
  const asked: [string, BrowserAsk | null][] = [];
  const state = {
    enabled: true,
    hosts: [] as string[],
    host: HOST as unknown,
    sessions: new Set(['S1', 'S2']),
    // 画面の代わりに、開く・新しいタブの知らせに応えるか
    renderer: true,
    // 画面がタブを今のタブにしてから、webview を知らせてくるまで
    attachDelay: 50,
    // 画面の代わりが webview を知らせたあと（読み込みの途中で起きることを差し込む）
    afterAttach: null as ((page: Tab) => void) | null,
  };
  let tabs = 0;
  // 画面の代わりが作ったタブ
  const created: Tab[] = [];
  const control: BrowserControl = new BrowserControl({
    send: (channel, payload) => {
      sent.push({ channel, payload });
      if (!state.renderer || (channel !== IpcChannel.BrowserOpen && channel !== IpcChannel.BrowserNewTab)) return;
      // 画面（PreviewPane）と同じ順: タブを作り、前に出すものはすぐ今のタブにして、ページの準備ができたら webview を知らせる
      const request = payload as { sessionId: string; url: string; background?: boolean };
      const tabId = `tab-${++tabs}`;
      if (!request.background) control.activate(request.sessionId, tabId);
      setTimeout(() => {
        const page = Object.assign(new FakeContents({ url: request.url, title: `${request.url} のタイトル` }), { tabId });
        created.push(page);
        control.attach(request.sessionId, tabId, page.id);
        state.afterAttach?.(page);
      }, state.attachDelay);
    },
    enabled: () => state.enabled,
    extraHosts: () => state.hosts,
    host: () => state.host as WebContents | null,
    hasSession: (id) => state.sessions.has(id),
    onAsk: (id, ask) => asked.push([id, ask]),
    channels: {
      open: IpcChannel.BrowserOpen,
      activity: IpcChannel.BrowserActivity,
      viewport: IpcChannel.BrowserViewport,
      newTab: IpcChannel.BrowserNewTab,
      selectTab: IpcChannel.BrowserSelectTab,
      closeTab: IpcChannel.BrowserCloseTab,
      ask: IpcChannel.BrowserAsk,
    },
  });

  // 画面がタブを作って知らせてきた（activate を false にすると、今のタブにはしない）
  const open = (url: string, options: { title?: string; sessionId?: string; activate?: boolean } = {}): Tab => {
    const tabId = `tab-${++tabs}`;
    const page = Object.assign(new FakeContents({ url, title: options.title ?? 'ページ' }), { tabId });
    const sessionId = options.sessionId ?? 'S1';
    control.attach(sessionId, tabId, page.id);
    if (options.activate !== false) control.activate(sessionId, tabId);
    return page;
  };

  // 中継から呼び出しが届いた。終わるまで時間を進める
  const call = (name: string, args: Record<string, unknown> = {}, sessionId = 'S1'): Promise<ToolResult> => finish(control.handle(sessionId, name, args));

  // 画面へ送ったもの（チャンネルごと）
  const sentOn = <T = unknown>(channel: string): T[] => sent.filter((s) => s.channel === channel).map((s) => s.payload as T);
  const activities = () => sentOn<BrowserActivity>(IpcChannel.BrowserActivity);

  // プレビューの webview が使うセッション
  const network = new FakeSession();
  control.watchNetwork(network as unknown as Session);

  return { control, state, sent, asked, created, open, call, sentOn, activities, network };
}

// ページのコンソールに出す（Electron の console-message）
export function logConsole(page: FakeContents, level: string, message: string, sourceId = '', lineNumber = 0): void {
  page.emit('console-message', { level, message, sourceId, lineNumber });
}

// 別プロセスの iframe につながった（URL は Runtime.evaluate の location.href で答える）
export function addChildFrame(page: FakeContents, child: string, type = 'iframe'): void {
  page.debugger.message('Target.attachedToTarget', { sessionId: child, targetInfo: { type } });
}

// CDP の命令に、名前ごとの答えを返す（child ごとの location.href も）
export function answerCdp(
  page: FakeContents,
  answers: Record<string, (params: Record<string, unknown> | undefined, child: string | undefined) => unknown>,
  frames: Record<string, string> = {},
): void {
  page.debugger.handler = (method, params, child) => {
    if (method === 'Runtime.evaluate' && child && params?.expression === 'location.href') {
      if (!(child in frames)) throw new Error(`知らない iframe のセッションです: ${child}`);
      return { result: { value: frames[child] } };
    }
    const answer = answers[method];
    return answer ? answer(params, child) : {};
  };
}
