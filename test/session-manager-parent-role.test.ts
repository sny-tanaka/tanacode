import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parentRoleText, parseParentRole, PARENT_INSTRUCTIONS_FILE } from '@shared/project-instructions';
import { transcriptPath } from '../src/main/claude-session';
import { line, ScriptedApp, stream, type ScriptedPty } from './helpers/scripted-claude';

// 「親にする」（SessionManager の parentInstructions・becomeParent・withParentRole）と、TANACODE.md を渡すフックの材料の渡し方。
// TANACODE_PARENT.md は、押したときに 1 回だけ、tanacode からの発言として読ませる。押さずに子を始めた親には、start_session の結果で 1 回だけ渡す

let app: ScriptedApp;
beforeEach(() => {
  app = new ScriptedApp({ instructionsHook: () => ({ command: '/Apps/tanacode Helper', script: '/x/instructions-hook.js' }) });
});
afterEach(() => {
  app.dispose();
});

const RULES = '# 親の決まり\n子に任せて、自分は見張る\n';
const putRules = (dir = app.cwd) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, PARENT_INSTRUCTIONS_FILE), RULES);
};
const infos = (id: string) => app.events(id).flatMap((e) => (e.type === 'info' ? [e] : []));
const queue = (id: string) => {
  const last = [...app.events(id)].reverse().find((e) => e.type === 'queue');
  return last?.type === 'queue' ? last.prompts : [];
};
const sentText = (prompt: unknown) => (prompt as { message: { content: string } }).message.content;

async function idleSession(parentId: string | null = null) {
  const { id, pipe } = app.create({}, parentId);
  await app.ready(id);
  return { id, pipe };
}

describe('parentInstructions', () => {
  it('プロファイルのフォルダとセッションのフォルダの直下の TANACODE_PARENT.md（プロファイル → フォルダの順）。子のセッション・一覧に無いセッション・どこにも無ければ空', async () => {
    const { id } = await idleSession();
    expect(app.manager.parentInstructions(id)).toEqual([]);
    putRules();
    expect(app.manager.parentInstructions(id)).toEqual([{ path: join(app.cwd, PARENT_INSTRUCTIONS_FILE), content: RULES }]);
    // 既定のプロファイルなら、Claude Code の設定のフォルダは ~/.claude
    putRules(join(app.home, '.claude'));
    expect(app.manager.parentInstructions(id).map((file) => file.path)).toEqual([join(app.home, '.claude', PARENT_INSTRUCTIONS_FILE), join(app.cwd, PARENT_INSTRUCTIONS_FILE)]);
    const { id: child } = await idleSession(id);
    expect(app.manager.parentInstructions(child)).toEqual([]);
    expect(app.manager.parentInstructions('none')).toEqual([]);
  });
});

