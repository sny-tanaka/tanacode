import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLanguage } from '../src/shared/i18n';
import { allowedToolIds } from '../src/shared/mcp-tools';
import { rangeQuestionText, restartRequestText, stepQuestionText, type Walkthrough, type WalkthroughShown } from '../src/shared/walkthrough';
import { finalCommentBody } from '../src/shared/walkthrough-comment';
import { WALKTHROUGH_MCP, walkthroughOfTool, walkthroughTarget, walkthroughToolId } from '../src/shared/walkthrough-tools';
import { AppSettings } from '../src/main/app-settings';
import { claudeArgs } from '../src/main/claude-session';
import type { PullRequest } from '../src/main/github';
import { textResult, type ToolResult } from '../src/main/mcp-bridge';
import { respond } from '../src/main/mcp-relay';
import { WalkthroughControl } from '../src/main/walkthrough-control';
import { draftWalkthroughComment, type CommentDeps } from '../src/main/walkthrough-github';

// ウォークスルー（Claude がエディタでコードを示しながら説明し、人が「次へ」で進めて質問する）。
// MCP のツール（手順の確かめ・寄り道・今の場所・PR への投稿）・画面からの操作・起動の引数・チャットの表示・質問の文

let dir: string;
let cwd: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tanacode-walkthrough-'));
  cwd = join(dir, 'repo');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'tax.ts'), Array.from({ length: 20 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n') + '\n');
  writeFileSync(join(cwd, 'src', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]));
  writeFileSync(join(dir, 'outside.ts'), 'secret\n');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ME = '11111111-0000-4000-8000-000000000001';

// PR を探す・コメントを書く代わり（PR は無い）
const noPullRequests: CommentDeps = { pullRequests: async () => [], comment: async () => '' };

// answer: Claude が示した場所を画面がどう扱ったか（画面からの返事）。null なら返事をしない（画面を作り直している間など）
function setup(enabled = true, comment = noPullRequests, answer: () => WalkthroughShown | null = () => 'moved') {
  const changes: { sessionId: string; walkthrough: Walkthrough | null }[] = [];
  const control: WalkthroughControl = new WalkthroughControl({
    cwdOf: (id) => (id === ME ? cwd : null),
    enabled: () => enabled,
    onChange: (sessionId, walkthrough) => {
      changes.push({ sessionId, walkthrough });
      const shown = walkthrough?.movedBy === 'claude' ? answer() : null;
      if (walkthrough && shown) control.shown(sessionId, walkthrough.id, walkthrough.seq, shown);
    },
    comment,
    clock: () => 1000,
    shownTimeoutMs: 20,
  });
  return { control, changes };
}

const text = (r: ToolResult) => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

const step = (over: Record<string, unknown> = {}) => ({ path: 'src/tax.ts', start_line: 3, end_line: 5, title: '税率を読む', body: '設定から読みます。', ...over });

describe('MCP のツール', () => {
  it('start_walkthrough: 手順を確かめて始め、1 つ目を開いたことを返す。画面に知らせる', async () => {
    const { control, changes } = setup();
    const r = await control.handle(ME, 'start_walkthrough', { title: '税率の変更', steps: [step(), step({ path: join(cwd, 'src/tax.ts'), start_line: 10, end_line: undefined, title: '切り捨て' })] });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toContain('1/2 "税率を読む" (src/tax.ts:3-5)');
    const w = control.get(ME)!;
    // フォルダの中の絶対パスは相対パスに、end_line を省くと 1 行
    expect(w.steps[1]).toEqual({ path: 'src/tax.ts', startLine: 10, endLine: 10, title: '切り捨て', body: '設定から読みます。', view: 'file' });
    expect(w).toMatchObject({ title: '税率の変更', current: 0, aside: null, visited: [0], movedBy: 'claude', seq: 1, startedAt: 1000 });
    expect(changes).toHaveLength(1);
  });

  it('start_walkthrough: 直せないステップは、全部の理由をまとめて返し、始めない', async () => {
    const { control, changes } = setup();
    const r = await control.handle(ME, 'start_walkthrough', {
      title: '税率の変更',
      steps: [
        step(),
        step({ path: join(dir, 'none.ts') }),
        step({ start_line: 18, end_line: 25 }),
        step({ start_line: 5, end_line: 3 }),
        step({ path: 'src/none.ts' }),
        step({ path: 'src/logo.png', start_line: 1, end_line: 1 }),
        step({ body: '  ' }),
      ],
    });
    expect(r.isError).toBe(true);
    const message = text(r);
    expect(message).toContain(`Step 2: ${join(dir, 'none.ts')} was not found`);
    expect(message).toContain('Step 3: src/tax.ts has 20 lines (there is no line 25).');
    expect(message).toContain('Step 4: src/tax.ts: end_line must be an integer of start_line or more');
    expect(message).toContain('Step 5: src/none.ts was not found');
    expect(message).toContain('Step 6: src/logo.png is not a text file');
    expect(message).toContain('Step 7: Pass body.');
    expect(message).not.toContain('Step 1:');
    expect(control.get(ME)).toBeNull();
    expect(changes).toEqual([]);
  });

  it('start_walkthrough: view は file（既定）か diff。ほかは断る', async () => {
    const { control } = setup();
    await control.handle(ME, 'start_walkthrough', { title: 't', steps: [step({ view: 'diff' }), step()] });
    expect(control.get(ME)!.steps.map((s) => s.view)).toEqual(['diff', 'file']);
    expect(text(await control.handle(ME, 'start_walkthrough', { title: 't', steps: [step({ view: 'split' })] }))).toContain('view must be "file" or "diff"');
  });

  it('start_walkthrough: ステップが無い・多すぎるときは断る', async () => {
    const { control } = setup();
    expect(text(await control.handle(ME, 'start_walkthrough', { title: 't', steps: [] }))).toContain('at least one step');
    const many = Array.from({ length: 41 }, () => step());
    expect(text(await control.handle(ME, 'start_walkthrough', { title: 't', steps: many }))).toContain('up to 40 steps (got 41)');
  });

  it('show_code: 寄り道として示し、人が戻ると元のステップに戻る。始めていなくても示せる', async () => {
    const { control } = setup();
    const alone = await control.handle(ME, 'show_code', { path: 'src/tax.ts', start_line: 7, body: 'ここです' });
    expect(text(alone)).toBe("Showed src/tax.ts:7 in the user's editor (an aside).");
    expect(control.get(ME)).toMatchObject({ steps: [], aside: { path: 'src/tax.ts', startLine: 7, endLine: 7, title: '' } });

    await control.handle(ME, 'start_walkthrough', { title: '税率の変更', steps: [step(), step({ start_line: 12, end_line: undefined })] });
    control.go(ME, 1);
    const r = await control.handle(ME, 'show_code', { path: 'src/tax.ts', start_line: 15, end_line: 16, body: '呼び出し元です' });
    // 戻るボタンの名前は、画面の言語で入れる
    expect(text(r)).toContain('When the user clicks "ウォークスルーに戻る（2/2）", the editor returns to 2/2.');
    expect(control.get(ME)).toMatchObject({ current: 1, aside: { startLine: 15, endLine: 16 }, movedBy: 'claude' });
    control.go(ME, 1);
    expect(control.get(ME)).toMatchObject({ current: 1, aside: null, movedBy: 'human' });
  });

  it('walkthrough_status: 手順と、人が見ているステップ・見たステップを返す', async () => {
    const { control } = setup();
    expect(text(await control.handle(ME, 'walkthrough_status', {}))).toContain('There is no walkthrough');
    await control.handle(ME, 'start_walkthrough', { title: '税率の変更', steps: [step(), step({ start_line: 12, end_line: undefined, title: '切り捨て' }), step({ title: '呼び出し' })] });
    control.go(ME, 1);
    const status = text(await control.handle(ME, 'walkthrough_status', {}));
    expect(status).toBe(
      [
        'Walkthrough "税率の変更" (3 steps). The user is viewing 2/3 "切り捨て".',
        '1. 税率を読む — src/tax.ts:3-5 (viewed)',
        '2. 切り捨て — src/tax.ts:12 (current)',
        // 見ていないステップには印を付けない
        '3. 呼び出し — src/tax.ts:3-5',
      ].join('\n'),
    );
    control.close(ME);
    // 開き直す場所（ソース管理）の名前は、画面の言語で入れる
    expect(text(await control.handle(ME, 'walkthrough_status', {}))).toContain('The user has closed the walkthrough (last viewed 2/3; it can be reopened from the list in "ソース管理").');
    control.discard(ME);
    expect(text(await control.handle(ME, 'walkthrough_status', {}))).toContain('There is no walkthrough');
  });

  it('show_code: 画面が動かさなかったときは、動かしたとは返さない（帯だけ・別のセッション・返事が無い）', async () => {
    const band = await setup(true, noPullRequests, () => 'band').control.handle(ME, 'show_code', { path: 'src/tax.ts', start_line: 7, body: 'ここ' });
    expect(text(band)).toBe(
      'Did not move the user\'s editor to src/tax.ts:7: the user has opened another file or view in this session. A band above the editor tells them that you are showing src/tax.ts:7, with "Claude が示している場所へ戻る" to open it. Mention the location in your reply so that the user can find it.',
    );
    const unseen = await setup(true, noPullRequests, () => 'unseen').control.handle(ME, 'show_code', { path: 'src/tax.ts', start_line: 7, body: 'ここ' });
    expect(text(unseen)).toBe(
      "Did not move the user's editor: the user is viewing another session in tanacode. src/tax.ts:7 opens when the user comes back to this session. Mention the location in your reply so that the user can find it.",
    );
    const silent = await setup(true, noPullRequests, () => null).control.handle(ME, 'show_code', { path: 'src/tax.ts', start_line: 7, body: 'ここ' });
    expect(text(silent)).toBe(
      "Sent src/tax.ts:7 to the user's editor as an aside, but the tanacode window did not confirm that it showed it. Mention the location in your reply so that the user can find it.",
    );
    // 画面が返事をしなくても、示した場所は残す（あとで帯や一覧から開ける）
    expect(silent.isError).toBeUndefined();
  });

  it('show_code: 遅れて届いた前の返事・別のウォークスルーへの返事は使わない', async () => {
    let control!: WalkthroughControl;
    let last: Walkthrough | null = null;
    control = new WalkthroughControl({
      cwdOf: () => cwd,
      enabled: () => true,
      onChange: (_id, w) => {
        last = w;
      },
      comment: noPullRequests,
      shownTimeoutMs: 20,
    });
    const pending = control.handle(ME, 'show_code', { path: 'src/tax.ts', start_line: 7, body: 'ここ' });
    await new Promise((r) => setTimeout(r, 5));
    const w = last as unknown as Walkthrough;
    control.shown(ME, 'another-walkthrough', w.seq, 'moved');
    control.shown(ME, w.id, w.seq - 1, 'moved');
    control.shown(ME, w.id, w.seq, 'nonsense' as WalkthroughShown);
    expect(text(await pending)).toContain('did not confirm');
  });

  it('start_walkthrough: 人が別のセッションを見ているときは、開いたとは返さない', async () => {
    const r = await setup(true, noPullRequests, () => 'unseen').control.handle(ME, 'start_walkthrough', { title: '税率の変更', steps: [step(), step()] });
    expect(text(r)).toContain('Prepared 1/2 "税率を読む" (src/tax.ts:3-5). The user is viewing another session in tanacode, so it opens when the user comes back to this session.');
    expect(text(r)).not.toContain('Opened');
    const silent = await setup(true, noPullRequests, () => null).control.handle(ME, 'start_walkthrough', { title: '税率の変更', steps: [step()] });
    expect(text(silent)).toContain('Sent 1/1 "税率を読む" (src/tax.ts:3-5) to the user\'s tanacode editor, but the tanacode window did not confirm that it opened it.');
  });

  it('walkthrough_status: 人が別のセッション・別のファイルを見ていれば、そう返す', async () => {
    const { control } = setup();
    await control.handle(ME, 'start_walkthrough', { title: '税率の変更', steps: [step(), step({ start_line: 12, end_line: undefined, title: '切り捨て' })] });
    control.go(ME, 1);
    control.viewing('another-session', false);
    expect(text(await control.handle(ME, 'walkthrough_status', {}))).toContain('The user is viewing another session in tanacode now. The walkthrough is at 2/2 "切り捨て".');
    control.viewing(ME, false);
    expect(text(await control.handle(ME, 'walkthrough_status', {}))).toContain(
      'The user has opened another file or view in the editor instead (a band above the editor offers to go back). The walkthrough is at 2/2 "切り捨て".',
    );
    control.viewing(ME, true);
    expect(text(await control.handle(ME, 'walkthrough_status', {}))).toContain('The user is viewing 2/2 "切り捨て".');
    // 寄り道だけのときも
    const alone = setup().control;
    await alone.handle(ME, 'show_code', { path: 'src/tax.ts', start_line: 7, body: 'ここ' });
    alone.viewing(null, false);
    expect(text(await alone.handle(ME, 'walkthrough_status', {}))).toBe(
      'No walkthrough has been started. Showing src/tax.ts:7 as an aside. The user is viewing another session in tanacode now.',
    );
  });

  it('メニューでオフ・知らないセッション・知らないツールは断る', async () => {
    expect(text(await setup(false).control.handle(ME, 'walkthrough_status', {}))).toBe(
      'The user has turned off "MCP > ウォークスルー" in the tanacode menu. Ask the user to turn it on.',
    );
    const { control } = setup();
    expect(text(await control.handle('other', 'walkthrough_status', {}))).toContain('not in tanacode');
    expect(await control.handle(ME, 'rm_rf', {})).toEqual(textResult('Unknown tool: rm_rf', true));
  });
});

describe('PR への投稿（post_walkthrough）', () => {
  const REPO = 'https://github.com/me/cafe';
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let posted: string[];
  beforeEach(() => {
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'me');
    git('config', 'user.email', 'me@example.com');
    git('add', '.');
    git('commit', '-qm', 'init');
    git('switch', '-qc', 'feature');
    posted = [];
  });

  const pr = (over: Partial<PullRequest> = {}): PullRequest => ({ number: 12, state: 'OPEN', headRefOid: git('rev-parse', 'HEAD'), baseRefName: 'main', url: `${REPO}/pull/12`, ...over });
  // 書いたコメントは posted に残し、何件目かを URL に入れて返す
  const github = (prs: PullRequest[]): CommentDeps => ({
    pullRequests: async (_cwd, branch) => (branch === 'feature' ? prs : []),
    comment: async (_cwd, number, body) => {
      posted.push(`${number}:${body}`);
      return `${REPO}/pull/${number}#issuecomment-${posted.length}\n`;
    },
  });
  const started = async (comment: CommentDeps) => {
    const { control } = setup(true, comment);
    await control.handle(ME, 'start_walkthrough', { title: '税率の変更', steps: [step()] });
    return control;
  };

  it('ボタンで下見の本文のまま投稿するのと同じコメントを載せ、URL を返す。画面の下見にも投稿済みと出す', async () => {
    const deps = github([pr()]);
    const control = await started(deps);
    const r = await control.handle(ME, 'post_walkthrough', {});
    expect(r.isError).toBeUndefined();
    expect(text(r)).toBe(`Posted the walkthrough "税率の変更" (1 step) to PR #12 as a comment: ${REPO}/pull/12#issuecomment-1`);
    const w = control.get(ME)!;
    const draft = await draftWalkthroughComment(cwd, w, control.postedUrl(w.id), deps);
    if (!draft.ok) throw new Error(draft.reason);
    expect(posted).toEqual([`12:${finalCommentBody(draft.body, true)}`]);
    expect(draft.postedUrl).toBe(`${REPO}/pull/12#issuecomment-1`);
  });

  it('投稿済みなら、そのコメントの URL を返して断る。repost: true のときだけ載せ直す', async () => {
    const control = await started(github([pr()]));
    await control.handle(ME, 'post_walkthrough', {});
    const again = await control.handle(ME, 'post_walkthrough', { repost: false });
    expect(again.isError).toBe(true);
    expect(text(again)).toContain(`has already been posted: ${REPO}/pull/12#issuecomment-1. Post it again only if the user asks you to, with repost: true.`);
    expect(posted).toHaveLength(1);
    expect(text(await control.handle(ME, 'post_walkthrough', { repost: true }))).toContain(`${REPO}/pull/12#issuecomment-2`);
    expect(posted).toHaveLength(2);
    // 作り直したウォークスルーは、まだ載せていない
    await control.handle(ME, 'start_walkthrough', { title: '作り直し', steps: [step()] });
    expect(text(await control.handle(ME, 'post_walkthrough', {}))).toContain(`${REPO}/pull/12#issuecomment-3`);
  });

  it('載せられない理由は、画面が日本語でも英語で返し、自分でコメントを書かないよう伝える。投稿済みにはしない', async () => {
    const control = await started(github([pr({ headRefOid: '0123456789abcdef' })]));
    const r = await control.handle(ME, 'post_walkthrough', {});
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(`Could not post the walkthrough "税率の変更". Your local HEAD (`);
    expect(text(r)).toContain('Push (or pull) before posting. Tell the user the reason instead of posting a comment of your own.');
    const dirty = await started(github([pr()]));
    writeFileSync(join(cwd, 'src', 'tax.ts'), 'changed\n'.repeat(20));
    expect(text(await dirty.handle(ME, 'post_walkthrough', {}))).toContain('Some files have uncommitted changes: src/tax.ts.');
    // セッションのフォルダの外のファイルのステップは、PR に無い（コミットするようには言わない）
    const { control: outside } = setup(true, github([pr()]));
    await outside.handle(ME, 'start_walkthrough', { title: '外も見る', steps: [step({ path: join(dir, 'outside.ts'), start_line: 1, end_line: 1 })] });
    expect(text(await outside.handle(ME, 'post_walkthrough', {}))).toBe(
      `Could not post the walkthrough "外も見る". Some steps show files outside the session folder: ${join(dir, 'outside.ts')}. They aren't in the PR, so this walkthrough can't be posted. To post one, start a walkthrough without those steps. Tell the user the reason instead of posting a comment of your own.`,
    );
    expect(posted).toEqual([]);
    expect(control.postedUrl(control.get(ME)!.id)).toBeNull();
  });

  it('gh が書けなかったときは、gh のエラーの文を返す', async () => {
    const control = await started({ ...github([pr()]), comment: async () => Promise.reject(new Error('HTTP 403: Resource not accessible')) });
    const r = await control.handle(ME, 'post_walkthrough', {});
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('HTTP 403: Resource not accessible');
    expect(control.postedUrl(control.get(ME)!.id)).toBeNull();
  });

  it('ウォークスルーが無い（寄り道だけ）ときは断り、GitHub に問い合わせない', async () => {
    const asked: string[] = [];
    const { control } = setup(true, { pullRequests: async (_cwd, branch) => (asked.push(branch), []), comment: async () => '' });
    expect(text(await control.handle(ME, 'post_walkthrough', {}))).toBe('There is no walkthrough to post. Start one with start_walkthrough first.');
    await control.handle(ME, 'show_code', { path: 'src/tax.ts', start_line: 1, body: 'x' });
    expect((await control.handle(ME, 'post_walkthrough', {})).isError).toBe(true);
    expect(asked).toEqual([]);
  });
});

