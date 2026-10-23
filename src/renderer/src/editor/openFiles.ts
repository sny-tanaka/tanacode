import type { FileContent } from '@shared/ipc';
import type { OpenFile, RevealRequest } from './EditorPane';

// フォルダごとのエディタの状態（開いているタブ・選んでいるタブ・表示する行）。App が持つ
export type EditorState = { files: OpenFile[]; activePath: string | null; reveal: RevealRequest | null };
export const EMPTY_EDITOR: EditorState = { files: [], activePath: null, reveal: null };

export function withFile(files: OpenFile[], path: string, content: FileContent): OpenFile[] {
  const open = files.find((f) => f.path === path);
  // 中身が同じなら入れ替えない（保存のあとの変更の知らせで読み直したときなど。入れ替えると App とエディタが描き直される）
  if (open?.content.kind === 'text' && content.kind === 'text' && open.content.text === content.text) return files;
  return open ? files.map((f) => (f.path === path ? { path, content } : f)) : [...files, { path, content }];
}

// 開いているタブの path の中身を content にする（開いていなければ、そのまま）
export function withOpenFile(state: EditorState, path: string, content: FileContent): EditorState {
  if (!state.files.some((f) => f.path === path)) return state;
  const files = withFile(state.files, path, content);
  return files === state.files ? state : { ...state, files };
}

// フォルダ dir のエディタの状態を fn で変える。変わらなければ、editors をそのまま返す（App を描き直さない）
export function withEditor(
  editors: Record<string, EditorState>,
  dir: string,
  fn: (state: EditorState) => EditorState,
): Record<string, EditorState> {
  const next = fn(editors[dir] ?? EMPTY_EDITOR);
  return next === editors[dir] ? editors : { ...editors, [dir]: next };
}
