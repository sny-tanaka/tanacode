import { Terminal } from '@xterm/headless';
import type { Activity, AskQuestion, ChooseResult, Menu, PermissionMode, ScreenInfo, ScreenLine, ScreenState } from '@shared/screen';
import {
  applyQuestions,
  findEffort,
  findMode,
  findModel,
  findTaskRows,
  isStreaming,
  parseMenu,
  parseRewind,
  parseSpinner,
  parseTasks,
  promptRange,
  showsCommandSuggestion,
  type SeenOptions,
  type TasksDialog,
} from './screen-parser';

// 描画が落ち着いてから読む（Ink は 1 回の更新を複数回に分けて書く）
const SETTLE_MS = 60;
// 入力欄もメニューも見えない状態がこれだけ続いたら、認識できない対話画面とみなす（再描画の途中を除く）
const UNKNOWN_AFTER_MS = 1200;
// 入力欄が出てから、打ち込んだ文字を受け付けるまでの余裕（描画のほうが先に出る）
const READY_AFTER_MS = 300;
// Claude Code は、直前の入力（指示の送信・前のメニューへの Enter・文字の入力）から少しの間、出たばかりのメニューに届いたキーを、
// 何も描かずに捨てる（続けて押したキーで、出たばかりの確認に答えてしまわないための仕組み。あとから効くこともない）。
// 本物（2.1.292・2.1.293）をモックの API で動かして測ると、捨てるのは直前の入力から約 250ms（重いときは 300ms ほどのことも）。
// メニューの中で打つ ↑/↓ などは数えない。
// メニューが出る前の最後の入力からこれだけたつまでは、選ぶキーを送らない（選ぶキーは送り直さないので、重いときの分の余裕を多めに足す）
const INPUT_GRACE_MS = 700;
// 出たばかりのメニューは、描き直されてカーソルが元に戻ることがある（起動直後のフォルダの信頼の確認は、出てから 0.13〜0.17 秒のうちに
// ↓ を押すと、カーソルがいったん動いたあと「No, exit」に戻り、続けて送った Enter で No, exit が選ばれた。2.1.293 で実測）。
// メニューを読み取ってからこれだけたつまでは、キーを送らない
const MENU_SETTLE_MS = 300;
// 選ぶキーを送ってから、メニューの画面が変わるのを待つ時間。少しも変わらなければ、Claude Code が受け付けなかったとして ignored を返す
// （送り直さない）。Claude Code が重くて描くのが遅れているだけのときに、早まって受け付けなかったとしないよう長めにする
const PRESS_CONFIRM_MS = 3000;
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
// /remote-control のメニューで選んだ・閉じたあと、メニューが閉じるのを待つ時間
const REMOTE_MENU_CLOSE_MS = 1500;
// トークン数が増えてからこれだけの間は、応答を受け取っている途中とみなす
const WRITING_MS = 1500;
// /tasks の画面で、目的の行を探して動かす回数の上限
const MAX_TASKS_STEPS = 60;

// stopTask の結果。stopped 以外は、何も止めていない
// busy: ほかの操作の途中 / not-prompt: 入力欄が出ていない（質問や確認の画面） / draft: 入力欄に書きかけの文字がある /
// not-found: 画面に見つからない（もう終わった・止まった） / ambiguous: 同じ名前が 2 つ以上あって決められない / failed: 画面が思ったとおりに動かなかった
export type StopResult = 'stopped' | 'busy' | 'not-prompt' | 'draft' | 'not-found' | 'ambiguous' | 'failed';

// pty の出力を仮想端末に流し込み、画面から「ユーザーの操作が必要な状態」を読み取る
export class ScreenTracker {
  private readonly term: Terminal;
  private info: ScreenInfo = { state: { kind: 'starting' }, model: null, effort: null, mode: null, draft: '', ready: false };
  private settleTimer: NodeJS.Timeout | null = null;
  // アプリが Claude Code に最後に入力を送った時刻と、今のメニューが出る前の最後の入力の時刻（Claude Code が入力を捨てる間を避ける）
  private lastInputAt = 0;
  private menuInputAt = 0;
  // 今のメニューを読み取った時刻
  private menuSince = 0;
  // 出力を仮想端末に書き込むたびに呼ぶもの（選ぶキーを送ったあと、メニューの画面が一瞬でも変わったかを見る）
  private readonly writtenWatchers = new Set<() => void>();
  // 書き込んだ出力を、まだ読み取っていない（state が画面より古い）
  private unread = false;
  private disposed = false;
  private unknownTimer: NodeJS.Timeout | null = null;
  private readyTimer: NodeJS.Timeout | null = null;
  // 起動直後（入力欄が一度も出ていない間）は認識できない画面とみなさない
  private promptSeen = false;
  private waiters: (() => void)[] = [];
  private busy = false;
  // 画面を操作している間（/tasks の画面など、入力欄が消えるとき）。読み取りを止めて、状態を今のままにする
  private holding = false;
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
    private readonly output: (data: string) => void,
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

