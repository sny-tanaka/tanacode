import { Terminal } from '@xterm/headless';
import type { Activity, AskQuestion, Menu, PermissionMode, ScreenInfo, ScreenLine, ScreenState } from '@shared/screen';
import { applyQuestions, findEffort, findMode, findModel, parseMenu, isStreaming, parseRewind, parseSpinner, promptRange, type SeenOptions } from './screen-parser';

// 描画が落ち着いてから読む（Ink は 1 回の更新を複数回に分けて書く）
const SETTLE_MS = 60;
// 入力欄もメニューも見えない状態がこれだけ続いたら、認識できない対話画面とみなす（再描画の途中を除く）
const UNKNOWN_AFTER_MS = 1200;
// 入力欄が出てから、打ち込んだ文字を受け付けるまでの余裕（描画のほうが先に出る）
const READY_AFTER_MS = 300;
const KEY_UP = '\x1b[A';
const KEY_DOWN = '\x1b[B';
const KEY_SHIFT_TAB = '\x1b[Z';
// 自由記述の欄の文字を消す
const KEY_CLEAR_LINE = '\x15';
// Shift+Tab で一巡する権限モードの数（bypassPermissions を含むと 5）
const MODE_CYCLE = 5;
// /rewind の一覧をさかのぼる上限
const MAX_REWIND_STEPS = 200;
// /remote-control のメニューの選択肢（つなぐ前の確認・つないだあとのメニュー）
const REMOTE_ENABLE = 'Enable Remote Control';
const REMOTE_DISCONNECT = 'Disconnect this session';
// つないだ・切ったあとに画面に出る知らせ
const REMOTE_CONNECTED = '/remote-control is active';
const REMOTE_DISCONNECTED = 'Remote Control disconnected';
// トークン数が増えてからこれだけの間は、応答を受け取っている途中とみなす
const WRITING_MS = 1500;

// pty の出力を仮想端末に流し込み、画面から「ユーザーの操作が必要な状態」を読み取る
export class ScreenTracker {
  private readonly term: Terminal;
  private info: ScreenInfo = { state: { kind: 'starting' }, model: null, effort: null, mode: null, draft: '', ready: false };
  private settleTimer: NodeJS.Timeout | null = null;
  private unknownTimer: NodeJS.Timeout | null = null;
  private readyTimer: NodeJS.Timeout | null = null;
  // 起動直後（入力欄が一度も出ていない間）は認識できない画面とみなさない
  private promptSeen = false;
  private waiters: (() => void)[] = [];
  private busy = false;
  private modelFromTranscript: string | null = null;
  private modelFromHistory: string | null = null;
  // 起動時の表示に「(1M context)」があったか。会話ログのモデル名には出ないので引き継ぐ
  private oneMillion = false;
  // 起動時の表示（モデル名の入った枠）を読めたか。再開時は会話の表示ですぐ流れて読めないことがある
  private bannerSeen = false;
  // 回答を待っている AskUserQuestion の質問（会話ログから）。選択メニューの中身はこれで組み立てる
  private questions: AskQuestion[] | null = null;
  // 答えた AskUserQuestion の質問文（会話ログに結果が書かれたもの）。画面に残っていても、もう答えられない。
  // 入力欄に戻ったら忘れる（同じ質問をもう一度聞かれたら出す）。
  // 次の質問は会話ログより先に画面に出ることがあるので、違う質問文のものは質問として扱う
  private answered: string[] = [];
  private seen: SeenOptions = new Map();
  private activity: Activity | null = null;
  // 最後に見たトークン数と、それが変わった時刻
  private tokens: { value: string | null; changedAt: number } = { value: null, changedAt: 0 };
  // 最後に読めたタイマーの経過秒と、読んだ時刻（タイマーの行が消えている間の経過時間を数える）
  private elapsed: { seconds: number; at: number } | null = null;

  constructor(
    cols: number,
    rows: number,
    private readonly write: (data: string) => void,
    private readonly onChange: (info: ScreenInfo) => void,
    // 前に起動したときの表示で分かった 1M コンテキスト（今回の表示が読めなかったときに使う）
    oneMillion = false,
    // 作業中の進み具合が変わった（作業中でなくなったら null）
    private readonly onActivity: (activity: Activity | null) => void = () => {},
  ) {
    this.term = new Terminal({ cols, rows, allowProposedApi: true });
    this.oneMillion = oneMillion;
  }

  // 今回の起動時の表示で分かった 1M コンテキストかどうか。表示を読めていなければ null
  get oneMillionSeen(): boolean | null {
    return this.bannerSeen ? this.oneMillion : null;
  }

  get current(): ScreenInfo {
    return this.info;
  }

  get currentActivity(): Activity | null {
    return this.activity;
  }

