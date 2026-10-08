import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverSessions } from '../src/main/session-discovery';

// アプリの外（ターミナルの claude など）で作られた会話を ~/.claude/projects から探す（src/main/session-discovery.ts）。
// HOME を使い捨てのフォルダにして、Claude Code と同じ形の会話ログ（1 行 1 つの JSON）を置く

// 一覧を作ってから開くまでの間に消された会話ログを作るため、open だけを、名前を決めて失敗させられるようにする
const openFails = vi.hoisted(() => ({ name: null as string | null }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: (...args: Parameters<typeof actual.open>) =>
      openFails.name && String(args[0]).endsWith(openFails.name)
        ? Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
        : actual.open(...args),
  };
});

let root: string;
let projects: string;
const oldHome = process.env.HOME;

beforeEach(() => {
  openFails.name = null;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'tanacode-discovery-')));
  process.env.HOME = root;
  projects = join(root, '.claude', 'projects');
});

afterEach(() => {
  process.env.HOME = oldHome;
  rmSync(root, { recursive: true, force: true });
});

const user = (content: string, extra: Record<string, unknown> = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });
const lines = (...entries: unknown[]) => entries.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n';
// 会話ログを置く。seconds: 更新日時（新しい順に並ぶ）
const save = (dir: string, id: string, text: string, seconds = 1000) => {
  mkdirSync(join(projects, dir), { recursive: true });
  const file = join(projects, dir, `${id}.jsonl`);
  writeFileSync(file, text);
  utimesSync(file, seconds, seconds);
  return file;
};
const session = (cwd: string, first: string, ...rest: unknown[]) => lines({ type: 'system', cwd, sessionId: 'x' }, user(first, { cwd }), ...rest);

describe('会話ログを探す', () => {
  it('~/.claude/projects が無ければ空', async () => {
    await expect(discoverSessions(new Set())).resolves.toEqual([]);
  });

  it('フォルダごとの会話ログを、新しい順に並べる。ID はファイル名、フォルダは会話ログの cwd、タイトルは最初の発言、日時は更新日時', async () => {
    const older = save('-Users-me-cafe', 'aaaa-1111', session('/Users/me/cafe', 'メニューを直して\n2 行目'), 1000);
    const newer = save('-Users-me-shop', 'bbbb-2222', session('/Users/me/shop', '在庫の画面を作る'), 2000);
    await expect(discoverSessions(new Set())).resolves.toEqual([
      { claudeSessionId: 'bbbb-2222', cwd: '/Users/me/shop', title: '在庫の画面を作る', updatedAt: statSync(newer).mtimeMs },
      { claudeSessionId: 'aaaa-1111', cwd: '/Users/me/cafe', title: 'メニューを直して', updatedAt: statSync(older).mtimeMs },
    ]);
  });

  it('アプリが知っている会話・会話ログでないもの・空のもの・ファイルでないものは出さない', async () => {
    save('-p', 'known', session('/p', 'アプリで始めた会話'), 5000);
    save('-p', 'shown', session('/p', '外で始めた会話'), 4000);
    save('-p', 'empty', '', 3000);
    writeFileSync(join(projects, '-p', 'notes.txt'), session('/p', '会話ログでないもの'));
    mkdirSync(join(projects, '-p', 'folder.jsonl'));
    // リンク切れ（日時が読めない）
    symlinkSync(join(root, 'missing.jsonl'), join(projects, '-p', 'broken.jsonl'));
    // projects の直下のファイル（フォルダでない）
    writeFileSync(join(projects, 'stray.jsonl'), session('/p', '置き場所の違うもの'));
    const found = await discoverSessions(new Set(['known']));
    expect(found.map((s) => s.claudeSessionId)).toEqual(['shown']);
  });

  it('cwd の無い会話・発言の無い会話（起動しただけ）は、再開できないので出さない', async () => {
    save('-p', 'no-cwd', lines(user('cwd が無い')), 3000);
    save('-p', 'no-prompt', lines({ type: 'system', cwd: '/p' }, user('<command-name>/clear</command-name>', { cwd: '/p' }), user('メタ', { cwd: '/p', isMeta: true })), 2000);
    save('-p', 'ok', session('/p', 'これは出す'), 1000);
    await expect(discoverSessions(new Set())).resolves.toMatchObject([{ claudeSessionId: 'ok', title: 'これは出す', cwd: '/p' }]);
  });

  it('壊れた行は飛ばして読む。cwd は最初に出てきたもの', async () => {
    save('-p', 's', lines('{壊れた行', { type: 'system', cwd: '/first' }, '42', user('最初の発言', { cwd: '/second' })));
    await expect(discoverSessions(new Set())).resolves.toMatchObject([{ cwd: '/first', title: '最初の発言' }]);
  });

  it('一覧を作ってから開くまでの間に消えた会話ログは出さない', async () => {
    save('-p', 'gone', session('/p', '消える'), 2000);
    save('-p', 'kept', session('/p', '残る'), 1000);
    openFails.name = 'gone.jsonl';
    await expect(discoverSessions(new Set())).resolves.toMatchObject([{ claudeSessionId: 'kept' }]);
  });

  it('新しいものから 200 件まで', async () => {
    for (let i = 0; i < 201; i++) save('-p', `s${String(i).padStart(3, '0')}`, session('/p', `発言 ${i}`), 1000 + i);
    const found = await discoverSessions(new Set());
    expect(found).toHaveLength(200);
    expect(found[0].claudeSessionId).toBe('s200');
    expect(found.at(-1)?.claudeSessionId).toBe('s001');
  });
});

