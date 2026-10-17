import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checklistToolId } from '../src/shared/checklist-tools';
import { CHECKLIST_SESSION_ENV, CHECKLIST_SOCKET_ENV, checklistHookEnv, checklistHookEvent, checklistHookRequest } from '../src/main/checklist-bridge';
import { CHECKLIST_HOOK_COMMAND, checklistHooks, hasLine, hookOutput, readTail, runHook, settledScan, turnActivity, preCompactBlock } from '../src/main/checklist-hook';
import { McpBridge, textResult } from '../src/main/mcp-bridge';

// チェックリストを使い続けさせるフック（src/main/checklist-hook.ts）。会話ログからツールを数え、アプリに聞いて、Claude Code に返す。
// 何を渡すか・止めるかは test/checklist-reminder.test.ts、本物の Claude Code での動きは test/cli/checklist-hooks.test.ts

// 会話ログの行。親（parentUuid）は link でつなぐ
type Entry = Record<string, unknown>;
const prompt = (text: string, extra: Entry = {}): Entry => ({ type: 'user', message: { role: 'user', content: text }, ...extra });
const use = (...names: string[]): Entry => ({ type: 'assistant', message: { content: [{ type: 'text', text: 'やります' }, ...names.map((name) => ({ type: 'tool_use', name }))] } });
const result = (): Entry => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't' }] } });
const say = (text: string, extra: Entry = {}): Entry => ({ type: 'assistant', message: { content: [{ type: 'text', text }] }, ...extra });
// 起きた順に並べた行に、uuid（u1, u2, …）を振って、前の行を親にする
const link = (...entries: Entry[]): Entry[] => entries.map((entry, i) => ({ uuid: `u${i + 1}`, parentUuid: i ? `u${i}` : null, ...entry }));
const text = (entries: Entry[]) => entries.map((e) => `${JSON.stringify(e)}\n`).join('');
const log = (...entries: Entry[]) => text(link(...entries));
const CARD_CHECK = checklistToolId('card_check');

