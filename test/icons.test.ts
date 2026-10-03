import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import * as icons from '../src/renderer/src/icons/icons';
import { iconHtml } from '../src/renderer/src/icons/iconHtml';
import { ICON_ENTRIES } from '../src/renderer/src/icons/catalog';

const { STROKE } = icons;

// アプリのアイコンは src/renderer/src/icons/ に自作の線画を集めてある。ばらばらに戻らないよう、次を確かめる:
// - 全アイコンがカタログ（Storybook の一覧）にある
// - どのアイコンも、同じ規則（viewBox 24・色は文字色・決めた大きさ）で描かれている
// - icons/ の外に、アイコンの <svg> や、記号文字のアイコンが増えていない

const SIZES = [12, 14, 16, 22] as const;
const RENDERER = join(__dirname, '../src/renderer/src');

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return path.endsWith('.tsx') ? [path] : [];
  });
}

describe('アイコンのカタログ', () => {
  const exported = Object.keys(icons).filter((name) => name.endsWith('Icon'));

  it('icons.tsx のアイコンは、すべてカタログに載っている（足し忘れない）', () => {
    expect(ICON_ENTRIES.map((e) => e.name).sort()).toEqual([...exported].sort());
  });

  it('意味（説明）が書いてあり、名前も説明も重ならない', () => {
    expect(new Set(ICON_ENTRIES.map((e) => e.name)).size).toBe(ICON_ENTRIES.length);
    expect(new Set(ICON_ENTRIES.map((e) => e.meaning)).size).toBe(ICON_ENTRIES.length);
    for (const e of ICON_ENTRIES) expect(e.meaning.trim().length, e.name).toBeGreaterThan(0);
  });
});

describe('アイコンの描き方', () => {
  for (const { name, Icon } of ICON_ENTRIES) {
    it(`${name}: viewBox 24・色は文字色・大きさは 4 段階`, () => {
      for (const size of SIZES) {
        const html = renderToStaticMarkup(createElement(Icon, { size }));
        expect(html, `${name} ${size}`).toContain('viewBox="0 0 24 24"');
        expect(html).toContain(`width="${size}"`);
        expect(html).toContain(`height="${size}"`);
        expect(html).toContain('stroke="currentColor"');
        expect(html).toContain('aria-hidden="true"');
        // 色は文字色だけ（決め打ちの色を混ぜない）
        expect(html).not.toMatch(/(?:fill|stroke)="(?!none|currentColor)[^"]*"/);
        expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}|rgb\(|hsl\(/);
      }
    });
  }
});

// ---- 絵の規則（CONTRIBUTING.md「アイコン」の「自作アイコンの描き方」）----

// SVG のパスのデータを、通る点（端点・制御点）の座標に直す。弧は端点だけを見る
function pathPoints(d: string): [number, number][] {
  const points: [number, number][] = [];
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
  let i = 0;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let cmd = '';
  const num = () => Number(tokens[i++]);
  const push = (px: number, py: number) => {
    x = px;
    y = py;
    points.push([x, y]);
  };
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase();
    const dx = rel ? x : 0;
    const dy = rel ? y : 0;
    switch (cmd.toUpperCase()) {
      case 'M':
        push(num() + dx, num() + dy);
        startX = x;
        startY = y;
        cmd = rel ? 'l' : 'L';
        break;
      case 'L':
      case 'T':
        push(num() + dx, num() + dy);
        break;
      case 'H':
        push(num() + dx, y);
        break;
      case 'V':
        push(x, num() + dy);
        break;
      case 'C': {
        const a = [num() + dx, num() + dy];
        const b = [num() + dx, num() + dy];
        points.push([a[0], a[1]], [b[0], b[1]]);
        push(num() + dx, num() + dy);
        break;
      }
      case 'S':
      case 'Q': {
        const a = [num() + dx, num() + dy];
        points.push([a[0], a[1]]);
        push(num() + dx, num() + dy);
        break;
      }
      case 'A':
        i += 5;
        push(num() + dx, num() + dy);
        break;
      case 'Z':
        push(startX, startY);
        break;
      default:
        throw new Error(`知らないパスの命令: ${cmd}`);
    }
  }
  return points;
}

type Shape = { tag: string; attrs: Record<string, string> };

function shapesOf(html: string): Shape[] {
  const inner = html.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
  return [...inner.matchAll(/<(\w+)([^>]*?)\/?>/g)].map(([, tag, rest]) => ({
    tag,
    attrs: Object.fromEntries([...rest.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, k, v]) => [k, v])),
  }));
}

const MARGIN = 2.5; // 絵の外側の余白（方眼の 24 のうち、上下左右 2.5 は空ける）
const ALLOWED_TAGS = new Set(['path', 'circle', 'rect']);
const ALLOWED_ATTRS = new Set(['d', 'cx', 'cy', 'r', 'x', 'y', 'width', 'height', 'rx', 'fill', 'stroke', 'opacity', 'stroke-dasharray']);
// 塗りつぶしてよい面（それ以外は線で描く。小さい点は別）
const FILLED = new Set(['StopIcon', 'PlayIcon']);

