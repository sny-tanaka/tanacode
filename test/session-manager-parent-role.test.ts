import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parentRoleText, parseParentRole, PARENT_INSTRUCTIONS_FILE } from '@shared/project-instructions';
import { line, ScriptedApp, type ScriptedPty } from './helpers/scripted-claude';

// 「親にする」（SessionManager の parentInstructions・becomeParent・withParentRole）と、TANACODE.md を渡すフックの材料の渡し方。
// TANACODE_PARENT.md は、押したときに 1 回だけ、tanacode からの発言として読ませる（親の状態は覚えない）

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
  it('セッションのフォルダの直下の TANACODE_PARENT.md。子のセッション・一覧に無いセッション・ファイルが無ければ null', async () => {
    const { id } = await idleSession();
    expect(app.manager.parentInstructions(id)).toBeNull();
    putRules();
    expect(app.manager.parentInstructions(id)).toEqual({ path: join(app.cwd, PARENT_INSTRUCTIONS_FILE), content: RULES });
    const { id: child } = await idleSession(id);
    expect(app.manager.parentInstructions(child)).toBeNull();
    expect(app.manager.parentInstructions('none')).toBeNull();
  });
});

describe('becomeParent', () => {
  it('TANACODE_PARENT.md を、囲みに入れた発言として送る。チャットでは知らせとして出る', async () => {
    const { id, pipe } = await idleSession();
    putRules();
    await app.manager.becomeParent(id);
    expect(pipe.prompts).toHaveLength(1);
    const sent = parseParentRole(sentText(pipe.prompts[0]));
    expect(sent).toMatchObject({ path: join(app.cwd, PARENT_INSTRUCTIONS_FILE), rest: '' });
    expect(sent!.body).toContain(RULES.trim());
    // 順番待ち・送信中の表示にも出す（ボタンで頼んだものなので）
    expect(queue(id)).toMatchObject([{ text: '親にする（TANACODE_PARENT.md を読ませる）', state: 'sending' }]);
    app.append(id, { ...line.user(sentText(pipe.prompts[0])), uuid: (pipe.prompts[0] as { uuid: string }).uuid });
    await app.waitFor('知らせが出る', () => app.events(id).some((e) => e.type === 'notice' && e.text === 'TANACODE_PARENT.md を読ませて、親のセッションにしました'));
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
    expect(app.manager.parentInstructions(id)).toEqual({ path: join(app.cwd, PARENT_INSTRUCTIONS_FILE), problem: 'empty' });
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
    expect(pty.writes[0].startsWith('\u001b[200~<tanacode-parent-role path=')).toBe(true);
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
    expect(parseParentRole(text)).toMatchObject({ path: join(app.cwd, PARENT_INSTRUCTIONS_FILE), rest: 'ログイン画面を作って' });
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
    pipe.answers.set('rewind_conversation', { rewound: true, prefillText: parentRoleText(join(app.cwd, PARENT_INSTRUCTIONS_FILE), RULES) });
    expect(await app.manager.rewind(id, first, { conversation: true, code: false })).toEqual({ ok: true, prefillText: null, error: null });
  });
});

describe('TANACODE.md を渡すフック', () => {
  it('起動したとき、TANACODE.md があるのに使えない（大きすぎる・読めない）なら、渡していないことをチャットに出す。空なら出さない', async () => {
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
