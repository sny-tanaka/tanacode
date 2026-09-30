import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import CssWorker from 'monaco-editor/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';
import { token } from '../theme';

self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    if (label === 'json') return new JsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    return new EditorWorker();
  },
};

// 閲覧専用でプロジェクトの型情報も持たないため、未解決 import などの誤検知を出さない
for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
  defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true });
}

const THEME = 'tanacode-dark';
let themeDefined = false;

// エディタのテーマ。色は global.css のトークン（構文の色は --syntax-*）から読むので、
// CSS が当たったあと（エディタを作るとき）に定義する。
// 関数名は Monaco の字句解析では識別子と区別されないので、function の色が付くのは区別する言語だけ
export function editorTheme(): string {
  if (themeDefined) return THEME;
  themeDefined = true;
  const hex = (name: string) => token(name).replace('#', '');
  monaco.editor.defineTheme(THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: hex('text-primary') },
      { token: 'identifier', foreground: hex('text-primary') },
      { token: 'variable', foreground: hex('text-primary') },
      { token: 'keyword', foreground: hex('syntax-keyword') },
      { token: 'string', foreground: hex('syntax-string') },
      { token: 'number', foreground: hex('syntax-type') },
      { token: 'comment', foreground: hex('syntax-comment'), fontStyle: 'italic' },
      { token: 'type', foreground: hex('syntax-type') },
      { token: 'type.identifier', foreground: hex('syntax-type') },
      { token: 'attribute.name', foreground: hex('syntax-type') },
      { token: 'function', foreground: hex('syntax-function') },
      { token: 'tag', foreground: hex('syntax-tag') },
      { token: 'delimiter', foreground: hex('text-secondary') },
      // vs-dark の既定の色（水色・オレンジ）が残る字句。JSON のキーは変数と同じ、値は文字列の色にする
      { token: 'string.key.json', foreground: hex('text-primary') },
      { token: 'string.value.json', foreground: hex('syntax-string') },
      { token: 'attribute.value', foreground: hex('syntax-string') },
      { token: 'regexp', foreground: hex('syntax-string') },
      { token: 'metatag', foreground: hex('syntax-tag') },
    ],
    colors: {
      'editor.background': token('bg-panel'),
      'editor.foreground': token('text-primary'),
      'editorLineNumber.foreground': token('text-tertiary'),
      'editorLineNumber.activeForeground': token('text-secondary'),
      'editor.lineHighlightBackground': token('bg-current-line'),
      // 行番号の欄も本文と同じ色にする
      'editorGutter.background': token('bg-panel'),
      'editor.selectionBackground': token('editor-selection'),
      'editorCursor.foreground': token('text-primary'),
      // 括弧の組の色分けも記号と同じ text-secondary にする（既定では黄・紫・青に塗り分けられる）
      ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`editorBracketHighlight.foreground${n}`, token('text-secondary')])),
      'editorBracketHighlight.unexpectedBracket.foreground': token('danger'),
      'editorIndentGuide.background1': token('border-subtle'),
      'scrollbarSlider.background': token('border-strong'),
      'scrollbarSlider.hoverBackground': token('text-tertiary'),
    },
  });
  return THEME;
}

export function languageFor(path: string): string {
  const name = path.split('/').pop() ?? path;
  const lower = name.toLowerCase();
  const match = monaco.languages
    .getLanguages()
    .find(
      (lang) =>
        lang.filenames?.some((f) => f.toLowerCase() === lower) ||
        lang.extensions?.some((ext) => lower.endsWith(ext.toLowerCase())),
    );
  return match?.id ?? 'plaintext';
}

export function languageLabel(id: string): string {
  const lang = monaco.languages.getLanguages().find((l) => l.id === id);
  return lang?.aliases?.[0] ?? id;
}

export { monaco };