describe('becomeParent', () => {
  it('TANACODE_PARENT.md を、囲みに入れた発言として送る。チャットでは知らせとして出る', async () => {
    const { id, pipe } = await idleSession();
    putRules();
    await app.manager.becomeParent(id);
    expect(pipe.prompts).toHaveLength(1);
    const sent = parseParentRole(sentText(pipe.prompts[0]));
    expect(sent).toMatchObject({ files: [{ path: join(app.cwd, PARENT_INSTRUCTIONS_FILE) }], rest: '' });
    expect(sent!.body).toContain(RULES.trim());
    // 順番待ち・送信中の表示にも出す（ボタンで頼んだものなので）
    expect(queue(id)).toMatchObject([{ text: '親にする（TANACODE_PARENT.md を読ませる）', state: 'sending' }]);
    app.append(id, { ...line.user(sentText(pipe.prompts[0])), uuid: (pipe.prompts[0] as { uuid: string }).uuid });
    await app.waitFor('知らせが出る', () => app.events(id).some((e) => e.type === 'notice' && e.text === 'TANACODE_PARENT.md を読ませて、親のセッションにしました'));
  });

  it('プロファイルのフォルダとセッションのフォルダの両方にあれば、両方を 1 つの発言で読ませる（プロファイル → フォルダの順）', async () => {
    const { id, pipe } = await idleSession();
    putRules();
    mkdirSync(join(app.home, '.claude'), { recursive: true });
    writeFileSync(join(app.home, '.claude', PARENT_INSTRUCTIONS_FILE), 'プロファイルの親の決まり');
    await app.manager.becomeParent(id);
    const sent = parseParentRole(sentText(pipe.prompts[0]));
    expect(sent?.files.map((file) => file.path)).toEqual([join(app.home, '.claude', PARENT_INSTRUCTIONS_FILE), join(app.cwd, PARENT_INSTRUCTIONS_FILE)]);
    expect(sent!.body.indexOf('プロファイルの親の決まり')).toBeLessThan(sent!.body.indexOf(RULES.trim()));
    // プロファイルのものだけでも押せる
    rmSync(join(app.cwd, PARENT_INSTRUCTIONS_FILE));
    await app.manager.becomeParent(id);
    expect(parseParentRole(sentText(pipe.prompts[1]))?.files.map((file) => file.path)).toEqual([join(app.home, '.claude', PARENT_INSTRUCTIONS_FILE)]);
    // 空のものは除いて読ませる。大きすぎる・読めないものがあれば、一部だけを黙って読ませず、わけを投げる
    writeFileSync(join(app.cwd, PARENT_INSTRUCTIONS_FILE), '');
    await app.manager.becomeParent(id);
    expect(parseParentRole(sentText(pipe.prompts[2]))?.files.map((file) => file.path)).toEqual([join(app.home, '.claude', PARENT_INSTRUCTIONS_FILE)]);
    writeFileSync(join(app.cwd, PARENT_INSTRUCTIONS_FILE), 'x'.repeat(1024 * 1024 + 1));
    await expect(app.manager.becomeParent(id)).rejects.toThrow('が大きすぎる（1MB を超える）ので、Claude に渡していません');
    expect(pipe.prompts).toHaveLength(3);
  });

  it('今の作業が終わってから届くように送る（priority: later。作業中に押しても、今のターンの途中には入らない）。押すたびに 1 回ずつ送る', async () => {
    const { id, pipe } = await idleSession();
    putRules();
    app.say(id, line.user('はじめ'), line.text('考えています'));
    await app.waitFor('作業中', () => app.manager.stateOf(id) === 'working');
    await app.manager.becomeParent(id);
    await app.manager.becomeParent(id);
    expect(pipe.prompts.map((p) => parseParentRole(sentText(p))?.rest)).toEqual(['', '']);
    expect(pipe.prompts.map((p) => (p as { priority?: string }).priority)).toEqual(['later', 'later']);
  });

  it('ファイルが無い・使えない・子のセッション・Claude Code が動いていないときは送らず、それぞれのわけを投げる', async () => {
    const { id, pipe } = await idleSession();
    await expect(app.manager.becomeParent(id)).rejects.toThrow('TANACODE_PARENT.md が見つかりません。セッションのフォルダに置くと使えます');
    writeFileSync(join(app.cwd, PARENT_INSTRUCTIONS_FILE), ' \n');
    await expect(app.manager.becomeParent(id)).rejects.toThrow(`${join(app.cwd, PARENT_INSTRUCTIONS_FILE)} が空なので、Claude に渡していません`);
    // 使えなくても、ボタンは押せる（押すとわけを出す）ので、パスは返す
    expect(app.manager.parentInstructions(id)).toEqual([{ path: join(app.cwd, PARENT_INSTRUCTIONS_FILE), problem: 'empty' }]);
    putRules();
    const { id: child, pipe: childPipe } = await idleSession(id);
    await expect(app.manager.becomeParent(child)).rejects.toThrow('子のセッションは親にできません');
    expect(pipe.prompts).toEqual([]);
    expect(childPipe.prompts).toEqual([]);
    pipe.exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
    await expect(app.manager.becomeParent(id)).rejects.toThrow('Claude Code が動いていません');
  });

  it('ターミナルモードでは、TUI の入力欄に貼る（Enter は人が押す）。確認のメニューを出している間は貼らず、わけを投げる', async () => {
    const { id } = await idleSession();
    await app.prompt(id, 'はじめ');
    app.say(id, line.text('はい'));
    app.finish(id);
    await app.waitFor('ターンの終わり', () => app.manager.stateOf(id) === 'idle');
    putRules();
    await app.manager.setTerminalMode(id, true);
    const pty = app.host.spawned.at(-1) as ScriptedPty;
    await app.manager.becomeParent(id);
    expect(pty.writes).toHaveLength(1);
    expect(pty.writes[0].startsWith('\u001b[200~<tanacode-parent-role>\n')).toBe(true);
    expect(pty.writes[0].endsWith('</tanacode-parent-role>\u001b[201~')).toBe(true);
    app.manager.permissionRequested(id, { tool_name: 'Bash', tool_input: { command: 'ls' } }, Date.now());
    await expect(app.manager.becomeParent(id)).rejects.toThrow('Claude Code が確認・質問を出している間は、入力欄に貼れません');
    expect(pty.writes).toHaveLength(1);
  });
});

