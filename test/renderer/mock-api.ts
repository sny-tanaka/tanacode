import type { TanacodeApi } from '@shared/ipc';

// 画面のテストで使う window.tanacode の偽物。呼び出しを控え、知らせ（onXxx）の受け手を持っておいて、テストから送れるようにする。
// 返す値は responses に「名前空間.メソッド」で決める（決めていないものは、invoke と同じく Promise で undefined を返す）
export type Call = { name: string; args: unknown[] };

export function mockApi(responses: Record<string, (...args: never[]) => unknown> = {}) {
  const calls: Call[] = [];
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const namespace = (ns: string) =>
    new Proxy(
      {},
      {
        get(_target, method: string) {
          const name = `${ns}.${method}`;
          if (method.startsWith('on')) {
            return (listener: (payload: unknown) => void) => {
              const set = listeners.get(name) ?? new Set();
              set.add(listener);
              listeners.set(name, set);
              return () => set.delete(listener);
            };
          }
          return (...args: unknown[]) => {
            calls.push({ name, args });
            const respond = responses[name] as ((...a: unknown[]) => unknown) | undefined;
            return respond ? respond(...args) : Promise.resolve(undefined);
          };
        },
      },
    );
  // pathForFile だけは名前空間でなく関数（responses の pathForFile で決める）
  const api = new Proxy({}, { get: (_target, ns: string) => (ns === 'pathForFile' ? (responses.pathForFile ?? (() => '')) : namespace(ns)) }) as TanacodeApi;
  return {
    api,
    calls,
    // 「名前空間.onXxx」の受け手に知らせる
    emit(name: string, payload?: unknown) {
      for (const listener of listeners.get(name) ?? []) listener(payload);
    },
    // name の呼び出しの引数（呼ばれた順）
    argsOf(name: string): unknown[][] {
      return calls.filter((c) => c.name === name).map((c) => c.args);
    },
    install() {
      (window as unknown as { tanacode: TanacodeApi }).tanacode = api;
    },
  };
}
