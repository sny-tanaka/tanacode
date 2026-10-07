import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VERIFIED_CLAUDE_CODE_VERSION } from '@shared/claude-code';
import type { Activity, Menu, ScreenInfo, ScreenLine } from '@shared/screen';
import { askQuestionsOf } from '../src/main/screen-parser';
import { ScreenTracker } from '../src/main/screen-tracker';

// 画面を読みながらキーを送る操作（選択肢を選ぶ・/rewind・/remote-control・/tasks）と、画面の状態の読み取り（質問を閉じる・モデル名・作業中の進み具合）。
// 画面は、動作確認済の Claude Code の控え（test/fixtures/claude-code/<バージョン>/screens/*.json）の文字を使い、キーを受けた
// Claude Code の代わりに、カーソルを動かした画面を描き直す。次のものは控えに無いので、src の読み取り（screen-parser.ts）に合わせて組み立てた:
// /rewind の一覧・/remote-control のメニューとつないだ知らせ・作業中のタイマーの行・/tasks の画面・入力例の薄い字・1M コンテキストのバナー

const DIR = join('test', 'fixtures', 'claude-code', VERIFIED_CLAUDE_CODE_VERSION);
const fixture = (name: string) => (JSON.parse(readFileSync(join(DIR, 'screens', `${name}.json`), 'utf8')) as ScreenLine[]).map((l) => l.text.replace(/\s+$/, ''));
const askInput = () => (JSON.parse(readFileSync(join(DIR, 'ask.json'), 'utf8')) as { tool_input?: unknown }).tool_input;
const paint = (lines: string[]) => `\x1b[2J\x1b[H${lines.join('\r\n')}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const KEY_UP = '\x1b[A';
const KEY_DOWN = '\x1b[B';

// 選択肢 n にカーソル（❯）を付けた画面
const pointAt = (lines: string[], n: number) =>
  lines.map((l) => l.replace(/^(\s*)❯ (\d+\.)/, '$1  $2')).map((l) => l.replace(new RegExp(`^(\\s*)  (${n}\\.)`), '$1❯ $2'));
// 入力欄（控えの prompt の画面）。draft: 入力欄の文字。above: 入力欄の上（エフォートの表示の上）に出す行
function promptScreen(draft = '', above: string[] = []): string[] {
  const lines = fixture('prompt');
  const prompt = lines.findIndex((l) => l === '❯');
  lines[prompt] = draft ? `❯ ${draft}` : '❯';
  lines.splice(prompt - 2 - above.length, above.length, ...above);
  return lines;
}

let tracker: ScreenTracker | null = null;
afterEach(() => {
  tracker?.dispose();
  tracker = null;
  vi.useRealTimers();
});

// 状態が満たされるまで待つ
async function until(check: () => boolean, ms = 2000): Promise<void> {
  for (const end = Date.now() + ms; !check() && Date.now() < end; ) await sleep(20);
}

// 偽の Claude Code。keys: 受け取ったキーに応じて、次に描く画面を返す（undefined なら描き直さない）
function fake(first: string[], keys: (data: string, view: string[]) => string[] | undefined, size = { cols: 120, rows: 40 }) {
  const writes: string[] = [];
  const states: ScreenInfo[] = [];
  let view = first;
  tracker?.dispose();
  // 描き直しは、このトラッカーが使われている間だけ（テストが終わったあとに、次のテストのトラッカーへ描かない）
  const draw = (lines: string[]) => {
    if (tracker === t) t.feed(paint(lines));
  };
  const t: ScreenTracker = new ScreenTracker(size.cols, size.rows, (data) => {
    writes.push(data);
    const next = keys(data, view);
    if (next) {
      view = next;
      setTimeout(() => draw(next), 30);
    }
  }, (info) => states.push(info));
  tracker = t;
  t.feed(paint(first));
  return { writes, states, draw, show: (lines: string[]) => ((view = lines), t.feed(paint(lines))), view: () => view };
}

describe('choose（選択肢を選ぶ）', () => {
  const permission = fixture('bash-permission');
  // ↑/↓ でカーソルを動かし、Enter・Space で入力欄に戻る許可の確認
  const menuKeys = (data: string, view: string[]) => {
    const pointed = Number(view.find((l) => /^\s*❯ \d+\./.test(l))?.match(/(\d+)\./)?.[1]);
    if (data === KEY_DOWN) return pointAt(view, Math.min(4, pointed + 1));
    if (data === KEY_UP) return pointAt(view, Math.max(1, pointed - 1));
    if (data === '\r' || data === ' ') return promptScreen();
    return undefined;
  };
  const menuShown = async () => until(() => tracker!.current.state.kind === 'menu');
  const pointedId = () => (tracker!.current.state as { menu: Menu }).menu.options.find((o) => o.pointed)?.id;

  it('カーソルを 1 つずつ動かし、目的の選択肢に来たら Enter を送る', async () => {
    const f = fake(permission, menuKeys);
    await menuShown();
    expect(pointedId()).toBe('1');
    expect(await tracker!.choose('3', 'enter')).toBe(true);
    expect(f.writes).toEqual([KEY_DOWN, KEY_DOWN, '\r']);
    expect(tracker!.operating).toBe(false);
  });

  it('上にある選択肢へは ↑ で動かす。Space で選ぶ・キーを送らない（none）こともできる', async () => {
    const f = fake(pointAt(permission, 4), menuKeys);
    await menuShown();
    expect(await tracker!.choose('2', 'none')).toBe(true);
    expect(f.writes).toEqual([KEY_UP, KEY_UP]);
    expect(await tracker!.choose('2', 'space')).toBe(true);
    expect(f.writes).toEqual([KEY_UP, KEY_UP, ' ']);
  });

  it('無い選択肢・思っていたのと違うメニュー・操作の途中には、何も送らない', async () => {
    const f = fake(permission, menuKeys);
    await menuShown();
    expect(await tracker!.choose('9', 'enter')).toBe(false);
    expect(await tracker!.choose('1', 'enter', undefined, (menu) => menu.kind === 'question')).toBe(false);
    // 操作の途中に頼まれた
    const first = tracker!.choose('4', 'enter');
    expect(tracker!.operating).toBe(true);
    expect(await tracker!.choose('2', 'enter')).toBe(false);
    expect(await first).toBe(true);
    expect(f.writes).toEqual([KEY_DOWN, KEY_DOWN, KEY_DOWN, '\r']);
  });

  it('動かしている途中で別のメニューに変わったら、それ以上送らない', async () => {
    const question = fixture('question');
    const f = fake(permission, (data) => (data === KEY_DOWN ? question : undefined));
    await menuShown();
    const title = (tracker!.current.state as { menu: Menu }).menu.title;
    expect(await tracker!.choose('3', 'enter', undefined, (menu) => menu.title === title)).toBe(false);
    expect(f.writes).toEqual([KEY_DOWN]);
  });

  it('質問の自由記述は、カーソルを合わせて前の文字を消してから打ち、Enter を送る。打ったあとにメニューが変わったら Enter は送らない', async () => {
    const question = fixture('question');
    const questions = askQuestionsOf(askInput())!;
    const keys = (data: string, view: string[]) => {
      if (data.startsWith('\x15')) return view;
      return data === KEY_DOWN ? pointAt(view, 3) : data === '\r' ? promptScreen() : undefined;
    };
    const f = fake(question, keys);
    await menuShown();
    tracker!.setQuestions(questions);
    expect(tracker!.askedQuestions).toEqual(questions);
    const typeSomething = (tracker!.current.state as { menu: Menu }).menu.options.find((o) => o.textInput)!;
    expect(await tracker!.choose(typeSomething.id, 'enter', '自由な答え')).toBe(true);
    expect(f.writes).toEqual([KEY_DOWN, '\x15自由な答え', '\r']);

    // 打ったあとに、許可の確認に変わった
    const g = fake(question, (data, view) => (data === KEY_DOWN ? pointAt(view, 3) : data.startsWith('\x15') ? permission : undefined));
    await menuShown();
    tracker!.setQuestions(questions);
    const isQuestion = (menu: Menu) => menu.kind === 'question';
    expect(await tracker!.choose(typeSomething.id, 'enter', '答え', isQuestion)).toBe(false);
    expect(g.writes).toEqual([KEY_DOWN, '\x15答え']);
  });
});

describe('質問の画面（setQuestions）', () => {
  const question = fixture('question');

  it('答えが会話ログに書かれたら、画面に質問が残っていても入力欄に戻ったことにし、同じ質問がまた聞かれたら出す', async () => {
    const f = fake(promptScreen(), () => undefined);
    await until(() => tracker!.current.state.kind === 'prompt');
    f.show(question);
    await until(() => tracker!.current.state.kind === 'menu');
    tracker!.setQuestions(askQuestionsOf(askInput()));
    expect(tracker!.current.state).toMatchObject({ kind: 'menu', menu: { kind: 'question', title: 'どちらの書き方にしますか？' } });
    tracker!.setQuestions(null);
    expect(tracker!.askedQuestions).toBeNull();
    expect(tracker!.current.state.kind).toBe('prompt');
    // 描き直されても、答えた質問は出さない
    f.show([...question]);
    await sleep(150);
    expect(tracker!.current.state.kind).toBe('prompt');
    // 入力欄に戻ったあとで、同じ質問がもう一度聞かれた
    f.show(promptScreen());
    await sleep(150);
    f.show(question);
    await until(() => tracker!.current.state.kind === 'menu');
    expect(tracker!.current.state).toMatchObject({ kind: 'menu', menu: { kind: 'question' } });
  });

  it('画面の質問文が、会話ログの質問文の頭だけでも、答えたものとみなす。入力欄が出ているときに答えが届いても、そのまま', async () => {
    const f = fake(promptScreen(), () => undefined);
    await until(() => tracker!.current.state.kind === 'prompt');
    tracker!.setQuestions(null);
    expect(tracker!.current.state.kind).toBe('prompt');
    f.show(question);
    await until(() => tracker!.current.state.kind === 'menu');
    const [q] = askQuestionsOf(askInput())!;
    tracker!.setQuestions([{ ...q, question: `${q.question}（敬体か常体か）` }]);
    tracker!.setQuestions(null);
    expect(tracker!.current.state.kind).toBe('prompt');
  });

  it('読み直しで届いた答えでは、画面の質問を閉じない', async () => {
    fake(question, () => undefined);
    await until(() => tracker!.current.state.kind === 'menu');
    tracker!.setQuestions(askQuestionsOf(askInput()));
    tracker!.setQuestions(null, false);
    expect(tracker!.current.state).toMatchObject({ kind: 'menu', menu: { kind: 'question' } });
  });

  it('許可の確認が出ているときに答えが届いても、許可の確認は閉じない', async () => {
    fake(fixture('bash-permission'), () => undefined);
    await until(() => tracker!.current.state.kind === 'menu');
    tracker!.setQuestions(null);
    expect(tracker!.current.state).toMatchObject({ kind: 'menu', menu: { kind: 'permission' } });
  });
});

describe('モデル名と起動の終わり', () => {
  it('会話ログのモデル名を、バナーより優先する。読み直しの過去のモデル名は、ほかに無いときだけ使う', async () => {
    fake(promptScreen(), () => undefined);
    expect(tracker!.oneMillionSeen).toBeNull();
    await until(() => tracker!.current.model !== null);
    expect(tracker!.current.model).toBe('Opus 5.5');
    expect(tracker!.oneMillionSeen).toBe(false);
    tracker!.noteModel('Sonnet 5', true);
    expect(tracker!.current.model).toBe('Opus 5.5');
    tracker!.noteModel('Haiku 4.5');
    expect(tracker!.current.model).toBe('Haiku 4.5');
    // バナーが画面に残っていても、描き直しで戻さない
    tracker!.feed(paint(promptScreen('x')));
    await until(() => tracker!.current.draft === 'x');
    expect(tracker!.current.model).toBe('Haiku 4.5');
  });

  it('バナーが読めないときは、過去のモデル名を使う。前の起動で分かった 1M コンテキストを付ける', async () => {
    // --resume で、会話の表示でバナーが流れた画面
    const lines = promptScreen();
    lines.splice(0, 4, '', '', '', '');
    tracker = new ScreenTracker(120, 40, () => {}, () => {}, true);
    tracker.feed(paint(lines));
    await until(() => tracker!.current.state.kind === 'prompt');
    expect(tracker.current.model).toBeNull();
    expect(tracker.oneMillionSeen).toBeNull();
    tracker.noteModel('Opus 5.5', true);
    expect(tracker.current.model).toBe('Opus 5.5 (1M context)');
  });

  it('あとから読めたバナーの 1M コンテキストを、会話ログのモデル名にも付ける', async () => {
    tracker = new ScreenTracker(120, 40, () => {}, () => {});
    tracker.noteModel('Opus 5.5');
    const lines = promptScreen();
    lines[2] = lines[2].replace('Opus 5.5 ·', 'Opus 5.5 (1M context) ·');
    tracker.feed(paint(lines));
    await until(() => tracker!.current.model === 'Opus 5.5 (1M context)');
    expect(tracker.oneMillionSeen).toBe(true);
    // もう一度読んでも重ねて付けない
    tracker.feed(paint(lines));
    await sleep(120);
    expect(tracker.current.model).toBe('Opus 5.5 (1M context)');
  });

  it('入力欄が出たままなら少しあとで ready。その前にメニューに変わったら ready にしない。会話が動いたら ready にする', async () => {
    const f = fake(promptScreen(), () => undefined);
    await until(() => tracker!.current.state.kind === 'prompt');
    f.show(fixture('trust'));
    await sleep(400);
    expect(tracker!.current).toMatchObject({ state: { kind: 'menu' }, ready: false });
    tracker!.markReady();
    expect(tracker!.current.ready).toBe(true);
    // ready になったあとは、入力欄が出ても待たない
    f.show(promptScreen());
    await until(() => tracker!.current.state.kind === 'prompt');
    expect(tracker!.current.ready).toBe(true);
  });

  it('起動を待っている間に会話が動いたら、待たずに ready にする。メニューが出ているときは、権限モードを切り替えない', async () => {
    const f = fake(promptScreen(), () => undefined);
    await until(() => tracker!.current.state.kind === 'prompt');
    expect(tracker!.current.ready).toBe(false);
    tracker!.markReady();
    expect(tracker!.current.ready).toBe(true);
    f.show(fixture('bash-permission'));
    await until(() => tracker!.current.state.kind === 'menu');
    expect(await tracker!.setMode('plan')).toBe(false);
    expect(f.writes).toEqual([]);
  });

  it('何も描かないうち・読み取りを待っている間に止めても落ちない', async () => {
    tracker = new ScreenTracker(120, 40, () => {}, () => {});
    tracker.dispose();
    const f = fake(promptScreen(), () => undefined);
    await until(() => tracker!.current.state.kind === 'prompt');
    f.show(['', '  知らない画面']);
    await sleep(150);
    // 操作できない画面とみなすのを待っている間に止めたら、もう状態を変えない
    const t = tracker!;
    t.dispose();
    tracker = null;
    await sleep(1300);
    expect(t.current.state.kind).toBe('prompt');
  });

  it('入力欄もメニューも見えない画面が続いたら、操作できない画面とする。起動直後は待つ', async () => {
    const f = fake(['', '  何かの画面'], () => undefined);
    await sleep(1400);
    expect(tracker!.current.state.kind).toBe('starting');
    f.show(promptScreen());
    await until(() => tracker!.current.state.kind === 'prompt');
    f.show(['', '  Claude Code の知らない画面']);
    await until(() => tracker!.current.state.kind === 'unknown', 2500);
    expect(tracker!.current.state.kind).toBe('unknown');
    expect(tracker!.text()).toBe('  Claude Code の知らない画面');
  });

  it('入力欄の薄い字（入力例）は書きかけに含めない。端末の大きさを変えられる', async () => {
    fake(promptScreen('\x1b[2mTry "fix lint errors"\x1b[22m'), () => undefined);
    await until(() => tracker!.current.state.kind === 'prompt');
    await sleep(100);
    expect(tracker!.current.draft).toBe('');
    tracker!.resize(100, 30);
    tracker!.feed(paint(promptScreen('書きかけ').slice(10)));
    await until(() => tracker!.current.draft === '書きかけ');
    expect(tracker!.current.draft).toBe('書きかけ');
  });
});

describe('作業中の進み具合', () => {
  // タイマーの行（「✳ Shimmying… (5s · ↓ 225 tokens · thought for 2s)」）と、文章を書いている間の応答の行
  it('タイマーの行から、考え中・待ち・書いている・作業中と経過時間を読み、タイマーが消えて文章が流れている間も経過時間を数える', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T10:00:00Z'));
    const activities: (Activity | null)[] = [];
    tracker = new ScreenTracker(120, 40, () => {}, () => {}, false, (a) => activities.push(a));
    const show = async (above: string[]) => {
      tracker!.feed(paint(promptScreen('', above)));
      await sleep(120);
    };
    await show(['✳ Shimmying… (5s · thinking)']);
    expect(tracker.currentActivity).toEqual({ phase: 'thinking', elapsed: '5s', tokens: null });
    await show(['✶ Churning…']);
    expect(tracker.currentActivity).toEqual({ phase: 'waiting', elapsed: null, tokens: null });
    await show(['✳ Shimmying… (1m 5s · ↓ 225 tokens · thought for 2s)']);
    expect(tracker.currentActivity).toEqual({ phase: 'writing', elapsed: '1m 5s', tokens: '225' });
    // トークン数が 1.5 秒変わらなければ、作業中
    vi.setSystemTime(new Date('2026-10-07T10:00:02Z'));
    await show(['✳ Shimmying… (1m 7s · ↓ 225 tokens · thought for 2s)']);
    expect(tracker.currentActivity).toEqual({ phase: 'working', elapsed: '1m 7s', tokens: '225' });
    // タイマーの行が消えて、応答の文章が流れている
    vi.setSystemTime(new Date('2026-10-07T10:00:05Z'));
    await show(['⏺ 応答の文章を書いています', '  続きの行']);
    expect(tracker.currentActivity).toEqual({ phase: 'writing', elapsed: '1m 10s', tokens: null });
    // 終わった
    await show(['⏺ 応答の文章', '', '✻ Worked for 12s · done 10:00 AM']);
    expect(tracker.currentActivity).toBeNull();
    // 同じ状態が続いても、知らせは重ねない
    await show(['⏺ 応答の文章', '', '✻ Worked for 12s · done 10:00 AM']);
    expect(activities.filter((a) => a === null)).toHaveLength(1);
    // 終わったあとの応答の経過時間は、前の作業から数えない
    await show(['⏺ 次の応答']);
    expect(tracker.currentActivity).toEqual({ phase: 'writing', elapsed: null, tokens: null });
    // 時間の単位
    await show(['✳ Shimmying… (1h 2m · ↓ 1.2k tokens)']);
    vi.setSystemTime(new Date('2026-10-07T10:01:00Z'));
    await show(['⏺ 長い作業']);
    expect(tracker.currentActivity).toEqual({ phase: 'writing', elapsed: '1h 2m', tokens: null });
    await show(['✳ Shimmying… (↓ 3 tokens)']);
    await show(['⏺ 経過時間の分からない作業']);
    expect(tracker.currentActivity).toEqual({ phase: 'writing', elapsed: null, tokens: null });
    // 作業中に送った発言が順番待ちになっている（タイマーの行が消えて発言が出る）
    await show(['❯ 順番待ちの発言']);
    expect(tracker.currentActivity).toBeNull();
    // 秒だけの経過時間
    await show(['✳ Shimmying… (5s · ↓ 9 tokens)']);
    vi.setSystemTime(new Date('2026-10-07T10:01:02Z'));
    await show(['⏺ 短い作業']);
    expect(tracker.currentActivity).toEqual({ phase: 'writing', elapsed: '7s', tokens: null });
  });

  it('進み具合の受け手を渡さなくても読める', async () => {
    tracker = new ScreenTracker(120, 40, () => {}, () => {});
    tracker.feed(paint(promptScreen('', ['✶ Churning…'])));
    await until(() => tracker!.currentActivity !== null);
    expect(tracker.currentActivity).toEqual({ phase: 'waiting', elapsed: null, tokens: null });
  });
});

describe('rewindTo（/rewind で巻き戻す）', () => {
  // /rewind の一覧。古い発言から並び、最後は (current)。❯ が選択中
  const rewindList = (items: string[], pointed: number) => [
    '▔'.repeat(120),
    '   Rewind',
    '',
    '   Restore the code and/or conversation to the point before…',
    '',
    ...items.map((item, i) => `   ${i === pointed ? '❯' : ' '} ${item}`),
    '',
    '   Enter to continue · Esc to cancel',
  ];
  function rewinder(items: string[], { upCloses = false } = {}) {
    let pointed = items.length - 1;
    let draft = '';
    return fake(promptScreen(), (data, view) => {
      const inList = view.some((l) => l.includes('Enter to continue · Esc to cancel'));
      if (!inList) {
        if (data === '\r') return rewindList(items, pointed);
        draft += data;
        return promptScreen(draft);
      }
      if (data === KEY_UP) {
        if (upCloses) return promptScreen();
        pointed = Math.max(0, pointed - 1);
        return rewindList(items, pointed);
      }
      if (data === '\r') return fixture('rewind-restore');
      if (data === '\x1b') return promptScreen();
      return undefined;
    });
  }

  it('一覧を開き、↑ で目的の発言まで動かして Enter を送る（省略された長い発言も、頭で見分ける）', async () => {
    const long = `長い発言 ${'あ'.repeat(60)}`;
    const f = rewinder([`${long.slice(0, 30)}…`, '二つ目の発言', '(current)']);
    await until(() => tracker!.current.state.kind === 'prompt');
    expect(await tracker!.rewindTo(long)).toBe(true);
    expect(f.writes).toEqual(['/rewind', '\r', KEY_UP, KEY_UP, '\r']);
    expect(tracker!.operating).toBe(false);
  });

  it('一覧の先頭まで探して無ければ、Esc で閉じる。一覧が閉じたら、それ以上送らない', async () => {
    const f = rewinder(['一つ目', '(current)']);
    await until(() => tracker!.current.state.kind === 'prompt');
    expect(await tracker!.rewindTo('ありません')).toBe(false);
    expect(f.writes).toEqual(['/rewind', '\r', KEY_UP, KEY_UP, '\x1b']);
    const g = rewinder(['一つ目', '(current)'], { upCloses: true });
    await until(() => tracker!.current.state.kind === 'prompt');
    expect(await tracker!.rewindTo('一つ目')).toBe(false);
    expect(g.writes).toEqual(['/rewind', '\r', KEY_UP]);
  });

  it('入力欄が出ていないとき・操作の途中には打たない', async () => {
    const f = fake(fixture('bash-permission'), () => undefined);
    await until(() => tracker!.current.state.kind === 'menu');
    expect(await tracker!.rewindTo('一つ目')).toBe(false);
    expect(f.writes).toEqual([]);
  });
});

describe('setRemoteControl（/remote-control でつなぐ・切る）', () => {
  // /remote-control のメニュー（初めてつなぐときの確認・つないだあとのメニュー）
  const remoteMenu = (options: string[], pointed: number) => [
    ...promptScreen().slice(0, 25),
    '─'.repeat(120),
    ' Remote Control',
    '',
    ...options.map((o, i) => ` ${i === pointed ? '❯' : ' '} ${i + 1}. ${o}`),
    '',
    ' Enter to select · Esc to cancel',
  ];

  it('つなぐ: メニューの「Enable Remote Control」にカーソルを合わせて Enter を送る', async () => {
    let pointed = 1;
    let draft = '';
    const f = fake(promptScreen(), (data) => {
      if (data === '\r' && draft) {
        draft = '';
        return remoteMenu(['Enable Remote Control', 'Cancel'], pointed);
      }
      if (data === KEY_UP) return remoteMenu(['Enable Remote Control', 'Cancel'], (pointed = 0));
      if (data === '\r') return promptScreen();
      draft += data;
      return promptScreen(draft);
    });
    await until(() => tracker!.current.state.kind === 'prompt');
    expect(await tracker!.setRemoteControl('tanacode')).toBe(true);
    expect(f.writes).toEqual(['/remote-control tanacode', '\r', KEY_UP, '\r']);
  });

  it('メニューが出ずに、つないだ・切った知らせが新しく出たら済んだことにする（前の知らせが残っていても数で見る）', async () => {
    const notice = (lines: string[]) => [...lines.slice(0, 5), '⎿  /remote-control is active · https://claude.ai/code/session_x', ...lines.slice(6)];
    const f = fake(notice(promptScreen()), (data, view) => {
      if (data === '\r') return [...view.slice(0, 6), '⎿  /remote-control is active · https://claude.ai/code/session_y', ...view.slice(7, 30), ...promptScreen().slice(30)];
      return [...view.slice(0, 30), ...promptScreen(data).slice(30)];
    });
    await until(() => tracker!.current.state.kind === 'prompt');
    expect(await tracker!.setRemoteControl('tanacode')).toBe(true);
    expect(f.writes).toEqual(['/remote-control tanacode', '\r']);
  });

  it('切る: 「Disconnect this session」を選ぶ', async () => {
    const f = fake(promptScreen(), (data, view) => {
      if (data === '/remote-control') return promptScreen(data);
      if (data === '\r' && view.some((l) => l.includes('Disconnect this session'))) return [...promptScreen().slice(0, 5), '⎿  Remote Control disconnected', ...promptScreen().slice(6)];
      if (data === '\r') return remoteMenu(['Disconnect this session', 'Cancel'], 0);
      return undefined;
    });
    await until(() => tracker!.current.state.kind === 'prompt');
    expect(await tracker!.setRemoteControl(null)).toBe(true);
    expect(f.writes).toEqual(['/remote-control', '\r', '\r']);
  });

  it('思っていたのと違うメニュー（もうつながっている）なら、Esc で閉じる', async () => {
    let timer: NodeJS.Timeout | null = null;
    const f = fake(promptScreen(), (data, view) => {
      if (data === '\r') {
        const menu = remoteMenu(['Disconnect this session', 'Cancel'], 0);
        // メニューを出している間、描き直し続ける（読み取りを待たせない）
        timer = setInterval(() => f.draw(menu), 100);
        return menu;
      }
      if (data === '\x1b') {
        if (timer) clearInterval(timer);
        return promptScreen();
      }
      return view.some((l) => l.includes('Remote Control')) ? undefined : promptScreen(data);
    });
    await until(() => tracker!.current.state.kind === 'prompt');
    try {
      expect(await tracker!.setRemoteControl('tanacode')).toBe(false);
    } finally {
      if (timer) clearInterval(timer);
    }
    expect(f.writes).toEqual(['/remote-control tanacode', '\r', '\x1b']);
  }, 10_000);

  it('書きかけの文字があるとき・入力欄が出ていないときは打たない', async () => {
    const f = fake(promptScreen('書きかけ'), () => undefined);
    await until(() => tracker!.current.draft === '書きかけ');
    expect(await tracker!.setRemoteControl('tanacode')).toBe(false);
    f.show(fixture('bash-permission'));
    await until(() => tracker!.current.state.kind === 'menu');
    expect(await tracker!.setRemoteControl(null)).toBe(false);
    expect(f.writes).toEqual([]);
  });
});

describe('stopTask（/tasks で止める）の、うまくいかないとき', () => {
  const TOP = `${'▔'.repeat(100)} ◐ medium · /effort ▔`;
  const list = (rows: string[], pointed: number, hint = '↑/↓ to select · Enter to view · x to stop · Esc to close') => [
    ...promptScreen().slice(0, 25),
    TOP,
    '   Background',
    `   ${rows.length} active shells`,
    `     Shells (${rows.length})`,
    ...rows.map((row, i) => `   ${i === pointed ? '❯' : ' '} ⏺ ${row.padEnd(40)}   running`),
    `   ${hint}`,
  ];
  // 偽の /tasks。onKey: 一覧が出ているときのキーへの反応
  function tasks(rows: string[], onKey: (data: string, pointed: number) => string[] | undefined, startAt = 0) {
    let draft = '';
    let opened = false;
    return fake(promptScreen(), (data) => {
      if (data === '\x1b') {
        opened = false;
        return promptScreen();
      }
      if (!opened) {
        if (data === '\r') {
          opened = true;
          draft = '';
          return list(rows, startAt);
        }
        draft += data;
        return promptScreen(draft, ['  /tasks    View and manage everything running in the background']);
      }
      return onKey(data, startAt);
    });
  }
  const ready = () => until(() => tracker!.current.state.kind === 'prompt' && tracker!.current.ready);

  it('止めたいものが上にあれば ↑ で動かす', async () => {
    let pointed = 1;
    const rows = ['sleep 1', 'sleep 2'];
    const f = tasks(rows, (data) => {
      if (data === KEY_UP) return list(rows, (pointed = 0));
      if (data === 'x') return promptScreen();
      return undefined;
    }, 1);
    await ready();
    expect(await tracker!.stopTask('sleep 1')).toBe('stopped');
    expect(f.writes).toEqual(['/tasks', '\r', KEY_UP, 'x']);
    expect(pointed).toBe(0);
  });

  it('x を送っても残るものは failed。動かしても動かないときも failed', async () => {
    const rows = ['sleep 1', 'sleep 2'];
    // x を送っても一覧に残る
    const stuck = tasks(rows, (data) => (data === 'x' ? list(rows, 0) : undefined));
    await ready();
    expect(await tracker!.stopTask('sleep 1')).toBe('failed');
    expect(stuck.writes).toEqual(['/tasks', '\r', 'x', '\x1b']);
    // ↓ を送ってもカーソルが動かない
    const frozen = tasks(rows, () => undefined);
    await ready();
    expect(await tracker!.stopTask('sleep 2')).toBe('failed');
    expect(frozen.writes).toEqual(['/tasks', '\r', KEY_DOWN, '\x1b']);
  }, 15_000);

  it('案内に x が無い一覧では、止めずに failed', async () => {
    const rows = ['sleep 1', 'sleep 2'];
    let draft = '';
    let opened = false;
    const f = fake(promptScreen(), (data) => {
      if (data === '\x1b') return (opened = false), promptScreen();
      if (!opened && data === '\r') return (opened = true), list(rows, 0, '↑/↓ to select · Enter to view · Esc to close');
      if (!opened) return promptScreen((draft += data), ['  /tasks    View and manage everything running in the background']);
      return undefined;
    });
    await ready();
    expect(await tracker!.stopTask('sleep 1')).toBe('failed');
    expect(f.writes).toEqual(['/tasks', '\r', '\x1b']);
  });

  it('動かした直後に一瞬読めなくても、描き直しを待って続ける。一覧が閉じたら not-found', async () => {
    const rows = ['sleep 1', 'sleep 2'];
    let pointed = 0;
    const f = tasks(rows, (data) => {
      if (data === KEY_DOWN) {
        // 描き直しの途中の画面を挟んでから、一覧を出す
        setTimeout(() => f.draw(list(rows, (pointed = 1))), 150);
        return [...promptScreen().slice(0, 25), TOP, '   Background'];
      }
      if (data === 'x') return promptScreen();
      return undefined;
    });
    await ready();
    expect(await tracker!.stopTask('sleep 2')).toBe('stopped');
    expect(f.writes).toEqual(['/tasks', '\r', KEY_DOWN, 'x']);
    expect(pointed).toBe(1);
    // ↓ で一覧が閉じてしまった
    const g = tasks(rows, (data) => (data === KEY_DOWN ? promptScreen() : undefined));
    await ready();
    expect(await tracker!.stopTask('sleep 9')).toBe('not-found');
    expect(g.writes).toEqual(['/tasks', '\r', KEY_DOWN]);
  });

  it('操作の途中には busy を返す', async () => {
    const rows = ['sleep 1', 'sleep 2'];
    tasks(rows, (data) => (data === 'x' ? promptScreen() : undefined));
    await ready();
    const first = tracker!.stopTask('sleep 1');
    expect(await tracker!.stopTask('sleep 1')).toBe('busy');
    expect(await first).toBe('stopped');
  });
});