describe('会話ログからツールを数える', () => {
  it('このターン（最後の発言のあと）のツールと、そのうちチェックリストのツールを数える。前のターンは数えない', () => {
    expect(turnActivity(log(prompt('前の依頼'), use('Edit', CARD_CHECK), result(), prompt('今の依頼'), use('Read', 'Bash'), result(), use(CARD_CHECK), result(), use('Edit')))).toMatchObject({ turn: 3, checklist: 1 });
  });

  it('Claude Code が足した行（isMeta・圧縮の要約・会話ログだけの行）とサブエージェントの行は、発言にもツールにも数えない', () => {
    const main = link(
      prompt('依頼'),
      use('Edit'),
      prompt('要約', { isCompactSummary: true }),
      prompt('メタ', { isMeta: true }),
      prompt('ログだけ', { isVisibleInTranscriptOnly: true }),
      use('Write'),
      { type: 'assistant', message: { content: [{ type: 'tool_use' }] } },
      { type: 'system' },
    );
    // サブエージェントの行は、本体の行を親にしていても、本体のつながりには入らない。親の無い行（file-history-delta など）・壊れた行は読み飛ばす
    const side = { uuid: 's1', parentUuid: 'u2', type: 'assistant', isSidechain: true, message: { content: [{ type: 'tool_use', name: 'Bash' }] } };
    const lines = [...main.slice(0, 5).map((e) => JSON.stringify(e)), JSON.stringify(side), JSON.stringify({ type: 'file-history-delta' }), '', '{ 壊れた行', ...main.slice(5).map((e) => JSON.stringify(e))];
    expect(turnActivity(lines.join('\n'))).toMatchObject({ turn: 2, checklist: 0 });
    expect(turnActivity('')).toEqual({ turn: 0, checklist: 0, since: null, settled: false });
  });

  it('文と画像の発言（ツールの結果を含まない配列）も、ターンのはじまりにする', () => {
    const image = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '画像つきの発言' }] } };
    expect(turnActivity(log(prompt('前'), use('Edit'), image, use('Read')))).toMatchObject({ turn: 1, checklist: 0 });
  });

  it('別の Claude からの知らせ（isMeta で origin が peer）で始まったターンは、前のターンのツールを数えない', () => {
    // 待機中の Claude Code は、サブエージェントやほかのセッションからの知らせで続きを始める。2.1.296
    const peer = prompt('サブエージェントの報告', { isMeta: true, origin: { kind: 'peer' } });
    // 知らせを受けて、ツールを使わずに返事だけした
    expect(turnActivity(log(prompt('依頼'), use('Edit'), result(), say('頼みました'), peer, say('報告を読みました')))).toMatchObject({ turn: 0, checklist: 0 });
    // 前のターンでチェックリストに触れていても、知らせのターンで触れずにツールを使えば、触れていない
    expect(turnActivity(log(prompt('依頼'), use(CARD_CHECK), result(), peer, use('Read'), result()))).toMatchObject({ turn: 1, checklist: 0 });
    // 出どころの無い isMeta の行（止めた理由など）は、はじまりにしない
    expect(turnActivity(log(prompt('依頼'), use('Edit'), result(), prompt('Stop hook feedback', { isMeta: true }), use('Read')))).toMatchObject({ turn: 2 });
  });

  it('行の順番ではなく、親をたどって数える（最初の応答の行が、発言の行より先に書かれていても数える）', () => {
    // Claude Code は、最初の応答の行を、発言の行（とそれに続く attachment の行）より先に書くことがある。2.1.296
    const [ask, attached, first, done1, second, done2, answer] = link(prompt('依頼'), { type: 'attachment' }, use('Write'), result(), use('Write'), result(), say('作業を終えました'));
    const written = text([first, ask, attached, done1, second, done2, answer]);
    expect(turnActivity(written, '作業を終えました')).toMatchObject({ turn: 2, checklist: 0, settled: true });
    expect(turnActivity(written)).toMatchObject({ turn: 2, checklist: 0, settled: false });
  });

  it('最後の応答が書かれていて、ターンのはじまりまで親がつながっていれば、そろっている。ターンのはじまりの時刻も返す', () => {
    const at = '2026-10-12T01:39:11.884Z';
    const lines = link(prompt('依頼', { timestamp: at }), use('Edit'), result(), say('直しました。\n確かめてください'));
    // 空白の違いは見ない
    expect(turnActivity(text(lines), ' 直しました。 確かめてください ')).toEqual({ turn: 1, checklist: 0, since: Date.parse(at), settled: true });
    // 最後の応答がまだ書かれていない。読めた分は、いちばん後ろの行からたどって数える
    expect(turnActivity(text(lines.slice(0, 3)), '直しました。 確かめてください')).toEqual({ turn: 1, checklist: 0, since: Date.parse(at), settled: false });
    // 最後の応答は書かれたが、その前の行（ツールを使った応答）がまだ書かれていない。たどれたいちばん前の行の時刻を返す
    const answered = '2026-10-12T01:40:00.000Z';
    expect(turnActivity(text([lines[0], { ...lines[3], timestamp: answered }]), '直しました。 確かめてください')).toEqual({ turn: 0, checklist: 0, since: Date.parse(answered), settled: false });
    // 最後の応答の文が分からない（古い Claude Code・文の無い応答）ときは、数えるだけ。時刻の無いはじまりは null
    expect(turnActivity(text(lines))).toEqual({ turn: 1, checklist: 0, since: Date.parse(at), settled: false });
    expect(turnActivity(log(prompt('依頼', { timestamp: '時刻でない' }), say('はい')), 'はい')).toEqual({ turn: 0, checklist: 0, since: null, settled: true });
  });

  it('同じ文の応答がいくつもあれば、いちばん新しいものからたどる。読んだ範囲より前に親があるときは、そこまでで数え終える', () => {
    const lines = link(
      prompt('依頼'),
      use('Edit'),
      result(),
      say('はい', { timestamp: '2026-10-12T01:00:00.000Z' }),
      prompt('次の依頼'),
      say('はい', { timestamp: '2026-10-12T01:05:00.000Z' }),
    );
    expect(turnActivity(text(lines), 'はい')).toMatchObject({ turn: 0, settled: true });
    // 会話ログの終わりの部分だけを読んだ（読んだ範囲より長いターン）。親が読んだ範囲より前にあるなら、まだ書かれていないのではない
    const long = link(prompt('依頼'), use('Edit'), result(), use('Bash'), result(), say('終わりました'));
    expect(turnActivity(text(long.slice(3)), '終わりました', (uuid) => uuid === 'u3')).toMatchObject({ turn: 1, since: null, settled: true });
    expect(turnActivity(text(long.slice(3)), '終わりました', () => false)).toMatchObject({ turn: 1, since: null, settled: false });
    expect(turnActivity(text(long.slice(3)), '終わりました')).toMatchObject({ turn: 1, since: null, settled: false });
  });
});