describe('画面からの操作', () => {
  it('go: 範囲に収めて、見たステップを覚える', async () => {
    const { control } = setup();
    await control.handle(ME, 'start_walkthrough', { title: 't', steps: [step(), step(), step()] });
    control.go(ME, 9);
    expect(control.get(ME)).toMatchObject({ open: true, current: 2, visited: [0, 2], seq: 2 });
    control.go(ME, -1);
    expect(control.get(ME)).toMatchObject({ current: 0, visited: [0, 2], seq: 3 });
  });

  it('close: 手順は残し、go で開き直せる。Claude が作り直すと置き換わる', async () => {
    const { control, changes } = setup();
    await control.handle(ME, 'start_walkthrough', { title: 't', steps: [step(), step(), step()] });
    control.go(ME, 1);
    const id = control.get(ME)!.id;
    control.close(ME);
    expect(control.get(ME)).toMatchObject({ id, open: false, current: 1, visited: [0, 1], movedBy: 'human' });
    expect(changes.at(-1)?.walkthrough?.open).toBe(false);
    // 閉じたものを、もう一度閉じても変わらない
    const count = changes.length;
    control.close(ME);
    expect(changes).toHaveLength(count);
    control.go(ME, 2);
    expect(control.get(ME)).toMatchObject({ id, open: true, current: 2 });
    control.close(ME);
    // 質問に答えて示すときは開く
    await control.handle(ME, 'show_code', { path: 'src/tax.ts', start_line: 7, body: 'ここ' });
    expect(control.get(ME)).toMatchObject({ id, open: true, aside: { startLine: 7 } });
    await control.handle(ME, 'start_walkthrough', { title: '作り直し', steps: [step()] });
    expect(control.get(ME)).toMatchObject({ title: '作り直し', open: true, current: 0, visited: [0] });
    expect(control.get(ME)!.id).not.toBe(id);
  });

  it('寄り道だけのものは、閉じると捨てる。discard は捨てて画面に知らせる', async () => {
    const { control, changes } = setup();
    await control.handle(ME, 'show_code', { path: 'src/tax.ts', start_line: 7, body: 'ここ' });
    control.close(ME);
    expect(control.get(ME)).toBeNull();
    expect(changes.at(-1)).toEqual({ sessionId: ME, walkthrough: null });
    await control.handle(ME, 'start_walkthrough', { title: 't', steps: [step()] });
    control.discard(ME);
    expect(control.get(ME)).toBeNull();
    expect(control.list()).toEqual([]);
  });
});

