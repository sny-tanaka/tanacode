// ミューテーションテスト（npm run mutation）。対象のファイルのコードを 1 か所ずつわざと壊し（ミュータント）、関係するテストを流して、
// テストが落ちる（killed）かを確かめる。落ちなかったもの（survived）は、テストがそこを通っていても、結果まで確かめていない場所。
// - 対象: 引数のファイル（無ければ DEFAULT_TARGETS）。例: npm run mutation -- src/shared/chat.ts
// - --concurrency <n>: 同時に流す数（既定 2）
// - --out <dir>: 結果の置き場所（既定 reports/mutation）
// - --list: ミュータントの一覧だけを出し、テストは流さない
// 流し方:
// 1. 対象のコードの文（と、式のアロー関数の値・正規表現など）に印を付け、対象を読み込むテストのファイルを流して、
//    テストごとに、どの印を通ったかを調べる（scripts/mutation-setup.mjs）。ここで落ちるテストがあれば止める
// 2. ミュータントごとに、その場所を通ったテストだけを、速いファイルから流す（1 つ落ちたら止める）。
//    読み込みや beforeAll で通った場所は、そのファイルのテストを全部流す。どのテストも通らない場所は流さない（no-coverage）
// 書き換えたコードは Vite のプラグインで渡すので、ソースのファイルは書き換えない（scripts/mutation-worker.mjs）。
// 結果は <out>/mutation.json（全部）と <out>/summary.md（要約と、生き残ったものの一覧）。GitHub Actions では、要約をジョブの概要にも書く
import { fork } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = join(root, 'scripts/mutation-worker.mjs');
// 既定の対象: 読み取りの中核で、単体テストのよく通っているもの
const DEFAULT_TARGETS = ['src/main/screen-parser.ts', 'src/shared/chat.ts'];
// テストのファイル（vitest.config.ts の include と同じ test/*.test.ts）
const TEST_DIR = join(root, 'test');
// 1 つのミュータントの待ち時間: 元のコードで流した時間の何倍と、足す時間
const TIMEOUT_FACTOR = 1.5;
const TIMEOUT_EXTRA_MS = 10_000;

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const value = argv[i + 1];
  argv.splice(i, 2);
  return value;
};
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i !== -1) argv.splice(i, 1);
  return i !== -1;
};
const concurrency = Math.max(1, Number(option('--concurrency', '2')) || 1);
const outDir = resolve(root, option('--out', 'reports/mutation'));
const listOnly = flag('--list');
const toPath = (abs) => relative(root, abs).split('\\').join('/');
const targets = [...new Set((argv.length > 0 ? argv : DEFAULT_TARGETS).map((t) => toPath(resolve(root, t))))];
for (const target of targets) {
  if (!/\.tsx?$/.test(target) || !existsSync(join(root, target))) {
    console.error(`対象にできません（.ts・.tsx のファイルを指定してください）: ${target}`);
    process.exit(1);
  }
}

// ---- ミュータントを作る ----