describe('タイトル', () => {
  it('発言は最初のもの。AI が付けたタイトルがあれば、その最新のもの。人が付けた名前（/rename）があれば、それを最優先', async () => {
    save('-p', 'first', session('/p', '最初の発言', user('2 つ目の発言')), 6000);
    save('-p', 'ai', session('/p', '最初の発言', { type: 'ai-title', aiTitle: '古い AI のタイトル' }, user('次'), { type: 'ai-title', aiTitle: '新しい AI のタイトル' }), 5000);
    save('-p', 'custom', session('/p', '最初の発言', { type: 'custom-title', customTitle: '人が付けた名前' }, { type: 'ai-title', aiTitle: 'あとの AI のタイトル' }), 4000);
    save('-p', 'renamed', session('/p', '最初の発言', { type: 'custom-title', customTitle: '前の名前' }, { type: 'custom-title', customTitle: '付け直した名前' }), 3000);
    const found = await discoverSessions(new Set());
    expect(Object.fromEntries(found.map((s) => [s.claudeSessionId, s.title]))).toEqual({
      first: '最初の発言',
      ai: '新しい AI のタイトル',
      custom: '人が付けた名前',
      renamed: '付け直した名前',
    });
  });

  it('書きかけの最後の行（改行で終わっていない）は使わない', async () => {
    save('-p', 's', session('/p', '最初の発言') + JSON.stringify({ type: 'custom-title', customTitle: '書きかけ' }));
    await expect(discoverSessions(new Set())).resolves.toMatchObject([{ title: '最初の発言' }]);
  });
});

