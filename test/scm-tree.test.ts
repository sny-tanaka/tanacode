import { expect, it } from 'vitest';
import { buildTree, filesInTreeOrder, visibleRows, type TreeNode } from '@shared/scm-tree';

// ソース管理の変更をツリーで見せる並べ方

const items = (...paths: string[]) => paths.map((path) => ({ path }));
// 木を「深さ + 名前」の行にして読みやすくする
const outline = (nodes: TreeNode<{ path: string }>[], collapsed = new Set<string>()) =>
  visibleRows(nodes, collapsed).map((r) => `${'  '.repeat(r.depth)}${r.node.name}${r.node.kind === 'dir' ? '/' : ''}`);

it('フォルダが先・ファイルが後で、どちらも名前順に並べる', () => {
  const tree = buildTree(items('README.md', 'src/b.ts', 'src/a.ts', 'docs/x.md', 'src/lib/c.ts', 'package.json'));
  expect(outline(tree)).toEqual([
    'docs/',
    '  x.md',
    'src/',
    '  lib/',
    '    c.ts',
    '  a.ts',
    '  b.ts',
    'package.json',
    'README.md',
  ]);
});

it('子がフォルダ 1 つだけのフォルダは、1 行にまとめる', () => {
  const tree = buildTree(items('src/renderer/src/scm/ScmPanel.tsx', 'src/renderer/src/scm/useGitState.ts', 'src/main/git.ts'));
  expect(outline(tree)).toEqual([
    'src/',
    '  main/',
    '    git.ts',
    '  renderer/src/scm/',
    '    ScmPanel.tsx',
    '    useGitState.ts',
  ]);
  const dir = tree[0];
  expect(dir.kind === 'dir' && dir.children.map((c) => c.path)).toEqual(['src/main', 'src/renderer/src/scm']);
});

it('ファイルもあるフォルダは、子がフォルダ 1 つでもまとめない', () => {
  const tree = buildTree(items('src/index.ts', 'src/lib/a.ts'));
  expect(outline(tree)).toEqual(['src/', '  lib/', '    a.ts', '  index.ts']);
});

it('フォルダの items は、下にあるすべての変更（まとめた行も同じ）', () => {
  const tree = buildTree(items('a/b/c.ts', 'a/b/d/e.ts', 'a/f.ts'));
  const a = tree[0];
  expect(a.kind === 'dir' && a.items.map((i) => i.path)).toEqual(['a/b/c.ts', 'a/b/d/e.ts', 'a/f.ts']);
  const b = a.kind === 'dir' ? a.children[0] : null;
  expect(b?.kind === 'dir' && b.items.map((i) => i.path)).toEqual(['a/b/c.ts', 'a/b/d/e.ts']);
  const merged = buildTree(items('x/y/z.ts'))[0];
  expect(merged.kind === 'dir' && [merged.name, merged.path, merged.items.length]).toEqual(['x/y', 'x/y', 1]);
});

it('畳んだフォルダの中は、行に出さない', () => {
  const tree = buildTree(items('src/a.ts', 'src/lib/b.ts', 'README.md'));
  expect(outline(tree, new Set(['src/lib']))).toEqual(['src/', '  lib/', '  a.ts', 'README.md']);
  expect(outline(tree, new Set(['src']))).toEqual(['src/', 'README.md']);
});

it('ファイルの順は、フォルダを畳んでいても、ツリーで上から並ぶ順', () => {
  const tree = buildTree(items('README.md', 'src/b.ts', 'src/lib/c.ts', 'src/a.ts'));
  expect(filesInTreeOrder(tree).map((i) => i.path)).toEqual(['src/lib/c.ts', 'src/a.ts', 'src/b.ts', 'README.md']);
});

it('変更が無ければ、空', () => {
  expect(buildTree([])).toEqual([]);
  expect(filesInTreeOrder(buildTree([]))).toEqual([]);
});