// 書き換えの種類（名前は Stryker に合わせる。ReturnValue だけはこのスクリプトの独自）
// EqualityOperator: === と !==、< と <= など / ArithmeticOperator: + と - など / LogicalOperator: && と || など
// ConditionalExpression: if・三項演算子の条件を true / false に、ループの条件を false に / BooleanLiteral: true と false、! を外す
// UnaryOperator: -x と +x / UpdateOperator: ++ と -- / AssignmentOperator: += と -= など
// StringLiteral: 文字列を空に（空は空でなく） / Regex: 正規表現の ^ $ を外す・\d を \D に・[..] を [^..] に・回数の指定を外す・先読みを逆に
// ReturnValue: return の値を undefined に / ArrowFunction: 式のアロー関数の値を undefined に / BlockStatement: ブロックを空に
// OptionalChaining: ?. を . に / ArrayDeclaration: 配列を空に / MethodExpression: startsWith と endsWith の入れ替え・filter や slice を外す など
const BINARY = {
  '===': ['!=='],
  '!==': ['==='],
  '==': ['!='],
  '!=': ['=='],
  '<': ['<=', '>='],
  '<=': ['<', '>'],
  '>': ['>=', '<='],
  '>=': ['>', '<'],
  '+': ['-'],
  '-': ['+'],
  '*': ['/'],
  '/': ['*'],
  '%': ['*'],
};
const LOGICAL = { '&&': ['||'], '||': ['&&'], '??': ['&&'] };
const ASSIGNMENT = { '+=': '-=', '-=': '+=', '*=': '/=', '/=': '*=', '&&=': '||=', '||=': '&&=', '??=': '&&=' };
const METHOD_SWAP = {
  startsWith: 'endsWith',
  endsWith: 'startsWith',
  trimStart: 'trimEnd',
  trimEnd: 'trimStart',
  toLowerCase: 'toUpperCase',
  toUpperCase: 'toLowerCase',
  some: 'every',
  every: 'some',
  min: 'max',
  max: 'min',
  indexOf: 'lastIndexOf',
  lastIndexOf: 'indexOf',
  find: 'findLast',
  findLast: 'find',
  findIndex: 'findLastIndex',
  findLastIndex: 'findIndex',
};
const METHOD_DROP = new Set(['trim', 'filter', 'slice', 'sort', 'reverse', 'substring', 'toSorted', 'toReversed']);
// 型だけの部分は書き換えない。ただし、式に型を付けたもの（x as T・x!・x satisfies T）の中の式は書き換える
const TS_EXPRESSION = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'TSInstantiationExpression']);
const SKIP_KEYS = new Set(['loc', 'extra', 'leadingComments', 'trailingComments', 'innerComments']);
const KEYED = new Set(['ObjectProperty', 'ObjectMethod', 'ClassProperty', 'ClassMethod', 'ClassPrivateProperty']);

function parseCode(code, file) {
  return parse(code, { sourceType: 'module', plugins: file.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'] });
}

// 文字の位置から行と列（どちらも 1 から）
function locator(code) {
  const starts = [0];
  for (let i = 0; i < code.length; i++) if (code[i] === '\n') starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - starts[lo] + 1 };
  };
}

// 正規表現の書き換えの候補（パターンの文字列）
function regexVariants(pattern) {
  const out = [];
  const edit = (start, end, text) => out.push(pattern.slice(0, start) + text + pattern.slice(end));
  const SWAP = { d: 'D', D: 'd', w: 'W', W: 'w', s: 'S', S: 's', b: 'B', B: 'b' };
  let classStart = -1;
  // 直前が、回数の指定を付けられるもの（文字・集まり・グループの終わり）か
  let atom = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') {
      const next = pattern[i + 1];
      // [..] の中の \b は後退の文字なので、そのまま
      if (SWAP[next] && !(classStart !== -1 && /[bB]/.test(next))) edit(i, i + 2, `\\${SWAP[next]}`);
      i++;
      atom = !/[bB]/.test(next);
      continue;
    }
    if (classStart !== -1) {
      if (c === ']') {
        const negated = pattern[classStart + 1] === '^';
        edit(classStart, classStart + (negated ? 2 : 1), negated ? '[' : '[^');
        classStart = -1;
        atom = true;
      }
      continue;
    }
    if (c === '[') classStart = i;
    else if (c === '^' || c === '$') {
      edit(i, i + 1, '');
      atom = false;
    } else if (c === '(') {
      const look = /^\(\?<?[=!]/.exec(pattern.slice(i))?.[0];
      if (look) edit(i, i + look.length, look.slice(0, -1) + (look.endsWith('=') ? '!' : '='));
      atom = false;
    } else if (c === ')') atom = true;
    else if ('*+?'.includes(c) && atom) {
      const lazy = pattern[i + 1] === '?' ? 1 : 0;
      edit(i, i + 1 + lazy, '');
      i += lazy;
      atom = false;
    } else if (c === '{' && atom && /^\{\d+(,\d*)?\}/.test(pattern.slice(i))) {
      const quantifier = /^\{\d+(,\d*)?\}\??/.exec(pattern.slice(i))[0];
      edit(i, i + quantifier.length, '');
      i += quantifier.length - 1;
      atom = false;
    } else atom = c !== '|';
  }
  return out;
}

