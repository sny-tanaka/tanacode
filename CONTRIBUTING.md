# tanacode の開発

tanacode をソースから動かす方法と、仕組み・ソースの構成のまとめ。使い方は [GUIDE.md](GUIDE.md) に。

- [貢献の流れ](#貢献の流れ)
- [始め方](#始め方)
- [書き方の決まり](#書き方の決まり)
- [見た目の確かめ方](#見た目の確かめ方)
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
- 出す前に `npm run typecheck`。画面を変えたときは Storybook で確かめ、PR にスクリーンショットを添付
- 自動テストはまだ無し

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
| `npm run storybook` | 画面の部品を、アプリを起動せずにブラウザで見る（http://localhost:6006） |
| `npm run dist` | ビルドする Mac に合わせて `dist/mac-arm64/tanacode.app`（Intel の Mac では `dist/mac/tanacode.app`）を作る（署名なし） |
| `npm run install-app` | `npm run dist` のあと、`/Applications/tanacode.app` に入れ替える（下の「ソースからビルドして使う」） |
| `npm run demo:record -- <動画の名前>` | README のデモ動画を録る（下の「デモ動画の仕組み」） |

### ソースからビルドして使う

`npm install` のあと `npm run install-app` を実行すると、ビルドして「アプリケーション」フォルダに入れます。手元でビルドしたものは、ダウンロードの印が付かないので `xattr` のコマンドは不要。

- 動いているアプリの上に上書きせず、隣にコピーしてから名前の付け替えで入れ替えます。動いているアプリと Claude Code は、そのまま動き続けます。
- 終了のダイアログで「動かしたまま終了」を選んで起動し直すと、新しい版になります。

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

## 仕組み

### Claude Code の動かし方

- セッションごとに、node-pty で本物の `claude` を起動します。
  - 起動するのはアプリではなく、pty ホストという常駐プロセス。アプリを再起動しても Claude Code を止めないためです。
    - アプリが Electron を Node として（`ELECTRON_RUN_AS_NODE`）、アプリと切り離して起動します。macOS では Dock にアイコンが出ないよう、同梱の `tanacode Helper.app` の実行ファイルを使います。アプリとは userData の Unix ソケットでやりとりします。パスが長すぎるときは一時フォルダに置きます。
    - ホストは Claude Code の画面を仮想の端末で持っています。起動し直したアプリは、その画面（`@xterm/addon-serialize`）と、Claude Code が起動した時刻を受け取って引き継ぎます。その時刻より後の会話ログの行は、今も動いている Claude Code が書いたものとして扱います。途中のターン・バックグラウンドのタスク・質問は、終わったことにせず、そのまま追いかけます。
    - アプリも Claude Code も無くなって 10 秒たつと、ホストは自分で終わります。
    - やりとりの形を変えたら、`pty-host-protocol.ts` の `PROTOCOL` を上げます。起動したアプリは、形の違う古いホストを Claude Code ごと止めて、起動し直します。止まったセッションは `--resume` で再開します。ホストのログは userData の `pty-host.log`。
  - 新しい会話には `--session-id <uuid>` を、再開には `--resume <id>` を付けます。
  - Remote Control をオンにしたセッションは、`--remote-control tanacode-<フォルダ名>` を付けます（開発版を除く）。
  - モデル・エフォート・権限モードを選んだときは、`--model` / `--effort` / `--permission-mode` も付けます。ユーザーの既定値（`~/.claude/settings.json`）は変えません。
- チャットは pty の画面ではなく、会話ログから組み立てます。会話ログは `~/.claude/projects/<フォルダ>/<id>.jsonl`。`/clear` で会話が切り替わっても追いかけます。
  - `/clear` のあとの会話ログは、statusLine の `transcript_path` で分かります（Remote Control を使っていなくても追える）。Remote Control を使っていれば、新しい会話ログにも同じ `bridge-session` の ID が書かれるので、それでも追います。
  - Remote Control のつながりは、会話ログの `bridge_status`（URL）と `bridge-session`（ID。切ると空になる）の行で分かります。以前つないでいた会話を再開して勝手につなぎ直したときは、`bridge-session` の行だけが書かれます。
  - 会話ログは、変更の通知（`fs.watch`）ですぐ読みます。取りこぼしに備えて、0.15 秒ごとにも確かめます。
  - 作業中に送った発言は、会話ログの順番待ちの行（`queue-operation`）から読みます。
- 選択メニュー（質問・許可の確認・巻き戻し）だけは、pty の画面を仮想の端末で再現して読み取ります。選んだ答えは ↑/↓ と Enter のキー入力にして送ります。
  - AskUserQuestion の質問文・選択肢・説明・プレビューは、その入力から取ります。画面からは、カーソルの位置・チェック・「その他」に打った文字・どの質問のページかだけを読みます。画面が低いと Claude Code は選択肢の一部しか出さないためです。
  - 今の Claude Code は、AskUserQuestion の行を答えたあとで会話ログに書きます。そこで、質問を出す前の PreToolUse のフックで、入力をセッションごとのファイルに書かせて読みます（下の `--settings`）。フックが無い（前の版のアプリが起動した）Claude Code では、画面から組み立てます。質問文は縦線（│）の枠で端末の幅に折り返して出るので、縦線を外して行をつなぎ直します。
- アプリが起動する Claude Code にだけ、`--settings` で statusLine を足します。
  - Claude Code は応答のたびに JSON を渡してきます。中身はモデル・コンテキストの上限と使用率・利用枠・今の会話ログのパス。これをセッションごとのファイルに書かせて読みます。
  - ユーザー自身が `~/.claude/settings.json` で statusLine を設定していれば、同じ JSON をそちらにも渡します。プロジェクトの設定（`.claude/settings*.json`）の statusLine は写しません。clone したリポジトリのコマンドを、フォルダの信頼の確認の前にフラグの設定として動かさないためです。このセッションでは `--settings` の statusLine が優先されるので、プロジェクトの statusLine は動きません。
- 同じく `--settings` で、AskUserQuestion の PreToolUse のフックを足します。質問の入力をセッションごとのファイルに書かせるだけで、何も止めません。ユーザー自身のフックは、これまでどおり一緒に動きます。このフックはチャットのフックの一覧に出しません。
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
- Remote Control の切り替えは、Claude Code が動いていればその場で `/remote-control` を送ります。以前つないでいた会話を再開すると、Claude Code はフラグが無くても勝手につなぎ直すので、オフのセッションでそうなったら、すぐに `/remote-control` で切ります。

### チャット

- 送った発言は、すぐチャットに出し、会話ログに書かれたら本物に置き換えます。Claude Code の作業中に送った発言は、今の作業が一区切りするまで会話ログに書かれません。
- 「作業中…」の横の進み具合は、Claude Code の画面のタイマーの行から読みます。順番待ちの発言があるあいだは、Claude Code がタイマーの行を出さないので、「作業中…」だけになります。
- Claude の思考は、会話ログに空で記録されるので出せません。設定（`showThinkingSummaries`）で要約を残させることはできますが、英語なので使っていません。
- 応答の文章は、書き終わるまで会話ログに書かれないので、チャットには書き終わってから出ます。
- ToDo は、今の Claude Code の TaskCreate・TaskUpdate（と、前の TodoWrite）を会話ログから読んで組み立てます。
- ツールの行の説明は、Bash・Agent などの `description`。
- 質問のカードでは、押した選択肢に枠を付けます。ターミナルのカーソルが選択肢を順に動く様子は出しません。答えが会話ログに書かれたら、画面の読み取りを待たずにカードを閉じます。答えたあとの画面がうまく読めないと、カードが残ってしまうためです。
- モデルの一覧は、Claude Code が持っている一覧の控え（`~/.claude/cache/model-catalog/`）から作ります。モデルやエフォートを変えると、`--model` / `--effort` を付けて起動し直し、会話を再開します。
- コンテキストの上限は、statusLine の値（1M かどうかも含めて正確な値）を使います。

### バックグラウンドの作業（タスク）

- 終わったエージェントに `SendMessage` で続きを頼んで再開したものは、別の実行として出します。完了の知らせは `SendMessage` の呼び出しに届き、会話は前と同じエージェントのログに続けて書かれます。
- ワークフローのフロー図の順番は、journal.jsonl の開始・終了の並びから読みます。途中から再開した実行でも、前の起動からの順番が分かります。子ワークフローは、`workflow()` で呼んだもの。

### ターミナル

- シェルは、セッションのフォルダでログインシェル（`$SHELL -l`）を開きます。
- 「Claude Code」タブでは、Claude Code の生の画面（pty）を出します。見ているあいだだけ、画面の大きさをパネルに合わせます。閉じると元の大きさ（120×40）に戻します。

### 画面の上の帯

- 図案だけの元の画像は `design/logo-mark.png`（背景を透過したもの）。ロゴは、これと「tanacode」の文字を並べた `design/logo.png`。README は、どちらのテーマでも読める背景付きの `design/logo-banner.png` を使います。タイトルバーのロゴは `src/renderer/src/assets/logo.png`、アプリのアイコンは `build/icon-source.png` から `npm run icon` で作ります。新規セッションの画面に出す小さいアイコン（`src/renderer/src/assets/icon.png`）も、同じ `npm run icon` で作ります。
- バージョンは、ビルドのときに `package.json` の `version` を埋め込みます。

## 読むもの・書くもの

### 読むもの

| 場所 | 使い道 |
| --- | --- |
| `~/.claude/projects/**/<id>.jsonl` | 会話・ツール・hooks・圧縮・読み書きしたファイル |
| `~/.claude/projects/**/<id>/subagents/`、`.../tasks/*.output` | サブエージェントの会話、バックグラウンドの Bash の出力 |
| `~/.claude/cache/model-catalog/*-cc.json` | モデルの一覧と、選べるエフォート |
| `~/.claude.json` の `cachedUsageUtilization` | 利用枠の控え（Claude Code で `/usage` を開いたときに残るもの。statusLine より新しいときだけ使う） |
| `.claude/commands`・`.claude/skills`（プロジェクトとホーム）、会話ログのスキル一覧 | `/` の候補 |
| `~/.claude/settings.json` | ユーザーの statusLine があるかどうか（読むだけ。プロジェクトの `.claude/settings*.json` は見ない） |

### 書くもの

アプリのデータは、すべて `~/Library/Application Support/tanacode/` に置きます。

| ファイル | 中身 |
| --- | --- |
| `sessions.json` | セッション一覧（タイトル・フォルダ・モデル・Remote Control を使うかなど） |
| `settings.json` | アプリ自身の設定（今は、macOS の通知を出すか。右上のベルで切り替える） |
| `statusline/<id>.json` | 各セッションの statusLine の最新の値 |
| `statusline/<id>.ask.json` | 各セッションで最後に出た AskUserQuestion の入力（フックが書く） |
| `usage.json` | 最後に分かった利用枠 |

次のものは変更しません。

- ユーザーのリポジトリ: エディタでの保存や、ソース管理パネルでの操作をしたときだけ書き込みます。
- Claude Code の設定: `~/.claude/settings.json`、`~/.claude.json`、認証情報などには書き込みません。

## ソースの構成

- `src/main`: Electron のメインプロセス
  - `session-manager.ts` / `session-store.ts`: セッションの作成・再開・アーカイブ・再起動・通知と、一覧の保存
  - `claude-session.ts`: pty ホストに `claude` を起動させる・引き継ぐ（起動オプション・statusLine と質問のフックの注入）
  - `pty-host.ts` / `pty-host-client.ts` / `pty-host-protocol.ts`: Claude Code を持っておく常駐プロセスと、アプリからの接続
  - `transcript-follower.ts` / `transcript-tail.ts`: 会話ログ（JSONL）を追いかけて読む
  - `screen-tracker.ts` / `screen-parser.ts`: pty の画面を仮想の端末で再現し、選択メニューを読み取る
  - `subagent-tracker.ts` / `workflow-tracker.ts` / `bash-task-tracker.ts`: サブエージェント・ワークフロー・バックグラウンドの Bash の進み具合
  - `knowledge-tracker.ts`: Claude が読んだ・書いたファイルと、コンテキストの使用量
  - `statusline.ts` / `usage-monitor.ts` / `model-catalog.ts`: statusLine・利用枠・モデル一覧
  - `commands.ts`: `/` の候補（組み込みコマンド・カスタムコマンド・スキル）
  - `workspace.ts` / `workspace-watcher.ts`: ファイルツリー・読み書き・全文検索・変更の監視
  - `git.ts` / `source-control.ts`: git CLI とソース管理の操作（ブランチの基点・デフォルトブランチの判定と、基点からの変更）
  - `system-monitor.ts`: CPU・メモリの使用量
  - `shell-terminals.ts`: ターミナルパネルのシェル（node-pty）
  - `app-settings.ts`: アプリ自身の設定（今は通知のオン・オフ）の保存
  - `notice-text.ts`: 通知の本文（確認待ちは、質問文や実行しようとしている内容を短くして出す）
- `src/preload`: renderer に `window.tanacode` の API を公開する
- `.storybook`: 画面の部品のカタログ（Storybook）。`window.tanacode` は何もしないモックに差し替えます（`mockApi.ts`）。ストーリーは部品の隣の `*.stories.tsx`
- `src/renderer/src`: React の UI
  - `chat/`: Claude Code ペイン（チャット・入力欄・ツールカード・hooks）
  - `review/`, `scm/`: 行コメント・差分・ソース管理（ブランチの変更）
  - `tasks/`, `workflow/`: バックグラウンドの作業のトレイ・一覧と中身の表示
  - `editor/`, `explorer/`, `search/`: エディタ・Markdown プレビュー・ファイルツリー・検索
  - `terminal/`: ターミナルパネル（シェル・Claude Code の生の画面）
  - `preview/`: アプリ内プレビュー（webview・要素の選択）
  - `sessions/`, `usage/`, `system/`, `knowledge/`, `layout/`: セッション一覧・利用枠・CPU/メモリ・コンテキスト・カラム
  - `notifications/`: 通知のオン・オフ（タイトルバーのベル）
  - `demo/`: README のデモ動画の作り物のデータと台本（下の「デモ動画の仕組み」）
- `src/shared`: IPC の型と、会話ログからチャットへの変換（`chat.ts`）
- `design/`: アプリのロゴ
- `scripts/`: アイコン・ライセンス表示の生成、node-pty の実行権限の修正、デモ動画の録画

## デモ動画の仕組み

- README の動画は、本物の Claude Code ではなく、作り物のデータと台本で録ります。会社の情報やユーザー名の入ったパスなどが映らず、UI を直したあとも同じ動きで録り直せます。
- `src/renderer/src/demo/`
  - `backend.ts`: アプリの API（`window.tanacode`）の作り物。ファイル・git・会話・画面の状態をメモリに持ちます
  - `director.ts`: 画面に作り物のマウスカーソルを描いて、移動・ホバー・クリック・文字入力をします（録画には OS のカーソルが映らないため）
  - `data.ts`: デモ用のプロジェクト（カフェのメニューを出す小さな React のアプリ）
  - `webview.ts`: アプリ内プレビューの `<webview>` の代わり。Storybook では webview が動かないので、iframe で作り物のページを出します
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