  // 画面にキーを送る操作（選択肢を選ぶ・モードの切り替え・巻き戻し・/tasks など）の途中か。途中に別の文字を打つと、その操作の画面に入ってしまう
  get operating(): boolean {
    return this.busy;
  }

  // 今出している AskUserQuestion の質問（フックが書いた入力）。答えが返るまで持つ。出していなければ null
  get askedQuestions(): AskQuestion[] | null {
    return this.questions;
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

  // アプリが Claude Code に入力を送った（チャットからの送信・ターミナルで打った文字など。このクラスが送るキーは write が数える）
  noteInput(): void {
    this.lastInputAt = Date.now();
  }

  feed(data: string): void {
    this.term.write(data, () => {
      this.unread = true;
      for (const watch of [...this.writtenWatchers]) watch();
      if (this.settleTimer) clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => this.read(), SETTLE_MS);
    });
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }

  dispose(): void {
    this.disposed = true;
    this.writtenWatchers.clear();
    if (this.settleTimer) clearTimeout(this.settleTimer);
    if (this.unknownTimer) clearTimeout(this.unknownTimer);
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.term.dispose();
  }

  // メニューの選択肢を選ぶ。↑/↓ を 1 回ずつ送り、画面上のカーソルが目的の選択肢に来たら key を送る。
  // text があれば（自由記述）カーソルを合わせたあと、前に打った文字を消して入力してから key を送る。
  // expect: キーを送る前に毎回、今のメニューがこれを満たすか確かめる（途中で別のメニューに変わったら、何も送らずにやめる）。
  // 出たばかりのメニュー（MENU_SETTLE_MS）と、Claude Code が入力を捨てる間（INPUT_GRACE_MS）には送らずに待ち、
  // 選ぶキー（key）は 1 回だけ送って、効いたかを画面で確かめる（press）。選べたら chosen。
  // 選べなかったときは、黙って捨てずに理由を返す（ChooseResult）。押し直すかは、人（カードの知らせを見て）が決める
  async choose(optionId: string, key: 'enter' | 'space' | 'none', text?: string, expect?: (menu: Menu) => boolean): Promise<ChooseResult> {
    if (this.busy) return 'busy';
    this.busy = true;
    const shown = () => {
      const menu = this.menu();
      return menu && (!expect || expect(menu)) ? menu : null;
    };
    try {
      // 押したのが、画面が変わる前のカードということがある。届いている出力を読み終えてから、今のメニューで確かめる
      await this.caughtUp();
      const menu = shown();
      if (!menu) return 'gone';
      if (!menu.options.some((o) => o.id === optionId)) return 'missing';
      await sleepUntil(Math.max(this.menuSince + MENU_SETTLE_MS, this.menuInputAt + INPUT_GRACE_MS));
      // 押す直前にカーソルが目的の選択肢から動いていたら（描き直しで戻った）、合わせ直す。
      // moved は選ぶキーを送る前に返るので、合わせ直しても、選ぶキーを送るのは 1 回だけ
      for (let attempt = 0; attempt < 3; attempt++) {
        const moved = await this.moveTo(optionId, shown);
        if (moved) return moved;
        if (text) {
          if (!shown()) return 'gone';
          this.write(KEY_CLEAR_LINE + text);
          await this.nextRead(500);
        }
        if (key === 'none') return 'chosen';
        const result = await this.press(key === 'space' ? ' ' : '\r', optionId, shown);
        if (result !== 'moved') return result;
      }
      return 'stuck';
    } finally {
      this.busy = false;
    }
  }

