import { memo, type FunctionComponent } from 'react';

// 部品が描き直された回数（名前ごと）。vi.mock で部品を包んで数える（中身と memo のしかたは元のまま）
export const renderCounts = new Map<string, number>();

export function rendersOf(name: string): number {
  return renderCounts.get(name) ?? 0;
}

type Memoized = { $$typeof: symbol; type: FunctionComponent<object>; compare: ((a: object, b: object) => boolean) | null };

// 部品を、描くたびに数えるものに包む。中身はその場で呼ぶ（部品の state が変わって描き直したときも数える）。
// memo した部品は、memo の中身を包み直して memo のまま返す（memo が効いたかも数に出る）
export function countRenders<T>(name: string, component: T): T {
  const memoized = (component as unknown as Memoized).$$typeof === Symbol.for('react.memo') ? (component as unknown as Memoized) : null;
  const target = memoized ? memoized.type : (component as unknown as FunctionComponent<object>);
  const counted = (props: object) => {
    renderCounts.set(name, rendersOf(name) + 1);
    return target(props);
  };
  counted.displayName = `Counted(${name})`;
  return (memoized ? memo(counted, memoized.compare ?? undefined) : counted) as unknown as T;
}