describe('会話ログが最後の応答まで書かれるのを待つ', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tanacode-checklist-hook-'));
    file = join(dir, 'log.jsonl');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('最後の応答がもう書かれていれば、待たずに数える', async () => {
    writeFileSync(file, log(prompt('依頼'), use('Edit'), result(), say('直しました')));
    const started = Date.now();
    expect(await settledScan(file, '直しました', 5000)).toMatchObject({ turn: 1, checklist: 0, settled: true });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('最後に使ったツールの行がまだ書かれていなければ、書かれるのを待ってから数える', async () => {
    // Claude Code は、応答の行を、その応答が終わってから書く。フックが動いた時点では、最後の応答（とその前のツール）がまだ無いことがある
    const lines = link(prompt('依頼'), use('Edit', 'Bash'), result(), say('終わりました'));
    writeFileSync(file, text(lines.slice(0, 1)));
    const late = settledScan(file, '終わりました', 5000);
    // 最後の応答が先に書かれても、その前の行がそろうまで待つ
    setTimeout(() => appendFileSync(file, text(lines.slice(3))), 40);
    setTimeout(() => appendFileSync(file, text(lines.slice(1, 3))), 120);
    expect(await late).toMatchObject({ turn: 2, checklist: 0, settled: true });
  });

  it('このターンの行がまだ 1 つも書かれていなければ、前のターンのツールを数えて早合点せず、書かれるのを待つ', async () => {
    // 前のターンでチェックリストに触れた。このターン（読んだだけ）の行は、フックが動いた時点ではまだ無い
    const lines = link(prompt('前の依頼'), use('Edit', CARD_CHECK), result(), say('直しました'), prompt('次の依頼'), use('Read'), result(), say('読みました'));
    writeFileSync(file, text(lines.slice(0, 4)));
    const scan = settledScan(file, '読みました', 5000);
    setTimeout(() => appendFileSync(file, text(lines.slice(4))), 60);
    expect(await scan).toMatchObject({ turn: 1, checklist: 0, settled: true });
  });

  it('1 ターンが読む範囲（終わりの 4MB）より長いときは、親が前にあるのを確かめて、待たずに読めた分を数える', async () => {
    const lines = link(prompt('依頼'), use('Edit'), result(), use('Bash'), result(), say('終わりました'));
    // ツールの結果（画像など）で、ターンの途中の行が 4MB を超えた
    const big = { ...lines[2], pad: 'x'.repeat(4 * 1024 * 1024 + 1000) };
    writeFileSync(file, text([lines[0], lines[1], big, ...lines.slice(3)]));
    const started = Date.now();
    expect(await settledScan(file, '終わりました', 5000)).toMatchObject({ turn: 1, checklist: 0, settled: true });
    expect(Date.now() - started).toBeLessThan(2000);
    // 親がどこにも無い（まだ書かれていない）なら、待つ
    writeFileSync(file, text([lines[0], { ...big, uuid: 'ほかの行' }, ...lines.slice(3)]));
    expect(await settledScan(file, '終わりました', 100)).toMatchObject({ turn: 1, settled: false });
    // つなぎ目（1MB ごと）にまたがっていても見つける
    writeFileSync(file, `${' '.repeat(1024 * 1024 - 10)}{"uuid":"またがる行"}\n`);
    expect(hasLine(file, 'またがる行')).toBe(true);
    expect(hasLine(file, '無い行')).toBe(false);
    expect(hasLine(join(dir, 'ありません.jsonl'), 'x')).toBe(false);
  });

  it('上限まで待ってもそろわなければ、読めた分を数えて、そろわなかったと返す。最後の応答の文が分からなければ、待たない', async () => {
    writeFileSync(file, log(prompt('依頼'), use('Edit'), result()));
    const started = Date.now();
    expect(await settledScan(file, '終わりました', 150)).toMatchObject({ turn: 1, checklist: 0, settled: false });
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    const again = Date.now();
    expect(await settledScan(file, undefined, 5000)).toMatchObject({ turn: 1, settled: false });
    expect(await settledScan(join(dir, 'ありません.jsonl'), undefined, 5000)).toMatchObject({ turn: 0, settled: false });
    expect(Date.now() - again).toBeLessThan(1000);
  });
});

describe('会話ログの終わりを読む', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'tanacode-checklist-hook-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('小さければ全部、大きければ終わりの部分だけを読み、途中から始まる行は捨てる。読めなければ空', () => {
    const file = join(dir, 'log.jsonl');
    writeFileSync(file, 'いちばん上の行\n2 行め\n3 行め\n');
    expect(readTail(file)).toBe('いちばん上の行\n2 行め\n3 行め\n');
    expect(readTail(file, 14)).toBe('3 行め\n');
    expect(readTail(join(dir, 'ありません.jsonl'))).toBe('');
  });
});