describe('大きな会話ログ', () => {
  const CHUNK = 64 * 1024;
  const padding = (n: number) => lines(...Array.from({ length: n }, (_, i) => ({ type: 'assistant', message: { content: `${i} ${'x'.repeat(200)}` } })));

  it('先頭（cwd と最初の発言）と末尾（最新のタイトル）だけを読む。間にあるものは読まない', async () => {
    const text =
      session('/big', '大きな会話の最初の発言') +
      padding(400) +
      lines({ type: 'custom-title', customTitle: '間にある名前（読まない）' }) +
      padding(400) +
      lines({ type: 'ai-title', aiTitle: '末尾の AI のタイトル' });
    expect(Buffer.byteLength(text)).toBeGreaterThan(CHUNK * 2);
    save('-p', 'big', text);
    await expect(discoverSessions(new Set())).resolves.toMatchObject([{ claudeSessionId: 'big', cwd: '/big', title: '末尾の AI のタイトル' }]);
  });

  it('末尾は途中から読むので、読み始めの行は捨てる（行の後ろ半分を、別の行と取り違えない）', async () => {
    // 1 行の後ろ半分が、それだけで JSON として読める行。末尾を読み始める位置（size - 64KB）を、ちょうどその後ろ半分の始まりにする
    const fake = JSON.stringify({ type: 'custom-title', customTitle: '行の後ろ半分' });
    const head = session('/big', '最初の発言') + padding(400) + '{"pad":0} ';
    // 後ろ半分より後ろ（後ろ半分の行の改行と、そのあとの行）を、ちょうど 64KB にする
    const after = CHUNK - Buffer.byteLength(fake);
    const rest = `\n{"type":"assistant","pad":"${'x'.repeat(after - 1 - '{"type":"assistant","pad":""}\n'.length)}"}\n`;
    const text = head + fake + rest;
    const start = Buffer.byteLength(text) - CHUNK;
    expect(start).toBe(Buffer.byteLength(head));
    expect(Buffer.from(text).subarray(start, start + Buffer.byteLength(fake)).toString()).toBe(fake);
    save('-p', 'big', text);
    await expect(discoverSessions(new Set())).resolves.toMatchObject([{ title: '最初の発言' }]);
  });

  it('最初の発言が先頭の 64KB に無くても、末尾にあれば使う。間にしか無ければ出さない', async () => {
    const text = lines({ type: 'system', cwd: '/big' }) + padding(700) + lines(user('遅い発言', { cwd: '/big' }));
    expect(Buffer.byteLength(text)).toBeGreaterThan(CHUNK * 2);
    save('-p', 'late', text);
    await expect(discoverSessions(new Set())).resolves.toMatchObject([{ claudeSessionId: 'late', title: '遅い発言' }]);
    save('-p', 'late', lines({ type: 'system', cwd: '/big' }) + padding(700) + lines(user('遅い発言', { cwd: '/big' })) + padding(400));
    await expect(discoverSessions(new Set())).resolves.toEqual([]);
  });
});

describe('ファイル名', () => {
  it('ID は .jsonl を除いたファイル名', async () => {
    const file = save('-p', '5f1c2a9e-1b2c-4d5e-8f90-123456789abc', session('/p', '発言'));
    const [found] = await discoverSessions(new Set());
    expect(found.claudeSessionId).toBe(basename(file, '.jsonl'));
  });
});

describe('不具合（いまのコードで落ちる）', () => {
  // 会話ログの 1 行が、JSON としては読めてもオブジェクトでない（null）と、その行を読むところ（e.cwd・transcriptTitle の entry.type）で TypeError になり、
  // discoverSessions 全体が失敗する（会話を取り込むダイアログ（ImportDialog）が、ほかの会話も含めて何も出せず、「ありません」も出ないままになる）。
  // 「壊れた行は飛ばす」のつもりのところ。shared の isTranscriptEntry と同じく、オブジェクトでない行を飛ばすのがあるべき動き
  it('JSON としては読めても、オブジェクトでない行（null）は飛ばす。その 1 行のせいで、ほかの会話まで探せなくならない', async () => {
    save('-p', 'with-null', lines({ type: 'system', cwd: '/p' }, 'null', user('最初の発言', { cwd: '/p' })), 2000);
    save('-p', 'ok', session('/p', 'ほかの会話'), 1000);
    await expect(discoverSessions(new Set())).resolves.toMatchObject([
      { claudeSessionId: 'with-null', cwd: '/p', title: '最初の発言' },
      { claudeSessionId: 'ok', title: 'ほかの会話' },
    ]);
  });
});