describe('withParentRole（新規セッションの画面の「親として始める」）', () => {
  it('最初の指示の前に、TANACODE_PARENT.md を付ける', async () => {
    const { id } = await idleSession();
    putRules();
    const text = app.manager.withParentRole(id, 'ログイン画面を作って');
    expect(parseParentRole(text)).toMatchObject({ files: [{ path: join(app.cwd, PARENT_INSTRUCTIONS_FILE) }], rest: 'ログイン画面を作って' });
    expect(infos(id)).toEqual([]);
  });

  it('始めるまでにファイルが無くなっていた・使えなくなっていたら、指示だけにして、読ませられなかったことをチャットに出す', async () => {
    const { id } = await idleSession();
    putRules();
    rmSync(join(app.cwd, PARENT_INSTRUCTIONS_FILE));
    expect(app.manager.withParentRole(id, 'ログイン画面を作って')).toBe('ログイン画面を作って');
    expect(infos(id)).toMatchObject([{ text: 'TANACODE_PARENT.md が見つからなかったので、親としては始めず、最初の指示だけを送りました', warning: true }]);
    writeFileSync(join(app.cwd, PARENT_INSTRUCTIONS_FILE), 'x'.repeat(1024 * 1024 + 1));
    expect(app.manager.withParentRole(id, 'ログイン画面を作って')).toBe('ログイン画面を作って');
    expect(infos(id).at(-1)).toMatchObject({
      text: `${join(app.cwd, PARENT_INSTRUCTIONS_FILE)} が大きすぎる（1MB を超える）ので、Claude に渡していません。親としては始めず、最初の指示だけを送りました`,
      warning: true,
    });
  });

  it('「ここまで戻す」で「親として始める」の指示を戻すと、入力欄には人が打った指示だけを戻す', async () => {
    const { id, pipe } = await idleSession();
    putRules();
    const first = await app.prompt(id, app.manager.withParentRole(id, 'ログイン画面を作って'));
    app.say(id, { ...line.text('はい'), parentUuid: first });
    app.finish(id);
    await app.waitFor('待機中', () => app.manager.stateOf(id) === 'idle');
    pipe.answers.set('rewind_conversation', { rewound: true, prefillText: app.manager.withParentRole(id, 'ログイン画面を作って') });
    expect(await app.manager.rewind(id, first, { conversation: true, code: false })).toEqual({ ok: true, prefillText: 'ログイン画面を作って', error: null });
    // 「親にする」だけの発言を戻したときは、入力欄に何も戻さない
    pipe.answers.set('rewind_conversation', { rewound: true, prefillText: parentRoleText([{ path: join(app.cwd, PARENT_INSTRUCTIONS_FILE), content: RULES }]) });
    expect(await app.manager.rewind(id, first, { conversation: true, code: false })).toEqual({ ok: true, prefillText: null, error: null });
  });
});