// 印（probe）の番号。対象のファイルをまたいで通し番号にする
let nextProbe = 0;

// ミュータントと、テストごとに通った場所を調べるための印を作る
function analyze(file) {
  const code = readFileSync(join(root, file), 'utf8');
  const at = locator(code);
  const src = (node) => code.slice(node.start, node.end);
  const found = [];
  // 印: statement は文の前に、expression は式を (印, 式) に、regexp は正規表現を、使ったときに知らせるものに置き換える
  const probes = [];
  const probeOf = new Map();
  const stack = [];
  const newProbe = (kind, node) => {
    const id = nextProbe++;
    probes.push({ id, kind, start: node.start, end: node.end });
    probeOf.set(node, id);
    return id;
  };
  // probe: 書き換えが効くのは、その印を通ったとき（ノードを渡したときは、あとでそのノードの印にする）
  const add = (mutator, node, replacement, probe = stack.at(-1)) =>
    found.push({ mutator, start: node.start, end: node.end, replacement, probe, fallback: stack.at(-1) });
  // 2 つの式の間にある演算子（間には空白・括弧・コメントだけがある）を差し替えた、式全体
  const swapOperator = (node, left, right, from, to) => {
    const gap = code.slice(left.end, right.start).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (c) => ' '.repeat(c.length));
    const index = gap.search(/[^\s()]/);
    if (index === -1 || !gap.startsWith(from, index)) return null;
    return code.slice(node.start, left.end + index) + to + code.slice(left.end + index + from.length, node.end);
  };

  const visit = (node, parent) => {
    switch (node.type) {
      case 'BinaryExpression':
        for (const to of BINARY[node.operator] ?? []) {
          const text = swapOperator(node, node.left, node.right, node.operator, to);
          if (text) add(/^[<>=!]/.test(node.operator) ? 'EqualityOperator' : 'ArithmeticOperator', node, text);
        }
        break;
      case 'LogicalExpression':
        for (const to of LOGICAL[node.operator]) {
          const text = swapOperator(node, node.left, node.right, node.operator, to);
          if (text) add('LogicalOperator', node, text);
        }
        break;
      case 'AssignmentExpression': {
        const to = ASSIGNMENT[node.operator];
        const text = to && swapOperator(node, node.left, node.right, node.operator, to);
        if (text) add('AssignmentOperator', node, text);
        break;
      }
      case 'IfStatement':
      case 'ConditionalExpression':
        if (!/Literal$/.test(node.test.type)) for (const value of ['true', 'false']) add('ConditionalExpression', node.test, value);
        break;
      case 'WhileStatement':
      case 'DoWhileStatement':
      case 'ForStatement':
        // true にすると止まらないので、false だけ
        if (node.test && !/Literal$/.test(node.test.type)) add('ConditionalExpression', node.test, 'false');
        break;
      case 'BooleanLiteral':
        add('BooleanLiteral', node, String(!node.value));
        break;
      case 'UnaryExpression':
        if (node.operator === '!') add('BooleanLiteral', node, code.slice(node.start + 1, node.end));
        else if (node.operator === '-' || node.operator === '+')
          add('UnaryOperator', node, (node.operator === '-' ? '+' : '-') + code.slice(node.start + 1, node.end));
        break;
      case 'UpdateExpression': {
        const text = src(node);
        const to = node.operator === '++' ? '--' : '++';
        add('UpdateOperator', node, node.prefix ? to + text.slice(2) : text.slice(0, -2) + to);
        break;
      }
      case 'StringLiteral': {
        // import・export の出どころ、オブジェクトのキー、JSX の属性は書き換えない
        if (/^(Import|Export)/.test(parent.type)) break;
        if (KEYED.has(parent.type) && parent.key === node && !parent.computed) break;
        if (parent.type === 'JSXAttribute') break;
        if (parent.type === 'CallExpression' && parent.callee.type === 'Import') break;
        add('StringLiteral', node, node.value === '' ? "'__mutated__'" : "''");
        break;
      }
      case 'TemplateLiteral':
        if (parent.type !== 'TaggedTemplateExpression' && (node.expressions.length > 0 || node.quasis.some((q) => q.value.raw !== '')))
          add('StringLiteral', node, '``');
        break;
      case 'RegExpLiteral': {
        let probe = null;
        for (const pattern of new Set(regexVariants(node.pattern))) {
          if (pattern === node.pattern) continue;
          try {
            new RegExp(pattern, node.flags);
          } catch {
            continue;
          }
          probe ??= newProbe('regexp', node);
          add('Regex', node, `/${pattern}/${node.flags}`, probe);
        }
        break;
      }
      case 'ReturnStatement': {
        const value = node.argument;
        if (value && !(value.type === 'Identifier' && value.name === 'undefined') && !/^(Null|Boolean)Literal$/.test(value.type))
          add('ReturnValue', value, 'undefined');
        break;
      }
      case 'ArrowFunctionExpression':
        if (node.body.type !== 'BlockStatement' && !(node.body.type === 'Identifier' && node.body.name === 'undefined') && !/Literal$/.test(node.body.type))
          add('ArrowFunction', node.body, 'undefined', node.body);
        break;
      case 'BlockStatement': {
        if (node.body.length === 0) break;
        const isFunction = /Function|Method/.test(parent.type);
        // return だけの関数は ReturnValue で足りる。コンストラクタは空にしない
        if (isFunction && node.body.length === 1 && node.body[0].type === 'ReturnStatement') break;
        if (parent.kind === 'constructor') break;
        add('BlockStatement', node, '{}', node.body[0]);
        break;
      }
      case 'OptionalMemberExpression':
      case 'OptionalCallExpression': {
        if (!node.optional) break;
        const head = node.type === 'OptionalMemberExpression' ? node.object : node.callee;
        const index = code.indexOf('?.', head.end);
        if (index === -1 || index >= node.end) break;
        const dot = node.type === 'OptionalMemberExpression' && !node.computed ? '.' : '';
        add('OptionalChaining', node, code.slice(node.start, index) + dot + code.slice(index + 2, node.end));
        break;
      }
      case 'ArrayExpression':
        if (node.elements.length > 0) add('ArrayDeclaration', node, '[]');
        break;
      case 'CallExpression': {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier') break;
        const name = callee.property.name;
        if (METHOD_SWAP[name])
          add('MethodExpression', node, code.slice(node.start, callee.property.start) + METHOD_SWAP[name] + code.slice(callee.property.end, node.end));
        else if (METHOD_DROP.has(name)) add('MethodExpression', node, code.slice(node.start, callee.object.end));
        break;
      }
    }
  };

  // 印を付ける場所: 文の並び（ブロック・ファイル・case）の中の文と、あとで実行される式（式のアロー関数の値・クラスのフィールドの初期値・引数の既定値）
  const isListed = (parent, key) => (/^(BlockStatement|Program|StaticBlock)$/.test(parent?.type) && key === 'body') || (parent?.type === 'SwitchCase' && key === 'consequent');
  const isDeferred = (parent, key) =>
    (parent?.type === 'ArrowFunctionExpression' && key === 'body' && parent.body.type !== 'BlockStatement') ||
    (/^Class(Private)?Property$/.test(parent?.type) && key === 'value') ||
    (parent?.type === 'AssignmentPattern' && key === 'right');
  const walk = (node, parent, key) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type.startsWith('TS')) {
      if (TS_EXPRESSION.has(node.type)) walk(node.expression, node, 'expression');
      else if (node.type === 'TSParameterProperty') walk(node.parameter, node, 'parameter');
      return;
    }
    if (node.type === 'ImportDeclaration' || node.declare) return;
    const marked = isListed(parent, key) ? newProbe('statement', node) : isDeferred(parent, key) ? newProbe('expression', node) : null;
    if (marked !== null) stack.push(marked);
    visit(node, parent);
    for (const childKey of Object.keys(node)) {
      if (SKIP_KEYS.has(childKey)) continue;
      const value = node[childKey];
      if (Array.isArray(value)) for (const child of value) walk(child, node, childKey);
      else if (value && typeof value.type === 'string') walk(value, node, childKey);
    }
    if (marked !== null) stack.pop();
  };
  walk(parseCode(code, file).program, null, null);

  // 同じ書き換えは 1 つに。構文が壊れるもの（あれば）は外す
  const seen = new Set();
  const mutants = [];
  for (const m of found.sort((a, b) => a.start - b.start || a.end - b.end)) {
    const key = `${m.start}:${m.end}:${m.replacement}`;
    if (seen.has(key) || code.slice(m.start, m.end) === m.replacement) continue;
    seen.add(key);
    const mutated = code.slice(0, m.start) + m.replacement + code.slice(m.end);
    try {
      parseCode(mutated, file);
    } catch {
      continue;
    }
    const start = at(m.start);
    mutants.push({
      id: `${file}#${mutants.length + 1}`,
      file,
      mutator: m.mutator,
      line: start.line,
      column: start.column,
      original: code.slice(m.start, m.end),
      replacement: m.replacement,
      probe: typeof m.probe === 'number' ? m.probe : (probeOf.get(m.probe) ?? m.fallback),
      code: mutated,
    });
  }
  return { file, mutants, instrumented: instrument(code, file, probes) };
}