  // 会話ログの応答に記録されたモデル。バナーより正確なのでこちらを優先する。
  // 再開時に読み直した過去の応答（fromHistory）は、起動時の表示も新しい応答も無いときだけ使う
  noteModel(model: string, fromHistory = false): void {
    const name = this.oneMillion ? `${model} (1M context)` : model;
    if (fromHistory) {
      this.modelFromHistory = name;
      if (!this.modelFromTranscript && !this.bannerSeen) this.update({ ...this.info, model: name });
      return;
    }
    this.modelFromTranscript = name;
    this.update({ ...this.info, model: name });
  }

  // AskUserQuestion が呼ばれた（質問を渡す）/ 答えが返った（null）。
  // 答えが返ったら、画面の読み取りを待たずに質問を閉じる（答えたあとの画面が読めないと、質問のカードが残ってしまうため）
  // live: 今答えた（会話ログの読み直しで届いた答えではない）
  setQuestions(questions: AskQuestion[] | null, live = true): void {
    const shown = this.menu();
    this.answered =
      questions === null && live
        ? [...(this.questions?.map((q) => q.question) ?? []), ...(shown?.kind === 'question' ? [shown.title] : [])].filter(Boolean)
        : [];
    this.questions = questions;
    this.seen = new Map();
    this.read();
    const still = this.menu();
    if (still?.kind === 'question' && this.isAnswered(still.title)) this.update({ ...this.info, state: { kind: 'prompt' } });
  }

  private isAnswered(title: string): boolean {
    const a = normalize(title);
    return !!a && this.answered.some((q) => {
      const b = normalize(q);
      return !!b && (a.startsWith(b.slice(0, 30)) || b.startsWith(a.slice(0, 30)));
    });
  }

  // 入力欄が読めなくても、会話が動いているなら Claude Code は入力を受け付けている
  markReady(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    this.update({ ...this.info, ready: true });
  }

