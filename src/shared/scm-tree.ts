// ソース管理の変更を、フォルダごとの入れ子（ツリー）で見せるための部品。
// パスの一覧から木を作る。VS Code と同じく、フォルダが先・ファイルが後（どちらも名前順）で、
// 子がフォルダ 1 つだけのフォルダは 1 行にまとめる（a/b/c）

export type TreeFile<T> = { kind: 'file'; name: string; path: string; item: T };
// items: このフォルダの下にあるすべての変更（フォルダごとのステージ・破棄に使う）
export type TreeDir<T> = { kind: 'dir'; name: string; path: string; children: TreeNode<T>[]; items: T[] };
export type TreeNode<T> = TreeFile<T> | TreeDir<T>;

type Draft<T> = { name: string; path: string; dirs: Map<string, Draft<T>>; files: TreeFile<T>[]; items: T[] };

const draft = <T>(name: string, path: string): Draft<T> => ({ name, path, dirs: new Map(), files: [], items: [] });
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

export function buildTree<T extends { path: string }>(items: T[]): TreeNode<T>[] {
  const root = draft<T>('', '');
  for (const item of items) {
    const parts = item.path.split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = dir.dirs.get(parts[i]);
      if (!next) {
        next = draft(parts[i], parts.slice(0, i + 1).join('/'));
        dir.dirs.set(parts[i], next);
      }
      next.items.push(item);
      dir = next;
    }
    dir.files.push({ kind: 'file', name: parts[parts.length - 1], path: item.path, item });
  }
  return childrenOf(root);
}

function childrenOf<T>(d: Draft<T>): TreeNode<T>[] {
  return [...[...d.dirs.values()].map(dirOf).sort(byName), ...[...d.files].sort(byName)];
}

function dirOf<T>(d: Draft<T>): TreeDir<T> {
  let node: TreeDir<T> = { kind: 'dir', name: d.name, path: d.path, items: d.items, children: childrenOf(d) };
  // 子がフォルダ 1 つだけなら、その子とまとめる（パスと items は、まとめた先のものがそのまま使える）
  while (node.children.length === 1 && node.children[0].kind === 'dir') {
    const only: TreeDir<T> = node.children[0];
    node = { ...only, name: `${node.name}/${only.name}` };
  }
  return node;
}

export type TreeRow<T> = { node: TreeNode<T>; depth: number };

// 画面に出す行を、上から順に並べる。collapsed に入っているフォルダ（パス）の中は出さない
export function visibleRows<T>(nodes: TreeNode<T>[], collapsed: ReadonlySet<string>, depth = 0): TreeRow<T>[] {
  return nodes.flatMap((node) => [
    { node, depth },
    ...(node.kind === 'dir' && !collapsed.has(node.path) ? visibleRows(node.children, collapsed, depth + 1) : []),
  ]);
}

// ファイルを、ツリーで上から並ぶ順に（フォルダを畳んでいても、全部）
export function filesInTreeOrder<T>(nodes: TreeNode<T>[]): T[] {
  return nodes.flatMap((node) => (node.kind === 'file' ? [node.item] : filesInTreeOrder(node.children)));
}