describe('Claude Code に返すもの', () => {
  it('どれも文を Claude のコンテキストに足す。Stop も、止める（decision: block）のではなく文を渡して続けさせる', () => {
    // block は Claude Code 2.1.302 でエラー（hookErrors）になり、ターミナルモードの画面に赤い「Stop hook error」と通知が出る。
    // Stop の additionalContext は「Stop hook feedback」として続きを始めさせ、続きのフックの入力には stop_hook_active が付く（2.1.293 からある）
    expect(JSON.parse(hookOutput('Stop', '直して'))).toEqual({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: '直して' } });
    expect(JSON.parse(hookOutput('UserPromptSubmit', '今の状態'))).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '今の状態' } });
  });

  it('設定には、人の発言・ターンの終わり・圧縮のあとの 3 つを足す。コマンドには、チャットに出さないための目印を付ける', () => {
    const hooks = [{ type: 'command', command: CHECKLIST_HOOK_COMMAND, timeout: 10 }];
    expect(checklistHooks()).toEqual({ UserPromptSubmit: [{ hooks }], Stop: [{ hooks }], SessionStart: [{ matcher: 'compact', hooks }], PreCompact: [{ matcher: 'auto', hooks }] });
    expect(CHECKLIST_HOOK_COMMAND).toBe('TANACODE_CHECKLIST_HOOK=1 ELECTRON_RUN_AS_NODE=1 "$TANACODE_CHECKLIST_COMMAND" "$TANACODE_CHECKLIST_SCRIPT" --hook');
  });

  it('フックが使う環境変数と、アプリへの呼び出しの名前', () => {
    const launch = { command: '/Apps/tanacode Helper', script: '/Apps/out/main/checklist-mcp.js', socketPath: '/u/checklist.sock', version: '1.0.0' };
    expect(checklistHookEnv(launch, 's1')).toEqual({
      [CHECKLIST_SOCKET_ENV]: '/u/checklist.sock',
      [CHECKLIST_SESSION_ENV]: 's1',
      TANACODE_CHECKLIST_COMMAND: '/Apps/tanacode Helper',
      TANACODE_CHECKLIST_SCRIPT: '/Apps/out/main/checklist-mcp.js',
    });
    for (const event of ['prompt', 'stop', 'compact'] as const) expect(checklistHookEvent(checklistHookRequest(event))).toBe(event);
    expect(checklistHookEvent('hook:other')).toBeNull();
    expect(checklistHookEvent('card_add')).toBeNull();
  });
});