// 印を付けたコード（テストごとに通った場所を調べるときだけ使う）
function instrument(code, file, probes) {
  const inserts = [];
  for (const p of probes) {
    const size = p.end - p.start;
    if (p.kind === 'statement') inserts.push({ at: p.start, order: [1, 0], text: `globalThis.__tanacodeMutationHit(${p.id});` });
    else {
      const open = p.kind === 'regexp' ? `globalThis.__tanacodeMutationRegExp(${p.id}, ` : `(globalThis.__tanacodeMutationHit(${p.id}), `;
      // 同じ位置では、閉じ括弧が先、次に文の印、次に外側の式（長いもの）から開く
      inserts.push({ at: p.start, order: [2, -size], text: open }, { at: p.end, order: [0, 0], text: ')' });
    }
  }
  inserts.sort((a, b) => a.at - b.at || a.order[0] - b.order[0] || a.order[1] - b.order[1]);
  let out = '';
  let last = 0;
  for (const insert of inserts) {
    out += code.slice(last, insert.at) + insert.text;
    last = insert.at;
  }
  out += code.slice(last);
  // 印の付け方を誤っていたら、ここで分かる
  parseCode(out, file);
  return out;
}

// ---- 対象を読み込むテストのファイル（import をたどる） ----

function resolveImport(from, spec) {
  let base;
  if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else if (spec === '@shared' || spec.startsWith('@shared/')) base = join(root, 'src/shared', spec.slice('@shared'.length));
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function importsOf(file) {
  // 型だけの import（import type …）は、実行には読み込まないので、たどらない
  const code = readFileSync(file, 'utf8').replace(/\b(?:import|export)\s+type\s[^;]*?\bfrom\s+['"][^'"]+['"]/g, '');
  const specs = [...code.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? m[2]);
  return specs.map((spec) => resolveImport(file, spec)).filter(Boolean);
}

function testFilesFor(targetPaths) {
  const wanted = targetPaths.map((t) => join(root, t));
  const result = [];
  for (const name of readdirSync(TEST_DIR).sort()) {
    if (!name.endsWith('.test.ts')) continue;
    const testFile = join(TEST_DIR, name);
    const visited = new Set([testFile]);
    const queue = [testFile];
    while (queue.length > 0) {
      for (const next of importsOf(queue.shift())) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push(next);
      }
    }
    if (wanted.some((t) => visited.has(t))) result.push(testFile);
  }
  return result;
}

