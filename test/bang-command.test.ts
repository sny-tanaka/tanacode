import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BANG_OUTPUT_CHARS, bangLines, findShellSnapshot, runBang, shellScript, type BangRun } from '../src/main/bang-command';

// 入力欄の「!」のコマンド（src/main/bang-command.ts）。本物のシェル（zsh・bash）で動かし、TUI の「!」と同じ形になるかを確かめる

let root: string;
let cwd: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'tanacode-bang-')));
  cwd = join(root, 'work');
  mkdirSync(join(cwd, 'sub'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const env = () => ({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: root, LANG: 'en_US.UTF-8' });
const run = (command: string, over: { shell?: string; snapshot?: string | null; signal?: AbortSignal; at?: string } = {}) =>
  runBang({ command, shell: over.shell ?? '/bin/zsh', cwd: over.at ?? cwd, env: env(), snapshot: over.snapshot ?? null, signal: over.signal });

describe('動かす', () => {
  it('標準出力と標準エラーを、出た順に 1 つにまとめる。標準入力は読めない（/dev/null）。終わったときの作業フォルダが分かる', async () => {
    const result = await run('echo one; echo two >&2; echo three; cat; cd sub');
    expect(result).toEqual({ output: 'one\ntwo\nthree\n', exitCode: 0, interrupted: false, cwd: join(cwd, 'sub') });
  });

  it('失敗したら終了コード。作業フォルダは分からない（成功したときだけ書く）', async () => {
    const result = await run('cd sub; echo out; echo err >&2; exit 3');
    expect(result).toEqual({ output: 'out\nerr\n', exitCode: 3, interrupted: false, cwd: null });
  });

  it('bash でも動く', async () => {
    // shopt はオプションがオフだと終了コード 1 を返すので、true で締める
    const result = await run('echo "$BASH_VERSION" | cut -c1; shopt extglob; true', { shell: '/bin/bash' });
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/^\d\nextglob\s+off\n$/);
  });

  it('シェルのスナップショットの別名と関数を使える', async () => {
    const snapshot = join(root, 'snapshot-zsh-1-a.sh');
    writeFileSync(snapshot, "alias hello='echo alias-works'\nworld() { echo func-works; }\n");
    const result = await run('hello; world', { snapshot });
    expect(result.output).toBe('alias-works\nfunc-works\n');
    // 読めないスナップショットは飛ばす
    expect((await run('echo ok', { snapshot: join(root, 'missing.sh') })).output).toBe('ok\n');
  });

  it('止めると、子のプロセスごと止まる', async () => {
    const controller = new AbortController();
    const marker = join(root, 'after');
    const pending = run(`echo before; sleep 30; touch ${marker}`, { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 300));
    controller.abort();
    const result = await pending;
    expect(result.interrupted).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.output).toBe('before\n');
  });

  it('起動できないシェルは、理由を返す', async () => {
    const result = await run('echo ok', { shell: join(root, 'no-shell') });
    expect(result.error).toBeDefined();
    expect(result.exitCode).toBeNull();
  });
});

describe('シェルに渡す文', () => {
  it('Claude Code の Bash ツールと同じ並び。コマンドの中の引用符を壊さない', () => {
    expect(shellScript("echo 'a b'", '/bin/zsh', '/s/snap.sh', '/tmp/x.cwd')).toBe(
      "source '/s/snap.sh' 2>/dev/null || true && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true && { \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval 'echo '\\''a b'\\''' < /dev/null && pwd -P >| '/tmp/x.cwd'",
    );
    expect(shellScript('ls', '/bin/bash', null, '/tmp/x.cwd')).toBe(
      "shopt -u extglob 2>/dev/null || true && { \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval 'ls' < /dev/null && pwd -P >| '/tmp/x.cwd'",
    );
  });
});

describe('会話ログに足す行', () => {
  const result = (over: Partial<BangRun>): BangRun => ({ output: '', exitCode: 0, interrupted: false, cwd: null, ...over });

  it('成功は <bash-stdout> に（末尾の改行を落とす）。< > & はエスケープする', () => {
    expect(bangLines('ls', result({ output: 'a <b> & c\n\n' }))).toEqual(['<bash-input>ls</bash-input>', '<bash-stdout>a &lt;b&gt; &amp; c</bash-stdout><bash-stderr></bash-stderr>']);
  });

  it('失敗は、出力を全部 <bash-stderr> に（終了コードは書かない）', () => {
    expect(bangLines('make', result({ output: 'out\nerr\n', exitCode: 2 }))).toEqual(['<bash-input>make</bash-input>', '<bash-stdout></bash-stdout><bash-stderr>out\nerr\n</bash-stderr>']);
  });

  it('起動できなかったら、理由を <bash-stderr> に', () => {
    expect(bangLines('ls', result({ exitCode: null, error: 'spawn /no/shell ENOENT' }))[1]).toBe('<bash-stderr>Command failed: spawn /no/shell ENOENT</bash-stderr>');
  });

  it('長い出力は、決まった長さで切って、そう書く', () => {
    const [, line] = bangLines('yes', result({ output: 'x'.repeat(BANG_OUTPUT_CHARS + 10) }));
    expect(line).toContain(`[Output truncated: showing the first ${BANG_OUTPUT_CHARS} of ${BANG_OUTPUT_CHARS + 10} characters]`);
  });
});

describe('シェルのスナップショットを探す', () => {
  const snap = (name: string) => {
    mkdirSync(join(root, 'shell-snapshots'), { recursive: true });
    writeFileSync(join(root, 'shell-snapshots', name), '');
    // 名前の時刻で選ぶ（ファイルの時刻は使わない）
    utimesSync(join(root, 'shell-snapshots', name), 0, 0);
  };

  it('同じシェルの、起動より後のもののうち、いちばん早いもの（その claude が作ったもの）。無ければほかのもののいちばん新しいもの', () => {
    expect(findShellSnapshot(root, '/bin/zsh', 0)).toBeNull();
    snap('snapshot-zsh-1000-aaaa.sh');
    snap('snapshot-zsh-3000-bbbb.sh');
    snap('snapshot-bash-5000-cccc.sh');
    snap('snapshot-zsh-2000-dddd.sh');
    expect(findShellSnapshot(root, '/bin/zsh', 1500)).toBe(join(root, 'shell-snapshots', 'snapshot-zsh-2000-dddd.sh'));
    expect(findShellSnapshot(root, '/bin/zsh', 9000)).toBe(join(root, 'shell-snapshots', 'snapshot-zsh-3000-bbbb.sh'));
    expect(findShellSnapshot(root, '/bin/bash', null)).toBe(join(root, 'shell-snapshots', 'snapshot-bash-5000-cccc.sh'));
    expect(findShellSnapshot(root, '/bin/fish', null)).toBeNull();
  });
});