  // カーソルを目的の選択肢に合わせる。合ったら null
  private async moveTo(optionId: string, shown: () => Menu | null): Promise<ChooseResult | null> {
    for (let step = 0; ; step++) {
      await this.caughtUp();
      const menu = shown();
      if (!menu) return 'gone';
      // カーソルが見えない（画面より高い質問で、上の切れた選択肢にある）ときは -1。↓ で見えるところまで送る
      const current = menu.options.findIndex((o) => o.pointed);
      const target = menu.options.findIndex((o) => o.id === optionId);
      if (target === -1) return 'missing';
      if (current === target) return null;
      // 目的の選択肢にカーソルが来なかったら、違う選択肢で答えないよう何も送らない
      if (step === 30) return 'stuck';
      this.write(target > current ? KEY_DOWN : KEY_UP);
      await this.readUntil(() => this.menu()?.options.findIndex((o) => o.pointed) !== current, 500);
    }
  }

  // 選ぶキー（Enter・Space）を 1 回だけ送り、メニューの画面が変わるのを待つ。変わったら chosen。
  // 変わらないまま PRESS_CONFIRM_MS たったら、Claude Code が受け付けなかった（入力を捨てる間に届いた）として ignored を返す。
  // 変わったかは、描き直しが落ち着いてから、カーソルの位置を除いて比べる（untilMenuChanges）。
  // 送り直さない。Claude Code が固まっていて、あとから最初のキーを受け付けたとき、送り直したキーが次の許可の確認に当たり、
  // 人が押していない許可を出してしまうおそれがあるため。
  // 送る直前に、カーソルが目的の選択肢に無かったら、何も送らずに moved を返す
  private async press(data: string, optionId: string, shown: () => Menu | null): Promise<ChooseResult | 'moved'> {
    await this.caughtUp();
    const menu = shown();
    if (!menu) return 'gone';
    // 読み取りより新しい、端末の今の画面でも確かめる（画面より高い質問で、目的の選択肢が見えていなければ、読み取りに任せる）
    const onScreen = parseMenu(this.lines())?.options.find((o) => o.id === optionId);
    if (!menu.options.find((o) => o.id === optionId)?.pointed || (onScreen && !onScreen.pointed)) return 'moved';
    const before = this.menuOnScreen();
    this.write(data);
    if (await this.untilMenuChanges(before, PRESS_CONFIRM_MS)) return 'chosen';
    return this.disposed ? 'gone' : 'ignored';
  }

  // 書き込んだ出力を読み取り終えるまで待つ（出力が続いているときは、長くても 500ms）
  private async caughtUp(): Promise<void> {
    await this.readUntil(() => !this.unread, 500);
  }

  // 今の仮想端末に出ているメニュー（読み取りを待たずに、その場で読む）。選ぶキーが効いたかを見るためのものなので、カーソルの位置は除く
  // （受け付けずに描き直しただけでカーソルが戻ることがある。選ぶキーが効けば、メニューが閉じるか、別のメニュー・チェックに変わる）
  private menuOnScreen(): string {
    const menu = parseMenu(this.lines());
    return JSON.stringify(menu && { ...menu, options: menu.options.map((o) => ({ ...o, pointed: false })) });
  }