describe('引数と状態の細かいところ', () => {
  it('start_walkthrough: title が無い・長すぎる、steps が配列でないときは断る', async () => {
    const { control, changes } = setup();
    expect(text(await control.handle(ME, 'start_walkthrough', { title: 5, steps: [step()] }))).toBe('Pass title.');
    expect(text(await control.handle(ME, 'start_walkthrough', { title: 'あ'.repeat(121), steps: [step()] }))).toBe('title can be up to 120 characters (got 121).');
    expect(text(await control.handle(ME, 'start_walkthrough', { title: 't', steps: 'src/tax.ts' }))).toContain('at least one step');
    expect(changes).toEqual([]);
  });

  it('start_walkthrough: オブジェクトでない・path の無い・start_line が 1 以上の整数でない・本文が長すぎるステップは、理由を返す', async () => {
    const { control } = setup();
    const r = await control.handle(ME, 'start_walkthrough', {
      title: 't',
      steps: ['src/tax.ts', [step()], step({ path: undefined }), step({ start_line: 0 }), step({ start_line: 2.5 }), step({ start_line: 'abc' }), step({ body: 'x'.repeat(4001) })],
    });
    expect(r.isError).toBe(true);
    expect(text(r).split('\n').slice(1)).toEqual([
      'Step 1: Pass path.',
      'Step 2: Pass path.',
      'Step 3: Pass path.',
      'Step 4: src/tax.ts: start_line must be an integer of 1 or more.',
      'Step 5: src/tax.ts: start_line must be an integer of 1 or more.',
      'Step 6: src/tax.ts: start_line must be an integer of 1 or more.',
      'Step 7: body can be up to 4000 characters (got 4001).',
    ]);
  });

  it('名前が .. で始まるファイル（フォルダの中のもの）も示せる', async () => {
    writeFileSync(join(cwd, '..notes.md'), 'a\nb\n');
    const { control } = setup();
    expect(text(await control.handle(ME, 'show_code', { path: '..notes.md', start_line: 1, body: 'ここ' }))).toBe("Showed ..notes.md:1 in the user's editor (an aside).");
  });

  it('末尾に改行の無いファイルも、最後の行まで示せる', async () => {
    writeFileSync(join(cwd, 'src', 'short.ts'), 'a\nb\nc');
    const { control } = setup();
    expect((await control.handle(ME, 'show_code', { path: 'src/short.ts', start_line: 3, body: '最後の行' })).isError).toBeUndefined();
    expect(text(await control.handle(ME, 'show_code', { path: 'src/short.ts', start_line: 4, body: 'x' }))).toBe('src/short.ts has 3 lines (there is no line 4).');
  });

  it('show_code: 示せないもの（無いファイル・フォルダ）は理由を返し、今の表示を変えない', async () => {
    const { control, changes } = setup();
    expect(text(await control.handle(ME, 'show_code', { path: join(dir, 'none.ts'), start_line: 1, body: 'x' }))).toBe(`${join(dir, 'none.ts')} was not found.`);
    expect(text(await control.handle(ME, 'show_code', { path: '..', start_line: 1, body: 'x' }))).toBe(`${dir} was not found.`);
    expect(control.get(ME)).toBeNull();
    expect(changes).toEqual([]);
  });

  // 人と決めたこと: 制限しない。Claude はもともと、どのファイルも読めるので、tanacode だけで制限しても意味がない
  it('セッションのフォルダの外のファイルも示せる（show_code・start_walkthrough のステップ）。外は絶対パスのまま、画面がエディタで開く', async () => {
    const outside = join(dir, 'outside.ts');
    const { control } = setup();
    // 絶対パス、.. で外に出る相対パス（名前が .. で始まるフォルダを通るもの）、.. を含む絶対パス
    for (const path of [outside, '../outside.ts', '..notes/../../outside.ts', `${cwd}/../outside.ts`]) {
      expect(text(await control.handle(ME, 'show_code', { path, start_line: 1, body: '外のファイル' }))).toBe(`Showed ${outside}:1 in the user's editor (an aside).`);
      expect(control.get(ME)!.aside).toEqual({ path: outside, startLine: 1, endLine: 1, title: '', body: '外のファイル', view: 'file' });
    }
    const r = await control.handle(ME, 'start_walkthrough', { title: '外も見る', steps: [step(), step({ path: outside, start_line: 1, end_line: 1, title: '外' })] });
    expect(r.isError).toBeUndefined();
    expect(control.get(ME)!.steps[1]).toMatchObject({ path: outside, startLine: 1, endLine: 1 });
    expect(text(await control.handle(ME, 'walkthrough_status', {}))).toContain(`2. 外 — ${outside}:1`);
  });

  it('セッションのフォルダがリンク越しのパスでも、Claude Code が渡すリンクを解いたパスのフォルダの中のファイルは、相対パスにする', async () => {
    const real = realpathSync(cwd);
    cwd = join(dir, 'linked');
    symlinkSync(real, cwd);
    const { control } = setup();
    expect(text(await control.handle(ME, 'show_code', { path: join(real, 'src', 'tax.ts'), start_line: 2, body: 'x' }))).toBe("Showed src/tax.ts:2 in the user's editor (an aside).");
    expect(control.get(ME)!.aside?.path).toBe('src/tax.ts');
  });

  it('思いがけない失敗（ツールの理由にできないもの）は、結果にせずに投げる', async () => {
    const { control } = setup();
    const broken = { valueOf: () => { throw new TypeError('壊れた値'); } };
    await expect(control.handle(ME, 'start_walkthrough', { title: 't', steps: [step({ start_line: broken })] })).rejects.toThrow('壊れた値');
    await expect(control.handle(ME, 'show_code', { path: 'src/tax.ts', start_line: broken, body: 'x' })).rejects.toThrow('壊れた値');
    expect(control.get(ME)).toBeNull();
  });

  it('時計を渡さなければ、今の時刻で始める', async () => {
    const control = new WalkthroughControl({ cwdOf: () => cwd, enabled: () => true, onChange: () => {}, comment: noPullRequests });
    const before = Date.now();
    await control.handle(ME, 'start_walkthrough', { title: 't', steps: [step()] });
    expect(control.get(ME)!.startedAt).toBeGreaterThanOrEqual(before);
    expect(control.get(ME)!.startedAt).toBeLessThanOrEqual(Date.now());
  });

  it('walkthrough_status: 寄り道だけのとき・寄り道を見ているときは、示している場所を返す', async () => {
    const { control } = setup();
    await control.handle(ME, 'show_code', { path: 'src/tax.ts', start_line: 7, body: 'ここ' });
    expect(text(await control.handle(ME, 'walkthrough_status', {}))).toBe('No walkthrough has been started. Showing src/tax.ts:7 as an aside.');
    await control.handle(ME, 'start_walkthrough', { title: '税率の変更', steps: [step(), step({ start_line: 12, end_line: undefined, title: '切り捨て' })] });
    await control.handle(ME, 'show_code', { path: 'src/tax.ts', start_line: 15, end_line: 16, body: '呼び出し元' });
    expect(text(await control.handle(ME, 'walkthrough_status', {}))).toContain('The user is viewing src/tax.ts:15-16, which you showed as an aside (going back returns to 1/2).');
  });

  it('画面からの操作は、ウォークスルーの無いセッション・ステップの無いもの・整数でない番号では何もしない', async () => {
    const { control, changes } = setup();
    control.go(ME, 0);
    control.close(ME);
    control.discard(ME);
    expect(changes).toEqual([]);
    // 寄り道だけ（ステップが無い）
    await control.handle(ME, 'show_code', { path: 'src/tax.ts', start_line: 7, body: 'ここ' });
    control.go(ME, 0);
    expect(control.get(ME)).toMatchObject({ aside: { startLine: 7 }, seq: 1 });
    await control.handle(ME, 'start_walkthrough', { title: 't', steps: [step(), step()] });
    const count = changes.length;
    control.go(ME, 1.5);
    control.go(ME, Number.NaN);
    expect(changes).toHaveLength(count);
    expect(control.get(ME)).toMatchObject({ current: 0 });
  });

  it('結果の文は英語で、画面の項目の名前（メニュー・ボタン・ソース管理）だけを画面の言語で入れる', async () => {
    try {
      setLanguage('en');
      expect(text(await setup(false).control.handle(ME, 'walkthrough_status', {}))).toBe(
        'The user has turned off "MCP > Walkthroughs" in the tanacode menu. Ask the user to turn it on.',
      );
      const { control } = setup();
      expect(text(await control.handle(ME, 'start_walkthrough', { title: 't', steps: [step(), step()] }))).toContain('with "Next" and "Back" at their own pace');
      expect(text(await control.handle(ME, 'show_code', { path: 'src/tax.ts', start_line: 7, body: 'x' }))).toContain('When the user clicks "Back to Walkthrough (1/2)", the editor returns to 1/2.');
      control.close(ME);
      expect(text(await control.handle(ME, 'walkthrough_status', {}))).toContain('it can be reopened from the list in "Source Control").');
    } finally {
      setLanguage('ja');
    }
  });

  it('断るときは isError を付ける', async () => {
    expect((await setup(false).control.handle(ME, 'walkthrough_status', {})).isError).toBe(true);
    expect((await setup().control.handle('other', 'walkthrough_status', {})).isError).toBe(true);
  });

  it('start_walkthrough の結果の文。作り直したときは、前のものを置き換えたと書く（寄り道だけのものは書かない）', async () => {
    const { control } = setup();
    await control.handle(ME, 'show_code', { path: 'src/tax.ts', start_line: 7, body: 'ここ' });
    expect(text(await control.handle(ME, 'start_walkthrough', { title: '税率', steps: [step(), step({ start_line: 12, end_line: undefined, title: '切り捨て' })] }))).toBe(
      // 「次へ」「戻る」のボタンの名前は、画面の言語で入れる
      'Started the walkthrough "税率" (2 steps). Opened 1/2 "税率を読む" (src/tax.ts:3-5) in the user\'s tanacode editor. The user moves through the steps with "次へ" and "戻る" at their own pace. Write only a short line in the chat, end your turn and wait for questions.',
    );
    expect(text(await control.handle(ME, 'start_walkthrough', { title: '作り直し', steps: [step()] }))).toContain(
      '(1 step). It replaced the previous walkthrough "税率". Opened 1/1',
    );
  });

  it('寄り道だけを示すと、題もステップも無い、開いたウォークスルーにする（Claude が動かしたもの）', async () => {
    const { control } = setup();
    await control.handle(ME, 'show_code', { path: 'src/tax.ts', start_line: 7, body: 'ここ' });
    expect(control.get(ME)).toMatchObject({ title: '', steps: [], open: true, current: 0, visited: [], movedBy: 'claude', seq: 1, startedAt: 1000 });
  });

  it('見たステップは番号の順に覚える。閉じるたびに seq を進める', async () => {
    const { control } = setup();
    await control.handle(ME, 'start_walkthrough', { title: 't', steps: [step(), step(), step()] });
    control.go(ME, 2);
    control.go(ME, 1);
    expect(control.get(ME)).toMatchObject({ visited: [0, 1, 2], seq: 3 });
    control.close(ME);
    expect(control.get(ME)).toMatchObject({ open: false, seq: 4 });
  });

  it('ステップは 40 個まで、題は 120 文字まで、本文は 4000 文字まで始められる', async () => {
    const { control } = setup();
    const many = Array.from({ length: 40 }, () => step({ body: 'あ'.repeat(4000) }));
    expect((await control.handle(ME, 'start_walkthrough', { title: 'あ'.repeat(120), steps: many })).isError).toBeUndefined();
    expect(control.get(ME)!.steps).toHaveLength(40);
  });

  it('ステップの path の前後の空白は除き、view は "file" も渡せる。null のステップ・title の無いステップは断る', async () => {
    const { control } = setup();
    await control.handle(ME, 'start_walkthrough', { title: 't', steps: [step({ path: ' src/tax.ts ', view: 'file' })] });
    expect(control.get(ME)!.steps[0]).toMatchObject({ path: 'src/tax.ts', view: 'file' });
    const r = await control.handle(ME, 'start_walkthrough', { title: 't', steps: [null, step({ title: undefined })] });
    expect(text(r).split('\n').slice(1)).toEqual(['Step 1: Pass path.', 'Step 2: Pass title.']);
  });

  it('list: ウォークスルーのあるセッションと、その中身を返す', async () => {
    const { control } = setup();
    await control.handle(ME, 'start_walkthrough', { title: 't', steps: [step()] });
    expect(control.list()).toEqual([{ sessionId: ME, walkthrough: control.get(ME) }]);
  });

  it('PR に載せたものを覚える。forget は画面に知らせずに捨てる（セッションを一覧から消したとき）', async () => {
    const { control, changes } = setup();
    expect(control.postedUrl('w1')).toBeNull();
    control.markPosted('w1', 'https://github.com/me/repo/pull/1#issuecomment-1');
    expect(control.postedUrl('w1')).toBe('https://github.com/me/repo/pull/1#issuecomment-1');
    await control.handle(ME, 'start_walkthrough', { title: 't', steps: [step()] });
    const count = changes.length;
    control.forget(ME);
    expect(control.get(ME)).toBeNull();
    expect(control.list()).toEqual([]);
    expect(changes).toHaveLength(count);
  });
});

