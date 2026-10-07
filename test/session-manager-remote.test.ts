import { afterEach, describe, expect, it } from 'vitest';
import { fixtureScreen, line, ScriptedApp, type ScriptedOptions, type ScriptedPty } from './helpers/scripted-claude';

// Remote Control（スマホから続ける）。起動の引数・/remote-control での切り替え・指定と実際のつながりのずれを合わせる（SessionManager）。
// 本物の claude の代わりに、テストが /remote-control の画面と、会話ログのつながりの行（bridge_status・bridge-session）を書く

let app: ScriptedApp;
const start = (options: ScriptedOptions = {}) => (app = new ScriptedApp(options));
afterEach(() => app.dispose());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// /remote-control でつないだ・切ったあとに出る知らせ（入力欄の上に出る）
const ACTIVE = `${fixtureScreen('prompt')}\x1b[10;1H  ⎿  /remote-control is active · https://claude.ai/code/session_abc`;
const DISCONNECTED = `${fixtureScreen('prompt')}\x1b[10;1H  ⎿  Remote Control disconnected`;
// /remote-control のメニュー（選択肢だけ。操作説明は無い）
const menu = (...rows: string[]) => `\x1b[H\x1b[2J${rows.map((row, i) => `\x1b[${i + 3};1H${row}`).join('')}`;

// 会話ログのつながりの行
const bridgeStatus = (url: string) => ({ ...line.turnEnd(), subtype: 'bridge_status', url });
const bridgeSession = (bridgeSessionId: string) => ({ ...line.turnEnd(), type: 'bridge-session', subtype: undefined, bridgeSessionId });

// Claude Code の /remote-control の代わり。打ったコマンドのあとの Enter に、screens を順に描いて答える（Enter のたびに 1 つ）
function answerRemote(pty: ScriptedPty, screens: (command: string) => string[]): string[] {
  const commands: string[] = [];
  let queue: string[] = [];
  pty.onWrite = (data) => {
    if (data.startsWith('/remote-control')) {
      commands.push(data);
      queue = screens(data);
      return;
    }
    if (data === '\x1b') setTimeout(() => pty.output(fixtureScreen('prompt')), 10);
    if (data !== '\r' || queue.length === 0) return;
    const next = queue.shift()!;
    setTimeout(() => pty.output(next), 10);
  };
  return commands;
}

const remoteEvents = (id: string) => app.events(id).filter((e) => e.type === 'remote-control');

describe('起動の引数', () => {
  it('指定があれば --remote-control <tanacode-フォルダ名> で起動し、つながったら URL をチャットに出す', async () => {
    start();
    const { id, pty } = app.create({ remoteControl: true });
    expect(pty.arg('--remote-control')).toBe('tanacode-work');
    expect(app.manager.summary(id)?.remoteControl).toBe(true);
    expect(app.manager.remoteAvailable()).toBe(true);
    await app.ready(id);
    app.append(id, bridgeStatus('https://claude.ai/code/session_abc'));
    await app.waitFor('つながり', () => remoteEvents(id).length > 0);
    expect(remoteEvents(id)).toEqual([{ type: 'remote-control', url: 'https://claude.ai/code/session_abc' }]);
    // もうつながっているので、切り替えても何も打たない
    expect(await app.manager.setRemoteControl(id, true)).toBeNull();
    expect(pty.typed).toBe('');
  });

  it('指定が無ければ付けない', () => {
    start();
    const { id, pty } = app.create({ remoteControl: false });
    expect(pty.arg('--remote-control')).toBeNull();
    expect(app.manager.summary(id)?.remoteControl).toBe(false);
  });

  it('開発版（Remote Control を使えない）では、指定があっても付けず、切り替えも断る', async () => {
    start({ remoteControlAvailable: false });
    const { id, pty } = app.create({ remoteControl: true });
    expect(pty.arg('--remote-control')).toBeNull();
    expect(app.manager.summary(id)?.remoteControl).toBe(false);
    expect(app.manager.remoteAvailable()).toBe(false);
    expect(await app.manager.setRemoteControl(id, true)).toContain('開発版では使えません');
  });

  it('再開したときは、前に起動した claude のつながり（読み直した過去の行）を出さない', async () => {
    start();
    const { id } = app.create({ remoteControl: true });
    await app.ready(id);
    app.append(id, line.user('はじめ'), bridgeStatus('https://claude.ai/code/session_old'), line.text('はい'), line.turnEnd());
    await app.waitFor('ターンの終わり', () => app.events(id).some((e) => e.type === 'turn-end'));
    app.manager.restart(id);
    expect(app.pty(id).arg('--remote-control')).toBe('tanacode-work');
    // 起動し直したあとのイベント（読み直した過去の行から作ったもの）
    const since = () => app.manager.snapshot(id).events;
    await app.waitFor('読み直し', () => since().some((e) => e.type === 'turn-end'));
    await sleep(300);
    expect(since().some((e) => e.type === 'user')).toBe(true);
    expect(since().filter((e) => e.type === 'remote-control')).toEqual([]);
  });
});

describe('setRemoteControl', () => {
  it('知らないセッションは断る。止まっているセッションは指定だけ変え、次に起動するときに使う', async () => {
    start();
    expect(await app.manager.setRemoteControl('nope', true)).toBe('セッションが見つかりません');
    const { id, pty } = app.create({ remoteControl: false });
    pty.exit(0);
    await app.waitFor('終了', () => app.manager.stateOf(id) === 'exited');
    expect(await app.manager.setRemoteControl(id, true)).toBeNull();
    expect(app.manager.summary(id)?.remoteControl).toBe(true);
    await app.manager.open(id);
    expect(app.pty(id).arg('--remote-control')).toBe('tanacode-work');
  });

  it('動いていれば /remote-control <名前> を打ってつなぎ、bridge_status が届いたらつながったことにする', async () => {
    start();
    const { id, pty } = app.create({ remoteControl: false });
    await app.ready(id);
    const commands = answerRemote(pty, () => [ACTIVE]);
    expect(await app.manager.setRemoteControl(id, true)).toBeNull();
    expect(commands).toEqual(['/remote-control tanacode-work']);
    expect(app.manager.summary(id)?.remoteControl).toBe(true);
    app.append(id, bridgeStatus('https://claude.ai/code/session_new'));
    await app.waitFor('つながり', () => remoteEvents(id).length > 0);
    expect(remoteEvents(id).at(-1)).toEqual({ type: 'remote-control', url: 'https://claude.ai/code/session_new' });
    // つながったので、もう一度押しても何も打たない
    expect(await app.manager.setRemoteControl(id, true)).toBeNull();
    expect(commands).toHaveLength(1);
  });

  it('初めてつなぐときの確認（Enable Remote Control）が出たら、それを選ぶ。切り替えの途中のメニューは、操作待ちとして知らせない', async () => {
    start();
    const { id, pty } = app.create({ remoteControl: false });
    await app.ready(id);
    answerRemote(pty, () => [menu(' Remote Control lets you continue from your phone.', '', ' ❯ Enable Remote Control', '   Not now'), ACTIVE]);
    expect(await app.manager.setRemoteControl(id, true)).toBeNull();
    // メニューで Enter を選んだ（/remote-control の Enter と、メニューの Enter）
    expect(pty.writes.filter((w) => w === '\r')).toHaveLength(2);
    await app.waitFor('入力欄', () => app.manager.screen(id)?.state.kind === 'prompt');
    await sleep(200);
    expect(app.attentions).toEqual([]);
    expect(app.manager.summary(id)?.attention).toBeNull();
  });

  it('切るときは /remote-control のメニューで「Disconnect this session」を選ぶ', async () => {
    start();
    const { id, pty } = app.create({ remoteControl: true });
    await app.ready(id);
    app.append(id, bridgeStatus('https://claude.ai/code/session_abc'));
    await app.waitFor('つながり', () => remoteEvents(id).length > 0);
    const commands = answerRemote(pty, () => [menu(' Remote Control', '', ' ❯ Disconnect this session', '   Continue'), DISCONNECTED]);
    expect(await app.manager.setRemoteControl(id, false)).toBeNull();
    expect(commands).toEqual(['/remote-control']);
    expect(app.manager.summary(id)?.remoteControl).toBe(false);
    // 切れたことにしたので、もう一度押しても打たない
    expect(await app.manager.setRemoteControl(id, false)).toBeNull();
    expect(commands).toHaveLength(1);
  });

  it('質問や確認が出ている・入力欄に書きかけがあるときは、打たずに指定を戻して理由を返す', async () => {
    start();
    const { id, pty } = app.create({ remoteControl: false });
    await app.ready(id);
    pty.output(fixtureScreen('bash-permission'));
    await app.waitFor('許可の確認', () => app.manager.screen(id)?.state.kind === 'menu');
    expect(await app.manager.setRemoteControl(id, true)).toContain('質問や確認の答えを待っているため');
    expect(app.manager.summary(id)?.remoteControl).toBe(false);
    pty.output(fixtureScreen('draft'));
    await app.waitFor('書きかけ', () => !!app.manager.screen(id)?.draft && app.manager.screen(id)?.state.kind === 'prompt');
    expect(await app.manager.setRemoteControl(id, true)).toContain('書きかけの文字があるため');
    expect(app.manager.summary(id)?.remoteControl).toBe(false);
    expect(pty.typed).toBe('');
  });

  it('切り替えている途中にもう一度押すと断る。画面で切り替えられなければ、指定を戻して理由を返す', async () => {
    start();
    const { id, pty } = app.create({ remoteControl: false });
    await app.ready(id);
    // メニューは出るが、カーソルが「Enable Remote Control」に来ない（↑ を押しても動かない）
    const stuck = menu(' Remote Control lets you continue from your phone.', '', '   Enable Remote Control', ' ❯ Not now');
    answerRemote(pty, () => [stuck]);
    const prev = pty.onWrite!;
    pty.onWrite = (data) => {
      prev(data);
      if (data === '\x1b[A') setTimeout(() => pty.output(stuck), 10);
    };
    const first = app.manager.setRemoteControl(id, true);
    await app.waitFor('打ち始め', () => pty.typed.includes('/remote-control'));
    expect(await app.manager.setRemoteControl(id, true)).toContain('切り替えている途中です');
    expect(await first).toContain('画面で Remote Control を切り替えられませんでした');
    expect(app.manager.summary(id)?.remoteControl).toBe(false);
    // 思っていたメニューと違うので、Esc で閉じた
    expect(pty.writes.at(-1)).toBe('\x1b');
  }, 15_000);
});

describe('指定と実際のつながりを合わせる', () => {
  it('切る指定なのに Claude Code がつなぎ直したら（以前つないでいた会話の再開）、自分で切る', async () => {
    start();
    const { id, pty } = app.create({ remoteControl: false });
    await app.ready(id);
    const commands = answerRemote(pty, () => [menu(' Remote Control', '', ' ❯ Disconnect this session', '   Continue'), DISCONNECTED]);
    app.append(id, bridgeSession('cse_abc'));
    await app.waitFor('切る', () => commands.length === 1);
    expect(commands).toEqual(['/remote-control']);
    expect(remoteEvents(id)).toEqual([{ type: 'remote-control', url: 'https://claude.ai/code/session_abc' }]);
    await app.waitFor('メニューの選択', () => pty.writes.filter((w) => w === '\r').length === 2);
    await sleep(300);
    expect(commands).toHaveLength(1);
  });

  it('入力欄に書きかけがあるときは、合わせない（打った文字が書きかけの続きに入るため）', async () => {
    start();
    const { id, pty } = app.create({ remoteControl: false });
    await app.ready(id);
    pty.output(fixtureScreen('draft'));
    await app.waitFor('書きかけ', () => !!app.manager.screen(id)?.draft);
    app.append(id, bridgeStatus('https://claude.ai/code/session_abc'));
    await app.waitFor('つながり', () => remoteEvents(id).length === 1);
    await sleep(300);
    expect(pty.typed).toBe('');
  });

  it('つなぐ指定で切れたら、つなぎ直す。つなぎ直せなかったら、同じ向きには試し直さない', async () => {
    start();
    const { id, pty } = app.create({ remoteControl: true });
    await app.ready(id);
    app.append(id, bridgeStatus('https://claude.ai/code/session_abc'));
    await app.waitFor('つながり', () => remoteEvents(id).length === 1);
    const stuck = menu(' Remote Control lets you continue from your phone.', '', '   Enable Remote Control', ' ❯ Not now');
    const commands = answerRemote(pty, () => [stuck]);
    const prev = pty.onWrite!;
    pty.onWrite = (data) => {
      prev(data);
      if (data === '\x1b[A') setTimeout(() => pty.output(stuck), 10);
    };
    // 切れた（空の bridge-session）
    app.append(id, bridgeSession(''));
    await app.waitFor('つなぎ直し', () => commands.length === 1);
    expect(commands).toEqual(['/remote-control tanacode-work']);
    // うまくいかず Esc で閉じたあと、入力欄に戻っても、もう試さない
    await app.waitFor('あきらめ', () => pty.writes.at(-1) === '\x1b', 10_000);
    await sleep(300);
    pty.output(fixtureScreen('prompt'));
    await sleep(300);
    expect(commands).toHaveLength(1);
    // 指定は変えない（指定を変えたら、また試す）
    expect(app.manager.summary(id)?.remoteControl).toBe(true);
  }, 15_000);
});