// ---- テストを流す ----

const children = new Set();
// fork したプロセスを、そこから起動したテストのプロセスごと止める
function killTree(child) {
  children.delete(child);
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}
// 途中で止めたとき・失敗で終わるときも、テストのプロセスを残さない
process.on('exit', () => {
  for (const child of [...children]) killTree(child);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(130));

function spawnWorker(args) {
  const child = fork(WORKER, args, { cwd: root, detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  children.add(child);
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  child.lastError = () => stderr.trim();
  return child;
}

// 次の type のメッセージを待つ。時間切れ・プロセスの終了では null
function nextMessage(child, type, timeoutMs) {
  return new Promise((done) => {
    const finish = (value) => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      done(value);
    };
    const onMessage = (message) => message.type === type && finish(message);
    const onExit = () => finish(null);
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.on('message', onMessage);
    child.on('exit', onExit);
  });
}

// 印を付けたコードで、テストのファイルを流し、テストごとに通った場所を調べる
async function measureHits(analyses, testFiles) {
  const child = spawnWorker(['hits', String(concurrency)]);
  if (!(await nextMessage(child, 'ready', 120_000))) throw new Error(`Vitest を起動できませんでした\n${child.lastError()}`);
  const files = Object.fromEntries(analyses.map((a) => [join(root, a.file), a.instrumented]));
  child.send({ files, testFiles });
  const result = await nextMessage(child, 'hits', 60 * 60_000);
  killTree(child);
  if (!result) throw new Error(`テストを流せませんでした\n${child.lastError()}`);
  if (result.status === 'killed') throw new Error(`元のコードのままで、テストが落ちました（${result.failed}）。先に npm test を通してください`);
  return result;
}

// ミュータントごとに流すテスト（ファイルごとに。速いファイルから）
function planOf(hits) {
  const modules = new Map(hits.modules.map((m) => [m.file, m]));
  const byProbe = new Map();
  const entry = (probe) => {
    if (!byProbe.has(probe)) byProbe.set(probe, { whole: new Set(), tests: new Map() });
    return byProbe.get(probe);
  };
  for (const test of hits.tests) {
    for (const probe of test.hits) {
      const e = entry(probe);
      if (!e.tests.has(test.file)) e.tests.set(test.file, []);
      e.tests.get(test.file).push(test);
    }
    for (const probe of test.setupHits) entry(probe).whole.add(test.file);
  }
  return (probe) => {
    const e = byProbe.get(probe);
    if (!e) return [];
    const files = new Set([...e.whole, ...e.tests.keys()]);
    return [...files]
      .map((file) => {
        const module = modules.get(file);
        if (e.whole.has(file)) return { file, testIds: null, ms: module.ms };
        const tests = e.tests.get(file);
        return { file, testIds: tests.map((t) => t.id), ms: module.overheadMs + tests.reduce((sum, t) => sum + t.ms, 0) };
      })
      .sort((a, b) => a.ms - b.ms);
  };
}

async function runMutants(mutants, onDone) {
  const queue = [...mutants];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      let host = null;
      while (queue.length > 0) {
        const mutant = queue.shift();
        if (!host) {
          host = spawnWorker(['host']);
          if (!(await nextMessage(host, 'ready', 120_000))) throw new Error(`Vitest を起動できませんでした\n${host.lastError()}`);
        }
        const timeout = mutant.specs.reduce((sum, s) => sum + s.ms, 0) * TIMEOUT_FACTOR + TIMEOUT_EXTRA_MS;
        host.send({ type: 'run', id: mutant.id, file: join(root, mutant.file), code: mutant.code, specs: mutant.specs.map(({ file, testIds }) => ({ file, testIds })) });
        const result = await nextMessage(host, 'result', timeout);
        if (result) Object.assign(mutant, { status: result.status === 'no-tests' ? 'no-coverage' : result.status, passed: result.passed, failed: result.failed, ms: result.ms });
        else {
          // 止まらない（無限ループなど）か、プロセスごと落ちた。時間切れは、テストが見つけたものとして数える
          const alive = host.exitCode === null && host.signalCode === null;
          Object.assign(mutant, alive ? { status: 'timeout', ms: Math.round(timeout) } : { status: 'error', failed: host.lastError().slice(-500) });
          killTree(host);
          host = null;
        }
        onDone(mutant);
      }
      if (host) killTree(host);
    }),
  );
}

