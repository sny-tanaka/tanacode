import { useLayoutEffect, useMemo, useRef } from 'react';
import DOMPurify from 'dompurify';
import { PlayIcon, iconHtml } from '../icons';
import { marked, replaceExternalImages } from '../markdown';
import { stripControlChars } from './sanitize';

// 実行ボタンを付けるコードブロックの言語（```bash など。言語名の最初の語で見る）
const SHELL_LANG = /^(bash|sh|zsh|shell)\b/;

// チャットで描いてよいタグと属性は、Markdown が作るものだけにする。
// 返答に混ざった HTML で、見た目を偽ったり（style・class・hidden）、ボタンやフォームを作ったりできないようにする。
// 実行ボタンなど、アプリが付けるものは消毒のあとで付ける
const SANITIZE = {
  ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'img'],
  ALLOWED_ATTR: ['href', 'title', 'src', 'alt', 'start', 'align'],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
};

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

// Markdown を HTML にする（消毒はまだ）。あわせて、コードブロックごとの実行するコマンド（シェルでなければ null）を、出てくる順に控える
function render(text: string): { html: string; commands: (string | null)[] } {
  const commands: (string | null)[] = [];
  const renderer = new marked.Renderer();
  // 生の HTML（ブロックもインラインも）は描かず、文字のまま出す
  renderer.html = ({ text, block }) => (block ? `<p>${escapeHtml(text.trimEnd()).replace(/\n/g, '<br>')}</p>` : escapeHtml(text));
  // タスクリストのチェックボックスは、入力部品を描かないよう文字で出す
  renderer.checkbox = ({ checked }) => (checked ? '☑ ' : '☐ ');
  const code = renderer.code.bind(renderer);
  renderer.code = (token) => {
    if (!SHELL_LANG.test(token.lang?.match(/^\S*/)?.[0] ?? '')) {
      commands.push(null);
      return code(token);
    }
    // 見えない制御文字は表示からも除き、見えている文字と実行する文字をそろえる
    const command = stripControlChars(token.text);
    commands.push(command.trim() || null);
    return code({ ...token, text: command });
  };
  return { html: marked.parse(text, { async: false, gfm: true, breaks: true, renderer }), commands };
}

// onRunCommand: シェルのコードブロック（```bash など）に「実行」ボタンを付け、押したらそのコマンドを渡す
export function Markdown({ text, onRunCommand }: { text: string; onRunCommand?: (command: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const { html, commands } = useMemo(() => render(text), [text]);
  const runCommand = useRef(onRunCommand);
  runCommand.current = onRunCommand;
  const runnable = !!onRunCommand;

  useLayoutEffect(() => {
    const fragment = DOMPurify.sanitize(html, { ...SANITIZE, RETURN_DOM_FRAGMENT: true });
    // 外の画像は読みにいかず、リンクに置き換える（返答に仕込まれた画像の URL で、会話の中身を外へ送られないように）。
    // 置き換えで付ける class は消毒の許可に無いので、消毒のあと・画面に入れる前に置き換える
    replaceExternalImages(fragment);
    // 生の HTML は文字になるので、pre はコードブロックからしかできない。数が合わなければ、取り違えないようボタンを付けない
    const pres = fragment.querySelectorAll('pre');
    if (runnable && pres.length === commands.length) pres.forEach((pre, i) => {
      const command = commands[i];
      if (!command) return;
      const button = document.createElement('button');
      button.className = 'code-run';
      // アイコンは React の外で作る DOM に入れるので、SVG を文字列にして入れる（名前とツールチップは IconButton と同じ属性）
      button.innerHTML = iconHtml(PlayIcon, 12);
      button.setAttribute('aria-label', '実行');
      button.dataset.tip = '実行';
      // 画面の文字ではなく、描くときに控えたコマンドを実行する
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        runCommand.current?.(command);
      });
      pre.classList.add('runnable');
      pre.appendChild(button);
    });
    ref.current!.replaceChildren(fragment);
  }, [html, commands, runnable]);

  return <div ref={ref} className="markdown" />;
}