describe('takeParentRules（「親にする」を押さずに子を始めた親に、start_session の結果で渡す）', () => {
  it('今の会話でまだ受け取っていなければ 1 回だけ渡す。2 本目の子では渡さない', async () => {
    const { id } = await idleSession();
    putRules();
    expect(app.manager.takeParentRules(id)).toEqual([{ path: join(app.cwd, PARENT_INSTRUCTIONS_FILE), content: RULES }]);
    expect(app.manager.takeParentRules(id)).toBeNull();
  });

  it('渡したことは記録に残し、アプリを起動し直しても繰り返さない', () => {
    const record = (id: string, extra: object) => ({ id, claudeSessionId: id, cwd: '', title: null, titlePriority: 0, archived: false, createdAt: 1, updatedAt: 1, ...extra });
    const given = '11111111-0000-4000-8000-000000000001';
    const fresh = '22222222-0000-4000-8000-000000000002';
    const restarted = new ScriptedApp({ records: [record(given, { parentRules: true }), record(fresh, {})] });
    try {
      putRules(restarted.cwd);
      expect(restarted.manager.takeParentRules(given)).toBeNull();
      expect(restarted.manager.takeParentRules(fresh)).not.toBeNull();
    } finally {
      restarted.dispose();
    }
  });

  it('「親にする」「親として始める」で受け取った親には、重ねて渡さない', async () => {
    putRules();
    const { id } = await idleSession();
    await app.manager.becomeParent(id);
    expect(app.manager.takeParentRules(id)).toBeNull();
    const { id: started } = await idleSession();
    app.manager.withParentRole(started, 'ログイン画面を作って');
    expect(app.manager.takeParentRules(started)).toBeNull();
  });

  it('ターミナルモードで入力欄に貼っただけ（送るのは人）なら、受け取ったことにしない', async () => {
    const { id } = await idleSession();
    await app.prompt(id, 'はじめ');
    app.say(id, line.text('はい'));
    app.finish(id);
    await app.waitFor('ターンの終わり', () => app.manager.stateOf(id) === 'idle');
    putRules();
    await app.manager.setTerminalMode(id, true);
    await app.manager.becomeParent(id);
    expect(app.manager.takeParentRules(id)).not.toBeNull();
  });

  it('ファイルが無い・使えないときは何もしない（あとで置けば、次に子を始めたときに渡す）。子のセッションには渡さない', async () => {
    const { id } = await idleSession();
    expect(app.manager.takeParentRules(id)).toBeNull();
    writeFileSync(join(app.cwd, PARENT_INSTRUCTIONS_FILE), ' \n');
    expect(app.manager.takeParentRules(id)).toBeNull();
    putRules();
    const { id: child } = await idleSession(id);
    expect(app.manager.takeParentRules(child)).toBeNull();
    expect(app.manager.takeParentRules(id)).not.toBeNull();
  });

  it('「ここまで戻す」で会話を戻したら、次に子を始めたときにもう一度渡す（戻した先に残っていても、重なるほうに倒す）', async () => {
    const { id, pipe } = await idleSession();
    putRules();
    const first = await app.prompt(id, app.manager.withParentRole(id, 'ログイン画面を作って'));
    app.say(id, { ...line.text('はい'), parentUuid: first });
    app.finish(id);
    await app.waitFor('待機中', () => app.manager.stateOf(id) === 'idle');
    expect(app.manager.takeParentRules(id)).toBeNull();
    // 戻せなかったときは、そのまま
    pipe.answers.set('rewind_conversation', { rewound: false, reason: 'turn_running' });
    expect((await app.manager.rewind(id, first, { conversation: true, code: false })).ok).toBe(false);
    expect(app.manager.takeParentRules(id)).toBeNull();
    pipe.answers.set('rewind_conversation', { rewound: true, prefillText: app.manager.withParentRole(id, 'ログイン画面を作って') });
    expect((await app.manager.rewind(id, first, { conversation: true, code: false })).ok).toBe(true);
    expect(app.manager.takeParentRules(id)).not.toBeNull();
    expect(app.manager.takeParentRules(id)).toBeNull();
  });

  it('会話を消したら（/clear・最適化圧縮で会話ログが替わる）、次に子を始めたときにもう一度渡す', async () => {
    const { id, pipe } = await idleSession();
    putRules();
    expect(app.manager.takeParentRules(id)).not.toBeNull();
    const next = '66666666-0000-4000-8000-000000000006';
    mkdirSync(dirname(transcriptPath(app.cwd, next)), { recursive: true });
    writeFileSync(transcriptPath(app.cwd, next), `${JSON.stringify({ ...line.user('新しい会話'), sessionId: next, cwd: app.cwd })}\n`);
    pipe.emit(stream.init(next));
    await app.waitFor('乗り換え', () => app.events(id).some((e) => e.type === 'reset'));
    expect(app.manager.takeParentRules(id)).not.toBeNull();
    expect(app.manager.takeParentRules(id)).toBeNull();
  });
});

describe('TANACODE.md を渡すフック', () => {
  it('起動する Claude Code に、プロファイルのフォルダも環境変数で渡す（そこの TANACODE.md も渡すため）', async () => {
    const { pipe } = await idleSession();
    expect(pipe.request.env.TANACODE_INSTRUCTIONS_PROFILE).toBe(join(app.home, '.claude'));
  });

  it('起動したとき、TANACODE.md（プロファイル・フォルダ）があるのに使えない（大きすぎる・読めない）なら、渡していないことをチャットに出す。空なら出さない', async () => {
    const big = join(app.cwd, 'TANACODE.md');
    writeFileSync(big, 'x'.repeat(1024 * 1024 + 1));
    const { id } = await idleSession();
    expect(infos(id)).toMatchObject([{ text: `${big} が大きすぎる（1MB を超える）ので、Claude に渡していません`, warning: true }]);
    writeFileSync(big, '');
    const { id: other } = await idleSession();
    expect(infos(other)).toEqual([]);
  });

  it('起動する Claude Code に、フックの設定と、探すフォルダ・実行ファイルの環境変数を渡す（子のセッションにも）', async () => {
    const { id, pipe } = await idleSession();
    const settings = (p: typeof pipe) => JSON.parse(p.arg('--settings')!) as { hooks: { SessionStart?: { matcher: string; hooks: { command: string }[] }[] } };
    expect(settings(pipe).hooks.SessionStart?.[0]).toMatchObject({ matcher: 'startup|resume|clear|compact' });
    expect(pipe.request.env).toMatchObject({
      TANACODE_INSTRUCTIONS_COMMAND: '/Apps/tanacode Helper',
      TANACODE_INSTRUCTIONS_SCRIPT: '/x/instructions-hook.js',
      TANACODE_INSTRUCTIONS_DIRS: JSON.stringify([app.cwd]),
    });
    const { pipe: child } = await idleSession(id);
    expect(settings(child).hooks.SessionStart?.[0].hooks[0].command).toContain('TANACODE_INSTRUCTIONS_HOOK=1');
  });
});
