import { useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { marked, replaceExternalImages } from '../markdown';
import { token } from '../theme';
import { editorTheme, monaco } from './monaco';

// 入力のたびに描き直さないよう、少し待ってからまとめて描く
const RENDER_DELAY_MS = 150;

type Props = {
  sessionId: string;
  path: string;
  // 編集中（未保存）の内容もそのまま映す
  model: monaco.editor.ITextModel;
  onOpenFile: (path: string, line?: number) => void;
};

// Markdown ファイルを整形して表示する。コードは Monaco と同じ色付け、mermaid は図にし、
// リポジトリ内の画像と相対リンク（別の .md など）も開けるようにする。外の画像は読み込まず、リンクにする
export function MarkdownPreview({ sessionId, path, model, onOpenFile }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [text, setText] = useState(() => model.getValue());

  useEffect(() => {
    setText(model.getValue());
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sub = model.onDidChangeContent(() => {
      timer ??= setTimeout(() => {
        timer = null;
        setText(model.getValue());
      }, RENDER_DELAY_MS);
    });
    return () => {
      sub.dispose();
      if (timer) clearTimeout(timer);
    };
  }, [model]);

  useEffect(() => {
    const root = ref.current!;
    let cancelled = false;
    // 文書として読むので、チャットと違い単独の改行は段落内の空白として扱う（GitHub と同じ）
    const html = marked.parse(text, { async: false, gfm: true, breaks: false });
    // 部品に分けてから差し込む。innerHTML に入れると、書き換える前の相対パスの画像を読みにいってしまう
    const fragment = DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true });
    // 外の画像（http(s)）は読み込まず、ブラウザで開くリンクにする
    replaceExternalImages(fragment);
    for (const img of fragment.querySelectorAll('img')) {
      const src = img.getAttribute('src') ?? '';
      if (isExternal(src) || src.startsWith('data:')) continue;
      img.removeAttribute('src');
      const target = resolvePath(path, src);
      if (target) img.dataset.path = target;
    }
    addHeadingIds(fragment);
    root.replaceChildren(fragment);

    for (const img of root.querySelectorAll<HTMLImageElement>('img[data-path]')) {
      void window.tanacode.workspace.readImage(sessionId, img.dataset.path!).then((url) => {
        if (!cancelled && url) img.src = url;
      });
    }
    for (const code of root.querySelectorAll<HTMLElement>('pre > code')) {
      const lang = /language-([\w+#-]+)/.exec(code.className)?.[1]?.toLowerCase();
      if (lang === 'mermaid') void renderMermaid(code, () => cancelled);
      else if (lang) void colorize(code, lang, () => cancelled);
    }
    return () => {
      cancelled = true;
    };
  }, [text, path, sessionId]);

  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a');
    const href = a?.getAttribute('href');
    if (!href) return;
    e.preventDefault();
    if (href.startsWith('#')) {
      ref.current?.querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`)?.scrollIntoView({ block: 'start' });
      return;
    }
    // 外部のページはブラウザで開く（メインプロセスが window.open を受けて開く）
    if (isExternal(href)) {
      window.open(href);
      return;
    }
    const [file, hash = ''] = href.split('#');
    const target = resolvePath(path, file);
    const line = /^L(\d+)/.exec(hash)?.[1];
    if (target) onOpenFile(target, line ? Number(line) : undefined);
  };

  return (
    <div className="markdown-preview" onClick={onClick}>
      <div className="markdown markdown-doc" ref={ref} />
    </div>
  );
}

function isExternal(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href);
}

// Markdown ファイルからの相対パスを、リポジトリのルートからのパスにする（/ で始まるものはルートから）
function resolvePath(from: string, href: string): string | null {
  let target: string;
  try {
    target = decodeURIComponent(href);
  } catch {
    target = href;
  }
  if (!target) return null;
  const parts = target.startsWith('/') ? [] : from.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}

// 見出しへのリンク（#使い方 など）が効くよう、GitHub と同じ形の id を付ける
function addHeadingIds(root: DocumentFragment): void {
  const used = new Map<string, number>();
  for (const h of root.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const base = (h.textContent ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    h.id = n ? `${base}-${n}` : base;
  }
}

function languageId(lang: string): string | null {
  const found = monaco.languages
    .getLanguages()
    .find(
      (l) =>
        l.id === lang ||
        l.aliases?.some((a) => a.toLowerCase() === lang) ||
        l.extensions?.some((ext) => ext.toLowerCase() === `.${lang}`),
    );
  return found?.id ?? null;
}

async function colorize(code: HTMLElement, lang: string, cancelled: () => boolean): Promise<void> {
  const id = languageId(lang);
  if (!id) return;
  // 色付けは今のテーマを使うので、エディタより先に開いたときもアプリのテーマにしておく
  monaco.editor.setTheme(editorTheme());
  const html = await monaco.editor.colorize(code.textContent ?? '', id, { tabSize: 2 });
  if (!cancelled()) code.innerHTML = html;
}

let mermaidLoader: Promise<typeof import('mermaid').default> | null = null;
let mermaidSeq = 0;

async function renderMermaid(code: HTMLElement, cancelled: () => boolean): Promise<void> {
  // 大きいので、図があるときだけ読み込む
  mermaidLoader ??= import('mermaid').then(({ default: mermaid }) => {
    // 図の色もアプリのトークンに合わせる（base テーマに色を渡す）
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      fontFamily: token('font-ui'),
      themeVariables: {
        background: token('bg-surface'),
        primaryColor: token('bg-surface'),
        primaryBorderColor: token('border-strong'),
        primaryTextColor: token('text-primary'),
        textColor: token('text-primary'),
        lineColor: token('text-secondary'),
        secondaryColor: token('bg-hover'),
        tertiaryColor: token('bg-panel'),
        fontFamily: token('font-ui'),
      },
    });
    return mermaid;
  });
  const pre = code.parentElement!;
  try {
    const mermaid = await mermaidLoader;
    const { svg } = await mermaid.render(`mermaid-${++mermaidSeq}`, code.textContent ?? '');
    if (cancelled()) return;
    const figure = document.createElement('div');
    figure.className = 'markdown-mermaid';
    figure.innerHTML = svg;
    pre.replaceWith(figure);
  } catch (err) {
    if (cancelled()) return;
    const note = document.createElement('div');
    note.className = 'markdown-mermaid-error';
    note.textContent = `図を描けませんでした: ${err instanceof Error ? err.message : String(err)}`;
    pre.after(note);
  }
}
