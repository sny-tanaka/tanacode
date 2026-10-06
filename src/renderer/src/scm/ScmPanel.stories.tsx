import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import type { FileChange, GitEntry, GitState } from '@shared/ipc';
import { ScmPanel } from './ScmPanel';
import type { ScmView } from './scmView';

// ソース管理パネル。ブランチの行のアイコンで、変更を「ファイルの一覧」と「フォルダごとのツリー」に切り替える。
// ツリーでは、フォルダの行で畳める・フォルダごとにステージ / 取り消し / 破棄ができる（操作は何もしないモック）。
// 子がフォルダ 1 つだけのフォルダは 1 行にまとめる（src/renderer/src/scm）

const change = (kind: FileChange['kind'], added: number, removed: number): FileChange => ({ kind, added, removed });

const entry = (path: string, index: string, worktree: string): GitEntry => ({ path, index, worktree });

const STATE: GitState = {
  isRepo: true,
  branch: 'feat/scm-tree-view',
  upstream: 'origin/feat/scm-tree-view',
  ahead: 2,
  behind: 0,
  empty: false,
  entries: [
    entry('src/renderer/src/scm/ScmPanel.tsx', 'M', ' '),
    entry('src/renderer/src/scm/scmView.ts', 'A', ' '),
    entry('src/shared/scm-tree.ts', 'A', ' '),
    entry('src/renderer/src/global.css', ' ', 'M'),
    entry('src/renderer/src/icons/icons.tsx', ' ', 'M'),
    entry('test/scm-tree.test.ts', '?', '?'),
    entry('GUIDE.md', ' ', 'M'),
    entry('docs/old-note.md', ' ', 'D'),
  ],
  branchChanges: {
    base: { ref: 'develop', mergeBase: '2ead5d4abcdef', kind: 'branch' },
    files: {
      'src/renderer/src/scm/ScmPanel.tsx': change('modified', 120, 38),
      'src/renderer/src/scm/scmView.ts': change('added', 28, 0),
      'src/renderer/src/scm/ScmPanel.stories.tsx': change('added', 70, 0),
      'src/renderer/src/App.tsx': change('modified', 9, 2),
      'src/renderer/src/global.css': change('modified', 16, 0),
      'src/renderer/src/icons/icons.tsx': change('modified', 18, 0),
      'src/shared/scm-tree.ts': change('added', 66, 0),
      'test/scm-tree.test.ts': change('added', 64, 0),
      'GUIDE.md': change('modified', 3, 1),
      'docs/old-note.md': change('deleted', 0, 12),
      'design/logo.png': { kind: 'modified', added: 0, removed: 0, binary: true },
    },
  },
};

const noop = () => {};

function Demo({ initial, state = STATE }: { initial: ScmView; state?: GitState }) {
  const [view, setView] = useState<ScmView>(initial);
  const [active, setActive] = useState<string | null>('src/renderer/src/App.tsx');
  return (
    <div className="side-panel" style={{ height: 640, border: '1px solid var(--border-subtle)' }}>
      <ScmPanel
        sessionId="s1"
        state={state}
        view={view}
        onViewChange={setView}
        onRefresh={noop}
        onOpenDiff={noop}
        onOpenBranchDiff={setActive}
        activeBranchPath={active}
        comments={[]}
        onShowComment={noop}
        onRemoveComment={noop}
        onWalkthrough={noop}
      />
    </div>
  );
}

const meta = {
  title: 'ソース管理/ソース管理パネル',
  parameters: { width: 300 },
} satisfies Meta;
export default meta;

type Story = StoryObj<typeof meta>;

export const 一覧: Story = { render: () => <Demo initial="list" /> };
export const ツリー: Story = { render: () => <Demo initial="tree" /> };
// 変更がフォルダ 1 本の奥にだけあるとき（まとめた 1 行になる）
export const 深いフォルダだけ: Story = {
  render: () => (
    <Demo
      initial="tree"
      state={{
        ...STATE,
        entries: [entry('src/renderer/src/scm/ScmPanel.tsx', ' ', 'M'), entry('src/renderer/src/scm/useGitState.ts', ' ', 'M')],
        branchChanges: null,
      }}
    />
  ),
};