// ---- 結果をまとめる ----

const STATUSES = ['killed', 'timeout', 'survived', 'no-coverage', 'error'];

function totalsOf(mutants) {
  const totals = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const m of mutants) totals[m.status]++;
  const detected = totals.killed + totals.timeout;
  const valid = detected + totals.survived + totals['no-coverage'];
  return {
    ...totals,
    total: mutants.length,
    // スコア: 見つけた（killed・timeout）割合。error は数えない（Stryker と同じ）
    score: valid === 0 ? null : (detected / valid) * 100,
    // テストが通った場所だけで見たスコア
    coveredScore: detected + totals.survived === 0 ? null : (detected / (detected + totals.survived)) * 100,
  };
}

const pct = (value) => (value === null ? '-' : `${value.toFixed(1)}%`);
const oneLine = (text, max = 100) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const inline = (text) => {
  const body = oneLine(text);
  return body.includes('`') ? `\`\` ${body} \`\`` : `\`${body}\``;
};
const duration = (ms) => {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`;
};

function summaryOf(results, elapsedMs) {
  const all = Object.values(results).flat();
  const out = ['## ミューテーションテスト', ''];
  out.push(`対象 ${targets.length} ファイル・ミュータント ${all.length} 個・かかった時間 ${duration(elapsedMs)}（同時に ${concurrency}）`, '');
  out.push('| ファイル | スコア | 通った場所でのスコア | 落ちた | 時間切れ | 生き残り | テストが通らない | エラー |');
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  const row = (name, t) =>
    `| ${name} | ${pct(t.score)} | ${pct(t.coveredScore)} | ${t.killed} | ${t.timeout} | ${t.survived} | ${t['no-coverage']} | ${t.error} |`;
  for (const [file, mutants] of Object.entries(results)) out.push(row(file, totalsOf(mutants)));
  if (targets.length > 1) out.push(row('合計', totalsOf(all)));
  out.push('');
  out.push('- スコア: 落ちた・時間切れ ÷（落ちた・時間切れ・生き残り・テストが通らない）。通った場所でのスコアは、テストが通らないものを除いた割合');
  out.push('- 生き残り: テストがそこを通っても、結果まで確かめていない場所の候補（書き換えても動きの変わらない、等価なものも混じります）', '');
  for (const [file, mutants] of Object.entries(results)) {
    const survived = mutants.filter((m) => m.status === 'survived');
    if (survived.length > 0) {
      out.push(`<details><summary>${file} の生き残り（${survived.length} 個）</summary>`, '');
      for (const m of survived) out.push(`- ${m.line} 行（${m.mutator}）: ${inline(m.original)} → ${inline(m.replacement)}`);
      out.push('', '</details>', '');
    }
    const uncovered = [...new Set(mutants.filter((m) => m.status === 'no-coverage').map((m) => m.line))];
    if (uncovered.length > 0) {
      out.push(`<details><summary>${file} の、テストが通らない行（${uncovered.length} 行）</summary>`, '', uncovered.join('、'), '', '</details>', '');
    }
  }
  return out.join('\n');
}

// ---- 本体 ----

const started = Date.now();
const analyses = targets.map(analyze);
const mutants = analyses.flatMap((a) => a.mutants);
console.log(`ミュータント: ${analyses.map((a) => `${a.file} ${a.mutants.length} 個`).join('・')}`);

if (listOnly) {
  for (const m of mutants) console.log(`${m.file}:${m.line}:${m.column} ${m.mutator} ${inline(m.original)} → ${inline(m.replacement)}`);
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });
const testFiles = testFilesFor(targets);
if (testFiles.length === 0) {
  console.error('対象を読み込むテストのファイルがありません');
  process.exit(1);
}
console.log(`元のコードで、対象を読み込むテストのファイル（${testFiles.length} 個）を流し、テストごとに通った場所を調べます`);
const hits = await measureHits(analyses, testFiles);
console.log(`  テスト ${hits.tests.length} 個（${duration(Date.now() - started)}）`);

const plan = planOf(hits);
const toRun = [];
for (const mutant of mutants) {
  mutant.specs = plan(mutant.probe);
  if (mutant.specs.length === 0) mutant.status = 'no-coverage';
  else toRun.push(mutant);
}
console.log(`ミュータントごとにテストを流します（${toRun.length} 個。テストが通らない ${mutants.length - toRun.length} 個は流しません）`);
let done = 0;
let lastLog = Date.now();
await runMutants(toRun, () => {
  done++;
  if (done === toRun.length || Date.now() - lastLog > 30_000) {
    lastLog = Date.now();
    const t = totalsOf(toRun.filter((m) => m.status));
    console.log(`  ${done}/${toRun.length}  落ちた ${t.killed}・時間切れ ${t.timeout}・生き残り ${t.survived}・エラー ${t.error}（${duration(Date.now() - started)}）`);
  }
});

const elapsed = Date.now() - started;
const results = Object.fromEntries(targets.map((t) => [t, mutants.filter((m) => m.file === t)]));
const report = {
  createdAt: new Date().toISOString(),
  durationMs: elapsed,
  concurrency,
  testFiles: hits.modules.map((m) => ({ file: toPath(m.file), ms: Math.round(m.ms) })),
  files: Object.fromEntries(
    Object.entries(results).map(([file, list]) => [
      file,
      {
        ...totalsOf(list),
        mutants: list.map(({ code, probe, specs, ...m }) => ({
          ...m,
          // 流したテスト（ファイルと、絞ったときはテストの数）
          tests: specs.map((s) => (s.testIds ? `${toPath(s.file)}（${s.testIds.length} 個）` : toPath(s.file))),
        })),
      },
    ]),
  ),
};
writeFileSync(join(outDir, 'mutation.json'), `${JSON.stringify(report, null, 2)}\n`);
const summary = summaryOf(results, elapsed);
writeFileSync(join(outDir, 'summary.md'), `${summary}\n`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);

console.log('');
for (const [file, list] of Object.entries(results)) {
  const t = totalsOf(list);
  console.log(`${file}: スコア ${pct(t.score)}（通った場所で ${pct(t.coveredScore)}）・生き残り ${t.survived}・テストが通らない ${t['no-coverage']}・時間切れ ${t.timeout}・エラー ${t.error}`);
}
console.log(`結果: ${toPath(join(outDir, 'summary.md'))}・${toPath(join(outDir, 'mutation.json'))}（${duration(elapsed)}）`);
const errors = mutants.filter((m) => m.status === 'error');
if (errors.length > 0) console.log(`エラーになったミュータントが ${errors.length} 個あります（mutation.json の failed）`);