describe('中継・起動の引数・設定', () => {
  it('tools/list: 示すツールと読むツールに readOnlyHint を付ける（ファイルは書き換えない）。PR への投稿は、外に書き込むことを示す', async () => {
    const deps = { server: WALKTHROUGH_MCP, version: '1', call: async () => textResult('ok') };
    const init = await respond({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, deps);
    expect(init?.result).toMatchObject({ serverInfo: { name: 'tanacode-walkthrough' } });
    expect((init?.result as { instructions: string }).instructions).toContain('start_walkthrough');
    const list = await respond({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, deps);
    const tools = (list?.result as { tools: { name: string; annotations: { readOnlyHint: boolean; openWorldHint: boolean } }[] }).tools;
    expect(Object.fromEntries(tools.map((t) => [t.name, t.annotations]))).toMatchObject({
      start_walkthrough: { readOnlyHint: true, openWorldHint: false },
      show_code: { readOnlyHint: true, openWorldHint: false },
      walkthrough_status: { readOnlyHint: true, openWorldHint: false },
      post_walkthrough: { readOnlyHint: false, openWorldHint: true },
    });
  });

  it('起動の引数に足し、PR への投稿のほかは許可済みにする（投稿は Claude Code の許可の確認を通す）', () => {
    const launch = { command: '/Apps/tanacode Helper', script: '/Apps/out/main/walkthrough-mcp.js', socketPath: '/u/walkthrough.sock', version: '1.0.0' };
    const checklist = { ...launch, script: '/Apps/out/main/checklist-mcp.js', socketPath: '/u/checklist.sock' };
    const args = claudeArgs({ claudeSessionId: 'c1', resume: false, remoteControlName: null, model: null, effort: null, permissionMode: null, checklist, walkthrough: launch, sessionId: 's1' });
    // --mcp-config と --allowedTools は 1 回ずつ
    expect(args.filter((a) => a === '--mcp-config')).toHaveLength(1);
    const config = JSON.parse(args[args.indexOf('--mcp-config') + 1]) as { mcpServers: Record<string, { env: Record<string, string> }> };
    expect(Object.keys(config.mcpServers)).toEqual(['tanacode-checklist', 'tanacode-walkthrough']);
    // 言語は、中継が tools/list で返すツールの短い名前に使う
    expect(config.mcpServers['tanacode-walkthrough'].env).toMatchObject({ TANACODE_WALKTHROUGH_SOCKET: '/u/walkthrough.sock', TANACODE_WALKTHROUGH_SESSION: 's1', TANACODE_LANGUAGE: 'ja' });
    const allowed = args[args.indexOf('--allowedTools') + 1].split(',');
    expect(allowed).toEqual(expect.arrayContaining(allowedToolIds(WALKTHROUGH_MCP)));
    expect(allowedToolIds(WALKTHROUGH_MCP)).toHaveLength(WALKTHROUGH_MCP.tools.length - 1);
    expect(allowed).toContain(walkthroughToolId('start_walkthrough'));
    expect(allowed).not.toContain(walkthroughToolId('post_walkthrough'));
  });

  it('メニューのオン・オフは既定でオンで、保存される', () => {
    const file = join(dir, 'settings.json');
    expect(new AppSettings(file).walkthroughControlEnabled()).toBe(true);
    new AppSettings(file).setWalkthroughControlEnabled(false);
    expect(new AppSettings(file).walkthroughControlEnabled()).toBe(false);
  });
});

describe('チャットの表示と質問の文', () => {
  it('ツールの行の対象と、押したときに開くもの', () => {
    const start = walkthroughToolId('start_walkthrough');
    const show = walkthroughToolId('show_code');
    expect(walkthroughTarget(start, { title: '税率の変更', steps: [{}, {}] }, '/r')).toBe('税率の変更 · 2 ステップ');
    expect(walkthroughTarget(show, { path: '/r/src/tax.ts', start_line: 3, end_line: 5 }, '/r')).toBe('src/tax.ts:3-5');
    expect(walkthroughTarget(show, { path: 'src/tax.ts', start_line: 3 }, '/r')).toBe('src/tax.ts:3');
    expect(walkthroughTarget('Read', { file_path: '/r/a' }, '/r')).toBeNull();
    expect(walkthroughOfTool(start, '{}')).toEqual({ kind: 'walkthrough' });
    expect(walkthroughOfTool(show, JSON.stringify({ path: 'src/tax.ts', start_line: 3 }))).toEqual({ kind: 'code', path: 'src/tax.ts', line: 3 });
    expect(walkthroughOfTool(walkthroughToolId('walkthrough_status'), '{}')).toBeNull();
    expect(walkthroughOfTool(show, 'not json')).toBeNull();
  });

  it('質問の文に、見ている場所と選んだコードを添える', async () => {
    const { control } = setup();
    await control.handle(ME, 'start_walkthrough', { title: '税率の変更', steps: [step(), step({ start_line: 12, end_line: undefined, title: '切り捨て' })] });
    control.go(ME, 1);
    const w = control.get(ME)!;
    expect(stepQuestionText(w, ' なぜ？ ')).toBe('ウォークスルー「税率の変更」の 2/2「切り捨て」（src/tax.ts:12）について質問です。\n\nなぜ？');
    expect(stepQuestionText({ ...w, aside: { path: 'src/a.ts', startLine: 1, endLine: 2, title: '', body: '', view: 'file' } }, 'これは？')).toContain('寄り道で示した src/a.ts:1-2 について');
    expect(rangeQuestionText('src/a.ts', 4, 4, 'const x = 1;', 'なぜ 1？')).toBe('src/a.ts:4 について質問です。\n```\nconst x = 1;\n```\n\nなぜ 1？');
    // コードに ``` があれば、囲みを長くする
    expect(rangeQuestionText('a.md', 1, 3, '```js\nx\n```', '?')).toContain('````\n```js');
    expect(restartRequestText(w)).toContain('2/2 から先を start_walkthrough で示し直して');
  });
});