  feed(data: string): void {
    this.term.write(data, () => {
      if (this.settleTimer) clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => this.read(), SETTLE_MS);
    });
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }

  dispose(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    if (this.unknownTimer) clearTimeout(this.unknownTimer);
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.term.dispose();
  }

  // メニューの選択肢を選ぶ。↑/↓ を 1 回ずつ送り、画面上のカーソルが目的の選択肢に来たら key を送る。
  // text があれば（自由記述）カーソルを合わせたあと、前に打った文字を消して入力してから key を送る
  async choose(optionId: string, key: 'enter' | 'space' | 'none', text?: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (let step = 0; ; step++) {
        const menu = this.menu();
        if (!menu) return;
        // カーソルが見えない（画面より高い質問で、上の切れた選択肢にある）ときは -1。↓ で見えるところまで送る
        const current = menu.options.findIndex((o) => o.pointed);
        const target = menu.options.findIndex((o) => o.id === optionId);
        if (target === -1) return;
        if (current === target) break;
        // 目的の選択肢にカーソルが来なかったら、違う選択肢で答えないよう何も送らない
        if (step === 30) return;
        this.write(target > current ? KEY_DOWN : KEY_UP);
        await this.readUntil(() => this.menu()?.options.findIndex((o) => o.pointed) !== current, 500);
      }
      if (text) {
        this.write(KEY_CLEAR_LINE + text);
        await this.nextRead(500);
      }
      if (key !== 'none') this.write(key === 'space' ? ' ' : '\r');
    } finally {
      this.busy = false;
    }
  }

  // 権限モードを切り替える。Shift+Tab を 1 回ずつ送り、画面の表示が目的のモードになるまで繰り返す。
  // /config などと違い、このセッションだけの切り替え（ユーザーの既定値は変わらない）
  async setMode(target: PermissionMode): Promise<boolean> {
    if (this.busy || this.info.state.kind !== 'prompt') return false;
    this.busy = true;
    try {
      for (let step = 0; step <= MODE_CYCLE; step++) {
        if (this.info.mode === target) return true;
        const before = this.info.mode;
        this.write(KEY_SHIFT_TAB);
        await this.readUntil(() => this.info.mode !== before, 800);
      }
      return this.info.mode === target;
    } finally {
      this.busy = false;
    }
  }

  // text で始まる発言の直前まで巻き戻す。/rewind の一覧を開き、↑ を 1 回ずつ送って
  // 選択中の行が目的の発言になったら Enter。その後の「何を戻すか」は選択メニューとして出る
  async rewindTo(text: string): Promise<boolean> {
    if (this.busy || this.info.state.kind !== 'prompt') return false;
    this.busy = true;
    const target = normalize(text);
    try {
      this.write('/rewind');
      await this.nextRead(300);
      this.write('\r');
      for (let i = 0; i < 10 && this.state().kind !== 'rewind'; i++) await this.nextRead(500);
      for (let step = 0; step < MAX_REWIND_STEPS; step++) {
        const state = this.state();
        if (state.kind !== 'rewind') return false;
        const pointed = normalize(state.pointed);
        if (pointed && (target.startsWith(pointed) || pointed.startsWith(target.slice(0, 40)))) {
          this.write('\r');
          return true;
        }
        const before = state.pointed;
        this.write(KEY_UP);
        await this.readUntil(() => {
          const now = this.state();
          return now.kind !== 'rewind' || now.pointed !== before;
        }, 500);
        // 一覧の先頭に着いて動かなくなった
        const after = this.state();
        if (after.kind === 'rewind' && after.pointed === before) break;
      }
      this.write('\x1b');
      return false;
    } finally {
      this.busy = false;
    }
  }

  // Remote Control をつなぐ（name）・切る（null）。/remote-control を打つとメニューが出るので、
  // つなぐときは「Enable Remote Control」（初めてつなぐときの確認。出ないこともある）、
  // 切るときは「Disconnect this session」にカーソルを合わせて Enter を送る。
  // 画面につないだ・切った知らせが新しく出たら、メニューが出なくても済んだことにする。
  // 入力欄に書きかけの文字があるときは、つながってしまうので打たない
  async setRemoteControl(name: string | null): Promise<boolean> {
    if (this.busy || this.info.state.kind !== 'prompt' || this.info.draft) return false;
    this.busy = true;
    const target = name ? REMOTE_ENABLE : REMOTE_DISCONNECT;
    const done = name ? REMOTE_CONNECTED : REMOTE_DISCONNECTED;
    // 前につないだ・切ったときの知らせが画面に残っていることがあるので、数が増えたかで見る
    const count = () => this.lines().filter((line) => line.text.includes(done)).length;
    const before = count();
    try {
      this.write(name ? `/remote-control ${name}` : '/remote-control');
      // 打った直後は / の補完が出ているので、少し待ってから Enter
      await new Promise((resolve) => setTimeout(resolve, 500));
      this.write('\r');
      for (let step = 0; step < 20; step++) {
        await this.nextRead(500);
        if (count() > before) return true;
        const row = this.lines().find((line) => line.text.includes(target))?.text;
        if (!row) continue;
        if (row.includes('❯')) {
          this.write('\r');
          return true;
        }
        this.write(KEY_UP);
      }
      // 思っていたのと違うメニュー（すでにつながっているなど）が出ていたら閉じる
      if (this.lines().some((line) => line.text.includes(REMOTE_ENABLE) || line.text.includes(REMOTE_DISCONNECT))) this.write('\x1b');
      return false;
    } finally {
      this.busy = false;
    }
  }

  // 待っている間に画面が変わるので、型の絞り込みをまたがないよう毎回読み直す
  private state(): ScreenState {
    return this.info.state;
  }

  private menu(): Menu | null {
    return this.info.state.kind === 'menu' ? this.info.state.menu : null;
  }

  // 送ったキーが画面に映るまで待つ。キーを送る前から描いていた画面の読み取り（キーがまだ映っていないもの）で
  // 先に進むと、次のキーを重ねて送ってしまう（権限モードを 1 つ飛ばすなど）。changed が真になるか、timeoutMs たつまで読み続ける
  private async readUntil(changed: () => boolean, timeoutMs: number): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (!changed()) {
      const left = until - Date.now();
      if (left <= 0) return;
      await this.nextRead(left);
    }
  }

  private nextRead(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private read(): void {
    const lines = this.lines();
    const banner = findModel(lines);
    if (banner) {
      this.bannerSeen = true;
      this.oneMillion = banner.endsWith('(1M context)');
      // 会話ログのモデル名が先に届いていても、あとから読めた表示の 1M を付ける
      if (this.oneMillion && this.modelFromTranscript && !this.modelFromTranscript.endsWith('(1M context)')) {
        this.modelFromTranscript = `${this.modelFromTranscript} (1M context)`;
      }
    }
    const model = this.modelFromTranscript ?? banner ?? this.info.model ?? this.modelFromHistory;
    const effort = findEffort(lines) ?? this.info.effort;
    const mode = findMode(lines) ?? this.info.mode;

    let state: ScreenState | null;
    let draft = this.info.draft;
    const rewind = parseRewind(lines);
    const prompt = promptRange(lines);
    if (prompt) {
      this.promptSeen = true;
      this.answered = [];
      this.scheduleReady();
      state = { kind: 'prompt' };
      // 巻き戻しなどでこちらがキー操作している間の入力（/rewind など）は、ユーザーの下書きではない
      draft = this.busy ? '' : this.draft(prompt);
      this.readActivity(lines, prompt[0]);
    } else if (rewind) {
      state = { kind: 'rewind', pointed: rewind.pointed };
    } else {
      const parsed = parseMenu(lines);
      // 答えたあとに画面に残っている質問は、もう答えられない
      const menu = parsed && !(parsed.kind === 'question' && this.isAnswered(parsed.title)) ? parsed : null;
      state = menu ? { kind: 'menu', menu: this.questions ? applyQuestions(menu, this.questions, this.seen) : menu } : null;
    }

    if (this.unknownTimer) clearTimeout(this.unknownTimer);
    this.unknownTimer = null;
    if (state) {
      this.update({ state, model, effort, mode, draft, ready: this.info.ready });
    } else {
      // 入力欄もメニューも無い。しばらく続いたら認識できない画面とする
      this.update({ state: this.info.state, model, effort, mode, draft, ready: this.info.ready });
      if (this.promptSeen) {
        this.unknownTimer = setTimeout(() => this.update({ ...this.info, state: { kind: 'unknown' } }), UNKNOWN_AFTER_MS);
      }
    }

    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach((w) => w());
  }

  // タイマーの行から進み具合を読む。メニューが出ている間は、前に読んだものを変えない
  private readActivity(lines: ScreenLine[], promptStart: number): void {
    const spinner = parseSpinner(lines, promptStart);
    const now = Date.now();
    if (!spinner) {
      // 文章を書いている間はタイマーの行が消える。経過時間は最後に読めた時刻から数える
      const streaming = isStreaming(lines, promptStart);
      if (!streaming) this.elapsed = null;
      const elapsed = this.elapsed && formatElapsed(this.elapsed.seconds + Math.floor((now - this.elapsed.at) / 1000));
      this.setActivity(streaming ? { phase: 'writing', elapsed, tokens: null } : null);
      return;
    }
    if (spinner.tokens !== this.tokens.value) this.tokens = { value: spinner.tokens, changedAt: now };
    const seconds = spinner.elapsed ? parseElapsed(spinner.elapsed) : null;
    this.elapsed = seconds === null ? null : { seconds, at: now };
    this.setActivity({
      phase: spinner.thinking
        ? 'thinking'
        : !spinner.tokens
          ? 'waiting'
          : now - this.tokens.changedAt < WRITING_MS
            ? 'writing'
            : 'working',
      elapsed: spinner.elapsed,
      tokens: spinner.tokens,
    });
  }

  private setActivity(next: Activity | null): void {
    if (JSON.stringify(next) === JSON.stringify(this.activity)) return;
    this.activity = next;
    this.onActivity(next);
  }

  // 入力欄が出たままこれだけ経ったら、起動が終わったとする（メニューなどで入力欄が消えたらやり直し）
  private scheduleReady(): void {
    if (this.info.ready || this.readyTimer) return;
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null;
      if (this.info.state.kind === 'prompt') this.update({ ...this.info, ready: true });
    }, READY_AFTER_MS);
  }

  private update(next: ScreenInfo): void {
    if (JSON.stringify(next) === JSON.stringify(this.info)) return;
    this.info = next;
    this.onChange(next);
  }

  // 入力欄の文字。先頭の「❯ 」と続きの行の字下げを除き、薄い文字（入力例の「Try "…"」）は含めない
  private draft([start, end]: [number, number]): string {
    const buf = this.term.buffer.active;
    const rows: string[] = [];
    for (let y = start; y < end; y++) {
      const line = buf.getLine(buf.viewportY + y);
      if (!line) continue;
      let text = '';
      for (let x = 2; x < this.term.cols; x++) {
        const cell = line.getCell(x);
        if (!cell || cell.getWidth() === 0) continue;
        text += cell.isDim() ? ' ' : cell.getChars() || ' ';
      }
      rows.push(text.trimEnd());
    }
    return rows.join('\n').trim();
  }

  private lines(): ScreenLine[] {
    const buf = this.term.buffer.active;
    const lines: ScreenLine[] = [];
    for (let y = 0; y < this.term.rows; y++) {
      const line = buf.getLine(buf.viewportY + y);
      lines.push({
        text: line?.translateToString(true) ?? '',
        full: !!line && (line.getCell(this.term.cols - 1)?.getChars() ?? '') !== '',
      });
    }
    return lines;
  }
}

// 画面では長い発言が端末の幅で切れたり「…」で省略されたりするので、空白を詰めて前方一致で比べる
function normalize(text: string): string {
  return text.replace(/…$/, '').replace(/\s+/g, ' ').trim();
}

// 画面の経過時間の表記（5s・1m 5s・1h 2m）と秒数
function parseElapsed(text: string): number {
  const unit: Record<string, number> = { h: 3600, m: 60, s: 1 };
  return [...text.matchAll(/(\d+)([hms])/g)].reduce((sum, m) => sum + Number(m[1]) * unit[m[2]], 0);
}

function formatElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}
