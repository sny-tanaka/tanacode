// エディタに落として開くファイル。Finder から落としたファイルと、エクスプローラーの行をドラッグしたもの。
// どちらも絶対パスにそろえ、エディタは App の openAbsolute で開く（フォルダの中のファイルは相対パスのタブになる）

// エクスプローラーの行をドラッグするときの型。中身はファイルの絶対パス。
// text/plain は入れない（Monaco やチャットの入力欄が、パスを文字として入れてしまうため）
export const TREE_FILE_TYPE = 'application/x-tanacode-file';

// エディタが受け取るドラッグか（Finder のファイルか、エクスプローラーの行）
export function isFileDrag(data: DataTransfer): boolean {
  return data.types.includes('Files') || data.types.includes(TREE_FILE_TYPE);
}

// 落としたものの絶対パス。フォルダは開けないので除く
export function droppedPaths(data: DataTransfer): string[] {
  const own = data.getData(TREE_FILE_TYPE);
  if (own) return [own];
  const paths: string[] = [];
  for (const item of Array.from(data.items)) {
    if (item.kind !== 'file' || item.webkitGetAsEntry()?.isDirectory) continue;
    const file = item.getAsFile();
    const path = file && window.tanacode.pathForFile(file);
    if (path) paths.push(path);
  }
  return paths;
}
