import { Fragment, isValidElement, type ReactNode } from 'react';
import type { IconComponent, IconSize } from './icons';

// アイコンの SVG を HTML の文字列にする。React の外（document.createElement で作る DOM など）にアイコンを置くときに使う。
// react-dom/server は、ブラウザ向けでも 200KB ほど増えるので使わない。
// 代わりに、アイコンが返す要素（関数コンポーネントと SVG のタグだけ）をその場でたどって文字列にする。
// そのため、アイコンは hooks を使わない部品だけで描く（icons.tsx の描き方の決まり）

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

function escape(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ESCAPES[c]);
}

// React の属性名を SVG の属性名にする（className → class、strokeWidth → stroke-width。viewBox だけは大文字のまま）
function attributeName(name: string): string {
  if (name === 'className') return 'class';
  if (name === 'viewBox') return name;
  return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function toHtml(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return escape(String(node));
  if (Array.isArray(node)) return node.map(toHtml).join('');
  if (!isValidElement(node)) return '';
  const { type, props } = node as { type: unknown; props: Record<string, unknown> };
  if (typeof type === 'function') return toHtml((type as (props: unknown) => ReactNode)(props));
  if (type === Fragment) return toHtml(props.children as ReactNode);
  if (typeof type !== 'string') throw new Error('iconHtml: アイコンに使えない要素です');
  const { children, ...attributes } = props;
  const attrs = Object.entries(attributes)
    .filter(([, value]) => value != null && value !== false)
    .map(([name, value]) => ` ${attributeName(name)}="${escape(String(value))}"`)
    .join('');
  return `<${type}${attrs}>${toHtml(children as ReactNode)}</${type}>`;
}

export function iconHtml(Icon: IconComponent, size: IconSize): string {
  return toHtml(Icon({ size }));
}
