import { expect, it } from 'vitest';
import { toChatEvents, type TranscriptEntry } from '../src/shared/chat';

// 会話ログの行からチャットのイベントを作る（toChatEvents）。
// 控えの会話ログ（test/fixtures/claude-code/<バージョン>/transcript.jsonl）に出てこない行を、Claude Code 2.1.292 が書く形で組み立てて読む

const CWD = '/work/app';
const TIME = '2026-10-07T09:00:00.000Z';
const AT = Date.parse(TIME);
// どの行にも付く項目（アプリは読まない）
const common = { sessionId: 'sess', cwd: CWD, version: '2.1.292', gitBranch: 'main', userType: 'external', isSidechain: false, timestamp: TIME };
const user = (uuid: string, content: string, extra: Record<string, unknown> = {}) =>
  ({ ...common, type: 'user', uuid, parentUuid: null, message: { role: 'user', content }, ...extra }) as TranscriptEntry;
const assistant = (uuid: string, content: unknown[], extra: Record<string, unknown> = {}) =>
  ({
    ...common,
    type: 'assistant',
    uuid,
    parentUuid: null,
    message: { id: `msg_${uuid}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content },
    ...extra,
  }) as TranscriptEntry;

it('サブエージェントの行（isSidechain）は本体の会話に出さず、サブエージェントの会話ログを読むときだけ出す', () => {
  const side = { isSidechain: true, agentId: 'a0f8965e7704b6639' };
  const prompt = user('s1', '画面の読み取りを調べてください', side);
  const reply = assistant('s2', [{ type: 'text', text: '調べました' }], side);
  expect(toChatEvents(prompt, CWD)).toEqual([]);
  expect(toChatEvents(reply, CWD)).toEqual([]);
  expect(toChatEvents(prompt, CWD, true)).toEqual([{ type: 'user', id: 's1', text: '画面の読み取りを調べてください', at: AT }]);
  expect(toChatEvents(reply, CWD, true)).toEqual([{ type: 'assistant-text', id: 's2:0', text: '調べました', at: AT }]);
});

it('思考の本文があれば thinking のイベントにし（前後の改行は除く）、本文が空（署名だけ）なら出さない', () => {
  const thinking = (text: string) => assistant('m1', [{ type: 'thinking', thinking: text, signature: 'CAQSlgYKEAgSGAI4AUIIdGhpbmtpbmc' }]);
  expect(toChatEvents(thinking('\nどのファイルから読むか考えています\n'), CWD)).toEqual([{ type: 'thinking', id: 'm1:0', text: 'どのファイルから読むか考えています' }]);
  expect(toChatEvents(thinking(''), CWD)).toEqual([]);
});

it('再開したときに Claude Code が差し込む <synthetic> の埋め合わせは出さない。<synthetic> でも API エラーの文は出す', () => {
  const synthetic = (text: string, extra: Record<string, unknown> = {}) => {
    const entry = assistant('m1', [{ type: 'text', text }], extra);
    entry.message!.model = '<synthetic>';
    return entry;
  };
  expect(toChatEvents(synthetic('No response requested.'), CWD)).toEqual([]);
  expect(toChatEvents(synthetic('API Error: 400 invalid request', { isApiErrorMessage: true }), CWD)).toEqual([
    { type: 'api-error', id: 'm1', text: 'API Error: 400 invalid request', retrying: false },
  ]);
});

it('待機中に届いた別の Claude からの知らせ（origin が peer の isMeta の行）は、ターンの始まりだけを伝える', () => {
  const peer = user('p1', 'Another Claude session sent a message:\n<agent-message from="a689fff9e26ff86f0">\n調べた結果です\n</agent-message>', {
    isMeta: true,
    origin: { kind: 'peer', from: 'a689fff9e26ff86f0', senderTaskId: 'a689fff9e26ff86f0', name: 'general-purpose', handback: true },
    promptSource: 'system',
    turnOrigin: 'peer',
  });
  expect(toChatEvents(peer, CWD)).toEqual([{ type: 'turn-start' }]);
  // サブエージェントの会話ログでは、ターンは始まらない
  expect(toChatEvents(peer, CWD, true)).toEqual([]);
  // 出どころの無い isMeta の行（Claude 向けの補足）は、何も出さない
  expect(toChatEvents(user('p2', '<system-reminder>補足</system-reminder>', { isMeta: true }), CWD)).toEqual([]);
});

it('! を付けて実行したシェルのコマンドと出力を、発言ではなく shell・shell-output のイベントにする', () => {
  // 今の Claude Code は、コマンドと出力を別の行に書く
  expect(toChatEvents(user('b1', '<bash-input>echo tanacode-shell</bash-input>'), CWD)).toEqual([
    { type: 'shell', id: 'b1', command: 'echo tanacode-shell', output: '' },
  ]);
  expect(toChatEvents(user('b2', '<bash-stdout>tanacode-shell</bash-stdout><bash-stderr></bash-stderr>'), CWD)).toEqual([
    { type: 'shell-output', id: 'b2', output: 'tanacode-shell' },
  ]);
  expect(toChatEvents(user('b3', '<bash-stdout></bash-stdout><bash-stderr>ls: missing: No such file or directory\n</bash-stderr>'), CWD)).toEqual([
    { type: 'shell-output', id: 'b3', output: 'ls: missing: No such file or directory' },
  ]);
  // 前の Claude Code は、コマンドと出力を同じ行に書く
  expect(toChatEvents(user('b4', '<bash-input>ls</bash-input><bash-stdout>a.ts\nb.ts</bash-stdout><bash-stderr>warning</bash-stderr>'), CWD)).toEqual([
    { type: 'shell', id: 'b4', command: 'ls', output: 'a.ts\nb.ts\nwarning' },
  ]);
});

it('CI の自動修正の知らせは、PR の番号と見つけたものを短く出し、全文は開いて読めるようにする', () => {
  const event = (id: string, body: string) => toChatEvents(user(id, `<ci-monitor-event>\n${body}\n</ci-monitor-event>`), CWD);
  const enabled = 'Auto-fix pull requests was just enabled for PR #42 in sny-tanaka/tanacode.';
  expect(event('c1', enabled)).toEqual([{ type: 'notice', id: 'c1', text: 'CI の自動修正（PR #42）: 有効になりました', detail: enabled }]);
  // 2 段落目の最初の文が、何を見つけたか
  const watching = 'Auto-fix pull requests is watching PR #42 in sny-tanaka/tanacode.';
  const comment = `${watching}\n\nYour PR #42 has 1 new review comment (quoted below). Address it.\n\n> テストの名前を直してください`;
  expect(event('c2', comment)).toEqual([{ type: 'notice', id: 'c2', text: 'CI の自動修正（PR #42）: 新しいレビューコメント 1 件', detail: comment }]);
  const comments = `${watching}\n\nYour PR #42 has 12 new review comments (quoted below). Address them.`;
  expect(event('c3', comments)).toEqual([{ type: 'notice', id: 'c3', text: 'CI の自動修正（PR #42）: 新しいレビューコメント 12 件', detail: comments }]);
  // そのほかの知らせは、見つけたものの文をそのまま出す
  const failed = `${watching}\n\nYour PR #42 has a failing check (test). Fix it.`;
  expect(event('c4', failed)).toEqual([{ type: 'notice', id: 'c4', text: 'CI の自動修正（PR #42）: has a failing check (test).', detail: failed }]);
  // Claude の作業中に届いたもの（attachment の queued_command。origin が無い）も、同じお知らせにする
  const queued = {
    ...common,
    type: 'attachment',
    uuid: 'c5',
    attachment: { type: 'queued_command', commandMode: 'prompt', prompt: `<ci-monitor-event>\n${enabled}\n</ci-monitor-event>` },
  } as TranscriptEntry;
  expect(toChatEvents(queued, CWD)).toEqual([{ type: 'notice', id: 'c5', text: 'CI の自動修正（PR #42）: 有効になりました', detail: enabled }]);
});

it('スケジュールタスクの起動は、タスクの名前を出し、全文は開いて読めるようにする', () => {
  const body = '毎朝の確認です。\n昨日からの PR を読んで、まとめてください。';
  expect(toChatEvents(user('t1', `<scheduled-task name="毎朝の確認">\n${body}\n</scheduled-task>`), CWD)).toEqual([
    { type: 'notice', id: 't1', text: 'スケジュールタスク「毎朝の確認」の実行', detail: body },
  ]);
  expect(toChatEvents(user('t2', `<scheduled-task>\n${body}\n</scheduled-task>`), CWD)).toEqual([{ type: 'notice', id: 't2', text: 'スケジュールタスクの実行', detail: body }]);
});

it('TodoWrite の一覧を tool-use の todos に載せる。ほかのツールには載せない', () => {
  const todos = [
    { content: '控えの画面を読む', status: 'completed', activeForm: '控えの画面を読んでいます' },
    { content: 'テストを足す', status: 'in_progress', activeForm: 'テストを足しています' },
  ];
  const [todoWrite] = toChatEvents(assistant('m1', [{ type: 'tool_use', id: 'toolu_todo', name: 'TodoWrite', input: { todos } }]), CWD);
  expect(todoWrite).toMatchObject({ type: 'tool-use', id: 'toolu_todo', name: 'TodoWrite', todos });
  const [other] = toChatEvents(assistant('m2', [{ type: 'tool_use', id: 'toolu_task', name: 'TaskCreate', input: { subject: 'テストを足す', todos } }]), CWD);
  expect(other).toMatchObject({ type: 'tool-use', name: 'TaskCreate', todos: undefined, taskChange: { kind: 'create', subject: 'テストを足す' } });
});
