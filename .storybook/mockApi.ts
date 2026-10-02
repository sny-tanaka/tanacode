// window.tanacode（preload が公開するアプリの API）の差し替え。Storybook には Electron が無いので、
// どの呼び出しも何もしない。on〜（購読）は購読をやめる関数を、それ以外は undefined で解決する Promise を返す。
// ストーリーで返事を決めたいときは mockApi({ 'workflows.get': () => [...] }) のように呼ぶ
type Handler = (...args: unknown[]) => unknown;

const overrides = new Map<string, Handler>();

function node(path: string[]): unknown {
  const call = (...args: unknown[]) => {
    const key = path.join('.');
    const handler = overrides.get(key);
    if (handler) return handler(...args);
    const name = path[path.length - 1] ?? '';
    return /^on[A-Z]/.test(name) ? () => {} : Promise.resolve(undefined);
  };
  return new Proxy(call, {
    get: (_target, key) => (typeof key === 'string' ? node([...path, key]) : undefined),
  });
}

export function installMockApi(): void {
  (window as unknown as { tanacode: unknown }).tanacode = node([]);
}

export function mockApi(handlers: Record<string, Handler>): void {
  for (const [key, handler] of Object.entries(handlers)) overrides.set(key, handler);
}

// ストーリーで決めた返事を捨てる（preview がストーリーごとに呼ぶ。前のストーリーの返事が次に残らないように）
export function resetMockApi(): void {
  overrides.clear();
}