  // メニューの画面が before から変わったかを見る。timeoutMs のうちに変わったら true。
  // 見るのは、出力が SETTLE_MS 途切れて描き直しが落ち着いたときだけ。Ink は 1 回の描き直しを何回かに分けて書くので、途中の画面では
  // メニューが半分しか無く、変わったように見える。選ぶキーを捨てた Claude Code が、裏の作業の知らせなどで同じメニューを描き直しただけのときに、
  // 選べたことにしないため（そうなると、カードに知らせが出ず、人は選べたと思ったまま待ってしまう）
  private untilMenuChanges(before: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let settle: NodeJS.Timeout | null = null;
      let expired = false;
      const finish = (changed: boolean) => {
        clearTimeout(timer);
        if (settle) clearTimeout(settle);
        this.writtenWatchers.delete(watch);
        resolve(changed);
      };
      const check = () => {
        settle = null;
        if (this.disposed) finish(false);
        else if (this.menuOnScreen() !== before) finish(true);
        else if (expired) finish(false);
      };
      const watch = () => {
        // 時間切れのあとは、確かめを先へ延ばさない（出力が途切れずに続いても、SETTLE_MS で決める）
        if (expired) return;
        if (settle) clearTimeout(settle);
        settle = setTimeout(check, SETTLE_MS);
      };
      // 時間切れのときに描き直しの途中なら、SETTLE_MS だけ待ってから決める
      const timer = setTimeout(() => {
        expired = true;
        if (!settle) check();
      }, timeoutMs);
      this.writtenWatchers.add(watch);
    });
  }

  // キーを Claude Code に送る。送った時刻を覚えておく（Claude Code が入力を捨てる間を避けるため）
  // 入力の時刻は、送ったあとに覚える（送る前に覚えると、届いた時刻より早くなり、次のキーまでの間が少し短くなる）
  private write(data: string): void {
    this.output(data);
    this.noteInput();
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
          await this.untilRemoteMenuClosed();
          return true;
        }
        this.write(KEY_UP);
      }
      // 思っていたのと違うメニュー（すでにつながっているなど）が出ていたら閉じる
      if (this.lines().some((line) => line.text.includes(REMOTE_ENABLE) || line.text.includes(REMOTE_DISCONNECT))) {
        this.write('\x1b');
        await this.untilRemoteMenuClosed();
      }
      return false;
    } finally {
      this.busy = false;
    }
  }

  // 選んだ・閉じた /remote-control のメニューが、画面の読み取りから消えるまで待つ。
  // 消える前に返すと、呼び出し元が今の画面（まだメニュー）を、人の操作待ちとして知らせてしまう
  private async untilRemoteMenuClosed(): Promise<void> {
    const shown = () => !!this.menu()?.options.some((o) => o.label.includes(REMOTE_ENABLE) || o.label.includes(REMOTE_DISCONNECT));
    await this.readUntil(() => !shown(), REMOTE_MENU_CLOSE_MS);
  }

  // バックグラウンドで動いているものを止める。本家の /tasks の画面を開き、name の行を選んで x を送る（人が押すのと同じ操作）。
  // 止めると、Claude Code が会話ログに「止められた」と書くので、状態はそちらから分かる。
  // 画面が開いている間は入力欄が消えるので、「操作できない画面」と読まないよう、状態を今のままにしておく（holding）。
  // 入力欄に書きかけの文字があるときは打たない（/tasks が続きに入って、発言として送ってしまう）
  async stopTask(name: string): Promise<StopResult> {
    if (this.busy) return 'busy';
    if (this.info.state.kind !== 'prompt') return 'not-prompt';
    if (this.info.draft) return 'draft';
    this.busy = true;
    this.holding = true;
    try {
      return await this.stopInTasks(name);
    } finally {
      await this.closeTasks();
      this.busy = false;
      this.holding = false;
      this.read();
    }
  }

  private async stopInTasks(name: string): Promise<StopResult> {
    this.write('/tasks');
    // 打った直後は / の補完が出ている。出てから Enter（補完を出している途中の Enter は、送信にならないことがある）
    await this.readUntil(() => showsCommandSuggestion(this.lines(), '/tasks'), 1500);
    this.write('\r');
    await this.readUntil(() => parseTasks(this.lines()) !== null, 3000);
    // 一覧に出ている 1 つ（または、1 つだけのときの詳細）が name かを見る
    const there = (d: TasksDialog | null): boolean =>
      !!d && (d.view === 'list' ? findTaskRows(name, d.rows.map((r) => r.label)).length > 0 : d.canStop && d.subjects.some((s) => findTaskRows(name, [s]).length > 0));
    const signature = (d: TasksDialog) => JSON.stringify(d.rows);
    const pressStop = async (): Promise<StopResult> => {
      this.write('x');
      await this.readUntil(() => !there(parseTasks(this.lines())), 2000);
      return there(parseTasks(this.lines())) ? 'failed' : 'stopped';
    };

    let dialog = parseTasks(this.lines());
    // 見えていない行は、まず下へ、行き止まりなら上へ探す
    let direction: 'down' | 'up' = 'down';
    for (let step = 0; dialog && step < MAX_TASKS_STEPS; step++) {
      if (dialog.view !== 'list') {
        if (!there(dialog)) return 'not-found';
        return pressStop();
      }
      const hits = findTaskRows(name, dialog.rows.map((r) => r.label));
      if (hits.length > 1) return 'ambiguous';
      const pointed = dialog.rows.findIndex((r) => r.pointed);
      if (hits.length === 1 && hits[0] === pointed) return dialog.canStop ? pressStop() : 'failed';
      const before = signature(dialog);
      this.write(hits.length === 1 ? (hits[0] > pointed ? KEY_DOWN : KEY_UP) : direction === 'down' ? KEY_DOWN : KEY_UP);
      await this.readUntil(() => {
        const now = parseTasks(this.lines());
        return !now || signature(now) !== before;
      }, 600);
      dialog = parseTasks(this.lines());
      // 描き直しの途中で、一瞬読めないことがある
      if (!dialog) {
        await this.readUntil(() => parseTasks(this.lines()) !== null, 600);
        dialog = parseTasks(this.lines());
      }
      if (dialog && signature(dialog) === before) {
        // 動かなかった（一覧の端）
        if (hits.length === 1) return 'failed';
        if (direction === 'up') return 'not-found';
        direction = 'up';
      }
    }
    return dialog ? 'failed' : 'not-found';
  }

  // /tasks の画面を閉じて入力欄に戻す。入力欄が見えるまで Esc を送る。
  // 入力欄が見えているときは送らない（作業中の Esc は、作業を中断してしまう）
  private async closeTasks(): Promise<void> {
    for (let i = 0; i < 6; i++) {
      await this.readUntil(() => promptRange(this.lines()) !== null, 700);
      if (promptRange(this.lines())) return;
      this.write('\x1b');
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
    this.unread = false;
    if (this.holding) {
      this.wake();
      return;
    }
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
    // 新しいメニュー（見出し・補足・選択肢の名前が変わったもの）が出たら、読み取った時刻と、それまでの最後の入力の時刻を覚える。
    // カーソルやチェックが動いただけ（メニューの中で打ったキー）では変えない
    if (state?.kind === 'menu' && menuIdentity(state.menu) !== (this.info.state.kind === 'menu' ? menuIdentity(this.info.state.menu) : null)) {
      this.menuInputAt = this.lastInputAt;
      this.menuSince = Date.now();
    }
    if (state) {
      this.update({ state, model, effort, mode, draft, ready: this.info.ready });
    } else {
      // 入力欄もメニューも無い。しばらく続いたら認識できない画面とする
      this.update({ state: this.info.state, model, effort, mode, draft, ready: this.info.ready });
      if (this.promptSeen) {
        this.unknownTimer = setTimeout(() => this.update({ ...this.info, state: { kind: 'unknown' } }), UNKNOWN_AFTER_MS);
      }
    }

    this.wake();
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach((w) => w());
  }

  // タイマーの行から進み具合を読む。メニューが出ている間は、前に読んだものを変えない
  private readActivity(lines: ScreenLine[], promptStart: number): void {
    const spinner = parseSpinner(lines, promptStart);
    const now = Date.now();
    if (!spinner) {
      // 文章を書いている間はタイマーの行が消える。経過時間は最後に読めた時刻から数える。
      // 長い応答の始まり（⏺）が画面の外に流れたら、書いている途中のまま
      const streaming = isStreaming(lines, promptStart, this.activity?.phase === 'writing');
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

  // 入力欄の文字。先頭の「❯ 」と続きの行の字下げを除き、薄い文字（入力例の「Try "…"」）は含めない。
  // ! を打ってシェルのコマンドを書いている間は、先頭の目印が「! 」になるので、打ったとおり「!」を付ける
  private draft([start, end]: [number, number]): string {
    const buf = this.term.buffer.active;
    const shell = buf.getLine(buf.viewportY + start)?.getCell(0)?.getChars() === '!';
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
    const text = rows.join('\n').trim();
    return shell ? `!${text}` : text;
  }

  // 今の画面の文字（空の行を除く）。起動に失敗したときの理由に添える
  text(): string {
    return this.lines()
      .map((line) => line.text.trimEnd())
      .filter(Boolean)
      .join('\n');
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

// メニューを見分けるもの（カーソルの位置とチェックを除く）
function menuIdentity(menu: Menu): string {
  return JSON.stringify([menu.kind, menu.title, menu.context, menu.options.map((o) => o.label)]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

// 時刻（Date.now()）が deadline になるまで待つ。タイマーはイベントループが少し前に覚えた時刻から数えるので、
// 実際の時刻では 1ms ほど早く起きることがある。起きたら確かめ、まだなら待ち直す
async function sleepUntil(deadline: number): Promise<void> {
  while (Date.now() < deadline) await sleep(deadline - Date.now());
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
