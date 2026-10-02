# tanacode の開発

tanacode をソースから動かす方法と、仕組み・ソースの構成のまとめ。使い方は [GUIDE.md](GUIDE.md) に。

- [貢献の流れ](#貢献の流れ)
- [始め方](#始め方)
- [書き方の決まり](#書き方の決まり)
- [見た目の確かめ方](#見た目の確かめ方)
- [Claude Code との互換性の確かめ方](#claude-code-との互換性の確かめ方)
- [仕組み](#仕組み)
- [機能ごとの実装メモ](#機能ごとの実装メモ)
- [読むもの・書くもの](#読むもの書くもの)
- [ソースの構成](#ソースの構成)
- [デモ動画の仕組み](#デモ動画の仕組み)
- [ライセンスの表示](#ライセンスの表示)

## 貢献の流れ

- 不具合・要望は、まず Issue へ。大きな変更は、実装の前に Issue で相談
- 脆弱性は Issue ではなく [SECURITY.md](SECURITY.md) の手順で
- PR は `develop` ブランチへ
- 出す前に `npm run typecheck` と `npm test`。画面を変えたときは Storybook で確かめ、PR にスクリーンショットを添付
- 画面・会話ログ・statusLine の読み取りを変えたときは、`npm run test:cli` も（下の「Claude Code との互換性の確かめ方」）

## 始め方

必要なもの: macOS 13 以降・Node.js 22・`claude` CLI（初回のセットアップを済ませたもの）

```bash
npm install
npm run dev
```

| コマンド | 内容 |
| --- | --- |
| `npm run dev` | 開発モードで起動（renderer は HMR） |
| `npm run build` / `npm start` | ビルドして起動 |
| `npm run typecheck` | 型チェック |
| `npm test` | 本物の Claude Code から取った控えで、画面・会話ログ・statusLine の読み取りを確かめる（読み取りの部品の単体の確認も） |
| `npm run test:cli` | 本物の `claude` をモックの API で動かして、読み取りを確かめる（料金なし） |
| `npm run storybook` | 画面の部品を、アプリを起動せずにブラウザで見る（http://localhost:6006） |
| `npm run dist` | ビルドする Mac に合わせて `dist/mac-arm64/tanacode.app`（Intel の Mac では `dist/mac/tanacode.app`）を作る（署名なし） |
| `npm run install-app` | `npm run dist` のあと、`/Applications/tanacode.app` に入れ替える（下の「ソースからビルドして使う」） |
| `npm run demo:record -- <動画の名前>` | README のデモ動画を録る（下の「デモ動画の仕組み」） |

### ソースからビルドして使う

`npm install` のあと `npm run install-app` を実行すると、ビルドして「アプリケーション」フォルダに入れます。手元でビルドしたものは、ダウンロードの印が付かないので `xattr` のコマンドは不要。

- 動いているアプリの上に上書きせず、隣にコピーしてから名前の付け替えで入れ替えます。動いているアプリと Claude Code は、そのまま動き続けます。
- 終了のダイアログで「動かしたまま終了」を選んで起動し直すと、新しいバージョンになります。

### 開発版での注意

- 開発版（`npm run dev`・`npm start` などパッケージしていないもの）では、Remote Control は使えません（トグルは押せません）。起動するたびにスマホに通知が届くためです。Claude Code が勝手につなぎ直したものも切ります。使いたいときは `TANACODE_REMOTE_CONTROL=1` を付けて起動します。
- パッケージ版の tanacode を使いながら開発版を試すときは、別の userData で起動します。同じ userData だと、パッケージ版で動いているセッションを開発版がもう一度 `claude --resume` してしまいます。

  ```bash
  npm run build
  npx electron . --user-data-dir=/tmp/tanacode-dev
  ```

- 開発版を終了しても、「Claude Code も止めて終了」を選ばない限り、pty ホストと Claude Code は残ります（次の起動で引き継ぐため）。

## 書き方の決まり

- コードのコメント・コミットメッセージ・ドキュメント・画面の文言は、日本語で書きます（コード中の識別子や、ツール名・コマンドなどの固有名詞はそのままでかまいません）。
- README・GUIDE・CONTRIBUTING・SECURITY は、名詞で止められるところは体言止め、動詞で終わる文は「です・ます」で書きます（例:「ワンクリックで作成。作成後に編集することもできます。」）。機能を変えたら、読む人に合わせて該当する文書も直します。
- 「版」は単体で使わず、「バージョン」と書きます（「新しいバージョン」「最新バージョン」など）。「開発版」のような熟語はそのまま。
- 画面の場所の呼び方は、文書と画面の文言でそろえます。左端の縦並びのアイコンは「アクティビティバー」、画面の下の帯は「ステータスバー」。hooks は「hooks」と書きます（画面の畳んだ行の表示は「フック N件」）。
- 整形ツール（prettier など）の設定は無し。まわりのコードの書き方に合わせます。
- AI のエージェント向けの決まりは [AGENTS.md](AGENTS.md) にあります。
- 決まった手順は、Claude Code のスキルとして `.claude/skills/` に。リリース（`/release`）・セキュリティ対応（`/security`）・デモ動画の録り直し（`/demo-video`）・ソースから入れたアプリの更新（`/update-app`）の 4 つ。リリースはメンテナーだけが行います。

## 見た目の確かめ方

- CSS や画面の部品を直したときは、アプリを起動せずに Storybook（`npm run storybook`）で確かめます。
- ストーリーは部品の隣の `*.stories.tsx`。`window.tanacode` は、何もしないモック（`.storybook/mockApi.ts`）に差し替えます。
- 状態の見せ方の決まり
  - 進行中・処理中は、グラデーションの回る印（`StatusDot`）と、グラデーションが流れる文字で出します。完了は緑のチェック、失敗・停止は赤の ✕。
  - ツールカードの枠は、実行中だけグラデーションを流し、終わったものは列の区切り線と同じ灰色。終わるときは、グラデーションを薄くして消しながらチェックを描きます。
  - タスクやターンが終わったときは、いきなり消さず、チェックを描いて「完了」と出してから消します。
  - 新しい行は、少し下からふわっと出します。macOS の「視差効果を減らす」がオンなら、動きは止めます。
  - アイコンだけのボタンのツールチップは、アプリで描きます（`data-tip`）。OS のツールチップ（`title`）は出るまで遅いためです。
- デザインの指示で守るのは、文字色・背景色・専用のグラデーション。

## Claude Code との互換性の確かめ方

tanacode は Claude Code の画面・会話ログ・statusLine・hooks の形に頼っています。Claude Code の更新でこれらの形が変わると、アプリの読み取りが通らなくなります。そこで、本物の Claude Code でアプリの読み取りを確かめます。

- `npm run test:cli`（`test/cli/`）: 本物の `claude` を node-pty で起動し、アプリと同じ部品で読みます。
  - 動かすのは本物の `SessionManager`。`src/main/index.ts` と同じく `SessionStore`・`StatusLineWatcher`・`WorkspaceWatchers` と組み立て、pty ホストだけを node-pty を直に使う偽物（`test/cli/fake-pty-host.ts`。`PtyHost` と同じ形の `spawn`・`attach`・`list`）に、userData を使い捨てのフォルダに差し替えます。Electron には頼りません。
  - 通る道もアプリと同じ: 画面は `ScreenTracker`、会話ログは `ClaudeSession` の `TranscriptFollower` から `SessionManager` の行の処理（引き継いだ claude の行の扱い・巻き戻し・順番待ち・モデル名・`TaskRouter` と各トラッカー・`KnowledgeTracker`）、statusLine と AskUserQuestion のフックは `StatusLineWatcher`（`<id>.json`・`<id>.ask.json`）。`/` の候補は `listCommands`。
  - 確かめるのは、`SessionManager` が配信したもの（チャットのイベント・画面の状態・操作待ちの知らせ・作業の完了の知らせ・一覧の状態）。テストの部品は `test/cli/claude-run.ts` の `ClaudeRun`。
  - 決まった時間だけ待たず、画面や会話ログの状態を待ちます（打った文字が入力欄に出てから Enter・選んだメニューが閉じたか）。メニューは、出てから 0.3 秒たつまで選びません。Claude Code は、許可の確認などを出した直後の入力を受け付けないことがあるためです。
  - API は、決まった応答を返すモック（`test/cli/mock-api.ts`）に `ANTHROPIC_BASE_URL` で差し替えます。API キーは使わず、料金もかかりません。
    - 応答は文章・ツールの呼び出し・思考（署名はそれらしい文字）。ツールの無い裏の呼び出し（タイトル作りなど）にも、決めた文を返せます。
  - サブエージェントやワークフローのエージェントも、別の会話として API を呼びます。モックは、会話のはじめの発言で台本を選びます。
  - 台本は 8 つのファイル。それぞれ別の `claude` を起動して、同時に流します。

    | ファイル | 台本 |
    | --- | --- |
    | `basic.test.ts`（台本は `test/scenario.ts`） | フォルダの信頼の確認 → 入力欄 → Bash（許可の確認・PostToolUse の hooks）→ AskUserQuestion → Write（許可の確認）→ 返事。チャットの組み立て（会話ログからと、`SessionManager` の配信から）・操作待ちの知らせと通知の本文・完了の知らせ・読んだ・書いたファイル・statusLine・`/` の候補（会話ログのスキル一覧）も |
    | `background.test.ts` | サブエージェント（Agent）→ バックグラウンドの Bash → ワークフロー（始める前の確認・実行中の journal も）。それぞれ完了まで、トラッカーで追えるか。完了通知（`<task-notification>`）は、出力ファイルや完了時の記録という後ろ盾と分けて、会話ログの行と `taskNotificationOf` だけで読めるか、チャットの知らせになるかも |
    | `session.test.ts` | 権限モードの切り替え（Shift+Tab）→ 作業中の進み具合 → 作業中に送った発言の順番待ち（`queue` のイベント）→ 会話ログのモデル名 → `/compact` → `/clear`（statusLine で新しい会話ログに乗り換え）→ `--resume` → `/rewind`（「何を戻すか」のメニューと、会話を戻して発言したときの `replace` のイベント） |
    | `adopt.test.ts` | `--resume` の前と後でバックグラウンドの Bash → アプリを起動し直して、動いている claude を引き継ぐ（前の claude の行は過去のもの、今の claude の行は今も動いているもの）→ アプリを止めている間の `/clear` |
    | `questions.test.ts`（台本は `test/scenarios/questions.ts`） | AskUserQuestion。複数の質問のページ送り（タブ・自由記述・回答の確認画面）→ 複数選択だけの質問（チェックの付け外し・Next / Submit）→ プレビュー付きの選択肢 → 説明が長く、上が切れて見えるメニュー。どれもカードのボタンと同じ操作で答え、会話ログの答えまで確かめる |
    | `errors.test.ts`（台本は `test/scenarios/errors.ts`） | 失敗と中断。応答の前・応答を待つ間・ツールの実行中の Esc → 中断した会話の `--resume`（`<synthetic>` の応答を出さない）→ API エラー（529 の再試行・529 のあきらめ・400）→ 新しい会話でツールの失敗（`exit 3`）・PreToolUse の hooks で止める・Write と Edit の差分・Stop の hooks |
    | `worktree.test.ts` | git のリポジトリで `claude --worktree`（`SessionManager.createInWorktree`）→ worktree の場所・ブランチ・Claude Code のロック・`.worktreeinclude` の写し・元のフォルダの未追跡に出ないこと → 準備の知らせが ready より先 → 会話ログが worktree の側に書かれる → `git branch -D` で、アプリが足した hooks の許可の確認が出る → 止めて `--resume`（worktree のフォルダで再開）→ worktree を削除してアーカイブ（未追跡のファイルの控えの ref）→ 戻すと作り直して再開。信頼していないフォルダでは始まらず、理由を日本語で返す |
| `input.test.ts`（台本は `test/scenarios/input.ts`） | 台本ごとに別の `claude` を起動。入力欄: `--effort` の表示とバナーのモデル名 → 書きかけ → 会話の最初の `/context` → 複数行の貼り付け（短いもの・長いもの）→ `!` のコマンド → `/rename` と AI のタイトル → セッションの一覧。読み取り: `@` の添付・Read・サブフォルダの CLAUDE.md・コンテキストの使用量（`KnowledgeTracker`）・思考・画像。サブエージェントの実行中の直近のツールと会話ログ（`readAgentLog`）。バックグラウンドの Bash を `TaskStop` で止める |

  - モックは、台本の応答の代わりに API エラーを返すこともできます（`failures`。回数を決めれば、その後は応答を返す）。再試行の待ち時間を短くするため、失敗と中断の台本では `CLAUDE_CODE_MAX_RETRIES` を付けて起動します（`ClaudeRun` の `env`）。

  - 確かめられないもの:
    - Remote Control とモデルの一覧の控え（claude.ai へのログインが要る）
    - ToDo（API キーで起動すると、`TaskCreate`・`TodoWrite` のツールが出ない）
    - `/usage` の利用枠
    - API エラーの再試行中の行（`system` の `api_error`）: 今の Claude Code は、再試行中にこの行を作って画面には出しますが、会話ログに残す前に飛ばします。チャットの「再試行中」の表示は、今は出ません
    - 貼り付けの `<pasted_content>` の囲み: Claude Code の入力欄に貼り付けたものは囲まれません。囲まれるのは、claude.ai など外から送られた発言（Remote Control）の貼り付けです
  - hooks で止めたときの行（`hook_blocking_error` の attachment）は、PostToolUse・PostToolUseFailure の hooks でだけ書かれます。PreToolUse で止めたときは書かれず、ツールの結果の文章（「PreToolUse:Bash hook error: …」）から読みます。どちらも `errors.test.ts` で確かめます。
  - 起動の引数は、アプリと同じもの（`claudeArgs`）。アプリが付ける引数が `claude --help` にあるかも見ます。
  - HOME は使い捨てのフォルダに差し替えるので、ふだんの `~/.claude` には触りません。
  - 確かめる `claude` は `TANACODE_CLAUDE_BIN` で指定（無ければ PATH の `claude`）。
  - 失敗したときは、そのときの Claude Code の画面がログに出ます。
- `npm test`（`test/recorded.test.ts`）: `npm run test:cli` のときに取った控え（`test/fixtures/claude-code/<バージョン>/`）を、同じ読み取りにかけます。`claude` が無くても速く流せます。古いバージョンの控えも残し、読めるままかを確かめ続けます。
  - 控えは `TANACODE_RECORD=1 npm run test:cli` で取ります。基本の台本は画面・会話ログ・statusLine・フックの入力を、ほかの台本は画面だけ（ワークフローを始める前の確認・`/rewind` の「何を戻すか」・AskUserQuestion の各ページ・中断のあとの入力欄・入力欄のまわり（`--effort`・書きかけ・長い貼り付けの目印・`!` のコマンド））を残します。システムプロンプトの全文やツールの一覧など、アプリが読まない大きな行は残しません。画面は、文字の行（`.json`）と、文字の属性ごとの書き出し（`.ansi`。`@xterm/addon-serialize`）の 2 つを残します。書きかけ（`draft`）は薄い字の入力例を除いて読むので、`.ansi` を `ScreenTracker` に流し込んで確かめます。
  - 控えは、クラウドの開発環境のように Claude Code の設定やトークンが置かれた環境では取りません。その環境ならではの表示が画面に混ざるためです。GitHub Actions が残した artifact か、手元の Mac で取ったものを使います。
- tanacode で動作確認済のバージョンは `src/shared/claude-code.ts` の `VERIFIED_CLAUDE_CODE_VERSION`。ステータスバーは、入っているバージョンがこれと同じならチェックマーク、違えば警告の印を付けます（新しいバージョンと古いバージョンで分ける）。
  - 上げるのは、GitHub Actions の毎日の確認です（下）。新しいバージョンで通ったら、`scripts/update-verified-version.mjs` で次のものを書き換えた PR を作って、そのままマージします。
    - `VERIFIED_CLAUDE_CODE_VERSION`
    - README と GUIDE の「動作確認済」の行のバージョン（README の先頭のバッジも、alt に「動作確認済」を入れてあるので一緒に変わる）
    - そのバージョンの控え（`test/fixtures/claude-code/<バージョン>/`）
  - 控えがあれば、`npm test` は動作確認済のバージョンの控えがあるかも見ます。
  - 手で上げるときも、同じスクリプトを使います（`TANACODE_RECORD=1 npm run test:cli` で控えを取ってから `node scripts/update-verified-version.mjs <バージョン>`）。
- GitHub Actions（`.github/workflows/claude-code-check.yml`）: PR と、毎日の定期の確認で、その日の最新の Claude Code で両方を流します。
  - 定期の確認で失敗したら、Issue を立てます（同じバージョンの Issue が開いていれば立てない）。
  - 定期の確認で通ったら、動作確認済のバージョンを上げる PR（ブランチは `claude-code/<バージョン>`）を作って、そのまま squash マージします。動作確認済のバージョンと同じバージョンで、その控えがまだコミットされていなければ、控えだけを足す PR を作って、同じようにマージします。同じバージョンの PR が一度でもあれば（閉じたものも）、作り直しません。
    - PR を作ってマージするのは、確認とは別のジョブ（`update`）です。書き込める権限を、PR の CI で動くコードに渡さないためです。
    - GitHub Actions が作った PR では、PR の CI が動きません。そのため、マージの条件は PR の CI ではなく、同じ確認（`check` ジョブの `npm test` と本物の claude での `npm run test:cli`、書き換えたあとの `npm test`）が通ったことです。確かめた実行へのリンクを PR の説明に載せます。
    - マージできなかったときは、`update` ジョブが失敗して、PR は開いたまま残ります。人が見てマージします。
    - マージしたあとの develop への push では、GitHub Actions のトークンの仕様で、ワークフローが動きません。
    - リポジトリの設定（Settings → Actions → General）で「Allow GitHub Actions to create and approve pull requests」をオンにしておく必要があります。develop のルールセット（need-pr）は、PR を通すことだけを求めています（承認 0 人・squash のみ）。必須のチェックを足すと、PR の CI が動かないこの PR はマージできなくなります。
  - 途中の控えは artifact（`claude-code-<バージョン>`）にも残します。
  - 「Run workflow」で、バージョンを指定して確かめることもできます。通れば、定期の確認と同じく PR を作ってマージします（動作確認済のバージョンより古いバージョンでは作らない）。

## 仕組み

### Claude Code の動かし方

- セッションごとに、node-pty で本物の `claude` を起動します。
  - 起動するのはアプリではなく、pty ホストという常駐プロセス。アプリを再起動しても Claude Code を止めないためです。
    - アプリが Electron を Node として（`ELECTRON_RUN_AS_NODE`）、アプリと切り離して起動します。macOS では Dock にアイコンが出ないよう、同梱の `tanacode Helper.app` の実行ファイルを使います。アプリとは userData の Unix ソケットでやりとりします。パスが長すぎるときは一時フォルダに置きます。
    - ホストは Claude Code の画面を仮想の端末で持っています。起動し直したアプリは、その画面（`@xterm/addon-serialize`）と、Claude Code が起動した時刻を受け取って引き継ぎます。その時刻より後の会話ログの行は、今も動いている Claude Code が書いたものとして扱います。途中のターン・バックグラウンドのタスク・質問は、終わったことにせず、そのまま追いかけます。
    - 引き継いだときは、アプリが止まっている間に書かれた statusLine のファイルも、次の書き込みを待たずに読みます。止まっている間に `/clear` で会話が変わっていても、すぐ新しい会話ログに乗り換えます。
    - アプリも Claude Code も無くなって 10 秒たつと、ホストは自分で終わります。
    - やりとりの形を変えたら、`pty-host-protocol.ts` の `PROTOCOL` を上げます。起動したアプリは、形の違う古いホストを Claude Code ごと止めて、起動し直します。止まったセッションは `--resume` で再開します。ホストのログは userData の `pty-host.log`。
  - 新しい会話には `--session-id <uuid>` を、再開には `--resume <id>` を付けます。
  - Remote Control をオンにしたセッションは、`--remote-control tanacode-<フォルダ名>` を付けます（開発版を除く）。worktree のセッションのフォルダ名は、元のフォルダの名前。
  - worktree のセッションは、新しい会話なら元のフォルダ（リポジトリのいちばん上）で `--worktree <名前>` を付けて起動します。再開は worktree のフォルダで `--resume` だけ（Claude Code は会話ログの `worktree-state` の行から worktree に戻る。実測）。
  - モデル・エフォート・権限モードを選んだときは、`--model` / `--effort` / `--permission-mode` も付けます。ユーザーの既定値（`~/.claude/settings.json`）は変えません。
  - 設定ファイル（登録した Claude Code の設定ファイル。セッションごとに選ぶ。`SessionRecord.settingsFile` に登録の ID を持つ）を選んだセッションは、`--settings` にアプリの設定と登録した設定を合わせたファイルを渡します（`settings-files.ts`）。
    - Claude Code は `--settings` を 2 回渡しても合わせず、最後の 1 つしか使いません（実測）。そのため、登録した設定ファイルを 2 つ目として足さず、アプリが合わせます。`hooks` は両方を残し、`statusLine` はアプリのもの（登録した設定の statusLine は、そのコマンドを `tee` の先で動かして包む）、`env`・`model` などは登録した設定のままにします。
    - 登録するのは名前とパス（`userData/settings.json` の `settingsFiles`。`AppSettings`）だけで、ファイルの中身は預かりません。名前を変えても、セッションが指す先（ID）は変わりません。読めないファイル（無い・JSON でない）は登録できません。
    - 合わせたファイルは `userData/session-settings/<セッション ID>.json`（`0600`、フォルダは `0700`）。登録した設定の `env` に API キーが入るので、引数（`ps` に見える）や pty ホストへの要求には載せず、パスだけを渡します。起動のたびに書き直し、Claude Code が終わった・アーカイブした・標準に戻した・アプリが Claude Code ごと終了したときに消します（アプリだけ終了して引き継ぐときは残します）。
    - `--model` は設定ファイルの `model` を上書きするので（実測）、モデルを選んでいないときは登録した設定の `model` を `--model` に渡します。設定ファイルを変えたら、モデルとエフォートは `null` に戻します（設定によって使えるモデルが違うため）。
    - 登録が外れている・ファイルが無い・読めないときは、記録を作る前・起動し直す前・動いている Claude Code を止める前に断ります。標準の設定に黙って切り替えると、意図しない契約で動いてしまうためです。登録を外すのは、使っているセッションがあっても止めません（次に起動するときに断られる）。
- チャットは pty の画面ではなく、会話ログから組み立てます。会話ログは `~/.claude/projects/<フォルダ>/<id>.jsonl`。`/clear` で会話が切り替わっても追いかけます。
  - `/clear` のあとの会話ログは、statusLine の `transcript_path` で分かります（Remote Control を使っていなくても追える）。Remote Control を使っていれば、新しい会話ログにも同じ `bridge-session` の ID が書かれるので、それでも追います。
  - Remote Control のつながりは、会話ログの `bridge_status`（URL）と `bridge-session`（ID。切ると空になる）の行で分かります。以前つないでいた会話を再開して勝手につなぎ直したときは、`bridge-session` の行だけが書かれます。
  - 会話ログは、変更の通知（`fs.watch`）ですぐ読みます。取りこぼしに備えて、0.15 秒ごとにも確かめます。
  - 作業中に送った発言は、会話ログの順番待ちの行（`queue-operation`）から読みます。
- 選択メニュー（質問・許可の確認・巻き戻し・フォルダの信頼の確認）だけは、pty の画面を仮想の端末で再現して読み取ります。選んだ答えは ↑/↓ と Enter のキー入力にして送ります。
  - キー（↑/↓・権限モードの Shift+Tab）は 1 つ送るたびに、画面にそれが映るのを待ってから次を送ります。キーを送る前から描いていた画面の読み取りで先に進むと、キーを重ねて送ってしまうためです。
  - 選択肢は、`❯` の行から上へたどって最初に見つかる「1.」から読みます。ワークフローを始める前の確認のように、説明の中にも番号付きの一覧（フェーズ）があるためです。
  - 問いかけが説明の上にある確認（「Run a dynamic workflow?」「Confirm you want to restore …:」）は、`?`（無ければ `:`）で終わる行を見出しにします。`/rewind` の「何を戻すか」の縦線の枠は質問文ではなく、戻す先の発言の引用なので、補足に出します。下の段に重ねて出るメニューの上端は `▔` の線です。
  - フォルダの信頼の確認は、選択肢に番号がありません（`❯ No, exit` など）。番号付きの選択肢が無いときは、下に操作説明があり、`❯` の行と同じ字下げの行が続くものを選択肢として読みます。上の文章は、問いかけ（`?` を含む段落）を見出しに、ほかを補足にします。
- 起動時のバナーのモデル名は、ロゴの右の「Claude Code vX.Y.Z」の次の行から読みます（前の Claude Code の、枠の中の形にも対応）。
  - AskUserQuestion の質問文・選択肢・説明・プレビューは、その入力から取ります。画面からは、カーソルの位置・チェック・「その他」に打った文字・どの質問のページかだけを読みます。画面が低いと Claude Code は選択肢の一部しか出さないためです。
  - 選択肢の説明が長く、メニューが画面より高いと、上（タブ・質問文・はじめの選択肢）が切れて見えません。そのときは、見えている選択肢の名前がそろう質問として組み立てます。カーソルのある選択肢が切れて `❯` が見えないときは、カーソルは見えている選択肢より上にあります（見えていないのが 1 つめだけなら、1 つめ）。カードで選んだとき、カーソルが目的の選択肢まで来なければ、違う選択肢で答えないよう Enter などを送りません。
  - 今の Claude Code は、AskUserQuestion の行を答えたあとで会話ログに書きます。そこで、質問を出す前の PreToolUse のフックで、入力をセッションごとのファイルに書かせて読みます（下の `--settings`）。フックが無い（前のバージョンのアプリが起動した）Claude Code では、画面から組み立てます。質問文は縦線（│）の枠で端末の幅に折り返して出るので、縦線を外して行をつなぎ直します。
- アプリが起動する Claude Code にだけ、`--settings` で statusLine を足します。
  - Claude Code は応答のたびに JSON を渡してきます。中身はモデル・コンテキストの上限と使用率・利用枠・今の会話ログのパス。これをセッションごとのファイルに書かせて読みます。
  - ユーザー自身が `~/.claude/settings.json` で statusLine を設定していれば、同じ JSON をそちらにも渡します。プロジェクトの設定（`.claude/settings*.json`）の statusLine は写しません。clone したリポジトリのコマンドを、フォルダの信頼の確認の前にフラグの設定として動かさないためです。このセッションでは `--settings` の statusLine が優先されるので、プロジェクトの statusLine は動きません。
- 同じく `--settings` で、AskUserQuestion の PreToolUse のフックを足します。質問の入力をセッションごとのファイルに書かせるだけで、何も止めません。ユーザー自身のフックは、これまでどおり一緒に動きます。このフックはチャットのフックの一覧に出しません。
- Bash の PreToolUse には、worktree やブランチを消す操作の歯止めのフック（`worktree-guard.ts`）を足します。`git worktree remove --force`・`git branch -D`・worktree の `rm -rf` だけ、`permissionDecision: "ask"` を返して許可の確認を出させます。
  - `ask` は、権限モードが auto や bypassPermissions でも確認を出します（実測）。止めはしません。
  - Node があるとは限らないので、macOS に必ずある awk で JSON を読みます。コマンドは `;`・`&&`・`|` などで区切り、区切りごとに見ます。macOS の awk（bwk awk）でも動くかは、`TANACODE_AWK=<bwk awk のあるフォルダ> npx vitest run test/worktree-guard.test.ts` で確かめられます（Linux なら `original-awk`）。
  - チャットのフックの一覧には出しません（目印は環境変数の名前 `TANACODE_WORKTREE_GUARD`）。
- 裏で Claude Code を別に起動することはありません。利用枠の取得に `/usage` を実行することもありません。

## 機能ごとの実装メモ

使い方（[GUIDE.md](GUIDE.md)）の裏で、何をしているか。

### セッション

- `/` の補完には、同じフォルダの前の会話からスキルの一覧を借りて出します。新しい会話には、まだ一覧が無いためです。
- 起動中（入力欄が出るまで）に送った発言は、起動が終わるのを待ってから送ります。起動中に打った文字は、Claude Code が取りこぼすためです。
- 新規セッションの画面で選んだフォルダは、`folders.open` で `folder:` から始まる id を払い出して開きます。main はこの id もセッションの id と同じようにフォルダに直すので、右パネル（エクスプローラー・検索・ソース管理）とエディタは、セッションが無くてもそのまま使えます。開けるのは、フォルダ選択ダイアログで選んだフォルダとセッションのフォルダだけ。フォルダを変えたり画面を閉じたりしたら `folders.close` で閉じ、ファイルの監視も外します。
- 止まっているセッションは、選んだ時点で `claude --resume` で会話を再開します。
- 終了のダイアログの「Claude Code も止めて終了」は、pty ホストも止めます。動いているセッションが無いときも、聞かずに pty ホストまで止めて終わります。
- kill（SIGTERM）で止めたときも、ふつうの終了と同じく聞きます。もう一度送ると、聞かずに強制的に終わります（Claude Code は止まらない）。
- macOS の通知（`notify`）は、出したものをクリック・閉じる・失敗のどれかまで main で持っておきます（上限 50 件）。持っていないと、Electron が回収してしまい、クリックしても `click` が届きません（アプリは前に出ても、セッションが移らない）。
- worktree のセッション（`worktree.ts`・`SessionManager.createInWorktree`）
  - 名前は `tc-<月日>-<乱数 4 文字>`。場所は `<リポジトリのいちばん上>/.claude/worktrees/<名前>`、ブランチは `worktree-<名前>`（どちらも Claude Code の決まり。サブフォルダから始めても、いちばん上に作る。実測）。`SessionRecord.cwd` は worktree のフォルダ、`SessionRecord.worktree` に名前・ブランチ・元のフォルダを持ちます。
  - worktree を作るのは Claude Code（`claude --worktree`）。アプリが `git worktree add` して、ふつうに `claude` を起動する形にしないのは、Claude Code の隔離のチェックが効かないためです。
  - `sessions.create` は、Claude Code が worktree を作る（`.git` ができる）まで待ってから返します。右パネルとエディタが、すぐ worktree を開けるようにするためです。作れずに Claude Code が終わったら、記録を消して、そのときの画面を添えて断ります。
    - `claude --worktree` は、まだ信頼していないフォルダでは、信頼の確認を出さずに「Workspace trust not yet accepted」で終わります（実測）。そのときは、日本語の理由にして返します。
  - ファイルの監視は、worktree ができてから始めます（無いフォルダは見張れない）。
  - 準備の段階（`SessionWorktree.preparing`: creating・restoring・copying・installing）は、一覧とチャットに出します。準備が終わるまで `ready` を配信しないので、最初の指示はその後に送られます（`pendingSends` の今の形のまま）。終わったら、何をしたかを `info` のイベントでチャットに出します。
  - `node_modules`: `cp -c -R`（APFS のクローン）で複製し、`.vite`・`.cache` を消します。`package-lock.json` が元のフォルダと違えば `npm install`。クローンに失敗したら `npm install`。`yarn.lock`・`pnpm-lock.yaml`・`bun.lock(b)` があれば `npm install` はしません。
    - `npm install` は `ShellTerminals.run` でログインシェルから実行し（Finder から起動したアプリでも、ふだんの PATH の npm を使うため）、`shell.onOpened` でターミナルパネルにタブを出させます。タブは終わっても残し、終了コードを名前に添えます。
  - 元のフォルダの未追跡に `.claude/worktrees/` が出ないよう、`.gitignore` で無視されていなければ `.git/info/exclude`（`git rev-parse --git-path info/exclude`）に足します。リポジトリの `.gitignore` は書き換えません。
  - Claude Code は worktree に「claude session <名前> (pid …)」のロックを付け、プロセスを止めても残します。`--resume` では付け直しません（実測）。消すときは、この理由のロックだけ外し、ほかのロックがあれば消さずに断ります。
  - 削除: アーカイブ・一覧からの削除で `removeWorktree` を指定したときだけ。`ClaudeSession.stop` で Claude Code が終わるのを待ち、未コミットの変更と未追跡のファイルがあれば、一時的なインデックス（`GIT_INDEX_FILE`）で `read-tree HEAD` → `add -A` → `write-tree` → `commit-tree` して `refs/tanacode/backup/<名前>`（あれば `-2`・`-3`…）に残します。そのうえで `git worktree remove --force`。何も残っていなければ `--force` なし。最後に `git branch -d`（マージ済みのときだけ消える）。
    - 消す前の確認に出すもの（`worktreeLeftovers`）: 未コミットの変更と未追跡のファイルの数（`git status`）、プッシュしていないコミット（上流が無ければ、このブランチだけにあって、どのリモートにも無いコミット）、デフォルトブランチに入っていないコミット。
  - 作り直し: 削除したセッションを開くと、`git worktree add <場所> <ブランチ>`（ブランチが無ければ `-b` で今の HEAD から）で作り直してから、worktree のフォルダで `--resume` します。Claude Code は worktree を消したあとに再開すると、元のフォルダで「worktree の結び付きを外した」と言って続けるため（実測）、作り直してから起動します。
  - アプリが自分から worktree を消すことはありません（「Claude Code も止めて終了」でも消さない）。Claude Code の終了時の確認（残す・消す）は、アプリがプロセスを止めるので出ません。Claude Code の自動の掃除も、`--worktree` のセッションは対象外です。
- Remote Control の切り替えは、Claude Code が動いていればその場で `/remote-control` を送ります。以前つないでいた会話を再開すると、Claude Code はフラグが無くても勝手につなぎ直すので、オフのセッションでそうなったら、すぐに `/remote-control` で切ります。

### チャット

- 送った発言は、すぐチャットに出し、会話ログに書かれたら本物に置き換えます。Claude Code の作業中に送った発言は、今の作業が一区切りするまで会話ログに書かれません。
- 「作業中…」の横の進み具合は、Claude Code の画面のタイマーの行から読みます。順番待ちの発言があるあいだは、Claude Code がタイマーの行を出さないので、「作業中…」だけになります。
- Claude の思考は、会話ログに空で記録されるので出せません。設定（`showThinkingSummaries`）で要約を残させることはできますが、英語なので使っていません。
- 応答の文章は、書き終わるまで会話ログに書かれないので、チャットには書き終わってから出ます。
- 応答が来る前に Esc で中断すると、Claude Code は発言を会話から外して入力欄に戻し、会話ログには何も書きません（中断の行もターンの終わりの行も無い）。入力欄に戻った文字が、応答の無い最後の発言と同じなのを画面で見て、発言の表示を取り消し、ターンを終えます（`pulledBackPrompt`）。戻った文字は、チャットの入力欄に移します。
  - 次の発言は、外した発言より前の行を親にして書かれます。会話の最初の発言だったときは親が無い（null）ので、会話の始まりからの枝分かれとして読みます（`branchCut`）。
- Claude Code は新しい会話ログを作るとき、最初の応答の行を発言の行より先に書くことがあります。まとめて読んだ行のうち、親（`parentUuid`）が後ろにある行は、親のすぐ後ろに回して読みます（`parentFirst`）。
- ToDo は、今の Claude Code の TaskCreate・TaskUpdate（と、前の TodoWrite）を会話ログから読んで組み立てます。
- ツールの行の説明は、Bash・Agent などの `description`。
- 質問のカードでは、押した選択肢に枠を付けます。ターミナルのカーソルが選択肢を順に動く様子は出しません。答えが会話ログに書かれたら、画面の読み取りを待たずにカードを閉じます。答えたあとの画面がうまく読めないと、カードが残ってしまうためです。
- モデルの一覧は、Claude Code が持っている一覧の控え（`~/.claude/cache/model-catalog/`）から作ります。モデルやエフォートを変えると、`--model` / `--effort` を付けて起動し直し、会話を再開します。
- コンテキストの上限は、statusLine の値（1M かどうかも含めて正確な値）を使います。

### バックグラウンドの作業（タスク）

- 終わったエージェントに `SendMessage` で続きを頼んで再開したものは、別の実行として出します。完了の知らせは `SendMessage` の呼び出しに届き、会話は前と同じエージェントのログに続けて書かれます。
- ワークフローのフロー図の順番は、journal.jsonl の開始・終了の並びから読みます。途中から再開した実行でも、前の起動からの順番が分かります。子ワークフローは、`workflow()` で呼んだもの。
- 完了通知（`<task-notification>`）は、発言の行・作業中の差し込み（attachment）・順番待ち（queue-operation）の 3 つの形で書かれます。サブエージェントの使用量（所要時間・トークン数・ツールの回数）は、attachment の `usage` が無い形でも、本文の `<usage>` から読みます。
- バックグラウンドの Bash の出力ファイルは、一度に一つずつ読みます。読んでいる途中に完了通知が届いたら、読み終えてからもう一度読み、終了コードを読んでから終わったことにします（終了コードの行を読み落とさない・終了コードの無い「完了」を出さないため）。
- 許可の確認で、実行するコマンドを囲む点線は補足に入れません。通知の本文では、Claude Code の使い方の案内（`Tip:`）の行を除きます。

### ターミナル

- シェルは、セッションのフォルダでログインシェル（`$SHELL -l`）を開きます。
- アプリが実行するコマンド（worktree の `npm install`）は、`ShellTerminals.run` で `$SHELL -l -c` から実行し、`shell:opened` でタブを足させます。終わってもタブは残し（`ShellTab.task`）、閉じるボタンは画面のタブだけを片付けます。
- 「Claude Code」タブでは、Claude Code の生の画面（pty）を出します。見ているあいだだけ、画面の大きさをパネルに合わせます。閉じると元の大きさ（120×40）に戻します。

### 画面の上の帯

- 図案だけの元の画像は `design/logo-mark.png`（背景を透過したもの）。ロゴは、これと「tanacode」の文字を並べた `design/logo.png`。README は、どちらのテーマでも読める背景付きの `design/logo-banner.png` を使います。タイトルバーのロゴは `src/renderer/src/assets/logo.png`、アプリのアイコンは `build/icon-source.png` から `npm run icon` で作ります。新規セッションの画面に出す小さいアイコン（`src/renderer/src/assets/icon.png`）も、同じ `npm run icon` で作ります。
- バージョンは、ビルドのときに `package.json` の `version` を埋め込みます。
- バージョンの右には、新しいバージョンの印（`layout/AppUpdate.tsx`）。main の `app-update.ts` が、起動時と 1 時間ごとに GitHub の `releases/latest` を問い合わせ、`app.getVersion()` と比べます。`releases/latest` は公開済みのバージョンだけを返すので、Releases の下書きを公開した時点で知らせが出ます。開くページは、返事の `html_url` を使わずにバージョンから組み立てます。問い合わせは `net.fetch`（macOS のプロキシの設定が効く）。確かめられなかったときは前の結果のまま。メニューの「新しいバージョンが出たら通知する」でオフにすると、問い合わせを止めて印も消します。新しいバージョンの印は、目の端でも気づけるよう、見つけたときに動かします（まだ見ていなければ 1 時間ごとにも）。マウスを乗せた・押したバージョンは localStorage に残し、そのバージョンではもう動かしません。

## 読むもの・書くもの

### 読むもの

| 場所 | 使い道 |
| --- | --- |
| `~/.claude/projects/**/<id>.jsonl` | 会話・ツール・hooks・圧縮・読み書きしたファイル |
| `~/.claude/projects/**/<id>/subagents/`、`.../tasks/*.output` | サブエージェントの会話、バックグラウンドの Bash の出力 |
| `~/.claude/cache/model-catalog/*-cc.json` | モデルの一覧と、選べるエフォート |
| `~/.claude.json` の `cachedUsageUtilization` | 利用枠の控え（Claude Code で `/usage` を開いたときに残るもの。statusLine より新しいときだけ使う） |
| `.claude/commands`・`.claude/skills`（プロジェクトとホーム）、会話ログのスキル一覧 | `/` の候補 |
| worktree のセッションのリポジトリ（`git worktree list`・`git status`・`git rev-list`） | worktree を消す前に、残っているもの（未コミットの変更・未追跡のファイル・プッシュしていないコミット・デフォルトブランチに入っていないコミット）と、Claude Code のロック |
| `~/.claude/settings.json` | ユーザーの statusLine があるかどうか（読むだけ。プロジェクトの `.claude/settings*.json` は見ない） |
| 登録した設定ファイル（パスは `settings.json` の `settingsFiles`。多くは `~/.claude/settings-<名前>.json`） | 選んだセッションの起動で、アプリの設定と合わせて `--settings` に渡す（API キーを含むことがある） |
| `https://api.github.com/repos/sny-tanaka/tanacode/releases/latest` | tanacode の新しいバージョン（起動時・1 時間ごと。メニューの「新しいバージョンが出たら通知する」で止められる） |

### 書くもの

アプリのデータは、すべて `~/Library/Application Support/tanacode/` に置きます。

| ファイル | 中身 |
| --- | --- |
| `sessions.json` | セッション一覧（タイトル・フォルダ・モデル・Remote Control を使うかなど） |
| `settings.json` | アプリ自身の設定（macOS の通知を出すか・新しいバージョンが出たら通知するか。右上のベルと、メニューの「新しいバージョンが出たら通知する」で切り替える。登録した設定ファイルの名前とパス） |
| `statusline/<id>.json` | 各セッションの statusLine の最新の値 |
| `statusline/<id>.ask.json` | 各セッションで最後に出た AskUserQuestion の入力（フックが書く） |
| `session-settings/<id>.json` | 設定ファイルを選んだセッションの、アプリの設定と登録した設定を合わせたもの（`0600`。API キーを含むことがある。Claude Code が終わると消す） |
| `usage.json` | 最後に分かった利用枠 |

worktree のセッションでは、ユーザーの操作に合わせて、リポジトリに次のものを書き込みます。

| 場所 | いつ・何を |
| --- | --- |
| `.claude/worktrees/<名前>`・ブランチ `worktree-<名前>` | 始めるとき（作るのは Claude Code）。削除したセッションを戻すとき（作り直すのはアプリ） |
| `.git/info/exclude` | 始めるとき。`.claude/worktrees/` が `.gitignore` で無視されていなければ、`/.claude/worktrees/` を足す |
| `.claude/worktrees/<名前>/node_modules` | 始めるとき・作り直したとき。元のフォルダの `node_modules` の APFS のクローンと `npm install` |
| `refs/tanacode/backup/<名前>` | worktree を削除するとき。未コミットの変更と未追跡のファイルの控えのコミット |
| worktree・マージ済みのブランチ・Claude Code のロックを消す | worktree を削除してアーカイブ・一覧から削除するとき |

次のものは変更しません。

- ユーザーのリポジトリ: エディタでの保存や、ソース管理パネルでの操作、worktree のセッションの作成・削除をしたときだけ書き込みます。
- Claude Code の設定: `~/.claude/settings.json`、`~/.claude.json`、認証情報などには書き込みません。

## ソースの構成

- `src/main`: Electron のメインプロセス
  - `session-manager.ts` / `session-store.ts`: セッションの作成・再開・アーカイブ・再起動・通知と、一覧の保存
  - `claude-session.ts`: pty ホストに `claude` を起動させる・引き継ぐ（起動オプション・statusLine と質問のフックの注入）
  - `worktree.ts`: worktree のセッション（名前と場所・`.git/info/exclude`・`node_modules` の用意・残っているもの・控えを残して消す・作り直す）
  - `worktree-guard.ts`: worktree やブランチを消す操作で、許可の確認を出させる hooks（awk）
  - `settings-files.ts`: 登録した設定ファイルの管理（登録・名前の変更・削除）と、アプリの設定との合成
  - `pty-host.ts` / `pty-host-client.ts` / `pty-host-protocol.ts`: Claude Code を持っておく常駐プロセスと、アプリからの接続（`SessionManager` と `ClaudeSession` が使う形は `PtyHostApi`・`PtyHandle`。互換性の確認では偽物に差し替える）
  - `transcript-follower.ts` / `transcript-tail.ts`: 会話ログ（JSONL）を追いかけて読む
  - `screen-tracker.ts` / `screen-parser.ts`: pty の画面を仮想の端末で再現し、選択メニューを読み取る
  - `subagent-tracker.ts` / `workflow-tracker.ts` / `bash-task-tracker.ts`: サブエージェント・ワークフロー・バックグラウンドの Bash の進み具合
  - `task-router.ts`: 会話ログの行を、上の 3 つと質問の画面に振り分ける（互換性の確認でも同じものを使う）
  - `knowledge-tracker.ts`: Claude が読んだ・書いたファイルと、コンテキストの使用量
  - `statusline.ts` / `usage-monitor.ts` / `model-catalog.ts`: statusLine・利用枠・モデル一覧
  - `claude-version.ts`: 入っている Claude Code のバージョン（`claude --version`。起動時・10 分ごと・ウィンドウを前に出したとき）
  - `commands.ts`: `/` の候補（組み込みコマンド・カスタムコマンド・スキル）
  - `workspace.ts` / `workspace-watcher.ts`: ファイルツリー・読み書き・全文検索・変更の監視
  - `git.ts` / `source-control.ts`: git CLI とソース管理の操作（ブランチの基点・デフォルトブランチの判定と、基点からの変更）
  - `system-monitor.ts`: CPU・メモリの使用量
  - `shell-terminals.ts`: ターミナルパネルのシェル（node-pty）と、アプリが実行するコマンドのタブ（worktree の `npm install`）
  - `app-settings.ts`: アプリ自身の設定（通知のオン・オフ、新しいバージョンが出たら通知するか、登録した設定ファイル）の保存
  - `app-update.ts`: tanacode の新しいバージョン（GitHub の Releases。起動時・1 時間ごと）
  - `notice-text.ts`: 通知の本文（確認待ちは、質問文や実行しようとしている内容を短くして出す）
- `src/preload`: renderer に `window.tanacode` の API を公開する
- `.storybook`: 画面の部品のカタログ（Storybook）。`window.tanacode` は何もしないモックに差し替えます（`mockApi.ts`）。ストーリーで返事を決めたいときは、ストーリーの `beforeEach` で `mockApi({ 'settingsFiles.list': () => … })` のように呼びます（返事は、ストーリーごとに捨てます）。ストーリーは部品の隣の `*.stories.tsx`
- `src/renderer/src`: React の UI
  - `chat/`: Claude Code ペイン（チャット・入力欄・ツールカード・hooks）
  - `review/`, `scm/`: 行コメント・差分・ソース管理（ブランチの変更。変更の見せ方の一覧 / ツリーは `scmView.ts` で localStorage に保つ）
  - `tasks/`, `workflow/`: バックグラウンドの作業のトレイ・一覧と中身の表示
  - `editor/`, `explorer/`, `search/`: エディタ・Markdown プレビュー・ファイルツリー・検索
  - `terminal/`: ターミナルパネル（シェル・Claude Code の生の画面）
  - `preview/`: アプリ内ブラウザ（webview・要素の選択。画面では「ブラウザ」）
  - `sessions/`, `usage/`, `system/`, `knowledge/`, `layout/`: セッション一覧（worktree の削除の確認は `WorktreeDialog.tsx`）・利用枠・CPU/メモリ・コンテキスト・カラム
  - `notifications/`: 通知のオン・オフ（タイトルバーのベル）
  - `demo/`: README のデモ動画の作り物のデータと台本（下の「デモ動画の仕組み」）
- `src/shared`: IPC の型と、会話ログからチャットへの変換（`chat.ts`）、Claude Code の入力欄に打ち込む文字（`prompt-keys.ts`。複数行はブラケットペースト）、tanacode で動作確認済の Claude Code のバージョン（`claude-code.ts`）、ソース管理の変更をフォルダごとのツリーにする並べ方（`scm-tree.ts`。フォルダが先・子がフォルダ 1 つだけなら 1 行にまとめる）
- `design/`: アプリのロゴ
- `scripts/`: アイコン・ライセンス表示の生成、node-pty の実行権限の修正、デモ動画の録画、動作確認済の Claude Code のバージョンの書き換え
- `test/`: Claude Code との互換性の確認（上の「Claude Code との互換性の確かめ方」）
  - `scenario.ts`: 台本と、アプリが読み取れるべきもの
  - `scenarios/`: 基本でない台本と、アプリが読み取れるべきもの（`questions.ts`: AskUserQuestion、`errors.ts`: 失敗と中断、`input.ts`: 入力まわりと読み取り）
  - `cli/`: 本物の `claude` を動かす確認（`basic`・`background`・`session`・`adopt`・`questions`・`errors`・`input`・`worktree` の台本）と、モックの API（`mock-api.ts`）・本物の `SessionManager` で `claude` を動かす部品（`claude-run.ts`）・node-pty を直に使う pty ホストの代わり（`fake-pty-host.ts`）
  - `recorded.test.ts` / `fixtures/claude-code/`: 控えと、控えを読む確認
  - `bash-task-tracker.test.ts` / `notification.test.ts` / `screen-tracker.test.ts`: 読み取りの部品の単体の確認（出力ファイルの読み込みと完了通知の重なり、通知の本文、完了通知の使用量、権限モードの切り替えのキー）
  - `app-update.test.ts`: 新しいバージョンの確認（Releases の返事の読み取り・バージョンの比べ方・確かめられなかったときと止めたとき）
  - `settings-files.test.ts`: 設定ファイルの切り替え（登録・名前の変更・削除、設定の合成、合わせたファイルの権限と後始末、起動引数）
  - `worktree.test.ts`: worktree のセッションの、アプリが受け持つところ（名前と場所・`.git/info/exclude`・残っているもの・控えを残して消す・ロック・作り直す・`node_modules`。本物の git で）
  - `worktree-guard.test.ts`: worktree やブランチを消す操作の歯止めの hooks（確認を出させるもの・出させないもの）

## デモ動画の仕組み

- README の動画は、本物の Claude Code ではなく、作り物のデータと台本で録ります。会社の情報やユーザー名の入ったパスなどが映らず、UI を直したあとも同じ動きで録り直せます。
- `src/renderer/src/demo/`
  - `backend.ts`: アプリの API（`window.tanacode`）の作り物。ファイル・git・会話・画面の状態をメモリに持ちます
  - `director.ts`: 画面に作り物のマウスカーソルを描いて、移動・ホバー・クリック・文字入力をします（録画には OS のカーソルが映らないため）
  - `data.ts`: デモ用のプロジェクト（カフェのメニューを出す小さな React のアプリ）
  - `webview.ts`: アプリ内ブラウザの `<webview>` の代わり。Storybook では webview が動かないので、iframe で作り物のページを出します
  - `scenarios/`: 動画ごとの台本。`claude.ts` は、ツールの呼び出しと結果を会話に足す作り物の Claude
  - `Demo.stories.tsx`: Storybook の「デモ」。ここで台本を流して見られます
- 動画は 6 本。
  - `基本`: Claude Code がもともと持つ機能（チャット・ツール・質問・バックグラウンドの作業・エディタ）の見せ方
  - `レビュー`: ブランチの変更をプルリクエストのように見て、差分の行にコメントを付けて直してもらう
  - `ワークフロー`: ワークフローの実行を、概要のフロー図とエージェントごとの会話で追う
  - `複数のセッション`: 並行して動くセッションの状態を、一覧の印と文言で追う
  - `プレビュー`: 開発中のページをアプリの中で開き、要素を選んで直してもらう
  - `見える化`: Claude が知っている範囲・コンテキスト・hooks・利用枠
- 録り方: 先に `npm run storybook` を起動し、ffmpeg を入れておきます。`npm run demo:record -- 基本` で `demo-videos/基本.mp4` ができます。`基本` の代わりに、上の動画の名前を渡します。
- `scripts/record-demo.mjs` が、Storybook の「デモ」のストーリーを Electron の画面の外で描きます。描き直しのたびに時刻付きでコマを保存し、ffmpeg で MP4 にします。動画は実時間どおりの長さになります。
  - 1440×900 の画面を 1.5 倍の解像度（2160×1350）で描きます。
  - `ワークフロー` はフロー図を全部入れるため、2000×1250 の画面を 1.08 倍で描きます。出来上がりの大きさはほかと同じ（`SIZES`）。
- README の動画は、GitHub にアップロードした動画の URL を貼っています。リポジトリに置いた MP4 は、GitHub が README の中で再生しないためです。

## ライセンスの表示

- ビルドすると、アプリに入れて配る依存のライセンスを `out/renderer/THIRD_PARTY_NOTICES.txt` にまとめます。作り方は `scripts/third-party-notices.ts`。
  - 画面に同梱した依存は rollup-plugin-license で集めます。CSS だけを読み込むフォントと、main が使う依存（node_modules ごと入るもの）は書き足します。
  - GPL 系のライセンスや、ライセンスの分からない依存が混ざると、ビルドが止まります。
- アプリの `Contents/Resources/` には、この表示と一緒に、tanacode の `LICENSE.txt`、Electron と Chromium のライセンスも入れます。