describe('アイコンの絵の規則', () => {
  it('線の太さは、画面の上で 1.0〜1.7px になる（小さいほど太く、大きさの順に細くなる）', () => {
    const sizes = [12, 14, 16, 22] as const;
    for (const size of sizes) {
      const px = (STROKE[size] * size) / 24;
      expect(px, `${size}px`).toBeGreaterThanOrEqual(1.0);
      expect(px, `${size}px`).toBeLessThanOrEqual(1.7);
    }
    expect(sizes.map((s) => STROKE[s])).toEqual([...sizes.map((s) => STROKE[s])].sort((a, b) => b - a));
  });

  for (const { name, Icon } of ICON_ENTRIES) {
    it(`${name}: path・circle・rect だけで描き、絵は余白 ${MARGIN} の内側に収まる`, () => {
      const shapes = shapesOf(renderToStaticMarkup(createElement(Icon, { size: 16 })));
      expect(shapes.length).toBeGreaterThan(0);
      const lo = MARGIN - 1e-6;
      const hi = 24 - MARGIN + 1e-6;
      const inside = (label: string, ...values: number[]) => {
        for (const v of values) {
          expect(v, `${name} ${label}`).toBeGreaterThanOrEqual(lo);
          expect(v, `${name} ${label}`).toBeLessThanOrEqual(hi);
        }
      };
      for (const { tag, attrs } of shapes) {
        expect(ALLOWED_TAGS.has(tag), `${name} <${tag}>`).toBe(true);
        for (const key of Object.keys(attrs)) expect(ALLOWED_ATTRS.has(key), `${name} ${key}`).toBe(true);
        if (tag === 'path') {
          for (const [px, py] of pathPoints(attrs.d)) inside(`path ${px},${py}`, px, py);
        } else if (tag === 'circle') {
          const [cx, cy, r] = [Number(attrs.cx), Number(attrs.cy), Number(attrs.r)];
          inside('circle', cx - r, cx + r, cy - r, cy + r);
        } else {
          const [x, y, w, h] = [Number(attrs.x), Number(attrs.y), Number(attrs.width), Number(attrs.height)];
          inside('rect', x, x + w, y, y + h);
          // 箱の角は丸める
          expect(Number(attrs.rx), `${name} rect の角丸`).toBeGreaterThanOrEqual(1.2);
          expect(Number(attrs.rx), `${name} rect の角丸`).toBeLessThanOrEqual(2.5);
        }
      }
    });

    it(`${name}: 塗りつぶしは、停止・実行の面と小さい点（半径 1 以下）だけ`, () => {
      for (const { tag, attrs } of shapesOf(renderToStaticMarkup(createElement(Icon, { size: 16 })))) {
        if (attrs.fill === undefined) continue;
        if (attrs.fill === 'none') continue;
        if (tag === 'circle' && Number(attrs.r) <= 1) continue;
        expect(FILLED.has(name), `${name} の塗りつぶし`).toBe(true);
      }
    });
  }

  it('iconHtml（コードブロックの実行ボタン用）は、描画した SVG と同じ文字列になる', () => {
    for (const { name, Icon } of ICON_ENTRIES) {
      for (const size of SIZES) {
        expect(iconHtml(Icon, size), `${name} ${size}`).toBe(renderToStaticMarkup(createElement(Icon, { size })));
      }
    }
  });
});

describe('アイコンの置き場', () => {
  const files = tsxFiles(RENDERER).filter((f) => !relative(RENDERER, f).startsWith('icons/'));

  it('アイコンの <svg> は icons/ に書く（図とアニメーションの印だけ例外）', () => {
    const allowed = new Set(['layout/CheckMark.tsx', 'workflow/WorkflowFlow.tsx']);
    const found = files.filter((f) => /<svg[\s>]/.test(readFileSync(f, 'utf8'))).map((f) => relative(RENDERER, f));
    expect(found.filter((f) => !allowed.has(f))).toEqual([]);
  });

  it('記号の文字をアイコン代わりにしていない（コメントは除く）', () => {
    // ボタンや見出しの印に使う記号。アイコンは icons/ から使う
    // 要素の中身や文字列の先頭・全体が記号のもの（文の途中の説明は対象外）
    const glyphs = /(?:>|['"`])\s*[✕＋↻⟳↺▸▾⚙⎇✓▶](?:\s|<|['"`])/;
    const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
    const found: string[] = [];
    for (const f of files) {
      stripComments(readFileSync(f, 'utf8')).split('\n').forEach((line, i) => {
        if (glyphs.test(line)) found.push(`${relative(RENDERER, f)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(found).toEqual([]);
  });
});