describe('フックの本体', () => {
  let dir: string;
  let bridge: McpBridge;
  let calls: { session: string; tool: string; args: Record<string, unknown> }[];
  let answer: () => ReturnType<typeof textResult>;
  let socket: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tanacode-checklist-hook-'));
    calls = [];
    answer = () => textResult('今のチェックリスト');
    bridge = new McpBridge(join(dir, 'c.sock'), async (session, tool, args) => {
      calls.push({ session, tool, args });
      return answer();
    });
    await bridge.start();
    socket = bridge.socketPath;
  });
  afterEach(() => {
    bridge.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const transcript = (...entries: Entry[]) => {
    const file = join(dir, 'log.jsonl');
    writeFileSync(file, log(...entries));
    return file;
  };
  const run = (input: Record<string, unknown>) => runHook(JSON.stringify(input), socket, 'S1', 2000);

  it('人の発言と圧縮のあとは、アプリが返した文をコンテキストに足す', async () => {
    expect(JSON.parse(await run({ hook_event_name: 'UserPromptSubmit' }))).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '今のチェックリスト' } });
    expect(JSON.parse(await run({ hook_event_name: 'SessionStart' }))).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '今のチェックリスト' } });
    expect(calls).toEqual([
      { session: 'S1', tool: 'hook:prompt', args: { turn: 0, checklist: 0 } },
      { session: 'S1', tool: 'hook:compact', args: { turn: 0, checklist: 0 } },
    ]);
  });

  it('ターンの終わりは、会話ログから数えたツールをアプリに渡し、返ってきた文で止める', async () => {
    const at = '2026-10-12T01:39:11.884Z';
    const transcript_path = transcript(prompt('依頼', { timestamp: at }), use('Edit', 'Bash'), result(), say('終わりました'));
    expect(JSON.parse(await run({ hook_event_name: 'Stop', transcript_path, last_assistant_message: '終わりました' }))).toEqual({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: '今のチェックリスト' } });
    // ターンのはじまりの時刻と、会話ログが最後の応答までそろっているのを確かめたことも渡す
    expect(calls).toEqual([{ session: 'S1', tool: 'hook:stop', args: { turn: 2, checklist: 0, since: Date.parse(at), settled: true } }]);
  });

  it('最後の応答が会話ログに書かれないままなら、上限まで待ってから、そろわなかったことをアプリに伝える', async () => {
    // 最後の応答（とその前のツール）がまだ書かれていない。アプリは、自分が受けた呼び出しでも確かめる
    const transcript_path = transcript(prompt('依頼'), use('Edit'), result());
    expect(JSON.parse(await runHook(JSON.stringify({ hook_event_name: 'Stop', transcript_path, last_assistant_message: '終わりました' }), socket, 'S1', 2000, 100))).toMatchObject({ hookSpecificOutput: { hookEventName: 'Stop' } });
    // 最後の応答の文が渡らない（古い Claude Code）ときも、そろったか分からないものとして伝える
    await run({ hook_event_name: 'Stop', transcript_path });
    expect(calls.map((c) => c.args)).toEqual([
      { turn: 1, checklist: 0, since: null, settled: false },
      { turn: 1, checklist: 0, since: null, settled: false },
    ]);
  });

  it('止めたあとの続き・チェックリストに触れたターン・ツールを使っていないターンは、アプリに聞かずに通す', async () => {
    const worked = transcript(prompt('依頼'), use('Edit'));
    expect(await run({ hook_event_name: 'Stop', transcript_path: worked, stop_hook_active: true })).toBe('');
    expect(await run({ hook_event_name: 'Stop', transcript_path: transcript(prompt('依頼'), use('Edit', CARD_CHECK)) })).toBe('');
    expect(await run({ hook_event_name: 'Stop', transcript_path: transcript(prompt('質問')) })).toBe('');
    expect(await run({ hook_event_name: 'Stop' })).toBe('');
    expect(calls).toEqual([]);
  });

  it('アプリが何も返さない・エラーを返す・文でないものを返す・つながらないときは、何も出さない', async () => {
    answer = () => textResult('');
    expect(await run({ hook_event_name: 'UserPromptSubmit' })).toBe('');
    answer = () => textResult('失敗しました', true);
    expect(await run({ hook_event_name: 'UserPromptSubmit' })).toBe('');
    answer = () => ({ content: [{ type: 'image', data: '', mimeType: 'image/png' }] });
    expect(await run({ hook_event_name: 'UserPromptSubmit' })).toBe('');
    answer = () => ({ content: [] });
    expect(await run({ hook_event_name: 'UserPromptSubmit' })).toBe('');
    socket = join(dir, 'ありません.sock');
    expect(await run({ hook_event_name: 'UserPromptSubmit' })).toBe('');
  });

  it('圧縮の前（PreCompact・auto）: アプリに聞いて、止める理由が返ったら、それを返す（入口が、終了コード 2 で圧縮を止める）', async () => {
    answer = () => textResult('tanacode resets the conversation');
    const ask = (input: Record<string, unknown>) => preCompactBlock(JSON.stringify(input), socket, 'S1', 2000);
    expect(await ask({ hook_event_name: 'PreCompact', trigger: 'auto' })).toBe('tanacode resets the conversation');
    expect(calls).toEqual([{ session: 'S1', tool: 'hook:precompact', args: {} }]);
    // アプリが止めないと答えた（自動がオフ・使えない・休んでいる）
    answer = () => textResult('');
    expect(await ask({ hook_event_name: 'PreCompact', trigger: 'auto' })).toBeNull();
    // 人が打った /compact は止めない。ほかのフック・読めない入力では、アプリに聞かない
    calls = [];
    expect(await ask({ hook_event_name: 'PreCompact', trigger: 'manual' })).toBeNull();
    expect(await ask({ hook_event_name: 'Stop' })).toBeNull();
    expect(await preCompactBlock('{ 壊れた入力', socket, 'S1', 2000)).toBeNull();
    expect(calls).toEqual([]);
    // アプリに聞けないときは、止めない（Claude Code の圧縮に任せる）
    socket = join(dir, 'ありません.sock');
    expect(await ask({ hook_event_name: 'PreCompact', trigger: 'auto' })).toBeNull();
    // ふつうのフックの本体は、圧縮の前のフックでは何も出さない
    expect(await run({ hook_event_name: 'PreCompact', trigger: 'auto' })).toBe('');
  });

  it('知らないイベント・読めない入力は、何も出さない', async () => {
    expect(await run({ hook_event_name: 'PreToolUse' })).toBe('');
    expect(await run({})).toBe('');
    expect(await runHook('{ 壊れた入力', socket, 'S1', 2000)).toBe('');
    expect(calls).toEqual([]);
  });
});
