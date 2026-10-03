import { renderToStaticMarkup } from 'react-dom/server';
import type { TodoItem } from '@shared/chat';
import type { ChatItem } from '../chat/chatState';
import { markdownHtml } from '../chat/Markdown';
import appCss from '../global.css?raw';
import { matchesIn, usedCss } from './exportCss';
import { imageKeys, type ExportMeta } from './exportContent';
import { ExportDocument } from './ExportDocument';

// 書き出したファイルは、外へ何も読みにいかない（画像は中に入れた data URL だけ・スクリプトは動かさない）。
// base・form は default-src で止まらないので、別に止める
const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

// アプリの画面の決まり（高さを画面に合わせてスクロールさせない）を、ふつうに縦に流れるページに戻す。
// 動き（ふわっと出す・グラデーションを流す）も止める
const PAGE_CSS = `
html, body { height: auto; overflow: visible; background: var(--bg-panel); }
*, *::before, *::after { animation: none !important; transition: none !important; }
`;

// 画像は、長い辺をここまで縮める（Claude Code が API に送る画像はもともとこの程度）
const MAX_IMAGE_EDGE = 1600;

export type ExportInput = {
  meta: ExportMeta;
  items: ChatItem[];
  todoSteps: ReadonlyMap<string, TodoItem[]>;
  // 画像を入れる（false なら読みにいかない）
  withImages: boolean;
};

// 1 枚で完結する HTML（CSS・画像を中に入れる）を作る
export async function buildExportHtml({ meta, items, todoSteps, withImages }: ExportInput): Promise<string> {
  const images = withImages ? await loadImages(imageKeys(items)) : new Map<string, string | null>();
  const body = renderToStaticMarkup(<ExportDocument meta={meta} items={items} todoSteps={todoSteps} images={images} markdown={markdownHtml} />);
  const css = collectCss(body);
  return [
    '<!doctype html>',
    '<html lang="ja">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    // 本文のリンクの先を、開いただけで名前解決しない
    '<meta http-equiv="x-dns-prefetch-control" content="off">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="generator" content="tanacode">',
    `<title>${escapeHtml(meta.title)}</title>`,
    `<style>${css}\n${PAGE_CSS}</style>`,
    '</head>',
    '<body>',
    body,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

async function loadImages(keys: string[]): Promise<Map<string, string | null>> {
  const images = new Map<string, string | null>();
  for (const key of keys) {
    const url = await window.tanacode.sessions.image(key);
    images.set(key, url ? await shrinkImage(url) : null);
  }
  return images;
}

// 長い辺を MAX_IMAGE_EDGE までにして WebP にする。小さくならなければ（GIF の動きを含めて）元のまま
async function shrinkImage(dataUrl: string): Promise<string> {
  if (dataUrl.startsWith('data:image/gif')) return dataUrl;
  try {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(img.naturalWidth, img.naturalHeight, 1));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
    const webp = canvas.toDataURL('image/webp', 0.85);
    return webp.startsWith('data:image/webp') && webp.length < dataUrl.length ? webp : dataUrl;
  } catch {
    return dataUrl;
  }
}

// 画面の CSS（global.css）のうち、書き出した中身に当たる規則だけを集める
function collectCss(bodyHtml: string): string {
  const doc = new DOMParser().parseFromString(`<!doctype html><html><head></head><body>${bodyHtml}</body></html>`, 'text/html');
  return usedCss(appCss, matchesIn(doc));
}
