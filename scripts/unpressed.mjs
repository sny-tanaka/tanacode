// 画面の操作の受け手（onClick・onChange など）のうち、テストで一度も動いていないもの（＝テストが押していないボタン・触っていない入力）を出す
// （npm run coverage:unpressed）。測ったカバレッジ（coverage/<名前>/coverage-final.json。単体テストと E2E）を合わせて、
// 受け手の関数が 1 回も呼ばれていなければ「押していない」とする。
// - 受け手がその場の関数（onClick={() => …}）なら、その関数
// - 同じファイルの関数の名前（onClick={save}。useCallback で包んだものも）なら、その関数
// - props から受け取ったもの（onClick={onCancel}）は、渡した側で数えるので、ここでは数えない
// --max <数>: 押していないものがこの数より多ければ失敗にする（増やさないための下限。0 を目指す）
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import libCoverage from 'istanbul-lib-coverage';

const traverse = traverseModule.default ?? traverseModule;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const coverageDir = join(root, 'coverage');
const RENDERER = join(root, 'src', 'renderer', 'src');
// 人の操作を受けるもの
const EVENTS = /^on(Click|DoubleClick|Change|Submit|KeyDown|KeyUp|MouseDown|MouseUp|Input|ContextMenu|Drop|DragStart|DragOver|Select|Blur|Focus|Paste|Toggle)$/;

const args = process.argv.slice(2);
const maxIndex = args.indexOf('--max');
const max = maxIndex >= 0 ? Number(args[maxIndex + 1]) : null;

const sources = existsSync(coverageDir) ? readdirSync(coverageDir).filter((n) => existsSync(join(coverageDir, n, 'coverage-final.json'))) : [];
if (sources.length === 0) {
  console.error('カバレッジがありません。先に npm run coverage（と npm run coverage:e2e）で測ってください');
  process.exit(1);
}
const map = libCoverage.createCoverageMap({});
for (const name of sources) map.merge(JSON.parse(readFileSync(join(coverageDir, name, 'coverage-final.json'), 'utf8')));
// カバレッジのファイルは、測った場所の絶対パスで入っている（別の作業場所や CI で測ったものも使えるよう、src/ からのパスで引く）。
// 同じファイルを別の場所で測ったものは、絶対パスが違って別々に入っているので、ここで合わせる（呼ばれた回数を足す）
const byPath = new Map();
for (const abs of map.files()) {
  const rel = abs.slice(abs.lastIndexOf('/src/renderer/') + 1);
  const fileCoverage = map.fileCoverageFor(abs);
  if (byPath.has(rel)) byPath.get(rel).merge(fileCoverage);
  else byPath.set(rel, fileCoverage);
}

function* tsxFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* tsxFiles(path);
    else if (entry.name.endsWith('.tsx') && !entry.name.endsWith('.stories.tsx')) yield path;
  }
}

// カバレッジの関数の記録から、start の位置で始まる関数が呼ばれた回数（見つからなければ null）
function callsAt(fileCoverage, start) {
  const { fnMap, f } = fileCoverage.data;
  let best = null;
  for (const [id, fn] of Object.entries(fnMap)) {
    for (const pos of [fn.decl.start, fn.loc.start]) {
      if (pos.line !== start.line) continue;
      const distance = Math.abs((pos.column ?? 0) - start.column);
      if (distance <= 2 && (!best || distance < best.distance)) best = { distance, count: f[id] };
    }
  }
  return best ? best.count : null;
}

const unpressed = [];
let counted = 0;
for (const file of tsxFiles(RENDERER)) {
  const code = readFileSync(file, 'utf8');
  const ast = parse(code, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
  const rel = relative(root, file).split('\\').join('/');
  const fileCoverage = byPath.get(rel) ?? null;
  traverse(ast, {
    JSXAttribute(path) {
      const name = path.node.name.name;
      if (typeof name !== 'string' || !EVENTS.test(name)) return;
      const value = path.node.value?.expression;
      if (!value) return;
      let fn = null;
      if (value.type === 'ArrowFunctionExpression' || value.type === 'FunctionExpression') fn = value;
      else if (value.type === 'Identifier') {
        const binding = path.scope.getBinding(value.name);
        const node = binding?.path.node;
        if (!node || binding.kind === 'param') return;
        if (node.type === 'FunctionDeclaration') fn = node;
        else if (node.type === 'VariableDeclarator') {
          const init = node.init;
          if (init?.type === 'ArrowFunctionExpression' || init?.type === 'FunctionExpression') fn = init;
          else if (init?.type === 'CallExpression' && ['ArrowFunctionExpression', 'FunctionExpression'].includes(init.arguments[0]?.type)) fn = init.arguments[0];
        }
        // props を分けて受け取ったもの（const { onCancel } = props など）は、渡した側で数える
        if (!fn) return;
      } else return;
      counted++;
      const count = fileCoverage ? callsAt(fileCoverage, fn.loc.start) : 0;
      if (count === 0 || count === null) {
        const element = path.parentPath.node.name;
        const tag = element.type === 'JSXIdentifier' ? element.name : element.type === 'JSXMemberExpression' ? `${element.object.name}.${element.property.name}` : '?';
        const attrs = path.parentPath.node.attributes;
        const labelAttr = attrs.find((a) => a.type === 'JSXAttribute' && ['aria-label', 'label', 'title', 'className'].includes(a.name.name));
        const label = labelAttr?.value?.type === 'StringLiteral' ? labelAttr.value.value : '';
        unpressed.push({ where: `${rel}:${path.node.loc.start.line}`, what: `<${tag}${label ? ` ${labelAttr.name.name}="${label}"` : ''}> ${name}`, unknown: count === null });
      }
    },
  });
}

for (const u of unpressed) console.log(`${u.where}\t${u.what}${u.unknown ? '（カバレッジに記録なし）' : ''}`);
console.log(`\n押していない操作の受け手: ${unpressed.length} / ${counted}（${sources.join('・')} のカバレッジから）`);
if (max !== null && unpressed.length > max) {
  console.error(`押していないものが ${unpressed.length} 個あり、上限（${max}）を超えています。テストで押してください`);
  process.exit(1);
}
