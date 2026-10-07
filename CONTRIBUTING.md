# tanacode の開発

tanacode をソースから動かす方法と、仕組み・ソースの構成のまとめ。使い方は [GUIDE.md](GUIDE.md) に。

- [貢献の流れ](#貢献の流れ)
- [始め方](#始め方)
- [書き方の決まり](#書き方の決まり)
- [見た目の確かめ方](#見た目の確かめ方)
- [テストと CI](#テストと-ci)
- [Claude Code との互換性の確かめ方](#claude-code-との互換性の確かめ方)
- [仕組み](#仕組み)
- [機能ごとの実装メモ](#機能ごとの実装メモ)
- [読むもの・書くもの](#読むもの書くもの)
- [ソースの構成](#ソースの構成)
- [デモのサイト](#デモのサイト)
- [README の紹介画像](#readme-の紹介画像)
- [ライセンスの表示](#ライセンスの表示)

## 貢献の流れ

- 不具合・要望は、まず Issue へ。大きな変更は、実装の前に Issue で相談
- 脆弱性は Issue ではなく [SECURITY.md](SECURITY.md) の手順で
- PR は `develop` ブランチへ
- 出す前に `npm run typecheck` と `npm test`（PR の CI で流すものは「テストと CI」）。画面を変えたときは Storybook で確かめ、PR にスクリーンショットを添付
- 画面・会話ログ・statusLine の読み取りを変えたときは、`npm run test:cli` も（下の「Claude Code との互換性の確かめ方」）
- 画面の操作や、Claude Code・MCP・ターミナルとのつなぎを変えたときは、`npm run build` してから `npm run test:e2e` も（下の「アプリの通しのテスト（E2E）」）

## 始め方

必要なもの: macOS 13 以降・Node.js 22・`claude` CLI（初回のセットアップを済ませたもの）・Xcode Command Line Tools（翻訳の補助プログラムを作る `swiftc`。無くてもビルドは進み、翻訳のボタンが出ないだけ）

`npm run dev`・`npm run build`・`npm run dist` は、始める前に翻訳の補助プログラム（`build/native/tanacode-translate`）を作ります（`predev`・`prebuild`・`predist`。下の「翻訳」）。

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
| `npm run test:e2e` | ビルドしたアプリを起動して、画面の操作から Claude Code・MCP・ターミナルまで通しで確かめる（先に `npm run build`。下の「アプリの通しのテスト（E2E）」） |
| `npm run coverage` / `npm run coverage:cli` | `npm test` / `npm run test:cli` と同じテストで、カバレッジを測る（下の「テストと CI」） |
| `npm run coverage:e2e` | `npm run test:e2e` と同じテストで、カバレッジを測る（先に `TANACODE_SOURCEMAP=1 npm run build`。下の「アプリの通しのテスト（E2E）」） |
| `npm run coverage:report` | 測ったカバレッジを合わせて層ごとに出し、下限を下回っていないか確かめる |
| `npm run coverage:unpressed` | 測ったカバレッジから、テストが一度も押していない画面のボタン・入力を出す（下の「押していないボタン・入力」） |
| `npm run storybook` | 画面の部品を、アプリを起動せずにブラウザで見る（http://localhost:6006） |
| `npm run dist` | ビルドする Mac に合わせて `dist/mac-arm64/tanacode.app`（Intel の Mac では `dist/mac/tanacode.app`）を作る（署名は下の「署名」） |
| `npm run install-app` | `npm run dist` のあと、`/Applications/tanacode.app` に入れ替える（下の「ソースからビルドして使う」） |
| `npm run screenshot` | README の紹介画像（`design/screenshot.png`）を撮る（下の「README の紹介画像」） |
| `npm run demo:dev` / `npm run demo:build` | ブラウザで動くデモのサイトを開く（http://localhost:5180）/ `demo-site/` に書き出す（下の「デモのサイト」） |
| `npm run demo:check` | デモのサイトのツアーが最後まで流れるかを確かめる（先に待ち時間 0 でビルドしておく。下の「デモのサイト」） |

### ソースからビルドして使う

`npm install` のあと `npm run install-app` を実行すると、ビルドして「アプリケーション」フォルダに入れます。手元でビルドしたものは、ダウンロードの印が付かないので `xattr` のコマンドは不要。

- 動いているアプリの上に上書きせず、隣にコピーしてから名前の付け替えで入れ替えます。動いているアプリと Claude Code は、そのまま動き続けます。
- 終了のダイアログで「動かしたまま終了」を選んで起動し直すと、新しいバージョンになります。

### 署名

アプリの署名は、自己署名の証明書「tanacode Code Signing」です。ad-hoc で署名すると、アプリの要件がビルドごとの cdhash（`designated => cdhash H"…"`）になり、macOS がビルドのたびに別のアプリとして扱います（フォルダへのアクセス・通知・キーチェーンなどの許可を、毎回聞き直される）。証明書で署名すると、要件が `identifier "dev.tanacode.app" and certificate leaf = H"…"` になり、ビルドをまたいで同じアプリとして扱われます。

- `npm run dist`・`npm run release` は、`scripts/electron-builder.mjs` を通して electron-builder を動かします。証明書がコード署名として信頼された状態でキーチェーンにあれば、その SHA-1 を `-c.mac.identity` に渡し、無ければ ad-hoc（`-`）で署名します。どちらで署名したかは、ビルドの最初に表示されます。
- `npm run release` と `release.yml` は `--require` 付きで、証明書が無いと止まります（配布物を、うっかり ad-hoc で作らないため）。
- `release.yml` は、環境 `release` の Secrets（`develop` のブランチと `v*` のタグからの実行だけに許している）の `MACOS_SIGNING_P12_BASE64`（p12 を base64 にしたもの）と `MACOS_SIGNING_P12_PASSWORD` から、証明書を一時のキーチェーンに取り込んで署名します。タグを付ける前に、アプリ（と翻訳の補助プログラム）の要件に証明書の SHA-1 が入っているかを確かめます。
- Apple の署名・公証はしていません。ダウンロードしたアプリには macOS の警告が出ます（README の手順）。pkg は署名していません。
- 自分の Mac で試すだけなら、証明書は要りません（ad-hoc で署名します）。ビルドしても許可を残したいときは、キーチェーンアクセスの「証明書アシスタント → 証明書を作成」で、名前を `tanacode Code Signing`・アイデンティティのタイプを「自己署名ルート」・証明書のタイプを「コード署名」にして作ります。信頼されていないと表示されたら、証明書を開き、「信頼」の「コード署名」を「常に信頼」にします。

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
- 画面の場所の呼び方は、文書と画面の文言でそろえます。左端の縦並びのアイコン（サイドパネルの切り替えと、ブラウザ・ターミナルの開閉）は「アクティビティバー」、画面の下の帯は「ステータスバー」。hooks は「hooks」と書きます（画面の畳んだ行の表示は「フック N件」）。
- 整形ツール（prettier など）の設定は無し。まわりのコードの書き方に合わせます。
- AI のエージェント向けの決まりは [AGENTS.md](AGENTS.md) にあります。
- 決まった手順は、Claude Code のスキルとして `.claude/skills/` に。リリース（`/release`）・セキュリティ対応（`/security`）・ソースから入れたアプリの更新（`/update-app`）の 3 つ。リリースはメンテナーだけが行います。手元のほか、Claude Code の cloud のセッションからも、Actions の手動の起動（`release.yml`・`release-publish.yml`）で行えます。
- 公開すると、`release-publish.yml` から呼ぶ `homebrew.yml` が、Homebrew の tap（[sny-tanaka/homebrew-tanacode](https://github.com/sny-tanaka/homebrew-tanacode)）の cask の `version` と `sha256` を新しいバージョンにします。プッシュの前に、ランナーの Mac でその cask から実際に入れ、バージョンと、quarantine 属性が外れることを確かめます。tap への書き込みは GitHub App の token（tap の Contents の書き込みだけ・1 時間で失効）。同じ App を、動作確認済の Claude Code を上げる PR にも使います（下の「Claude Code との互換性の確かめ方」）。App の Client ID と秘密鍵は、develop でしか使えない Environment「homebrew」の `HOMEBREW_TAP_APP_CLIENT_ID`（変数）と `HOMEBREW_TAP_APP_PRIVATE_KEY`（シークレット）に置きます。失敗したときは、develop で `homebrew.yml` を手動で起動し直します。

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

### アイコン

アイコンは、すべて自作の線画を `src/renderer/src/icons/` に集めています。外部のアイコン集（Lucide・Feather・Codicon・Material など）の SVG は、写しもなぞりもしません。出どころを 1 つにして、絵柄とライセンスをそろえるためです。新しく足すときも、白紙から描きます。

#### 使い方の決まり

- アイコンは `icons/` から読みます（`import { CloseIcon, IconButton } from '../icons'`）。`<svg>` は `icons/` の外に書かず、文字・記号（× ＋ ↻ ▸ など）もアイコン代わりに使いません。
- 名前は意味で付けます（`ReloadIcon`・`CloseIcon`・`AddIcon`。見た目の名前にはしません）。**1 つの意味に 1 つのアイコン**にします。更新・再読み込み・もう一度・再起動は同じ `ReloadIcon`、閉じる・外す・取り消すは同じ `CloseIcon`、展開は `DisclosureIcon`。同じ意味のものを別に描かないでください。意味が違うものは、絵も分けます（ターミナルのパネルは `TerminalIcon`、Claude Code の画面は `MonitorIcon`）。
- 大きさは 12・14・16・22 の 4 段階だけ（`IconSize`）。22 はアクティビティバー、16 はトグルやヘッダー、14 はボタン（`IconButton` の `md`）とチップ、12 は行の中・タブ・ステータスバー（`IconButton` の `sm`）で使います。
- アイコンだけのボタンは、`IconButton` で作ります。名前（`label`）は読み上げ（`aria-label`）とツールチップ（`data-tip`）の両方に付き、補足があれば `tip` に書きます。見た目は `.icon-button` の 1 か所で決めます（枠の大きさは `sm` の 20px と `md` の 26px）。実行中は `busy`、トグルは `pressed`、元に戻せない・止める操作は `danger`。行や見出しにホバーしたときだけ出すボタンは、`reveal` を付け、親の要素に `reveal-host` を付けます。
- 主な操作（送信・コミット・コメントを追加）は、`IconButton` の `primary`（主要ボタンと同じ色と枠）にします。送信は紙飛行機、コミットは履歴の線の上の丸、コメントを追加は ＋。
- 文字のまま残すもの: 状態のカードの主な操作（再開・アクティブに戻す・ターミナルで操作）、質問カードの確定（決定・送信・次の質問へ）、元に戻せない操作の確認（保存の競合の 2 択・worktree の削除）、取り込みの入口（「既存の会話を開く…」）、ブランチ名・フォルダ名・件数のように文字が情報のもの、メニューの項目。アイコンを足す場合も、ツールチップで名前を補います。

#### 自作アイコンの描き方

| 項目 | 決まり |
| --- | --- |
| 方眼 | `viewBox="0 0 24 24"`。中心は (12, 12)。絵は、上下左右の 2.5 の余白を空けた内側（2.5〜21.5）に収める |
| 部品 | `path`・`circle`・`rect` だけ。`g`・`line`・`polyline`・`transform`・`style`・色名は使わない。使える属性は `d`・`cx`・`cy`・`r`・`x`・`y`・`width`・`height`・`rx`・`fill`・`stroke`・`opacity`・`stroke-dasharray` |
| 線 | 線画が基本。色は `currentColor`（文字色）だけ。端と角は丸める。太さと端・角の指定は `Svg` が付けるので、個別に書かない。太さは大きさごとに決めてあり（12→2.2・14→2・16→1.9・22→1.7）、画面の上で 1.0〜1.7px になる |
| 塗りつぶし | 停止（`StopIcon`）と実行（`PlayIcon`）の面、状態の小さい点（半径 1 以下の円。`Dot`）だけ。ほかは線で描く |
| 角 | 箱（`rect`）の角丸 `rx` は 1.2〜2.5（標準は 2、大きい枠は 2.5、小さい箱は 1.2）。path の角は、弧で丸める |
| 丸 | 全体を囲む丸は、中心 (12, 12)・半径 9。コミットなどの「点」の丸は半径 2〜3（Git 系は 2 を標準） |
| 矢印 | 頭は 45°。脚の長さは、単独の矢印とシェブロン `>` が 6、ほかの絵の中に組み込む小さい矢印が 2.5〜4.5（絵の大きさに合わせる）。軸は、頭の脚の 2 倍以上。向きに意味がある（↑ 前・↓ 次と最新・← 戻る・→ 進む・右向きは展開で、開くと下へ回す） |
| すきま | 線と線の間は、目安として 2 以上空ける。12px で潰れる細部は省く（テストでは見えないので、Storybook の「一覧」で目で確かめる） |
| 濃淡・点線 | 使わない。例外は `FilesIcon` の 2 枚目（`opacity` 0.5）と、`PointerIcon` の点線の枠 |

#### 足す手順

1. `icons/catalog.ts` で、同じ意味のアイコンが無いか探します（あれば、それを使います）。
2. いちばん近い既存のアイコンを手本に、`icons/icons.tsx` に `○○Icon` を足します。上の表を守り、意味を 1 行のコメントに書きます。
3. `icons/catalog.ts` に、意味といっしょに足します。
4. Storybook の「カタログ/アイコン」で見ます。「一覧」は 22・16・14・12px、「拡大」は 3 倍。**12px で潰れていない**ことを確かめます。
5. `npm test`。

#### テストで守っているもの

`test/icons.test.ts` が、次を検査します。足し忘れや、はみ出しは、`npm test` で分かります。

- 全アイコンがカタログにあり、名前も意味も重ならない。
- 描き方: `viewBox`・色は `currentColor`・大きさ（12・14・16・22）・`aria-hidden`・使える部品と属性・余白 2.5 の内側・箱の角丸・塗りつぶしの範囲・色の決め打ちがない。
- 線の太さが、画面の上で 1.0〜1.7px に収まり、大きいほど細い。
- `iconHtml`（Markdown のコードブロックの実行ボタン用）が、`IconButton` などの描画と同じ文字列を返す。
- `icons/` の外に、`<svg>` と、記号のアイコンが増えていない（例外は、図の `WorkflowFlow` とアニメーションの印の `CheckMark`）。

## テストと CI

PR と develop・main への push で、次のものを流します。

| ワークフロー | ジョブ | 内容 | ランナー |
| --- | --- | --- | --- |
| `ci.yml` | `typecheck` | 型チェック（`npm run typecheck`） | ubuntu |
| `ci.yml` | `app` | アプリ本体を、配布と同じ手順で `.app` まで作る（翻訳の補助プログラム・electron-vite build・electron-builder。署名は ad-hoc）。同梱するもの（翻訳の補助・node-pty・Helper・ライセンスの表示）と署名も確かめる。できた `.app` で E2E（`npm run test:e2e`）も流す | macOS |
| `ci.yml` | `storybook` | Storybook のビルド | ubuntu |
| `claude-code-check.yml` | `check` | `npm test` と `npm run test:cli`（下の「Claude Code との互換性の確かめ方」）と、ソースマップ付きでビルドしたアプリでの E2E（`npm run coverage:e2e`）。どれもカバレッジを測り、合わせて下限を確かめる（下の「カバレッジ」） | macOS |
| `demo-site.yml` | `build`・`tour`・`tour-sp` | デモのサイトのビルドと、ツアーが最後まで流れるか（下の「デモのサイト」） | ubuntu |

- PR では流さず、週 1 回の定期実行と手動の実行だけで流すものに、`mutation.yml`（ubuntu。下の「ミューテーションテスト」）があります。
- アプリは macOS 専用なので、アプリ本体と Claude Code との互換性の確認は macOS で流します。Linux で動くかは確かめません。Claude Code は OS で画面の描き方が違う（応答の印は macOS では ⏺、Linux では ●）ので、互換性の確認と控えの記録も macOS で行います。型チェック・Storybook・デモのサイトは OS に依らないので、ubuntu で流します。
- public のリポジトリなので、標準のランナー（macOS も）は無料です。気にするのは、PR がマージできるまでの待ち時間です。

### テストの部品

- `test/helpers/scripted-claude.ts`: 本物の claude を起動せずに、本物の `SessionManager` を動かす（`npm test` で速く、決まった結果になる）。pty ホストを、テストが画面の出力と終了を送る偽物（`ScriptedHost`）に差し替え、会話ログの行はテストが書き込みます。画面は本物の Claude Code から取った控え（`.ansi`）を流し込みます（`fixtureScreen`）。キーを受けたときの claude の反応（Shift+Tab で権限モードを描き直すなど）は `ScriptedPty.onWrite` で決めます。`test/session-manager.test.ts` が使います。
  - 本物の Claude Code での振る舞いは `npm run test:cli` が確かめます。こちらは、その上の `SessionManager` の分岐（権限モードの上限・再起動・取り消し・順番待ち・一覧の操作など）を確かめます。
  - `new ScriptedApp({ … })` で、アプリが `SessionManager` に渡す残りの引数（Remote Control を使えるか・登録した設定ファイル・`runTask`・MCP サーバーの材料）を差し替えられます。`ScriptedPty.exitOnKill` を付けると、止めたらすぐ終わる（`ClaudeSession.stop` が終わるのを待つところを通せる）。
  - `test/session-manager-*.test.ts` が、分かれ目ごと（状態・送信・Remote Control・worktree・引き継ぎ・起動のしかた・バックグラウンドのタスク）に使います。worktree は本物の git で確かめ、Claude Code が作るところは同じ形の worktree を git で作って代わりにします。
- `test/pty-host.test.ts`: 本物の pty ホストを、アプリのビルドと同じく 1 つの JS にまとめて（`node_modules/.cache` に書き出す）Node で起動し、アプリ側の接続（`PtyHost`）から `/bin/sh` を動かします。test:cli はホストを偽物に差し替えるので、ソケット・やりとりの形・引き継ぎ・ホストが落ちたときは、ここで確かめます。
- `test/helpers/fake-electron.ts`・`test/helpers/browser-control.ts`: Electron を起動せずに、アプリ内ブラウザの操作（`src/main/browser-control.ts`）を動かす。テストのファイルの `vi.mock('electron', …)` で、webview の中身（webContents）・CDP（debugger）・撮った画像（nativeImage）を、テストが決めた答えを返して受けたもの（CDP の命令・ページで動かすスクリプト・撮った範囲）を控える作り物に差し替えます。画面（`PreviewPane`）の代わりに、タブを開く知らせに応えて webview を知らせます。待ち・時間切れは `vi.useFakeTimers` で時間を進めて確かめます（`finish`）。`test/browser-control*.test.ts` が使います。
  - ページの中で動かすスクリプト（要素を探す・文字を読む・待つ）は、`test/browser-control-scripts.test.ts` が jsdom の文書の上で本当に動かします。jsdom は描かないので、要素の位置（`getBoundingClientRect`）と、その位置にある要素（`elementFromPoint`）はテストが決めます。
- `test/helpers/main-app.ts`: アプリの入り口（`src/main/index.ts`）を、Electron を起動せずに読み込んで動かす部品。`test/main-ipc.test.ts`・`test/main-app.test.ts` が使います。
  - `electron` を作り物（ウインドウ・ダイアログ・メニュー・通知・セッションの権限など）に差し替えます。`app.whenReady` はすぐに済むので、読み込むと起動の流れが最後まで進み、IPC の受け口・メニュー・ウインドウができます。テストは受け口を画面の代わりに呼び（`invoke`・`sendFromRenderer`）、メニューを押し、Electron のイベントを送ります。
  - Claude Code・pty ホスト・ソケット・監視など、重いものや外に出る部品は、呼ばれ方を控える作り物にします。作り物のメソッドは、既定では「呼ばれたメソッドと引数」をそのまま返すので、受け口が正しい相手に、引数を取り違えずに渡し、返事をそのまま返すかを、戻り値で確かめられます。アプリの設定・ウインドウの位置の保存・通知の文・shared は本物です。
  - index.ts は読み込むたびに状態（開いたフォルダ・終了の確認など）を持つので、`boot()` はテストごとに読み込み直します（userData とダウンロードは使い捨てのフォルダ）。読み込み直すと index.ts が使うモジュールも別のものになるので、本物の部品（`AppSettings` など）の失敗は `vi.spyOn` でなく、ファイルを書けなくするなどして起こします。
  - 別のプロセスで動くホストは、単体のテストのカバレッジに入りません。`test/pty-host-server.test.ts` が、ホストをテストのプロセスの中で読み込んで（`process.exit`・`process.chdir` は差し替え）、同じやりとりを確かめます。
  - アプリ側の接続の細かいところ（溜めておく出力・答えないホスト・つながっていない間の起動など）は、`test/pty-host-client.test.ts` が、決めたとおりに答える偽物のホストで確かめます。
- テストを足すときは、確かめたいところをわざと壊して、テストが落ちることも確かめます（通るだけのテストにしない）。

### 配線と契約

型チェックとテストで、画面と main の間（IPC）と、Claude Code と tanacode の間（MCP のツール）の食い違いを止めます。

- IPC: チャンネルを足すときは、`src/shared/ipc.ts` の `IpcChannel` と、3 つの表のどれか 1 つに足します。表の型は、それを呼ぶ・受ける `TanacodeApi` のメソッドから取ります。
  - `IpcInvoke`: 画面 → main の呼び出し（preload の `invoke` ↔ main の `handle`）
  - `IpcSend`: 画面 → main の知らせ（preload の `send` ↔ main の `listen`）
  - `IpcEvent`: main → 画面の知らせ（main の `send` ↔ preload の `subscribe`）
  - preload と main の両方がこの表で型を付けるので、引数の順番・型、戻り値、知らせの中身が食い違うと、型チェックで止まります。同じ型の引数どうしの入れ替え（`mergeBase` と `relPath` など）は止まりません。
  - `test/ipc-wiring.test.ts` が、型では分からないものを確かめます。preload が使うチャンネルに main の受け口がちょうど 1 つあるか、main が送る知らせを画面が受けるか、使っていないチャンネル・どの表にも無いチャンネル（型チェックで止める）が無いか、です。
  - 同じ型どうしの入れ替え（2 つのメソッドのチャンネル、`mergeBase` と `relPath` の順番など）・省略できる引数の渡し忘れは、両側を動かして止めます。正しい組み合わせは、上の 3 つの表と `TanacodeApi` の型の宣言をソースから読んで決めます（`test/helpers/ipc-tables.ts`）。
    - `test/preload-api.test.ts`: `electron` の `ipcRenderer`・`contextBridge` を作り物にして preload を読み込み、どのメソッドも表のチャンネルを、引数をそのままの順で呼ぶか・知らせの受け手が表のチャンネルを購読して中身だけを渡し、返した関数で同じ受け口を解除するかを、メソッドごとに確かめます。中身の無い知らせ（表で `undefined`）を足したら、受けるメソッドを `ipc-tables.ts` の `EMPTY_EVENTS` に足します。
    - `test/main-ipc.test.ts`: main の受け口が、どれも 1 つずつ登録されるか・受け取った引数を正しい相手に渡すか・画面から届いた値を確かめるかを、受け口ごとに確かめます（上の「テストの部品」の `main-app.ts`）。
- MCP: `test/mcp-contract.test.ts` が、4 つのサーバー（アプリ内ブラウザ・セッション・チェックリスト・ウォークスルー）について確かめます。
  - 定義の形（名前・ラベルが重ならない、説明がある、引数に型と説明がある、必須の引数が properties にある）
  - 名前・種類・引数の形・許可済みにするツールが、控え（`test/__snapshots__/mcp-contract.test.ts.snap`）と同じか。種類を変えると許可の確認の有無が変わるので、控えの差分で気づけるようにしています。説明の文は控えに入れません。定義を変えたら `npx vitest run test/mcp-contract.test.ts -u` で控えを書き直し、差分を見てからコミットします。
  - 制御（`*-control.ts`）が、定義にあるツールを漏れなく振り分けるか（ソースから読む。セッション・チェックリスト・ウォークスルーは、動かしても確かめる）。制御が読む引数（`args.xxx`）が、どれかのツールのスキーマにあるか（無い引数は、Claude が渡せないので黙って動かない）

### 画面のテスト

- 画面（renderer）のテストは `test/renderer/` に置き、ファイルの先頭の `// @vitest-environment jsdom` で DOM の代わり（jsdom）を使います。型は `tsconfig.web.json` で確かめます（DOM の型が要るため）。
  - happy-dom は使いません。DOMPurify（Markdown の無害化）の結果が、本物のブラウザと食い違ったためです。
- `test/renderer/mock-api.ts`: `window.tanacode` の偽物。呼び出し（`argsOf('sessions.submit')` など）を控え、知らせ（`emit('sessions.onChat', …)`）をテストから送ります。返す値は `responses` に「名前空間.メソッド」で決めます。
- `test/renderer/dom.ts`: jsdom に無いもの（`scrollIntoView`・`requestAnimationFrame`）を補います。使う部品のテストの先頭で読み込みます。
- 画面のボタン・入力は、テストでひとつ残らず押し、押した結果（IPC に渡った引数・表示・props の受け手に渡った値）まで確かめます。セッションまわり・ソース管理・エクスプローラー・検索・エディタは `press-sessions*.test.tsx`。
  - Monaco エディタを使う部品（エディタ・差分）のボタンは、`editor/monaco.ts` を `vi.mock` で作り物（モデルの内容の読み書きと、内容が変わった知らせだけを持つ）に差し替えて押します（`press-sessions-editor.test.tsx`）。エディタそのものの動き（打ち込み・色付けなど）は E2E で確かめます。
- 部品は Testing Library（`@testing-library/react`）で描き、押す・打つ操作をして、`window.tanacode` に渡ったもの（送ったキー・本文など）を確かめます。Monaco エディタ・xterm・webview を使う部品は、アプリ本体の E2E で確かめます。
- 対象（セッション・フォルダ・カードなど）を切り替えた直後に押すテスト（`switch-then-press.test.tsx`。新規セッションの画面の「最新のデフォルトブランチへ切り替える」は `new-session-pane.test.tsx`）。処理中の印や返事のあとの処理が、前の対象から持ち越されていないかを確かめます。
  - 書き方: 対象 A で描いてボタンを押し、返事を返さないまま（`responses` から、テストが好きなときに返せる約束を返す）、`rerender` で対象 B に描き直します。B のボタンが押せること（`disabled` でない）と、押すと B の ID で呼ぶことを確かめます。そのあと A の返事を返し、B の表示（処理中の印・書きかけ・状態）が変わらないことを確かめます。
  - App が `key` で作り直す部品は、テストでも App と同じ組み合わせ（`key` と、一緒に使うフック）で描きます。モーダルのダイアログのように、開いたまま対象が変わらない部品は、閉じて開き直す流れで確かめます。アプリ内ブラウザ（`PreviewPane`）は、`<webview>` を作り物（`getURL`・`executeJavaScript` など）に差し替えて描きます。
  - jest-dom の matcher は使いません。`(el as HTMLButtonElement).disabled` などで確かめます。
- 部品のテストを足したら、`npm run mutation:ui -- <部品のファイル>` で、その部品のボタン・入力が効かなくなったときに、テストが落ちるかを確かめます（下の「ミューテーションテスト」）。

### カバレッジ

3 つのテストで測り、それぞれ `coverage/<名前>/coverage-final.json` に書きます。

| コマンド | 同じテスト | 書く場所 |
| --- | --- | --- |
| `npm run coverage` | `npm test` | `coverage/unit/` |
| `npm run coverage:cli` | `npm run test:cli` | `coverage/cli/` |
| `npm run coverage:e2e` | `npm run test:e2e`（先に `TANACODE_SOURCEMAP=1 npm run build`。下の「アプリの通しのテスト（E2E）」） | `coverage/e2e/` |

- 単体と本物の claude のテストで測る範囲は `vitest.coverage.ts`。`src` の .ts・.tsx で、ストーリーとデモのサイトの台本は除きます。テストで読み込まなかったファイルも 0% として数えます。E2E も同じ範囲のファイルだけを数えます。
- 落ちたテストがあっても、ほかのテストで通ったところは数えます。手元で `npm run coverage:cli` を root で動かすと、`bypassPermissions` の台本は Claude Code が起動を断るので落ちます（CI では起きません）。
- 単体のテストは main・shared の中核と、Electron を作り物にした入り口（`src/main/index.ts`）と preload、画面の部品を、E2E は本物の Electron の上での配線（IPC・preload・pty ホスト・MCP の中継）と、部品をつないだ画面を通します。E2E を合わせると、画面の割合が大きく上がります。
- `npm run coverage:report` が、`coverage/` にあるものを全部合わせて、層（main・preload・shared・renderer）ごとに行・分岐・関数の割合を出します。1 行も通っていないファイルの一覧も出します。
  - 下限は `test/coverage-thresholds.json`。下回った層があれば失敗にします。
  - 下限は上げるだけで、下げません。テストを足して上がったら、`npm run coverage:report -- --update` で上げます。今の値から 1 ポイント下げて置きます。本物の claude を動かすテストと E2E は、待ち方しだいで通る行が少し変わるためです。手元で上げるときは、CI と同じく 3 つとも測ってから流します（どれかが無いと、その分だけ低く出ます）。
  - `--diff <ref>` を付けると、`<ref>` から変えた行のうち、テストで通った行の割合と、通らなかった行も出します。
  - 合わせるときは、文・分岐・関数を src の位置で突き合わせます。単体のテスト（ファイルごとに変換したもの）と E2E（ビルドしてまとめたものを、ソースマップで戻したもの）では、同じ文でも位置が少しずれることがあり、そのときは別のものとして数えます。行の割合は、同じ行のうち通ったものを数えるので影響を受けません。分岐と関数の割合は、少し動くことがあります。
- CI の `check` のジョブは、PR と push で 3 つとも測って合わせ、表をジョブの概要に出します。PR では、マージ先からの差分の行のカバレッジも出します（こちらは下限を見ません）。毎日の定期の確認では、E2E を流さず、まとめもしません。その日の最新の Claude Code の互換性を見るためのものだからです。
- カバレッジは、テストで実行された行の割合です。結果まで確かめたかは分かりません。テストを足すときは、確かめたいところをわざと壊して、テストが落ちることも確かめます（まとめて確かめるのが、下の「ミューテーションテスト」）。

### 押していないボタン・入力

画面のボタン・入力は、すべて一度はテストで押して、押した結果まで確かめます。行のカバレッジの割合は、押していないボタンがあっても上がってしまうので、別に数えます。

- `npm run coverage:unpressed`（`scripts/unpressed.mjs`）が、画面の部品（`src/renderer/src` の .tsx。ストーリーとデモのサイトは除く）の操作の受け手（`onClick`・`onChange`・`onKeyDown` など）をソースから拾い、`coverage/` にあるカバレッジを全部合わせて、一度も呼ばれていないものを `ファイル:行` と要素で出します。
  - 受け手がその場の関数か、同じファイルの名前の付いた関数（`useCallback` で包んだものも）なら、その関数が呼ばれたかで見ます。props から受け取ったもの（`onClick={onCancel}`）は、渡した側で数えます。
  - 別の場所で測ったカバレッジ（CI の成果物など）を `coverage/<名前>/` に置いても、`src/renderer/` からのパスで突き合わせて合わせます。
- CI の `check` のジョブは、PR と push で 3 つのカバレッジを合わせたあとに数え、1 つでもあれば失敗にします（`--max 0`）。ボタンや入力を足したら、押すテストも足します。
  - 単体テストと E2E では、同じ関数でも位置が少しずれて別々に記録されるので、近くにある記録のうち、いちばん多く呼ばれたもので見ます。
- 押すテストは、押したあとの IPC（正しいセッション・フォルダなどの ID で呼ばれたか）や表示の変化まで確かめます。対象（セッション・フォルダなど）を props で受け取る部品は、別の対象に描き直した直後に押しても、新しい対象に効くことも確かめます（下の「画面のテスト」）。Monaco・xterm・webview の中のものは E2E で押します。

### ミューテーションテスト

コードを 1 か所ずつわざと壊し（ミュータント）、テストが落ちるかを確かめます。落ちなかったもの（生き残り）は、テストがそこを通っても、結果まで確かめていない場所の候補。カバレッジでは分からない、テストの確かめ漏れを探すためのものです。

- 流し方: `npm run mutation`。対象は引数で変えられます（`npm run mutation -- src/shared/chat.ts`）。フォルダを渡すと、中の .ts・.tsx を全部（ストーリーと型の宣言は除く。書き換えの無いファイルは結果に出しません）。引数が無ければ、`scripts/mutation.mjs` の既定の対象（読み取りの中核の `src/main/screen-parser.ts` と `src/shared/chat.ts`）。
  - `--concurrency <n>`: 同時に流す数（既定 2）。`--out <dir>`: 結果の置き場所（既定 `reports/mutation/`。`--ui` では `reports/mutation-ui/`）。`--list`: ミュータントの一覧だけを出し、テストは流しません。`--mutators <名前,名前>`: 書き換えの種類を絞ります（例: `--mutators EventHandler,Disabled`）。
  - 既定の対象で、ミュータントは 2,300 個ほど。かかる時間は、同時に 2 で 35 分ほど（ほとんどが `screen-parser.ts`。画面を流し込むテストが、描画が落ち着くのを待つため）。
- 画面の操作: `npm run mutation:ui`（`--ui`）。書き換えを、ボタン・入力を効かなくするもの（下の `EventHandler`・`CallbackProp`・`Disabled`）だけにして流します。「押しても何も起きない」「押せないまま」になっても、テストが気づくかを確かめるためのものです。
  - 引数が無ければ、`scripts/mutation.mjs` の `UI_TARGETS`（新規セッション・入力欄・ソース管理・チャット・セッション一覧の 5 つの部品）。ほかの部品は、ファイルかフォルダで指定します（`npm run mutation:ui -- src/renderer/src/checklist`）。画面の部品を全部（`npm run mutation:ui -- src/renderer/src`）でも 600 個ほどで、1 分かかりません。
  - 確かめられるのは、画面のテスト（`test/renderer/`）で描いて押したものだけ。どのテストも描かない部品は、全部「テストが通らない」になります。アプリの通しのテスト（E2E）では流しません（ミュータントごとに、アプリのビルドからやり直しになるため）。
- 道具は自前のスクリプト（`scripts/mutation.mjs`・`mutation-worker.mjs`・`mutation-setup.mjs`）。Stryker（`@stryker-mutator/vitest-runner` 10.0.0）は、vitest 5 では正しく動きません。ミュータントごとに流すテストを名前で絞るとき、vitest 5 は名前を「describe > テスト」の形で照らし合わせるのに、Stryker は空白でつないだ名前を渡すため、テストが 1 つも流れず、全部が生き残りになります。
- 仕組み
  - 書き換え（名前は Stryker に合わせる）: 比較（`===` と `!==`、`<` と `<=` など）・算術・論理（`&&` と `||`・`??`）・代入の演算子・`++` と `--`・符号・条件（if と三項演算子の条件を true / false に、ループの条件を false に）・真偽値と `!`・文字列（空に）・正規表現（`^` `$` を外す、`\d` を `\D` に、`[..]` を `[^..]` に、回数の指定を外す、先読みを逆に）・戻り値（`return` の値と、式のアロー関数の値を `undefined` に）・ブロック（空に）・`?.` を `.` に・配列（空に）・メソッド（`startsWith` と `endsWith`、`some` と `every` などの入れ替え、`filter`・`slice`・`trim` などを外す）。型の部分と、import・オブジェクトのキーは書き換えません。構文は `@babel/parser` で読みます。
  - 画面の操作の書き換え（.tsx の JSX。このスクリプトの独自）
    - `EventHandler`: 人の操作の受け手（`onClick`・`onDoubleClick`・`onMouseDown`・`onContextMenu`・`onKeyDown`・`onChange`・`onInput`・`onSubmit`・`onDrop`・`onPaste`）を `undefined` に。素の要素（`button`・`input` など）に付けたものも、部品（`IconButton` など）に渡すものも。
    - `CallbackProp`: 部品に渡す、ほかの `onXxx`（`onSend`・`onSelect`・`onPick` など）を `undefined` に。
    - `Disabled`: `disabled={式}` を `disabled={true}` に。
    - どのボタン・入力かを、結果に添えます（例: `IconButton「送信」`・`input[checkbox]「worktree を使う」`・`button.folder-menu-item「{dir}」`）。名前の手がかりは、属性（`aria-label`・`label`・`title`・`tip`・`data-tip`・`placeholder`・`alt`）、子の文字、（入力なら）囲んでいる `<label>` の文字の順。`{式}` しか手がかりの無い素の要素には、クラス名を添えます。
    - 受け手が、その場の関数（`onClick={() => …}`）か、同じファイルの名前の付いた関数（`function send()`・`const send = …`・`useCallback(…)`）なら、その関数の中を通ったテスト（押したテスト）だけを流します。それ以外（props で受けた関数など）と `Disabled` は、その要素を描いたところを通ったテストを流します。
  - はじめに、対象のコードに印を付けて、対象を読み込むテストのファイル（`test/*.test.ts` と、画面のテスト `test/renderer/*.test.{ts,tsx}` から import をたどる）を流し、テストごとに、どの印を通ったかを調べます（`mutation-setup.mjs`）。印は、文の前と、あとで実行される式（式のアロー関数の値・フィールドの初期値・引数の既定値）に付けます。正規表現は、使ったとき（`exec`）に通ったとみなします。ここで落ちるテストがあれば止めます。
  - ミュータントごとに、その場所を通ったテストだけを、速いファイルから流し、1 つ落ちたら止めます。読み込みや `beforeAll` で通った場所（ファイルの先頭の定数など）は、そのファイルのテストを全部流します。どのテストも通らない場所は、流さずに「テストが通らない」に数えます。
  - テストを絞って流すので、テストは 1 つだけでも通るように書きます（前のテストの結果に頼るテストは、壊していないのに落ちて「落ちた」に数えてしまいます）。`test.concurrent` は使いません（どのテストが通ったかを分けられないため）。
  - 壊したコードは、Vite のプラグインでテストに渡します。ソースのファイルは書き換えません。Vitest は、同時に流す数だけ立ち上げたままにして、使い回します。
  - 止まらなくなったもの（元のコードで流した時間の 1.5 倍 + 10 秒）は、Vitest ごと止めて「時間切れ」にします。テストが見つけたものとして数えます。
- 結果の読み方
  - `reports/mutation/summary.md`（要約と、生き残りの一覧）と `reports/mutation/mutation.json`（全部のミュータントと、流したテスト・落ちたテスト）。`--ui` では `reports/mutation-ui/` に書きます。`reports/` は git に入れません。
  - スコアは、見つけた（落ちた・時間切れ）割合。分母は、落ちた・時間切れ・生き残り・テストが通らない。「通った場所でのスコア」は、テストが通らないものを除いた割合です。エラー（Vitest ごと落ちたもの）は数えません。
  - 生き残りは、行と書き換えの内容で出します（例: `42 行（EqualityOperator）: a === b → a !== b`）。書き換えても動きの変わらないもの（等価なミュータント。例: 結果に出ない並べ替え、`>=` と `>` の差が出ない値、`trim` してもしなくても同じ文字列）も混じるので、1 つずつ見て、意味のあるものにテストを足します。足したら、もう一度流して、その書き換えでテストが落ちるようになったかを確かめます。
  - 「テストが通らない」は、どのテストも実行しなかった場所。行のカバレッジより細かく、通った行の中の、呼ばれなかったコールバックなども入ります。テストを足す場所の目安です。
  - 画面の操作は、どのボタン・入力かも出します（例: `336 行（Disabled） SchedulePicker「時刻を指定して送信」: disabled={!canSchedule} → disabled={true}`）。生き残りは、そのボタンが効かなくなっても（押せなくなっても）、落ちるテストが無いもの。押したあとに `window.tanacode` に渡ったものや、画面の変わり方を確かめるテストを足します。
  - 画面の操作の「テストが通らない」は、行でなく、ボタン・入力ごとの一覧で出します。「押すテストが無い」（受け手の関数を通ったテストが無い）か、「描くテストが無い」（その要素を描いたところを通ったテストが無い）かを添えます。
- CI: `mutation.yml` が、週 1 回（月曜の朝）の定期実行と、手動の実行（Actions の画面から。対象のファイルを空白で区切って指定できる）で流します。あわせて `npm run mutation:ui` も流します（手動の実行では、対象のファイル・フォルダを `ui_targets` で指定できる）。毎回の PR では重いので流しません。ファイルごとのスコアと生き残りの数・一覧をジョブの概要に出し、詳しい結果（`reports/mutation/`・`reports/mutation-ui/`）を artifact（`mutation`）に残します。スコアの下限はまだ設けません（生き残りがあっても失敗にしません）。

### アプリの通しのテスト（E2E）

`npm run test:e2e`（`test/e2e/`）は、アプリ本体を Playwright で起動し、人と同じように画面を操作して、Claude Code・MCP・ターミナルまで通しで確かめます。`claude` は本物（`TANACODE_CLAUDE_BIN`、無ければ PATH の `claude`）、API はモック（`test/cli/mock-api.ts`）なので、料金はかかりません。

- 起動するのは、ビルドしたアプリ（`out/`。先に `npm run build`）か、`TANACODE_E2E_APP` に渡した実行ファイル（パッケージした `.app` の `Contents/MacOS/tanacode`）。
- CI では 2 か所で流します。どちらも PR と push だけで、`claude` は動作確認済のバージョンです。
  - `ci.yml` の `app` のジョブ: 作った `.app` で流します（`npm run test:e2e`）。配る形のまま動くかを確かめるためです。
  - `claude-code-check.yml` の `check` のジョブ: ソースマップ付きでビルドした `out/` で、カバレッジを測りながら流します（`npm run coverage:e2e`）。単体と本物の claude のテストと合わせて、下限を確かめます。Electron の本体は `npm ci` では入らないので、`node node_modules/electron/install.js` で入れます。
  - 毎日の定期の確認（最新の Claude Code）では流しません。E2E はビルドを含めて数分かかり、画面の待ち方しだいで落ちることもあるので、互換性の確認（読み取りが壊れていないか）とは分けています。新しい Claude Code での E2E は、動作確認済のバージョンを上げる PR の CI で流れ、通らなければマージしません。
- userData（`--user-data-dir`）と HOME は使い捨てのフォルダにします。ふだんのアプリの設定や `~/.claude` には触りません。通知と更新の確認は切ります。フォルダを選ぶダイアログは、作業フォルダを選んだことにします。
- 終わるときは、終了の確認で「Claude Code も止めて終了」を選んだことにして、pty ホストと `claude` が終わるのを待ってから、一時フォルダを消します。
- 失敗したテストは、画面の写し・メインプロセスの出力・モックの API の呼び出し・セッションの一覧・選んでいるセッションの Claude Code の画面を `test-results/e2e/` に残します。CI では、ジョブの成果物（`e2e-results`）に入れます。
- 画面の目印には、クラス名と `aria-label` を使います。画面を変えて目印が変わったら、`test/e2e/app.ts` の操作の部品か、テストの目印を直します。
- Linux でも `xvfb-run -a npm run test:e2e` で流せます（手元で確かめる用。CI では流しません）。
- カバレッジも測るときは、`TANACODE_SOURCEMAP=1 npm run build` でソースマップ付きでビルドしてから `npm run coverage:e2e`（Linux では `xvfb-run -a npm run coverage:e2e`）。`npm run coverage:report` は、ほかのカバレッジと合わせて数えます（上の「カバレッジ」）。
  - 集め方: メインプロセス・pty ホスト・MCP の中継（どれも Node）は `NODE_V8_COVERAGE` で、画面と preload は Playwright の `page.coverage` で、`coverage/e2e-raw/` に集めます。
  - 画面のカバレッジは、測り始めてから読み込んだスクリプトの分しか取れないので、起動したら画面を読み込み直します。
  - MCP の中継は、Claude Code が終わるときにシグナル（SIGINT）で止められ、そのままでは `NODE_V8_COVERAGE` を書きません。測るときだけ、シグナルを受けたら `process.exit` で終える `test/e2e/coverage-exit.cjs` を、`NODE_OPTIONS` の `--require` で読み込ませます。Playwright は起動するアプリに `NODE_OPTIONS` を渡さないので、起動したあとメインプロセスの環境変数に足します（Claude Code がそれを引き継いで、中継に渡します）。
  - 戻し方: 終わったら `scripts/e2e-coverage.mjs`（`test/e2e/global-setup.ts` から）が、同じスクリプトの記録（起動のたび・プロセスごと）を V8 の形のまま合わせてから、ソースマップで src の行に戻し（`ast-v8-to-istanbul`）、`coverage/e2e/coverage-final.json` に書きます。記録ごとに戻すと、大きなスクリプト（画面は 10MB ほど）を何十回も戻すことになり、遅いためです。
  - ビルドは、ソースマップを書き出す分だけメモリを多く使います（手元の計測で、ソースマップなしの 4.5GB ほどに対して 5.5〜6GB ほど）。
  - ソースマップ（`.map`）は、パッケージしたアプリには入れません（`package.json` の `build.files`）。

| ファイル | 確かめること |
| --- | --- |
| `chat.test.ts` | 新規セッションの画面から始め、信頼の確認・Bash と Write の許可・質問に、チャットのカードで答える（答えがモックの API まで届くか）。チャットの並び・一覧のタイトル・Claude Code の画面（xterm）への描画と入力（人と同じ速さで 1 文字ずつ打ち、打っている途中の文字がチャットの入力欄に移らないか。打ちかけたまま離れると移るか）・ターミナルのシェル |
| `workspace.test.ts` | 作業フォルダのファイルを、エクスプローラー・エディタ・Markdown のプレビュー・⌘P・全文検索で扱う。プレビューの整形（コードの色付け・mermaid の図・フォルダの中の画像）と相対リンク。エディタで書き換えて ⌘S で保存するとディスクに書かれ、ディスクの変更がエディタに戻るか |
| `mcp.test.ts` | Claude が MCP でチェックリスト・ウォークスルー・アプリ内ブラウザを操作すると、画面に出るか。許可や「終わった」の操作が、ツールの結果として Claude に戻るか |
| `checklist.test.ts` | 人がチェックリストを画面で使う（リストとカードを作ってチェックを付ける）。カードのスレッドに「Claude に通知する」で返信すると、手の空いた Claude に知らせが届くか。Claude が MCP でスレッドに返信すると、画面に出るか |
| `tasks.test.ts` | Claude がバックグラウンドで動かすもの（サブエージェント・バックグラウンドの Bash・ワークフロー）が、タスクの一覧に出るか。開くと中身（サブエージェントの会話・ワークフローのフェーズとエージェント）が見え、動いている Bash を画面から止められるか。ワークフローを始める前の確認には、チャットのカードで答える |
| `sessions.test.ts` | Claude がセッションの MCP で子セッションを始める（許可のカード・一覧に並ぶ・子が動き出す） |
| `session-ops.test.ts` | 一覧とチャットの見出しからの、セッションの操作。名前の変更（見出しと記録にも出る）・作業の HTML への書き出し（本人だけが読めるファイル）・アーカイブ。一覧の「アクティブに戻す」で戻して送ると、Claude Code を再開して同じ会話を続けられるか |
| `scm.test.ts` | Claude が直したファイルを、ソース管理の画面で開いて差分の行にコメントし、チャットから返す。画面からステージしてコミットする |
| `default-branch.test.ts` | 新規セッションの画面の「最新のデフォルトブランチへ切り替える」。フォルダを切り替えた直後に押しても効くか。フェッチに時間がかかっている間（合図があるまで答えないリモート。git の `ext::`）にフォルダを変えると、変えた先のボタンと送信がすぐ使えるか。時間のかかっているフォルダは止めずに、リモートが答えたら切り替わるか |
| `restart.test.ts` | 「動かしたまま終了」で閉じて起動し直すと、Claude Code が引き継がれて続けられる。「再起動」のあとも同じ会話を続けられる |

どのファイルも、最後に画面のコンソールにエラーが出ていないかを確かめます。

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
  - 台本は 12 個のファイル。それぞれ別の `claude` を起動して、同時に流します。

    | ファイル | 台本 |
    | --- | --- |
    | `basic.test.ts`（台本は `test/scenario.ts`） | フォルダの信頼の確認 → 入力欄 → Bash（許可の確認・PostToolUse の hooks）→ AskUserQuestion → Write（許可の確認）→ 返事。チャットの組み立て（会話ログからと、`SessionManager` の配信から）・操作待ちの知らせと通知の本文・完了の知らせ・読んだ・書いたファイル・statusLine・`/` の候補（会話ログのスキル一覧）も |
    | `background.test.ts` | サブエージェント（Agent）→ バックグラウンドの Bash → ワークフロー（始める前の確認・実行中の journal も）。それぞれ完了まで、トラッカーで追えるか。完了通知（`<task-notification>`）は、出力ファイルや完了時の記録という後ろ盾と分けて、会話ログの行と `taskNotificationOf` だけで読めるか、チャットの知らせになるかも |
    | `stop.test.ts` | バックグラウンドのタスクを、アプリから止める（`SessionManager.stopTask`）。サブエージェント・Bash 5 つ（長いコマンド・同じコマンドの 2 つ）・ワークフローを動かし続け、`/tasks` の一覧から、コマンド・説明・名前で選んで止める（ほかは動いたまま。同じコマンドが 2 つのときは決められないと断る）。画面を操作している間にメニューや「操作できない画面」の知らせが出ないこと、止めたあと入力欄に戻ること、動いていないもの・書きかけの文字があるときは打たずに断ることも。1 つだけのときは別の `claude` で、一覧を飛ばした詳細の画面（Bash・サブエージェントは止めると閉じ、ワークフローは残る）から止める |
    | `session.test.ts` | 権限モードの切り替え（Shift+Tab）→ 作業中の進み具合 → 作業中に送った発言の順番待ち（`queue` のイベント）→ 会話ログのモデル名 → `/compact` → 複数行の指示を添えた `/compact`（入力欄では貼り付けの目印になる。要約の頼みの `Additional Instructions:` に、改行もそのまま入るか）→ `/clear`（statusLine で新しい会話ログに乗り換え）→ `--resume` → `/rewind`（「何を戻すか」のメニューと、会話を戻して発言したときの `replace` のイベント） |
    | `adopt.test.ts` | `--resume` の前と後でバックグラウンドの Bash → アプリを起動し直して、動いている claude を引き継ぐ（前の claude の行は過去のもの、今の claude の行は今も動いているもの）→ アプリを止めている間の `/clear` |
    | `questions.test.ts`（台本は `test/scenarios/questions.ts`） | AskUserQuestion。複数の質問のページ送り（タブ・自由記述・回答の確認画面）→ 複数選択だけの質問（チェックの付け外し・Next / Submit）→ プレビュー付きの選択肢 → 説明が長く、上が切れて見えるメニュー。どれもカードのボタンと同じ操作で答え、会話ログの答えまで確かめる |
    | `errors.test.ts`（台本は `test/scenarios/errors.ts`） | 失敗と中断。応答の前・応答を待つ間・ツールの実行中の Esc → 中断した会話の `--resume`（`<synthetic>` の応答を出さない）→ API エラー（529 の再試行・529 のあきらめ・400）→ 新しい会話でツールの失敗（`exit 3`）・PreToolUse の hooks で止める・Write と Edit の差分・Stop の hooks |
    | `browser.test.ts` | アプリ内ブラウザの MCP。アプリと同じ起動の引数（`--mcp-config`・`--allowedTools`・`--settings` の `PreToolUse` のフック）で起動し、ビルドした中継（`test/cli/browser-relay-build.ts` で `src/main/browser-mcp.ts` をまとめたもの）が、アプリの代わりのソケット（`McpBridge`）まで呼び出しを運ぶか。読むだけのツールは確認なし・クリックは確認あり・JavaScript の実行は localhost のページなら確認なし、それ以外のページなら「次から聞かない」を選んでも次も確認、アプリに聞けない間も確認・`--resume` のあとも使える・ソケットが無い間は「起動していません」と返し、戻ればそのまま使える・`ask_user_to_act` は許可の確認なしに届き、Esc で取り消し（`notifications/cancelled`）が届く・バックグラウンドに移ったあとも、結果が知らせで届いて Claude が続きを始める |
    | `sessions.test.ts` | ほかのセッションを扱う MCP。アプリと同じ起動の引数（`--mcp-config` の `timeout` も・`--allowedTools`・`--settings` の `PreToolUse` のフック）で起動し、ビルドした中継（`src/main/sessions-mcp.ts`）がアプリの代わりのソケットまで呼び出しを運ぶか。読むだけのツールと子への指示・質問への回答は確認なし・子の中断と起動は確認あり。bypassPermissions でも、子の起動だけはフックで確認が出て、確認に「利用枠」が出る。親からの指示（囲みと、複数行の本文の貼り付け）は会話ログから「親セッションからの指示」として読め、順番待ちにも本文だけが出る。子の知らせは「Claude への知らせ」として読め、Claude が続きを始める。作業中に頼んだ親の指示は、ターンが終わってから打つ。子が出した AskUserQuestion に、親（`SessionsControl` の `answer_question`。本物の `SessionManager` で）が答えると、子が続きを始める |
    | `checklist.test.ts` | チェックリストの MCP。アプリと同じ起動の引数で起動し、ビルドした中継（`src/main/checklist-mcp.ts`）が、アプリの代わりのソケットの先の `ChecklistControl` まで呼び出しを運ぶか。書き換えるツールも確認なしに通る。サーバーの説明が Claude に渡り、`/compact` で圧縮したあとも渡り続ける。人がスレッドに「Claude に通知する」で返信すると、手の空いた Claude Code（本物の `SessionManager` で）の入力欄に知らせが打たれ、会話ログからカードの場所を持つ「Claude への知らせ」として読める |
    | `worktree.test.ts` | git のリポジトリで `claude --worktree`（`SessionManager.createInWorktree`）→ worktree の場所・ブランチ・Claude Code のロック・`.worktreeinclude` の写し・元のフォルダの未追跡に出ないこと → 準備の知らせが ready より先 → 会話ログが worktree の側に書かれる → `git branch -D` で、アプリが足した hooks の許可の確認が出る → 止めて `--resume`（worktree のフォルダで再開）→ worktree を削除してアーカイブ（未追跡のファイルの控えの ref）→ 戻すと作り直して再開。信頼していないフォルダでは始まらず、理由を日本語で返す。大きなモノレポ（4 万ファイル）で、workspaces の各パッケージの `node_modules` も見つける |
| `input.test.ts`（台本は `test/scenarios/input.ts`） | 台本ごとに別の `claude` を起動。入力欄: `--effort` の表示とバナーのモデル名 → 書きかけ → 会話の最初の `/context` → 複数行の貼り付け（短いもの・長いもの）→ `!` のコマンド → `/rename` と AI のタイトル → セッションの一覧。読み取り: `@` の添付・Read・サブフォルダの CLAUDE.md・コンテキストの使用量（`KnowledgeTracker`）・コンテキストの中身（`ContextTracker`）・思考・画像。サブエージェントの実行中の直近のツールと会話ログ（`readAgentLog`）。バックグラウンドの Bash を `TaskStop` で止める |

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
  - 控えは、クラウドの開発環境のように Claude Code の設定やトークンが置かれた環境では取りません。その環境ならではの表示が画面に混ざるためです。GitHub Actions（macOS のランナー）が残した artifact か、手元の Mac で取ったものを使います。2.1.290 までの控えは Linux のランナーで取ったもので、応答の印が ● です（読めるままかを確かめ続けるため、そのまま残します）。2.1.292 からは macOS のランナーで取ったものです。
- tanacode で動作確認済のバージョンは `src/shared/claude-code.ts` の `VERIFIED_CLAUDE_CODE_VERSION`。ステータスバーは、入っているバージョンがこれと同じならチェックマーク、違えば警告の印を付けます（新しいバージョンと古いバージョンで分ける）。
  - 上げるのは、GitHub Actions の毎日の確認です（下）。新しいバージョンで通ったら、`scripts/update-verified-version.mjs` で次のものを書き換えた PR を作って、そのままマージします。
    - `VERIFIED_CLAUDE_CODE_VERSION`
    - README と GUIDE の「動作確認済」の行のバージョン（README の先頭のバッジも、alt に「動作確認済」を入れてあるので一緒に変わる）
    - そのバージョンの控え（`test/fixtures/claude-code/<バージョン>/`）
  - 控えがあれば、`npm test` は動作確認済のバージョンの控えがあるかも見ます。
  - 手で上げるときも、同じスクリプトを使います（`TANACODE_RECORD=1 npm run test:cli` で控えを取ってから `node scripts/update-verified-version.mjs <バージョン>`）。
- GitHub Actions（`.github/workflows/claude-code-check.yml`）: PR と develop・main への push、毎日の定期の確認で、両方を流します。
  - 確かめる Claude Code は、毎日の定期の確認と「Run workflow」ではその日の最新、PR と push では動作確認済のバージョン（`VERIFIED_CLAUDE_CODE_VERSION`）。新しい Claude Code が出ても、関係のない PR が落ちないようにするためです。新しいバージョンへの追従は、毎日の確認と、それが作るバージョンを上げる PR で行います（その PR の CI は、上げたあとのバージョンで流れます）。
  - 定期の確認で失敗したら、Issue を立てます（同じバージョンの Issue が開いていれば立てない）。
  - 定期の確認で通ったら、動作確認済のバージョンを上げる PR（ブランチは `claude-code/<バージョン>`）を作って、PR の CI が通ったら squash マージし、ブランチを消します（リポジトリの設定の「ブランチの自動削除」で GitHub が先に消していれば、そのまま。消せずに残ったときは、ジョブは失敗にせず警告を出す）。動作確認済のバージョンと同じバージョンで、その控えがまだコミットされていなければ、控えだけを足す PR を作って、同じようにマージします。同じバージョンの PR が一度でもあれば（閉じたものも）、作り直しません。
    - PR を作ってマージするのは、確認とは別のジョブ（`update`）です。書き込める権限を、PR の CI で動くコードに渡さないためです。
    - GitHub Actions のトークン（`GITHUB_TOKEN`）で作った PR では、PR の CI が動きません。そのため、push・PR の作成・マージは、Homebrew の配信と同じ GitHub App の token でします。PR の CI（必須のチェックの `check`・`build`・`tour`）が普通の PR と同じく動き、`update` ジョブはそれが通るのを待ってからマージします。マージしたあとの develop への push でも、ワークフローが動きます。
    - App には、tanacode の Contents と Pull requests の書き込みの権限を付けて、tanacode にもインストールしておきます。App の Client ID と秘密鍵は Environment「homebrew」にあるので、`update` ジョブは develop で動かしたときだけ動きます。
    - PR の CI が通らなかったとき・マージできなかったときは、`update` ジョブが失敗して、PR は開いたまま残ります。人が見て直します。
    - develop のルールセット（need-pr）は、PR を通すことと、必須のチェック（`check`・`build`・`tour`）が通ることを求めています（承認 0 人・squash のみ）。
  - 途中の控えは artifact（`claude-code-<バージョン>`）にも残します。
  - 「Run workflow」で、バージョンを指定して確かめることもできます。通れば、定期の確認と同じく PR を作ってマージします（動作確認済のバージョンより古いバージョンでは作らない）。

## 仕組み

### Claude Code の動かし方

- セッションごとに、node-pty で本物の `claude` を起動します。
  - 起動するのはアプリではなく、pty ホストという常駐プロセス。アプリを再起動しても Claude Code を止めないためです。
    - アプリが Electron を Node として（`ELECTRON_RUN_AS_NODE`）、アプリと切り離して起動します。macOS では Dock にアイコンが出ないよう、同梱の `tanacode Helper.app` の実行ファイルを使います。アプリとは userData の Unix ソケット（`pty-host.sock`。`0600`。つながれば任意のコマンドを起動できるため、自分だけにする）でやりとりします。パスが長すぎるときは一時フォルダに置きます。
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
- アプリ内ブラウザを Claude に操作させる設定・ほかのセッションを扱わせる設定・チェックリストとウォークスルーの設定がオンなら、`--mcp-config` でそれぞれの MCP サーバー（中継）を、`--allowedTools` で許可済みにするツール（読むだけのもの・アプリ内ブラウザの `ask_user_to_act`・チェックリストとウォークスルーのすべて）の許可を足します（下の「アプリ内ブラウザ（Claude による操作）」「セッション間の連携（Claude による操作）」「チェックリスト」「ウォークスルー」）。どちらも値をいくつも取る引数なので、次の `--` で終わるよう `--settings` より前に置きます。
  - 2 つのサーバーを足すときも、`--mcp-config` と `--allowedTools` は 1 回ずつにまとめて渡します（`mcpArgs`）。2 回渡したときの扱いが決まっていないためです。
- アプリが起動する Claude Code にだけ、`--settings` で statusLine を足します。
  - Claude Code は応答のたびに JSON を渡してきます。中身はモデル・コンテキストの上限と使用率・利用枠・今の会話ログのパス。これをセッションごとのファイルに書かせて読みます。
  - ユーザー自身が `~/.claude/settings.json` で statusLine を設定していれば、同じ JSON をそちらにも渡します。プロジェクトの設定（`.claude/settings*.json`）の statusLine は写しません。clone したリポジトリのコマンドを、フォルダの信頼の確認の前にフラグの設定として動かさないためです。このセッションでは `--settings` の statusLine が優先されるので、プロジェクトの statusLine は動きません。
- 同じく `--settings` で、AskUserQuestion の PreToolUse のフックを足します。質問の入力をセッションごとのファイルに書かせるだけで、何も止めません。ユーザー自身のフックは、これまでどおり一緒に動きます。このフックはチャットのフックの一覧に出しません。
- Bash の PreToolUse には、worktree やブランチを消す操作の歯止めのフック（`worktree-guard.ts`）を足します。`git worktree remove --force`・`git branch -D`・worktree の `rm -rf` だけ、`permissionDecision: "ask"` を返して許可の確認を出させます。
  - `ask` は、権限モードが auto や bypassPermissions でも確認を出します（実測）。止めはしません。
  - Node があるとは限らないので、macOS に必ずある awk で JSON を読みます。コマンドは `;`・`&&`・`|` などで区切り、区切りごとに見ます。macOS の awk（bwk awk）でも動くかは、`TANACODE_AWK=<bwk awk のあるフォルダ> npx vitest run test/worktree-guard.test.ts` で確かめられます（Linux なら `original-awk`）。
  - チャットのフックの一覧には出しません（目印は環境変数の名前 `TANACODE_WORKTREE_GUARD`）。
- 裏で Claude Code を別に起動することはありません（子セッションも、許可の確認のあとに、一覧に並ぶふつうのセッションとして起動します）。利用枠の取得に `/usage` を実行することもありません。

## 機能ごとの実装メモ

使い方（[GUIDE.md](GUIDE.md)）の裏で、何をしているか。

### セッション

- `/` の補完には、同じフォルダの前の会話からスキルの一覧を借りて出します。新しい会話には、まだ一覧が無いためです。
- 起動中（入力欄が出るまで）に送った発言は、起動が終わるのを待ってから送ります。起動中に打った文字は、Claude Code が取りこぼすためです。
- 新規セッションの画面で選んだフォルダは、`folders.open` で `folder:` から始まる id を払い出して開きます。main はこの id もセッションの id と同じようにフォルダに直すので、右パネル（エクスプローラー・検索・ソース管理）とエディタは、セッションが無くてもそのまま使えます。開けるのは、フォルダ選択ダイアログで選んだフォルダとセッションのフォルダだけ。フォルダを変えたり画面を閉じたりしたら `folders.close` で閉じ、ファイルの監視も外します。
- 新規セッションの「最近のフォルダ」は、保存せずにセッション一覧（アーカイブ済みを含む）から作ります（`src/shared/recent-folders.ts`）。外したフォルダは、外した時刻と一緒に localStorage の `tanacode.hiddenFolders` に覚え（`useHiddenFolders.ts`）、一覧から除くだけでセッションは消しません。外した時刻より新しく作った（取り込んだ）セッションがあれば、フォルダはまた出ます。
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
  - `node_modules` の用意は、Claude Code が入力欄を出してから始めます。`git worktree add` は `.git` を先に書き、そのあとでファイルを書き出すので、`.git` ができた時点では、大きなリポジトリだと `git ls-files` が空になります（実測。サブフォルダの `package.json` を見落とす）。Claude Code は worktree を作り終えてから入力欄を出します。
  - 準備の段階（`SessionWorktree.preparing`: creating・restoring・copying・installing）は、一覧とチャットに出します。準備が終わるまで `ready` を配信しないので、最初の指示はその後に送られます（`pendingSends` の今の形のまま）。終わったら、何をしたかを `info` のイベントでチャットに出します。
  - `node_modules`: モノレポのため、worktree で `git ls-files` した `package.json` のフォルダごとに見ます（node_modules の中は除く）。元のフォルダにあって worktree に無い `node_modules` を、ディレクトリ丸ごと 1 回の `clonefile(2)`（APFS のクローン）で複製し、`.vite`・`.cache` を消します。
    - `cp -c -R` はファイル 1 つごとにクローンするので、ファイルの多い `node_modules` では遅くなります（実測: 15 万ファイルで 44 秒。丸ごとの `clonefile` なら 3 秒）。`clonefile` を呼べるコマンドは無いので、macOS 標準の `osascript`（JXA の `ObjC.bindFunction`）から呼びます（`apfsClone`）。
    - 別のボリューム・APFS 以外などで `clonefile` が失敗したときは `cp -c -R` に切り替えます（こちらはクローンできなければ通常のコピーになります）。
    - install のコマンドは、lock ファイルで決めます（`LOCKFILES`。`pnpm-lock.yaml` → `pnpm install`、`yarn.lock` → `yarn install`、`bun.lock(b)` → `bun install`、`package-lock.json` → `npm install`）。同じフォルダに複数あれば、npm 以外を使います（古い `package-lock.json` が残っていることがあるため）。
    - install する場所: lock があり、元のフォルダでも依存を入れている（`node_modules` か `.pnp.cjs` がある）場所のうち、lock が元のフォルダと違うところと、複製できなかった `node_modules` を受け持つところ（同じフォルダか、いちばん近い上のフォルダの lock。workspaces ならいちばん上）。上のフォルダから順に実行します。
    - yarn の Plug'n'Play: `.pnp.cjs` はふつう gitignore されていて worktree に無く、`yarn install` するまで依存を読めません。元のフォルダにあって worktree に無ければ、lock が同じでも `yarn install` します。
    - install は `ShellTerminals.run` でログインシェルから実行し（Finder から起動したアプリでも、ふだんの PATH の npm を使うため）、`shell.onOpened` でターミナルパネルにタブを出させます。タブは終わっても残し、終了コードを名前に添えます。
  - 元のフォルダの未追跡に `.claude/worktrees/` が出ないよう、`.gitignore` で無視されていなければ `.git/info/exclude`（`git rev-parse --git-path info/exclude`）に足します。リポジトリの `.gitignore` は書き換えません。
  - Claude Code は worktree に「claude session <名前> (pid …)」のロックを付け、プロセスを止めても残します。`--resume` では付け直しません（実測）。消すときは、この理由のロックだけ外し、ほかのロックがあれば消さずに断ります。
  - 削除: アーカイブ・一覧からの削除で `removeWorktree` を指定したときだけ。`ClaudeSession.stop` で Claude Code が終わるのを待ち、未コミットの変更と未追跡のファイルがあれば、一時的なインデックス（`GIT_INDEX_FILE`）で `read-tree HEAD` → `add -A` → `write-tree` → `commit-tree` して `refs/tanacode/backup/<名前>`（あれば `-2`・`-3`…）に残します。そのうえで `git worktree remove --force`。何も残っていなければ `--force` なし。最後に `git branch -d`（上流か、元のフォルダの今のブランチにマージ済みのときだけ消える）。消えなくても、手元にしか無いコミットが無ければ（`localOnlyCommits` が 0）、`git branch -D` で消します。数えられなかったときは消しません。
    - `git worktree remove` の前に、gitignore されたフォルダ（`node_modules`・`dist` など）を `git ls-files --others --ignored --exclude-standard --directory` で見つけ、`<git-common-dir>/tanacode-trash/<名前>-<乱数>/` へ `rename` で動かします（`setAsideIgnoredDirs`）。`git worktree remove` に消させると、ファイルの多い `node_modules` で 20〜30 秒かかるためです（実測: mitsucari の約 25 万ファイルで 27 秒。`rm -rf` で 31 秒、8 並列でも 18 秒で、APFS のファイル削除が下限）。`rename` なら 0.2 秒で返ります。
    - `git worktree remove` に失敗したら、動かしたフォルダを元に戻します。成功したら、ごみ箱を裏で `rm -rf` します（待たない）。アプリが終わって消し残しても、次に worktree を消すときに片付けます（使っている最中のごみ箱は消さないよう、メモリに覚えておきます）。`rename` できないフォルダ（別のボリュームなど）は動かさず、git に消させます。
    - 消す前の確認に出すもの（`worktreeLeftovers`）: 未コミットの変更と未追跡のファイルの数（`git status`）、プッシュしていないコミット（`localOnlyCommits`）、ブランチから作った PR。
    - PR（`github.ts` の `pullRequestsOf`）: `gh pr list --head <ブランチ> --state all --json …`。head の名前は、上流（`branch.<名前>.merge`）があればその名前。いくつかあれば、開いているもの → マージ済み → 閉じたものの順に、新しいもの。`gh` は、起動時に取り込んだログインシェルの PATH から探します。`gh` が無い・ログインしていない・GitHub のリポジトリでないなどで失敗したら「調べられない」として、PR を使わずに数えます。
    - プッシュしていないコミット（手元にしか無いコミット）: 上流があれば上流に無いもの、無ければ `--remotes` にも、ほかのブランチ（`--branches`）にも無いもの。PR の head のコミットも除きます（GitHub は、マージのあとにリモートのブランチを消しても、PR の head を残すため）。手元に無い head は除けないので（`rev-list` の `--not` に渡すと失敗する）、`cat-file -e` で確かめてから渡します。
    - それでも残れば、PR を使わずに手元でスカッシュマージ・cherry-pick したものかもしれないので、中身がデフォルトブランチ（手元と `origin/<デフォルトブランチ>`）に入っているかを比べ（`mergedInto`）、入っていれば 0 にします（`contentIn`）。コミットが作り直されてハッシュが変わるので、中身で比べます。デフォルトブランチの、ブランチと分かれたあとの時点（今の先頭と、ブランチが変えたファイルに触れたコミットを古い順に。100 まで）で `git merge-tree --write-tree <時点> <ブランチ>` し、結果のツリーがその時点のツリーと同じ（マージしても何も変わらない）ものがあれば、入っているとみなします。今の先頭だけだと、マージのあとに同じところを変えると衝突して見分けられず、ブランチ全体の差分のパッチ ID（`git cherry`）だと、マージまでにデフォルトブランチが近くの行を変えると一致しないためです。衝突を直してからマージしたものは見分けられず、入っていない側に倒れます。
  - 作り直し: 削除したセッションを開くと、`git worktree add <場所> <ブランチ>`（ブランチが無ければ `-b` で今の HEAD から）で作り直してから、worktree のフォルダで `--resume` します。Claude Code は worktree を消したあとに再開すると、元のフォルダで「worktree の結び付きを外した」と言って続けるため（実測）、作り直してから起動します。
  - アプリが自分から worktree を消すことはありません（「Claude Code も止めて終了」でも消さない）。Claude Code の終了時の確認（残す・消す）は、アプリがプロセスを止めるので出ません。Claude Code の自動の掃除も、`--worktree` のセッションは対象外です。
- Remote Control の切り替えは、Claude Code が動いていればその場で `/remote-control` を送ります。以前つないでいた会話を再開すると、Claude Code はフラグが無くても勝手につなぎ直すので、オフのセッションでそうなったら、すぐに `/remote-control` で切ります。

### チャット

- 送った発言は、すぐチャットに出し、会話ログに書かれたら本物に置き換えます。Claude Code の作業中に送った発言は、今の作業が一区切りするまで会話ログに書かれません。
- チャットの入力欄からの送信は、画面が pty に直接打たず、main の `SessionManager.submit`（IPC `sessions:submit`）が Claude Code の入力欄に打ち込みます。同じセッションへの送信は、親セッションからの指示・子の知らせも含めて、セッションごとの順番待ち（`sendChain`）で 1 つずつ打ちます。2 つの送信の文字が、入力欄で混ざらないようにするためです。
  - 打ち込んでいる途中の文字（送ってから 5 秒の間）は、main が画面に知らせる書きかけ（`draft`）から除きます（`shownScreen`）。Claude Code の入力欄に残った文字として、チャットの入力欄に移してしまわないためです。
  - 人が Claude Code の画面（ターミナル）で打っている途中の文字も、チャットの入力欄に移しません。画面にフォーカスがある間と、離れてから 0.5 秒の間は、画面で打っているとみなします（`terminal/claudeScreenTyping.ts`。`ClaudeScreen` が `focusin`・`focusout` で知らせ、`chat/claudeDraft.ts` の `useTakeClaudeDraft` が移すのを待つ）。打つそばから移して消すと、途中の文字が欠けるためです（打つのが遅い macOS の E2E で実測）。最後に打ってからの時間では見分けません。考えながら手を止めている間に移してしまうためです。
    - Enter で送れば、Claude Code の入力欄は空になるので、何も移しません。画面で Esc を押して中断し、入力欄に戻った発言も、画面にいる間はそのまま残します。
    - 打ちかけたまま画面を離れたら（チャットの入力欄をクリックした・パネルを閉じた・シェルのタブにしたなど）、書きかけをチャットの入力欄に移し、Claude Code の入力欄は消します。残すと、チャットから送った文字が書きかけの後ろにつながり、予約や親子の知らせも打てない（`acceptsTyping`）ためです。0.5 秒待つのは、Enter の直後に離れたとき、送った文字が入力欄から消えた画面が届くのを待つためです。
    - ほかのアプリに切り替えたとき（フォーカスが画面に残る）は、打っている途中のままにします。戻れば、そのまま続きを打てます。
  - Enter は、打った文字が入力欄に出てから送ります（`untilTyped`・`typedShown`。空白を除いて末尾で比べ、貼り付けは `[Pasted text #1 …]` の目印が出たかで見る。3 秒たっても出なければ、そのまま送る）。決まった時間だけ待つと、Claude Code が忙しくて読むのが遅れたとき（起動の直後に MCP サーバーがつながる間など）、文字と Enter が 1 度に届きます。長い文字（親からの指示など）と一緒に届いた Enter は、貼り付けの中の改行として入力欄に入り、送られません（2.1.292 で実測）。
  - 中断（Esc）は `sessions:interrupt`。打ち込み中の控えを捨てるので、応答の前に中断して Claude Code が入力欄に戻した発言は、そのままチャットの入力欄に移ります。
- 「作業中…」の横の進み具合は、Claude Code の画面のタイマーの行から読みます。順番待ちの発言があるあいだは、Claude Code がタイマーの行を出さないので、「作業中…」だけになります。
- Claude の思考は、会話ログに空で記録されるので出せません。設定（`showThinkingSummaries`）で要約を残させることはできますが、英語なので使っていません。
- 応答の文章は、書き終わるまで会話ログに書かれないので、チャットには書き終わってから出ます。
- 応答が来る前に Esc で中断すると、Claude Code は発言を会話から外して入力欄に戻し、会話ログには何も書きません（中断の行もターンの終わりの行も無い）。入力欄に戻った文字が、応答の無い最後の発言と同じなのを画面で見て、発言の表示を取り消し、ターンを終えます（`pulledBackPrompt`）。戻った文字は、チャットの入力欄に移します。
  - 次の発言は、外した発言より前の行を親にして書かれます。会話の最初の発言だったときは親が無い（null）ので、会話の始まりからの枝分かれとして読みます（`branchCut`）。
  - 親セッションからの指示は、囲み（複数行なら貼り付けの目印）ごと入力欄に戻るので、囲みの始まりで比べます。
- Claude Code は新しい会話ログを作るとき、最初の応答の行を発言の行より先に書くことがあります。まとめて読んだ行のうち、親（`parentUuid`）が後ろにある行は、親のすぐ後ろに回して読みます（`parentFirst`）。親の行があとの読み込みで届くこともあるので、追いかけて読む行（`TranscriptTail`）は、親の行がまだ届いていなければ、親が届くまで（長くても 1 秒）待ってから出します。読み始めた時点で既にあった行（再開したセッションの過去ログ）は待ちません。
- ToDo は、今の Claude Code の TaskCreate・TaskUpdate（と、前の TodoWrite）を会話ログから読んで組み立てます。
- ツールの行の説明は、Bash・Agent などの `description`。
- 質問のカードでは、押した選択肢に枠を付けます。ターミナルのカーソルが選択肢を順に動く様子は出しません。答えが会話ログに書かれたら、画面の読み取りを待たずにカードを閉じます。答えたあとの画面がうまく読めないと、カードが残ってしまうためです。
- モデルの一覧は、Claude Code が持っている一覧の控え（`~/.claude/cache/model-catalog/`）から作ります。モデルやエフォートを変えると、`--model` / `--effort` を付けて起動し直し、会話を再開します。
- コンテキストの上限は、statusLine の値（1M かどうかも含めて正確な値）を使います。圧縮の直後は statusLine の使用量が次の応答まで 0 になるので、会話ログの圧縮後の量（`compactMetadata.postTokens`）を使います。
- 引数が複数行・長い（800 文字を超える）`/compact` は、名前だけを打鍵し、引数をブラケットペーストで送ります（`promptKeys`）。丸ごと貼り付けると、Claude Code は入力を `[Pasted text #1 …]` の目印に置き換え、`/` で始まらない入力として、コマンドにせずにふつうの発言で送るためです（実測）。ほかの「/単語」で始まる複数行の発言（「/api のエンドポイントを…」など）は、今までどおり丸ごと貼り付けます。名前を打鍵すると、Claude Code がコマンドとして実行したり（`/clear` など）、知らないコマンドとして断ったりするためです。

### 時刻を指定して送信（予約）

- 予約は main の `ScheduledMessages`（`scheduled-messages.ts`）が持ち、`scheduled-messages.json` に保存します。画面（`chat/SchedulePicker.tsx`・`chat/ScheduledRow.tsx`）は IPC（`scheduled:*`）で予約・時刻の変更・今すぐ送る・取り消しを頼み、`scheduled:changed` で一覧を受け取るだけ。画面を閉じていても、時刻になれば送ります。
- 時刻になったら、子セッションへの指示と同じ `SessionManager.submitWhenReady` で送ります。手が空く（ターンが終わり、入力を受け付けられる）のを待ってから打つので、作業中に出た許可の確認に、打った文字や Enter が選択として入ってしまうことがありません。待つ時間の上限は無し。待っている間に取り消したら、`AbortSignal` で待つのをやめます（打ち込み始めたあとは止めない）。画像は、チャットの入力欄からの送信と同じく、パスを貼り付けとして送ります。
- 止まっているセッション（`exited`）は、`SessionManager.open` で再開してから送ります。起動が終わるまでは、`submitWhenReady` が待ちます。
- 時刻を `SCHEDULE_LATE_MS`（5 分）より過ぎてから気づいたもの（アプリが閉じていた・Mac がスリープしていてタイマーが遅れて動いた）は、送らずに `missed` にします。何時間も前の指示が、急に動き出さないようにするためです。送っている途中（`sending`）でアプリを閉じたものは、まだ送っていないので、時刻を待っていたものと同じに扱います。
- 送れなかったもの（`failed`）と `missed` は、macOS の通知で知らせます（`scheduledNotice`）。どちらも一覧に残し、人が今すぐ送る・時刻を変える・取り消すを選びます。
- セッションがアーカイブされた・一覧から消えたら（`SessionManager.watchState` で状態が `archived` か、知らないセッションになったら）、そのセッションの予約を取り消します。
- タイマーは、いちばん早い予約に 1 つだけ掛けます。`setTimeout` の上限（約 24.8 日）より先なら、途中で一度起きて測り直します。

### 翻訳

- 画面は `src/renderer/src/translate/BlockTranslation.tsx` の `useBlockTranslation`。ボタンと訳文の部品を返し、`chat/ChatRow.tsx` の `ResponseBlock`・`ThinkingBlock` が使います（サブエージェントの会話の表示も同じ部品なので、そこにも出ます）。
  - ボタンを出すのは、主に日本語でない文のときだけ（`src/shared/translate.ts` の `isMostlyForeign`）。コード・URL・パス（`/` や、文字にはさまれた `.` を含む語。日本語の応答にも多い）を除いた文字で、ラテン文字が 20 字以上、かつ日本語の文字がラテン文字の 1 割に満たないもの（ラテン文字の言語だけが対象）。1 つのブロックの一部だけが英語、ということはないので、ブロック全体で見ます。
  - 使えるか（`translate:available`）は、ボタンを出す文が来たときに main に一度だけ聞き、答え（使えない、も）を覚えておきます。覚えたもの（使えるか・訳文）は、Storybook がストーリーごとに `resetBlockTranslation` で捨てます（`.storybook/preview.tsx`）。
  - 訳文を出している間に押すと閉じ、訳せなかったあとに押すと訳し直します。畳んだ思考で押したときは、思考を開きます。ボタンはマウスを乗せなくても出しておきます。応答では本文より先に置いて右へ回り込ませる（`float`）ので、本文やコードブロック（「実行」のボタンも）はボタンをよけ、文字が隠れません。
  - ボタンは、はじめの描画では出さず、画面に出てから（effect で）出します。作業の書き出しは思考の行を `ChatRow` で `renderToStaticMarkup` するので、押しても動かないボタンが HTML に入らないようにするためです。
  - 訳文は、原文をキーに画面のメモリにだけ 200 件まで持ちます（保存しない）。訳文の Markdown のコードブロックには、実行ボタンを付けません（原文の方にある）。
  - アイコンは `TranslateIcon`（`icons.tsx`・`catalog.ts`）。
- 訳す前後の文字の扱いは、`src/shared/translate.ts` の `planTranslation`・`applyTranslation`。
  - 1 行ずつ渡します。macOS の翻訳に複数行をまとめて渡すと、改行が空行に増えるためです。
  - コードブロック（`` ``` ``・`~~~` の囲み。引用の `>` の中のものも。閉じるのは印だけの行で、`` ```bash `` のような行は入れ子の中の開く印として閉じない）の中と、リンクの参照の定義（`[1]: https://…`）は渡しません。行頭の字下げ・引用・リスト（チェックボックスも）・見出しの印は外して渡し、訳したあとに付け直します。文字を含まない行（表の区切りの行など）も渡しません。
  - 表の行は、区切りの `|` の数が変わったら（崩れたら）原文のまま。インラインコードは、訳しても `` `…` `` のまま残ります（macOS 26 で実測）。太字は「」になることがあります。
  - かかる時間は 1 行に 50 ミリ秒ほど（200 行で 9 秒。実測）。
- main は `src/main/translate.ts`（テストのため、electron を import しない）。
  - 補助プログラムのパス（`translateHelperPath`）は、パッケージ後は `process.resourcesPath`、開発中は `app.getAppPath()/build/native` の `tanacode-translate`。使えるのは、macOS 15 以上で、ファイルがあるとき（`translateAvailable`）。
  - 画面から来た値は、文字列の配列で、最大 1000 行・合計 100,000 字までかを確かめます（`translateTexts`）。
  - 依頼ごとに補助プログラムを `execFile` で起動し、訳す文字を標準入力で渡します（`runTranslateHelper`）。依頼は `Translator` が 1 つずつ順に動かします（続けて押されても、一度にたくさん起動しない）。返事は `parseTranslateOutput` で読み、形が違えば `failed`。
  - IPC は `index.ts` の `registerIpc`（`translate:available`・`translate:run`・`translate:open-settings`）。`translate:open-settings` は、決まった URL（`x-apple.systempreferences:com.apple.Localization-Settings.extension`。「言語と地域」）だけを開きます。
- 補助プログラムは `native/translate/main.swift`。
  - 標準入力で `{"texts": [...]}`（JSON）を受け、標準出力に結果の JSON を 1 行で返します。訳せたら `{ok: true, texts, source}`、訳せなければ `{ok: false, error, source?, message?}`（`error` は `same-language`・`not-installed`・`unsupported`・`failed`）。
  - 元の言語は `NLLanguageRecognizer` で判定し、`LanguageAvailability` で翻訳データが入っている（`installed`）ときだけ訳します。入っていないまま訳すと、ダウンロードの確認を出そうとして止まるためです（窓が画面の外なので見えない）。
  - macOS 15 では、翻訳のセッションを SwiftUI の `translationTask` からしか作れません。そこで、画面の外に小さな窓を置いて、そこで動かします。アプリは accessory なので前に出ず、フォーカスも奪いません（実測）。
  - 止まったまま窓が残らないよう、20 秒 + 1 行 0.1 秒で自分で終わります。main も、それより少し長く待って返事が無ければ止めます。
- 作るのは `scripts/build-translate-helper.mjs`。
  - `xcrun` の `swiftc` で arm64 と x86_64（`-target <アーキテクチャ>-apple-macos15.0`）を作り、`lipo` で 1 つにまとめ、`codesign --force --sign -` で署名し直して `build/native/tanacode-translate` に置きます（`.gitignore` 済み）。lipo のあとに署名し直さないと、起動を止められることがあるためです。
  - 元（`main.swift` とこのスクリプト）より新しいものがあれば、作り直しません。
  - macOS でない・`swiftc` が無い・作れないときは、警告だけ出して進めます（翻訳のボタンが出ないだけ）。`swiftc` があるかは、先に `xcode-select -p` で確かめます（Command Line Tools が無い Mac では、`xcrun` がインストールのダイアログを出すため）。`--require` を付けると失敗にします。
  - `package.json` の `predev`・`prebuild`・`predist` で呼び、`prerelease` では `--require` 付きで呼びます。`postinstall` には入れません（PR の CI は ubuntu で `npm ci` するため）。
  - `build.extraResources` で `Contents/Resources/tanacode-translate` に入れます（electron-builder が、アプリの署名に合わせて署名し直す）。electron-builder は元のファイルが無くても警告だけで進むので、`release.yml` で、パッケージしたあとに両方のアーキテクチャのアプリに入ったかを `test -x` で確かめます。

### コンテキストの中身と圧縮

- 中身の一覧は、本体の会話ログから `ContextTracker`（`context-tracker.ts`）が集めます。`KnowledgeTracker` と同じく、`SessionManager` が行ごとに渡します。起動していないセッション（アーカイブ済みなど）は、取りに来たときに会話ログ全体を読みます（`readContext`）。
  - 画面は、パネルが見えている間だけ取りに行き（`context:get`）、使用量が変わったら（`knowledge:changed`）取り直します。
  - 巻き戻し（`/rewind`）は、チャットと同じく `branchCut` で、外れた枝のものを捨てます。同じ uuid の行が 2 回書かれたとき（デスクトップ版の会話ログは圧縮のたびに最初から書き直す・圧縮でそのまま残した行の書き直し）は、前のものを使います。巻き戻しの検出（`branchCut`）より先に見ます。
- 並べるものと、まとめ方
  - ファイル: Read の結果・Edit や Write の入力（書いた中身）・`@` や圧縮のあとの添付（`file`）・変更に気づいた知らせ（`edited_text_file`）・CLAUDE.md や記憶（`instructions`・前の Claude Code の `nested_memory`）。同じファイルは 1 行に足します。
  - ツールの結果: 1,000 トークン以上のものだけ 1 行にし、小さいものはやりとりに足します。スキルの本文（`Skill` のすぐあとの isMeta の行。`sourceToolUseID` でつながる）は、そのツールの行に入れます。
  - 画像: ツールの結果と発言の添付。画像のファイルを Read したときは、そのファイルの行に入れます。発言の添付は、指示の文でどれか分かるよう、発言の冒頭と何枚目かを名前にします。
  - サブエージェント: Agent の結果と、完了の知らせ（`<task-notification>` の `<tool-use-id>`）・報告（`<agent-message from>` のサブエージェントの ID）を、起動した行にまとめます。
  - やりとり: 発言ごと。質問（AskUserQuestion）への答え・待機中に届いた完了の知らせや別の Claude からの知らせでも区切ります（発言だけで区切ると、1 つのまとまりが会話全体の半分以上になりがちなため。実測）。作業の途中に届いた知らせ（`queued_command`）では区切りません（作業の途中に送った人の発言では区切ります）。知らせかどうかは、出どころ（`origin.kind`）か、文の先頭の `<task-notification>` で見ます。圧縮を送った発言・コマンドの記録は、要約の行に入れます。
  - モデルに渡らない attachment（`prompt_snapshot`・`deferred_tools_record`・`compact_file_reference` など）は数えません。
  - Claude Code が足す一覧や環境の知らせ（`skill_listing`・`*_delta`・`environment`・`total_tokens_reminder` など）は、一覧に出さず「そのほか」に入れます。圧縮のあとにも送り直され、`/compact` の指示では消せないためです。大きさの直し（下）には入れます。hooks が足した文（`hook_*`）は、そのやりとりに入れます。
- 大きさの見積もり（会話ログ 129 本で実測）
  - 文章は文字数から。日本語（CJK の記号・かな・漢字・全角）は 1 文字 1.07 トークン、ほかの文字は 2.2 文字で 1 トークン（Bash の出力やコードが多く、よく言われる 4 文字より重い）。ツールの結果 1 つに 40 を足します。
  - Claude の応答は、`message.usage.output_tokens`。思考は会話ログに中身が残らない（署名だけ）のに、次の入力に残るためです。同じ応答（`message.id`）は中身のブロックごとに別の行に書かれるので、1 回だけ数えます。書いた中身（Edit・Write の入力）は、応答からファイルの行に移します（その応答の出力より多くは移さない）。
  - 応答の入力の量は、前の応答の入力と出力に、その間に増えた中身を足したもの。その差で、間に増えた中身（ツールの結果・発言・添付）の見積もりを直します。多くは結果が 1 つなので、ほぼその大きさになります。直す割合が 0.25〜4 倍を外れたとき（ツールの定義の読み込みなど、会話ログに無いものが混ざる）と、圧縮の境目をまたぐときは直しません。巻き戻したあとは、切られた応答で直し終えた分を差から引いて、残りだけを直します。
  - 画像は、幅 × 高さ ÷ 750（PNG・JPEG・GIF の頭から大きさを読む）。
  - 一覧の合計と、statusLine の使用量の差を「そのほか（システムプロンプト・ツールの定義・Claude Code が足す知らせなど）」として出します。実測では 3.3 万〜5 万で安定していました（会話ログ 40 本）。
  - 圧縮の直後は、statusLine の使用量が次の応答まで分かりません（会話ログの圧縮後の量は、システムプロンプトなどを含まない）。一覧の合計より小さいときは、全体の量を出しません。
- 圧縮の前と後
  - 最後の `compact_boundary` より前の行のものを、圧縮で要約に置き換わったもの（`compacted`）にします。ただし `compactMetadata.preservedMessages.allUuids` の行（要約せずにそのまま残された直前の応答など）は、今のものとして数えます。
  - 要約の行（`isCompactSummary`）は「前回の圧縮の要約」の行に。圧縮のあとに添付し直されたファイルは、今のファイルの行になります。
- 圧縮の指示（`compactInstructions`・`src/shared/context.ts`）
  - 印から決まった形の文を組み立てます。「A の内容と、「B」から始まるやりとりは詳しく残す。C の出力は捨ててよい。」のように、種類ごとの言い方（ファイルは内容、Bash は出力、検索は検索結果など）でつなぎます。裏で Claude Code を起動して文を作らせることはしません。
  - Claude Code は、`/compact` の引数を要約のプロンプトの最後（`Additional Instructions:`）に、そのまま足します。長さの上限は無く、改行も残ります（Claude Code 2.1.288 の本体で確認）。
  - 指示は効きます。本物の Claude Code で、同じ会話を「設計を残し、インストールの出力とポートの調べものは捨てる」「指示なし」「逆の指示」で圧縮すると、残すとした目印はすべて要約に残り、捨ててよいとした目印は 0 件でした（指示なしでは全部残った）。
  - 印は、セッションごとに画面のメモリに持ちます（アプリを終了すると消える）。付けたときの要約の行（圧縮の区切り）と一緒に覚え、圧縮が進んで要約の行が変わったら使いません（ヘッダーの「圧縮」・自動の圧縮も）。送った時点では外しません。送れなかったときに、付け直さなくてよいようにするためです。
  - パネルは、セッションごとに作り直します（`key`）。書きかけの指示を、切り替えた先のセッションに送らないためです。

### 作業の書き出し

- 材料は、会話ログを最初から読み直したもの（`sessions.exportSource` → `readExportLog`）。動いているセッションでも、画面のチャットではなく会話ログから作ります。読み直すときに、画像も画像置き場（`image-cache.ts`）に入れ直します。ブランチは、会話ログの行の `gitBranch`（会話全体で出てきた順。範囲には合わせない）。
  - アーカイブ済みなどの止まっているセッションは、チャットと同じく最後にターンを終わらせ、結果の来なかったツールを中断にします。Claude Code が動いているセッションは終わらせず、作業の途中のツールを実行中のまま入れます。
  - 期間と発言の時刻のため、発言と応答のイベントに会話ログの時刻（`at`）を持たせています。
- 範囲の切り方・選んだものの外し方・`~` への置き換え・先頭に出すものは `exportContent.ts`。
  - 最初の発言からの範囲には、その前の行（起動時のお知らせなど）も入れます。最後の発言までの範囲は、次の発言の手前（その発言への応答の終わり）まで。
  - ツールの結果を外すときは、`!` のコマンドの出力と hooks の出力（標準出力・標準エラー・Claude に渡した内容・止めた理由）も外します。変えた行の数・hooks の結果・ツールの入力は残します。差分を外すときは、`NotebookEdit` の入力（書いた中身が入る）も外します（Edit・Write の入力は、もともと空）。
  - `~` への置き換えは、チャットの行・ToDo の一覧・セッション名・フォルダ・ブランチの文字をすべて書き換えます（画像の鍵は uuid なので変わらない）。`/Users/me2`・`/Users/me.old` のような別のフォルダと、パスの途中（`…/Data/Users/me`・URL の中）は置き換えません。Claude Code の会話ログのフォルダ名（パスの `/` と `.` を `-` にした `-Users-me-…`）の中も、名前を残さないよう `-~` にします。
- HTML は、チャットの部品を `renderToStaticMarkup` で文字にします（`ExportDocument.tsx`）。チャットと同じクラスを使い、畳む・開くは `<details>` で動かします（JavaScript は入れない）。
  - お知らせ・思考・区切り・エラー・`!` のコマンドは `ChatRow`、質問と答えは `AnswersCard`、届いたファイルは `SentFilesCard`、カードの中身は `ToolDetail`、hooks は `HookChip`・`HookDetail`、ToDo は `TodoList` を、チャットと共通で使います。画面で動かすもの（終わるときの動き・画像の取り寄せ・コードブロックの実行ボタン）は使いません。
  - Markdown は、チャットと同じ整形と消毒（`markdownHtml`）をして入れます。チャットの Markdown には mermaid の図やコードの色付けが無いので、そのまま静的な HTML になります。
  - 画像を押すと大きく出すのも `<details>`。開いたときに `summary` の `::before` を画面いっぱいの暗幕にし、暗幕を押すと閉じます。小さく並べるときの `overflow: hidden` が残ると暗幕が描かれないので、開いたときは外します（実測）。
  - ToDo の進み具合は、ToDo を変えたツールごとに、変えたあとの一覧を持ち（`todoSteps`）、そのまとまりの下に出します。
- CSS は、`global.css` の元の文字（`?raw`）から、書き出した中身に当たる規則だけを抜き出します（`exportCss.ts`）。ホバー・`[open]` などの状態は外して、当たる要素があるかを見ます。`@font-face`・`@keyframes` は入れず、動きは止めます。
  - ブラウザが読み込んだ規則（`CSSRule.cssText`）を書き戻さないのは、`var()` を使った一括指定（`background: var(--grad-flow) …`）の後ろに個別の指定（`background-clip` など）があると、値が空になって消えるためです（実測。進行中の ToDo の文字が消えた）。
  - 書き出した HTML でしか使わない見た目は、`global.css` の「書き出した HTML」の節に `export-` で始まるクラスで書きます。ページを縦に流す指定（アプリの画面は高さを画面に合わせている）と、動きを止める指定は、`exportHtml.tsx` の `PAGE_CSS`。
- 外へ読みにいかないよう、`<meta http-equiv="Content-Security-Policy">` で `default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'` にします（`base`・`form` は `default-src` で止まらない）。本文のリンクの先を開いただけで名前解決しないよう、`x-dns-prefetch-control` も切ります。
- 画像は、長い辺 1,600px までに縮めて WebP（品質 0.85）にします。小さくならなければ元のまま（GIF も、動きを残すため元のまま）。
- 保存は main（`saveExport`）。保存のダイアログ（既定は「ダウンロード」の `<セッション名> <日付>.html`）で選んだ場所に、`0600` で書きます（`writeFile` の `mode` は新しく作るときにしか効かないので、上書きのために `chmod` し直す）。Finder で見せるのは、このアプリが保存したパスだけ。
- HTML を作る部品（react-dom/server・`global.css` の文字）は大きいので、書き出すときに読み込みます（`import('./exportHtml')`）。
- 書き出すのは本体の会話だけ。サブエージェント・ワークフローの会話は入れません。

### バックグラウンドの作業（タスク）

- 動いているものを人が止める操作（`SessionManager.stopTask` → `ScreenTracker.stopTask`）は、本家の `/tasks`（別名 `/bashes`。バックグラウンドで動いているものを管理する画面）を、キー入力で操作して行います。Claude Code は、止めたものを会話ログに `<task-notification>`（Bash は `status` が `killed`、「was stopped by the user」の要約付き）として書くので、止まったかはトラッカーが今までどおり読みます。
  - 止める名前は、`/tasks` の行の見出しと同じもの。Bash はコマンド、サブエージェントは Agent の `description`（`SubagentRun.description`。`SendMessage` で再開したものは元のものから引き継ぐ）、ワークフローは名前。長いコマンドは「…」で省略されるので、同じ名前を先に探し、次に省略された頭が同じもの、最後に途中までしか出ないもの（複数行のコマンド）の順で当てます（`findTaskRows`）。2 つ以上に当たったら、取り違えないよう何も止めずに断ります。
  - 一覧（`Background`）は、実行中のものだけが種類ごと（`Shells`・`Local agents`・`Dynamic workflows`）に新しい順で並びます。↑/↓ を 1 つずつ送り、カーソル（`❯`）が目的の行に来たら `x` を送ります。一覧に見えていない行は、下へ、行き止まりなら上へ探します。止めたあとも一覧は残ります。
  - 動いているものが 1 つだけのときは、一覧を飛ばして詳細が出ます（`←` で一覧には戻れません）。Bash は `Command:`、サブエージェントは先頭の行の「種類 › 説明」、ワークフローは先頭の行（名前）で、止めたいものか確かめてから `x` を送ります。Bash とサブエージェントは止めると画面が閉じますが、ワークフローは画面が残ります。
  - 画面が開いている間は入力欄が消えるので、そのままでは「操作できない画面」と読んで、通知を出してしまいます。操作している間は画面の状態を今のままにし（`holding`）、終わったら画面を読み直します。
  - 終わったら、入力欄が見えるまで Esc を送ります。入力欄が見えているときは送りません（作業中の Esc は、作業を中断してしまうため）。
  - 打つのは、入力欄に書きかけの文字が無く、質問や確認の画面が出ていないときだけ（`/tasks` が書きかけの続きに入って、発言として送ってしまうため）。作業中でも `/tasks` は開けて、チャットの順番待ちにもなりません。
  - `/tasks` を打ったら、`/` の補完の候補に出てから Enter を送ります（補完を出している途中の Enter は、送信にならないことがある）。候補の行は、入力欄の行（行頭の「❯ /tasks」）と字下げで見分けます（`showsCommandSuggestion`）。Claude Code 2.1.290 から、選択中の候補の頭にも「❯」が付くようになったため（「  ❯ /tasks   説明」）、「❯ を含まない行」では見分けられません。
  - 止めると、Claude Code が止められたことを Claude に知らせて、Claude が続けて返事をすることがあります（本家でも同じ）。
- 終わったエージェントに `SendMessage` で続きを頼んで再開したものは、別の実行として出します。完了の知らせは `SendMessage` の呼び出しに届き、会話は前と同じエージェントのログに続けて書かれます。
- ワークフローのフロー図の順番は、journal.jsonl の開始・終了の並びから読みます。途中から再開した実行でも、前の起動からの順番が分かります。子ワークフローは、`workflow()` で呼んだもの。
- 完了通知（`<task-notification>`）は、発言の行・作業中の差し込み（attachment）・順番待ち（queue-operation）の 3 つの形で書かれます。サブエージェントの使用量（所要時間・トークン数・ツールの回数）は、attachment の `usage` が無い形でも、本文の `<usage>` から読みます。
- バックグラウンドの Bash の出力ファイルは、一度に一つずつ読みます。読んでいる途中に完了通知が届いたら、読み終えてからもう一度読み、終了コードを読んでから終わったことにします（終了コードの行を読み落とさない・終了コードの無い「完了」を出さないため）。
- 許可の確認で、実行するコマンドを囲む点線は補足に入れません。通知の本文では、Claude Code の使い方の案内（`Tip:`）の行を除きます。

### ターミナル

- シェルは、セッションのフォルダでログインシェル（`$SHELL -l`）を開きます。
- アプリが実行するコマンド（worktree の `npm install`・`yarn install` など）は、`ShellTerminals.run` で `$SHELL -l -c` から実行し、`shell:opened` でタブを足させます。終わってもタブは残し（`ShellTab.task`）、閉じるボタンは画面のタブだけを片付けます。
- モニターのアイコンのタブ（「Claude Code の画面」）では、Claude Code の生の画面（pty）を出します。見ているあいだだけ、画面の大きさをパネルに合わせます。閉じると元の大きさ（120×40）に戻します。

### アプリ内ブラウザ（Claude による操作）

- Claude Code に足す MCP サーバー（`tanacode-browser`）は、tanacode に同梱する stdio の中継（`src/main/browser-mcp.ts` → `out/main/browser-mcp.js`）。tanacode 本体を `ELECTRON_RUN_AS_NODE` で動かすので（macOS では pty ホストと同じ Helper.app）、Node.js を別に入れる必要はありません。MCP の SDK は使わず、使う分の JSON-RPC（`initialize`・`tools/list`・`tools/call`・`ping` と、取り消しの `notifications/cancelled`）だけを書いています（`mcp-relay.ts`。サーバーの定義を受け取る形で、セッションの MCP と使い回す）。
  - ツールの一覧（名前・説明・入力の形・種類）は `src/shared/browser-tools.ts`（定義の形は `src/shared/mcp-tools.ts`）。中継が `tools/list` で返し、アプリが実行し、チャットのツールの行の名前にも使います。中継が一覧を持つのは、アプリが閉じている間に起動した Claude Code にもツールを見せるため。
  - 中継は、ツールの呼び出しのたびに userData の Unix ソケット（`browser.sock`。作るときから `0600`）でアプリにつなぎ、返事を受け取ったら切ります（`mcp-bridge.ts` の `McpBridge`・`callBridge`。セッションの MCP と使い回し、ソケットはサーバーごとに分ける）。ソケットのパスとセッションは、`--mcp-config` の `env`（`TANACODE_BROWSER_SOCKET`・`TANACODE_BROWSER_SESSION`）で渡します。
  - HTTP にしないのは、アプリを閉じても Claude Code は動き続けるため。HTTP だと、アプリを起動し直すたびにポートが変わり、接続が切れたままになります。ソケットのパスは変わらないので、アプリが戻ればそのまま使えます。アプリが閉じている間は、中継が「tanacode が起動していません」と返します。
  - 足すのは起動するときだけ。`~/.claude` の設定や `.mcp.json` には書き込みません（statusLine と hooks を `--settings` で足しているのと同じ考え方）。
- 許可: 読むだけのツールと、ユーザーに操作を頼む `ask_user_to_act`（ページを動かさない。`tools/list` の `readOnlyHint` も true）は `--allowedTools` で許可済みに。ページを動かすツールは、ふつうの許可の確認を通します。JavaScript の実行（`evaluate`）は、`--settings` の `PreToolUse` のフック（`browser-gate.ts`）が、今のページで決めます。`permissions.ask` では、ページによって変えられず、localhost の開発中のページでも毎回確認が出るためです。
  - 今のページが localhost・127.0.0.1・[::1]・*.localhost（`isLocalUrl`）なら確認なし（`permissionDecision: allow`）。それ以外（`*.local` や足した先を含む）は確認（`ask`）。アプリに聞けない・答えを読めないときも `ask`。
  - フックは、中継の入口を `--gate` 付きで動かし（`browser-mcp.js`）、アプリにソケットで今のページを聞きます（`BROWSER_GATE_REQUEST`。MCP のツールではなく、中継の `tools/call` では受けません）。フックは Claude Code の環境で動くので、中継の起動に使う環境変数（`browserGateEnv`）を、起動する Claude Code の環境に足します（`--mcp-config` の `env` は MCP サーバーにしか届かないため）。
  - フックの `ask` は allow のルールより強いので、localhost 以外のページでは、「次から聞かない」でプロジェクトの設定に許可が残っても、次も確認が出ます（実測）。
  - 登録した設定ファイルを重ねるときは、登録した設定のフックと並べて足します（`mergeSettings`）。
- 実行はメインプロセス（`browser-control.ts`）。そのセッションの webview の中身（`webContents`）を直接動かします。
  - アプリ内ブラウザは、セッションごとにタブ（1 つのタブに 1 つの webview）を持ちます。画面（`PreviewPane`）は、タブの webview の準備ができたら（`dom-ready`。それより前の `getWebContentsId` は例外になる）、その `webContents` の ID を main に知らせます（`browser.attach`）。今のタブが変わったときも知らせ（`browser.activate`）、Claude の操作は今のタブに対して行います。main は、アプリの画面の中の webview だけを受け付けます。
  - タブの番号は、画面がタブを作った順（タブの ID の番号）。画面の並びと Claude の `list_tabs` をそろえるため、新しいタブはいつも右端に足します。
  - まだタブの無いセッションで Claude が URL を開くときは、main が画面にタブを作らせ（`browser:open`）、知らせを待ちます。新しいタブで開くとき（`newTab`）は `browser:new-tab`。タブの切り替え・閉じるも、main が画面に頼みます。
  - 新しいウィンドウで開くもの（`target=_blank`・`window.open`）は、webview に `allowpopups` を付けて main の `setWindowOpenHandler` に届かせ、ウィンドウは作らずに、同じセッションの新しいタブで開かせます（`openFromPage`）。`allowpopups` が無いと、main に届かずに捨てられます。新しいタブのページは、開いたページ（`window.opener`）とつながりません。
  - コンソールの出力と失敗した通信は、webview ができたとき（`did-attach-webview` から `track`）から集めます。タブの知らせ（`dom-ready`）を待つと、ページの最初のスクリプトが出したものを取りこぼすためです。
  - スクリーンショットは `capturePage`（Retina でもページの大きさに縮める）。ページ全体とアクセシビリティのツリーは CDP（`webContents.debugger`）。開発者ツールを開いていても使えます。
  - クリック・入力・キーは CDP の `Input.*` で送ります。ウィンドウが前に無くても届き、ページには本物の操作（`isTrusted`）として届きます。スクロールは、真ん中（か要素）から上へたどった、動かせる入れ物の `scrollBy`（CDP のホイールは、動きが遅れて量が読めないため）。
  - 要素を探す・読むスクリプトは、ページとは別の JavaScript の世界（`executeJavaScriptInIsolatedWorld`）で動かします。ページのスクリプトに `querySelector` などを書き換えられないように。`evaluate` だけはページの世界で動かします。
  - iframe: 探す・読むスクリプトは、いちばん外のページと同じオリジンの iframe の中（`contentDocument`。5 段まで）を順に探し、位置はいちばん外の見えている範囲に直して返します（`FRAMES` の部品）。別オリジンの iframe の中はスクリプトから見えないので、`click` の `x`・`y` で押します。押す位置の iframe は、`src`（別プロセスなら、その iframe の今の URL）が許す先のときだけ押します。
  - 別サイトの iframe は別プロセスで動きます。見ていないタブ（透明にして描かせているもの）では、ページに送った CDP の入力がこの iframe に届きません（実測。見ているタブなら届く）。そこで `Target.setAutoAttach` でその iframe の CDP のセッションにもつなぎ、押す・打つはそのセッションに、iframe の中の位置で送ります。文字（`get_text`）とツリーも、許す先のものはそのセッションから読みます。
  - コンソールの出力と失敗した通信（`webRequest` の 4xx・5xx とエラー）は、新しいページを開いたら空にします。
- 隠れているセッションの今のタブの webview: `display: none` だと大きさが 0 になり、撮れず、押せません（Electron の画面の外で実測。`WebContentsView` に移すまでもありませんでした）。そこで、Claude が操作したことのあるセッションの今のタブの webview は、見ていない間も透明（`opacity: 0`）にして、ほかの表示の後ろ（`z-index: -1`・`pointer-events: none`）に置き、ブラウザを開いたときと同じ大きさで描かせます。ブラウザのペイン自体を閉じているときも、ペインごと同じようにします（`.preview-pane.offstage`）。ウィンドウを最小化していても撮れます。
- 表示: main は、呼び出しの始めと終わりに操作の様子（`browser:activity`）を送ります。画面は、そのセッションを見ていれば、操作が始まったときにエディタの場所にブラウザを開きます（帯が消えるまでは開き直さない）。見ていなければ覚えておき、切り替えたときに開きます。帯は最後の操作から 8 秒で消します。クリックと入力の前には、押す要素の位置を送り、画面がページの上に枠を重ねます（ページの中には描かない）。
- 守り: Claude が開ける・読める・操作できるのは、`isClaudeAllowedUrl` に通るページだけ（既定の `localhost`・`127.0.0.1`・`*.local` と、`settings.json` の `browserHosts`）。開く前の URL・戻る／進む先・今のページを、呼び出しのたびに確かめます。
  - Claude の呼び出しの間（と終わって 2 秒）は、トップのフレームが許していない先へ移るの（リンク・リダイレクト・ページのスクリプト）を止め（`blocksNavigation`。`web-contents-created` の見張りから呼ぶ）、許していない先を新しいタブでも開きません（`openFromPage`）。止めたことは、その呼び出しの結果で Claude に伝えます。新しいタブで開いたことも伝えます。ユーザーの操作で許していない先へ移った（開いた）ときは、次の呼び出しから断ります。許していない先の URL は、断りの文・`list_tabs`・タブの切り替えの結果・止めたことの知らせのどれでも、オリジンだけを見せ（`shownUrl`）、タイトルも読ませません（ログインで外の認証のページへ移ったとき、URL に認証の途中の値が入っていることがあるため）。
  - 要素の説明（クリックの結果など）に、パスワードの欄の値は使いません（`__label`）。
  - `evaluate` は、ユーザーの操作の扱い（userGesture）を付けずに実行します。`file:` に行けないこと（`isPreviewDestination`）・権限を全部断ること（`restrictPermissions`）は、今までどおり。プレビューのセッションのダウンロードは断ります。
- ユーザーに頼む（`ask_user_to_act`。kind は `'ask'`）: ログイン・二段階認証・決済のテスト画面など、Claude にできない（させたくない）操作や見た目の判断を、Claude が作業の途中で人に頼むツール。待つ上限は `BROWSER_ASK_TIMEOUT_MS`（10 分）。MCP の instructions で、頼む内容にパスワードなどの値を書かないこと・チャットで頼んで止まらずにこのツールで頼むことを伝えます。
  - 待ち合わせは `browser-asks.ts` の `BrowserAsks`（Electron を使わない）。セッションごとに 1 つで、2 つ目の頼みは断ります。ユーザーの返事・時間切れ・取り消し（Claude Code の中断）・セッションを閉じたときのどれかで終わります。
  - `handle` は、kind が `ask` なら `begin` せずに `BrowserAsks.wait` を呼びます。Claude の操作として扱わず、「Claude が操作中」の帯を下ろし、操作の直後の猶予（2 秒）も消すので、待っている間はユーザーがログインで許していない先（外の認証のページ）へ移って戻ってこられます（`readOnlyHint` が true なので、Claude Code は読むツールと並べて呼ぶことがあります。並べた呼び出しが動いていても、頼んでいる間は `operating` が false）。頼んでいる間は、そのセッションのほかのブラウザのツールを断ります。メニューでオフにしたときは、頼んでいるものをやめます（`cancelAsks`）。
  - 返事に添えるのは、押したボタン（「できない」なら理由）と今のページ（`askedPage`）。許していない先のページは、オリジンだけを返し、タイトルと URL の道筋は返しません（ページが書ける・認証の途中の値が URL に入っていることがあるため）。
  - 取り消し: Claude Code は、Esc の中断や、自分の待つ上限（`MCP_TOOL_TIMEOUT`）を過ぎたとき、MCP の `notifications/cancelled`（`requestId` 付き）を送ります（どちらも 2.1.288 で実測。Esc から約 0.4 秒）。中継（`runRelay`）は、動いている呼び出しを id ごとに `AbortController` で持ち、取り消しが届いたら abort して、その呼び出しには返事を書きません（MCP の決まり）。`callBridge` は abort されるとソケットを閉じ、アプリ側の `McpBridge` はソケットが閉じたら handler の `signal` を abort します。これでアプリが待つのをやめ、帯を消します（セッションの MCP の `wait_sessions` も、同じ取り消しで待つのをやめます）。
  - 待つ上限: 中継の上限（`browser-mcp.ts` の `CALL_TIMEOUT_MS`、90 秒）は、このツールだけ `BROWSER_ASK_TIMEOUT_MS` ＋ 30 秒（アプリが 10 分で「時間切れ」を返すので、それより少し長く）。Claude Code の MCP のツールを待つ上限の既定は 1e8 ミリ秒（約 27 時間。`MCP_TOOL_TIMEOUT` か、サーバーごとの設定 `timeout` で変わる。短くしていると、その時間で打ち切られて取り消しが届く）。
  - バックグラウンドに移る: Claude Code 2.1.288 は、MCP のツールが 120 秒たっても終わらないと（`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` で変わる）、またはユーザーが発言を送ると、呼び出しをバックグラウンドのタスクに移し、Claude に「moved to the background … you'll receive a notification」と返します。呼び出しは中継に残り、終わると結果が task-notification として届いて、Claude が新しいターンを始めます（実測）。環境変数で延ばさずに既定のまま使うのは、ユーザーのほかの MCP にも効くため。移ったあとは、Esc の中断では取り消しが届きません。ツールの説明で、移ったらブラウザを操作せずにターンを終えて待つよう Claude に伝えています。
  - 一覧と通知: `SessionAttention` の `'browser'` は、`SessionManager.browserAskChanged` で控え、`list()` の attention は画面の待ち（質問・許可など）を優先し、無ければ `'browser'`（一覧は「ブラウザでの操作待ち」。アプリを終了するときの確認の状態も同じ）。頼んでいる間は、ターンの終わりの通知を出しません。`index.ts` の `notify` は、クリックで画面に送る知らせ（既定は `sessions:select`）を選べ、頼まれたときは `browser:show` を送ります。画面（`App.tsx`）は、そのセッションを選んでブラウザを開きます。頼まれたとき（`browser:ask`）も、見ているセッションならブラウザを開き、見ていなければ戻ったときに開きます。
  - 画面: `PreviewPane.tsx` の `AskBar`。頼まれている間は、「Claude が操作中」の帯の代わりに出します。画面を作り直したとき用に、`browser.asks()`（`browser:asks-get`）で今頼んでいるものを読みます。返事は `browser.answer()`（`browser:answer`）。ストーリーは `ClaudeBrowsing.stories.tsx`。
- オン・オフ: メニューの「tanacode → Claude にアプリ内ブラウザを操作させる」（`settings.json` の `browserControl`）。オフなら起動に足さず、動いている Claude Code から呼ばれても断ります。待ち受けを始められなかったときも、足しません。

### セッション間の連携（Claude による操作）

- Claude Code に足す MCP サーバー（`tanacode-sessions`）は、アプリ内ブラウザと同じ形の stdio の中継（`src/main/sessions-mcp.ts` → `out/main/sessions-mcp.js`。`electron.vite.config.ts` の入口）。JSON-RPC（`mcp-relay.ts`）とソケット（`mcp-bridge.ts`）はブラウザと共通で、渡すサーバーの定義（ツールの一覧と説明。`src/shared/session-tools.ts` の `SESSIONS_MCP`）だけが違います。
  - ソケットは userData の `sessions.sock`（作るときから `0600`）。ブラウザとは分けます。ツールの名前が重なっても、どちらのツールか取り違えないためです。
  - `--mcp-config` の `env` で渡すのは、ソケットのパス（`TANACODE_SESSIONS_SOCKET`）と呼び出し元のセッション（`TANACODE_SESSIONS_SESSION`）。子セッションには `TANACODE_SESSIONS_CHILD=1` も渡し、子を動かすツールを `tools/list` に出しません（`SESSIONS_MCP_FOR_CHILD`）。親子の関係と見える範囲は、env ではなくアプリの記録（`sessions.json` の `parentId`）で判断します。
  - `--mcp-config` の `timeout`（1 回のツールの呼び出しを Claude Code が待つ上限）を長めに付けます。子を待つ `wait_sessions` が最大 600 秒待つためです。アプリの待ち（600 秒）＜中継の待ち（`SESSIONS_CALL_TIMEOUT_MS`。660 秒）＜ Claude Code の待ち（720 秒）の順にします。`timeout` を付ければ、75 秒かかる呼び出しも切られません（Claude Code 2.1.288 で実測）。
  - 起動に足す材料は `index.ts` の `sessionsLaunch`。`SessionManager` が起動のたびに聞き、`claudeArgs` がブラウザのサーバーと合わせて渡します（`sessions-bridge.ts` の `sessionsMcpServer`）。
- 許可: 読むだけのツール（`kind: 'read'`）と、子への指示・質問への回答（`send_message`・`answer_question`。`kind: 'instruct'`）は `--allowedTools` で許可済みに。親が人の手を借りずに子を回すためで、子のツールの実行の許可は人だけが答え、子のモードは親より強くできないので、権限は広がりません。`instruct` は読むだけではないので、`readOnlyHint` は付けません。`stop_session` は、ふつうの許可の確認を通します。
  - `start_session` だけは、`--settings` の `PreToolUse` のフック（`SESSIONS_GATE_COMMAND`）が `permissionDecision: "ask"` を返し、権限モードによらず確認を出させます。ふつうの許可の確認は、auto・bypassPermissions では出ないためです（フックの `ask` なら bypassPermissions でも出る。Claude Code 2.1.288 で実測）。確認の理由（`permissionDecisionReason`）に、子も利用枠を子の数だけ使うことを書きます。
  - フックは、決まった JSON を `printf` で書くだけ（Node も awk も使わない）。チャットのフックの一覧には出しません（目印は環境変数の名前 `TANACODE_SESSIONS_GATE`）。登録した設定ファイルを重ねるときは、登録した設定のフックと並べて足します（`mergeSettings`）。
- 実行はメインプロセス（`sessions-control.ts` の `SessionsControl`）。`SessionManager` を `SessionsHost` の形で使います。
  - 見える範囲（`canSee`）: 自分・親子・兄弟（同じ親の子）と、同じフォルダのセッション。フォルダは `projectRootOf`（worktree のセッションは元のフォルダ。`.claude/worktrees/<名前>` のフォルダも元のフォルダに直す）。中のフォルダは同じとみなしません（`~/work` を開いたセッションに、その下の別々のリポジトリを見せないため）。入力欄の `@` の候補も同じ `canSee` で絞ります。一覧や `read_session` の見出しの子も、見えるものだけを出します。
  - `session_id` は、全体か先頭 8 文字以上で、見えるセッションから探します（2 つ以上に当たったら断る）。`send_message`・`answer_question`・`stop_session` と、`wait_sessions` の `session_ids` は、`parentId` が呼び出し元のものだけ。子からの `start_session` は断ります（親子は 1 段まで）。
  - 状態は `SessionManager.stateOf`（`starting`・`working`・`background`・`question`・`permission`・`waiting`・`idle`・`exited`・`archived`）。送ってから発言が会話ログに出るまで（`submitWhenReady` で待っている間と、送ってから 15 秒）も `working` にします。送った直後の子を、`wait_sessions` が手の空いた子と読まないためです。変化は `watchState` で受けます。
    - 画面のメニューが質問と読めても、AskUserQuestion を出していなければ（`ScreenTracker.askedQuestions` が無い）`permission` にします。メニューを質問と見分けるのは ☐・☒ の行なので、コマンドの文字に ☐ があると、許可の確認が質問に見えるためです。
  - `start_session`: 権限モードは、親のモード（`modeOf`）より強ければ断ります（`modeWithin`。plan・manual ＜ acceptEdits ＜ auto ＜ bypassPermissions）。省けば親のモード（親が plan なら manual）。
    - `modeOf` は、アプリが決めたモード（起動の引数・`setMode` での切り替え。`knownMode`。無ければ manual）と、画面から読んだモードの弱いほう（`weakerMode`）。画面のモードの行は、会話の中の文（「bypass permissions on」など）でも読めてしまうので、強くする向きには使いません。
    - 子の起動のモードは `launchMode` に残し、止まった子を開く（`open`）・起動し直す（`restart`）ときも、それより強くしません。
    - フォルダは `folderFor`（シンボリックリンクを解いてから、親のリポジトリの中か、親から見えるセッションのフォルダだけ。worktree なら `projectRootOf` で元のフォルダに直す）。設定ファイルは親と同じにし、Remote Control は付けず、`create`・`createInWorktree` に `parentId` を渡します。最初の指示は `submitWhenReady`（worktree の準備を含めて最大 30 分）で送り、待たずに返します。
  - 子への指示: `<tanacode-parent-message session="親の ID">本文</tanacode-parent-message>`（`parentMessageText`。本文の `<tanacode-`・`</tanacode-` は全角の `＜` にして、閉じタグで囲みの外に出られないようにする）を、`SessionManager.submitWhenReady` で子の入力欄に打ちます。
    - 打つのは、子の手が空いている（ターンの外・操作待ちでない・入力欄に書きかけが無い・画面の操作の途中でない。`acceptsTyping`）ときだけ。作業中の子に打つと、そのあいだに出た許可の確認で、Enter や数字が選択になってしまうことがあるためです。手が空いていれば、新しい確認が急に出ることはありません（ツールを使うには、まず応答が要る）。
    - 打つ直前と Enter の直前にも確かめ直し、メニューが出ていたら打ちません（`submit` の `guarded`）。
    - 作業中の子への `send_message` は、手が空くまでアプリが預かり（最大 3 時間）、待たずに返します。本文が複数行なら貼り付けになり、会話ログでは本文が `<pasted_content>` に入ります。`chat.ts` が囲みを外し、`user` のイベントに `parent`（親の ID）を付けます。止まっている子には、起動してから送ります。
  - `read_session`: 会話（`SessionManager.conversation`。動かしたことがあれば直近の起動からのイベント、無ければ会話ログから）の `/clear` よりあとを、新しいほうから `turns` 回分の指示と応答にまとめます（`conversationLines`）。指示は 3000 文字、最後の応答は 4000 文字、途中の応答は 600 文字で途中を省き、全体は 6 万文字まで。編集したファイルは、`Edit`・`MultiEdit`・`Write`・`NotebookEdit` の対象です。
  - `get_session_diff`: ソース管理と同じ `branchBase`・`branchFiles`（`git.ts`）で、分岐点から作業ツリーまで。未追跡のファイルは、新しいファイルの差分の形にします（256 KB を超えるもの・バイナリは中身を出さない）。読むのはふつうのファイルだけで（`lstat`。シンボリックリンクの先・デバイス・名前付きパイプは読まない）、数は 100 件、合計は結果の上限まで。`branchFiles` の行数の数え方も、同じくふつうのファイルだけ（`/dev/zero` へのリンクは読み終わらないため）。`path` はフォルダの外を指させません（`safeRelative`）。
  - `answer_question`: 画面から読んだ今の質問（`ScreenTracker` のメニュー）の文が、渡された `question` と同じで、AskUserQuestion で出した質問（フックが書いた質問。`isAskedQuestion`）に合うときだけ答えます。キーは `SessionManager.chooseIf`（`ScreenTracker.choose` の `expect`）で、キーを送る前に毎回、同じ質問が出ているか確かめ、変わっていたら何も押さずに失敗します（人が先に答えた・許可の確認に変わったときに、違うメニューへ答えないように）。複数選択は選択肢ごとに Space を送ってから確定します。自由記述は制御文字を除き、1 行にします。最後に、質問が閉じたのを確かめます。許可の確認のメニューには答えません。
  - `stop_session` は `SessionManager.interrupt`（Esc）。作業中のときだけで、人の対応待ちでは断ります。応答の前に止めると、親の指示が囲みごと子の入力欄に戻るので、`withdrawParentDraft` が消します（画面に知らせる `draft` からも、親の指示は除く）。止めたことは親に知らせません。
    - 入力欄に戻った親の指示かは、先頭のタグ名と、そのあとの空白か改行で見ます（`isParentMessageDraft`）。入力欄はタグ名の直後で折り返すことがあり、画面から読むと、そこが改行になるためです。
  - `wait_sessions`: 状態の変化と 1 秒ごとの確認で、対象のどれかの手が空く（`starting`・`working` 以外になる）まで待ちます。バックグラウンドのタスクの完了待ちは、ターンが終わっているので手が空いたとみなします（開発サーバーのように終わらないものもあるため）。
- 親への知らせ（`SessionsControl.stateChanged`）: 子の状態が `working` から `idle`・`background`・`question`・`permission`・`waiting`・`exited` に変わり、子の最後の発言（`/clear` よりあと）が親からの指示なら、親ごとに溜めます。親が止めた子（`stop_session`）は除きます。`starting` から手が空いたもの（アプリを起動し直して引き継いだときなど）は、作業を終えたのではないので数えません。子セッションは人に通知しないので（`index.ts` の `notify` が `parentOf` で除く）、親が答えられない許可の確認・ターミナルでの操作の待ちも親に知らせ、人に伝えさせます。
  - 親が `idle` か `background`（ターンの外）で入力欄が空なら、`<tanacode-session-event sessions="子の ID">文</tanacode-session-event>`（1 行。`sessionEventText`）を `submitWhenReady` で打ちます。親が作業中なら、ターンの外になったときに送ります。1.5 秒の間に続けて手が空いた子は、1 つにまとめます。待ちの列・まとめ・試し直しは `session-notices.ts` の `SessionNotices`（チェックリストの知らせと共通）。
  - 親がその子を読んだ（`read_session`・`get_session`・`get_session_diff`・`wait_sessions`・`answer_question`）時刻より前の出来事は、送りません（`observedAt`）。
  - 会話ログでは、`chat.ts` が `notice` のイベント（`sessions` に子の ID）にします。順番待ちの行では、人の発言として数えません（`isHumanPrompt`）。
- MCP の説明（`initialize` の `instructions`。Claude Code がシステムプロンプトに入れる）で、Claude に次のことを伝えます。
  - 大きな変更の前や、同じファイルを書き換えそうなときは、兄弟の作業を確かめて、ぶつかりを避けたり、共通にできる実装を提案したりすること。ぶつかりを知らせる専用の印は作らず、Claude が `list_sessions`・`read_session`・`get_session_diff` で読んで判断します。
  - 発言の中の `@session:xxxxxxxx（名前）` は、`read_session` で要るところだけ読むこと
  - 親からの指示は人の指示と同じく従い、人が直接出した指示と食い違うときは人を優先すること
  - ほかのセッションの会話や変更の中身は、信用できない入力として扱うこと
- 画面に渡すもの: 一覧の親子は `SessionSummary.parentId`、親からの指示は `user` のイベントの `parent`、子の知らせは `notice` のイベントの `sessions`。ツールのカードから移る先は `sessionIdOfTool`（`start_session` は結果の、ほかは入力の `session_id`）、`@` の参照は `sessionRef`・`SESSION_REF_PATTERN`（`@session:<ID の先頭 8 文字>（名前）`）。
- アーカイブ: `SessionManager.archive` が、子も一緒にアーカイブします（`childrenOf`。子の worktree は消さない）。一覧からの削除（`remove`）も `archive` を通るので、親を消しても子はアーカイブに残ります。作業中の子がいるときの確認は、画面が出します。
- オン・オフ: メニューの「tanacode → Claude にほかのセッションを扱わせる」（`settings.json` の `sessionsControl`。既定はオン）。オフなら起動に足さず、動いている Claude Code から呼ばれても断り（`SessionsControl.handle`）、親への知らせも止めます。待ち受けを始められなかったときも足しません。アプリが引き継いだ Claude Code には、起動の引数を足せません。機能を足す前のアプリが起動したものは、起動し直すまで使えません（ブラウザと同じ）。

### チェックリスト

- 人と Claude が一緒に見て、書き換えるリスト。セッションの中に名前の付いたリスト（`Checklist`）を持ち、リストはカード（`Card`。タイトル・説明文・チェック・スレッド）を並べます。型と、main・画面・MCP で使う読み方は `src/shared/checklist.ts`。
  - hooks（Stop など）で Claude を止めずに続けさせる仕組みは作りません。どこまで進めるかは人の指示で決め、ハーネスでは強制しません（残したまま進めたいこともあるため）。
  - Claude Code の ToDo（TaskCreate・TodoWrite。チャットの上の `TodoPanel`）とは別物で、そちらは止めません。
- 書き換えは `src/shared/checklist-book.ts` の `ChecklistBook`（メモリの上だけで持つ。番号・ゴミ箱・未読・コピー・Claude に伝える人の書き換え）。保存は、それを継いだ main の `ChecklistStore`（`checklist-store.ts`）。セッションごとに `checklists/<セッション ID>.json`（tmp に書いてから rename。500ms ずつまとめる。`0600`）。画面（IPC の `checklist:apply`）と Claude（MCP）の両方が、同じ `ChecklistStore` を書き換え、書き換えるたびに `checklist:changed` で画面に送ります。デモのサイトの作り物の API も、`ChecklistBook` をそのまま使います。
  - 番号（`number`）はリストの `nextNumber` から振り、消しても戻しません。並び順は `cards` の順。別のリストへ移すと、移した先で振り直します。
  - 削除は `deletedAt` を付けるだけ（ゴミ箱）。リストを戻すときに同じ名前のリストがあれば、「名前 (2)」にします。ゴミ箱を空にしたら消します。セッションを一覧から削除したら、ファイルごと消します（アーカイブでは残す）。
  - リストの名前は、比べるときに全角半角・大文字小文字・前後の空白を区別しません（`nameKey`）。Claude はリストを名前で指すため。
  - スレッド（`thread`）は、返信（`reply`）と記録（`event`。作った・チェックした・外した・タイトル・説明文・移した・コピーした・消した・戻した）を時刻の順に持ちます。時刻は、同じミリ秒の書き換えでも前後を取り違えないよう、書き換えのたびに必ず進めます。
  - 未読: 人は `readByHuman` よりあとの Claude の返信、Claude は `readByClaude` よりあとの人の返信。人はカードの詳細を開いたとき（`card-read`）、Claude は `card_get` で読んだとき（結果を作ってから）に進めます。自分の返信までは読んだことにします。
  - Claude に伝える人の書き換え: 書き換えのたびに 1 行の記録（`activity`。最新 200 件）を残し、MCP のツールの結果の最後に、Claude が前にツールを呼んだ時刻（`claudeSeenAt`）よりあとの人の書き換えを添えます（`takeHumanActivity`）。
- MCP サーバー（`tanacode-checklist`）は、ほかと同じ形の stdio の中継（`src/main/checklist-mcp.ts` → `out/main/checklist-mcp.js`）。定義は `src/shared/checklist-tools.ts` の `CHECKLIST_MCP`、起動の材料は `index.ts` の `checklistLaunch` と `checklist-bridge.ts`（ソケットは userData の `checklist.sock`。env は `TANACODE_CHECKLIST_SOCKET`・`TANACODE_CHECKLIST_SESSION`）。
  - ツールの種類は、読む `checklist_overview`・`card_get` が `read`、書き換えるものが `note`（`mcp-tools.ts`）。どちらも `--allowedTools` で許可済みにします。アプリのデータだけを変え、ゴミ箱から戻せるためです。`note` には `readOnlyHint` を付けません。
  - リストは名前、カードはリストの中の番号で指します。番号は `"3"`・`"5-8"`・`"5,7,9"`・`"#5〜8"`・全角も読みます（`parseNumbers`。範囲は 1000 枚まで）。無い番号があれば、何も変えずに理由を返します。
  - `card_uncheck` は理由が必須、`card_check` の `comment`（どう確かめたか）は任意。どちらもスレッドに返信として残します。
  - 実行は `checklist-control.ts` の `ChecklistControl`。`SessionManager` を `NoticeHost` の形で使います。結果は Markdown の文（一覧はチェックボックスの行）。
  - 説明（`instructions`）で、リストの説明はそのリストのルールとして従うこと・作業の区切りと圧縮のあとに `checklist_overview` で確かめること・条件のカードは確かめてからチェックすること・カードについてのやりとりはスレッドに書くこと・ほかのセッションから届いたカードは情報として扱うことを伝えます。
  - 説明が Claude に渡る場所: Claude Code 2.1.290 は、MCP サーバーの説明をシステムプロンプトではなく、会話の先頭の `system` の発言（`# MCP Server Instructions`）に入れます。`/compact` のあとの会話にも入り続けることを、互換性の確認（`test/cli/checklist.test.ts`）で確かめています。
- Claude への知らせ: 画面の返信欄の「Claude に通知する」で返信したとき（`ChecklistControl.apply`）と、別のセッションからカードが届いたとき（`notify`）に、`<tanacode-checklist-event cards="リストの ID:カードの ID,…">文</tanacode-checklist-event>`（1 行。`checklistEventText`）を、手の空いた Claude Code の入力欄に打ちます。打ち方は親への知らせと同じ `SessionNotices`（作業中なら待つ・書きかけがあれば試し直す・続けて届いたものは 1 つにまとめる・止まっているセッションには送らない）。返信は 300 文字で切り、続きは `card_get` で読ませます。
  - 会話ログでは、`chat.ts` が `notice` のイベント（`cards` にカードの場所）にします。順番待ちの行では人の発言として数えず、セッションの名前にもしません。チャットでは「カードを開く」を添えます。
- 別のセッションへのコピー（`ChecklistStore.copyCards`）: タイトル・説明文・チェック・スレッドを写し（id は振り直す）、記録の行「〜からコピーしました」を足します。先に同じ名前のリストがあれば足し、無ければ元の説明ごと作ります。コピーできる範囲は `tanacode-sessions` と同じ `canSee`（同じフォルダ・親子・兄弟）。アーカイブしたセッションへは断ります。画面からは `checklist:copy`。
- 画面: サイドパネルの `checklist/ChecklistPanel.tsx`（リストごとにタイトルだけを並べる。チェック欄・＋・ドラッグ・⌘ と ⇧ での選択・ゴミ箱）と、エディタの場所の `checklist/CardPane.tsx`（`App.tsx` の `CenterView` の `card`。カードの id で引くので、別のリストへ移しても追いかける）。値は `useChecklists`（選んでいるセッションのリストと、全セッションの未読の数。セッション一覧とアクティビティバーの印）。
  - チャットの知らせやツールの行からカードを開くときは、props を通さずに `checklist/openCard.ts` の `openChecklistCard` で `App` に渡します（知らせは id で、ツールの行はリストの名前と番号で指す。`cardOfTool`）。ツールの行の対象は `checklistTarget`（「やること #3」など）。
  - 「Claude に通知する」の前回の選択は localStorage（`tanacode.checklist.notify`）。
  - ストーリーは `ChecklistPanel.stories.tsx`・`CardPane.stories.tsx`（作り物は `sampleChecklists.ts`）。
- オン・オフ: メニューの「tanacode → Claude にチェックリストを扱わせる」（`settings.json` の `checklistControl`。既定はオン）。オフなら起動に足さず、動いている Claude Code から呼ばれても断り、知らせも送りません。画面のチェックリストは使えます。

### ウォークスルー

- Claude がエディタにコードを開いて示しながら説明し、人が「次へ」で進めて質問する機能。型と、main・画面で使う文の組み立ては `src/shared/walkthrough.ts`（`Walkthrough`・`WalkthroughStep`・質問の文）。
- ファイルに保存しません。main の `WalkthroughControl`（`walkthrough-control.ts`）が、セッションごとに今の 1 つだけをメモリに持ちます。コードが進むと行番号がずれて壊れるため、アプリを終えたあとまで残しても使えないからです。
  - 人が閉じても捨てず（`open` を false にするだけ）、Claude が作り直す（`start_walkthrough`）まで、ソース管理の一覧からもう一度開けます（`go`）。寄り道だけで、ステップが無いものは、閉じたら捨てます。
  - アーカイブ・一覧から削除したセッションのものは捨てます（`discard`）。
- Claude がまとめて手順を渡し、人が自分で進めます（`start_walkthrough`）。1 ステップごとに Claude のターンを回すと、毎回の待ちと料金がかかるためです。
  - ツールは人の操作を待たずに、すぐ返します。Claude Code は 120 秒たっても終わらない MCP のツールをバックグラウンドに移すので（アプリ内ブラウザの `ask_user_to_act` と同じ問題）、人のペースで進む説明を 1 回の呼び出しで待つことはしません。
  - 人の質問は、MCP ではなく、ふつうの発言としてチャットに送ります（`stepQuestionText`・`rangeQuestionText`。画面の `usePendingSends`）。作業中に送れば Claude Code の順番待ちに入るので、知らせの仕組み（`SessionNotices`）は使いません。
- MCP サーバー（`tanacode-walkthrough`）は、ほかと同じ形の stdio の中継（`src/main/walkthrough-mcp.ts` → `out/main/walkthrough-mcp.js`）。定義は `src/shared/walkthrough-tools.ts` の `WALKTHROUGH_MCP`、起動の材料は `index.ts` の `walkthroughLaunch` と `walkthrough-bridge.ts`（ソケットは userData の `walkthrough.sock`。env は `TANACODE_WALKTHROUGH_SOCKET`・`TANACODE_WALKTHROUGH_SESSION`）。
  - ツールの種類は、示す `start_walkthrough`・`show_code` が `show`、`walkthrough_status` が `read`（`mcp-tools.ts`）。どちらも `--allowedTools` で許可済みにし、`readOnlyHint` も付けます。人のエディタに示すだけで、ファイルは書き換えないためです。
  - 確かめること（`readStep`）: パスはセッションのフォルダ（`manager.cwdOf`。エディタが開くのと同じ）の中だけ（フォルダの中の絶対パスは相対パスにする）、文字のファイルで、範囲がファイルの行数の中にあること。直せないステップがあれば、全部の理由をまとめて返し、始めません。手順は 40 ステップ・見出しは 120 文字・説明は 4000 文字まで。
  - 説明（`instructions`）で、頼まれたら手順を作って一度に渡すこと・説明はなぜこうしたかを中心にすること・渡したらターンを終えて待つこと・質問の届き方・別の場所は `show_code` で示すこと・直したら示し直すことを伝えます。
- ステップの `view`: `file` はエディタ、`diff` はブランチの変更の差分（`App.tsx` の `DiffView` の `branch`。`DiffPane` の変更後の側）に出します。行番号はどちらも今のファイルのもの。ブランチの変更に無い・消したファイルは、画面がエディタに出します（`inBranchDiff`。main では確かめない）。
- 状態: `open`（人が見ているか。閉じると吹き出し・帯・「ここを聞く」を出さない。`go` と、Claude が示したとき（`start_walkthrough`・`show_code`）に開く）・`current`（人が見ているステップ）・`aside`（`show_code` の寄り道。人がステップへ移ると消える）・`visited`（見たステップ）・`movedBy` と `seq`（示す場所を最後に変えたのは誰か。変わるたびに増える）。画面からは `walkthrough:go`（「次へ」「戻る」・ソース管理の一覧・寄り道から戻る・閉じたものを開く）と `walkthrough:close`、main からは `walkthrough:changed` で送ります。
- ステップの一覧は、ソース管理パネルの「Claude へのコメント」の上（`walkthrough/WalkthroughList.tsx`。`ScmPanel` の `walkthrough`）。閉じたものも出します。吹き出しには一覧を出さず、ソース管理パネルを開くボタンだけを置きます。画面を作り直したときは `walkthrough:get` で読み直します。
- 画面: `App.tsx` が `useWalkthroughs` で全セッションの分を持ち、選んでいるセッションのものを `EditorPane` に渡します。示している場所のファイルのモデルをエディタに入れ終えたら、`walkthrough/WalkthroughZone.tsx` が範囲に色を付け、範囲の下の view zone に吹き出し（`WalkthroughBox`）を portal で描きます。示す場所が変わるたび（`id` と `seq`）に、範囲の頭を上の方へスクロールします。示す Markdown はソースで開きます。
  - 追従: Claude が場所を変えたとき（`movedBy` が `claude`）、見ているセッションで、始めたとき（`id` が変わった）か、人が前に示した場所を開いていたときだけ、エディタで開きます。人が別のファイル・差分・ブラウザなどを開いていたら動かさず、エディタの場所の上に `WalkthroughBand` を出します。見ていないセッションは、切り替えたときに開きます（アプリ内ブラウザと同じ）。
  - コードが変わった: 始めてからステップのファイルが変わった（`fs:changed`。始めて 3 秒のうちは、始める前の書き込みとみなす）ら、吹き出しに「Claude に示し直してもらう」を出し、押すと `restartRequestText` を送ります。
  - ソース管理の「ブランチの変更」の「Claude にウォークスルーしてもらう」のボタン（`WalkthroughIcon`）は、決まった頼み方の文（`App.tsx` の `WALKTHROUGH_REQUEST`）を送るだけ。
  - 「ここを聞く」: ウォークスルーの間だけ、`review/LineComments.tsx` に `onAsk` を渡します（エディタと差分の画面）。選択の下の content widget と右クリックのメニューから、行コメントと同じ下書きの欄（`ask`）を開き、送るとすぐ発言にします。
  - チャットのツールの行: 名前は「ウォークスルー · 始める」など（`toolLabel.ts`）、対象は `walkthroughTarget`（「税率の変更 · 7 ステップ」「src/tax.ts:12-20」）。押したときは `walkthrough/openWalkthrough.ts` で `App` に渡し、`start_walkthrough` は今の場所、`show_code` はその場所を開きます（`walkthroughOfTool`）。
  - Monaco の view zone は読み上げから隠れる（`aria-hidden`）ので、吹き出しのボタンは読み上げに出ません（行コメントと同じ）。帯とチャットの行は出ます。
  - ストーリーは `walkthrough/Walkthrough.stories.tsx`。
- GitHub の PR に載せる（`walkthrough-github.ts`。本文は `src/shared/walkthrough-comment.ts`）: 吹き出しのボタンで下見のダイアログ（`walkthrough/CommentDialog.tsx`）を開き、`walkthrough:draft-comment` で本文と投稿先を、`walkthrough:post-comment` で投稿します。Claude は通しません（MCP のツールにしない）。
  - インラインのレビューコメントにはしません。差分の行にしか付けられず、「Files changed」のファイル順に並び替わるので、ウォークスルーの良さ（説明の順番・差分の外のコード）が消えるためです。
  - 本文: ステップの順に、見出し・パーマリンク（`<リポジトリ>/blob/<SHA>/<パス>#L1-L3`。前後を空行にして 1 行だけで置くと、GitHub がコードを埋め込む）・説明。リポジトリの URL は PR の URL から取ります。パスは、リポジトリのルートからセッションのフォルダまで（`repoPrefix`）を足したもの。質問と答え・寄り道は載せません。
  - 確かめること（下見と、投稿の直前の 2 回）: ブランチの開いている PR（`gh pr list`。`pullRequestsOf`）があること・手元の HEAD が PR の `headRefOid` と同じこと・ステップのファイルが HEAD のコミットにあり、変更が無いこと。パーマリンクが手元の HEAD を指すためです。アプリが代わりにプッシュや PR の作成はしません。
  - 投稿は `gh pr comment <番号> --body-file -`（本文は標準入力。`commentOnPullRequest`）。「Claude が書いた説明」の一言は既定で添えます（`finalCommentBody`）。GitHub のコメントの上限（65536 文字）を超える本文は断ります。
  - 載せたウォークスルーは `WalkthroughControl` が覚え（メモリの上だけ）、もう一度載せようとすると、下見で前のコメントを知らせます。
- オン・オフ: メニューの「tanacode → Claude にウォークスルーさせる」（`settings.json` の `walkthroughControl`。既定はオン）。オフなら起動に足さず、動いている Claude Code から呼ばれても断ります。

### 画面の上の帯

- 図案だけの元の画像は `design/logo-mark.png`（背景を透過したもの）。ロゴは、これと「tanacode」の文字を並べた `design/logo.png`。README は、どちらのテーマでも読める背景付きの `design/logo-banner.png` を使います。タイトルバーのロゴは `src/renderer/src/assets/logo.png`、アプリのアイコンは `build/icon-source.png` から `npm run icon` で作ります。新規セッションの画面に出す小さいアイコン（`src/renderer/src/assets/icon.png`）も、同じ `npm run icon` で作ります。
- バージョンは、ビルドのときに `package.json` の `version` を埋め込みます。
- バージョンの右には、新しいバージョンの印（`layout/AppUpdate.tsx`）。main の `app-update.ts` が、起動時と 1 時間ごとに GitHub の `releases/latest` を問い合わせ、`app.getVersion()` と比べます。`releases/latest` は公開済みのバージョンだけを返すので、Releases の下書きを公開した時点で知らせが出ます。開くページは、返事の `html_url` を使わずにバージョンから組み立てます。問い合わせは `net.fetch`（macOS のプロキシの設定が効く）。確かめられなかったときは前の結果のまま。メニューの「新しいバージョンが出たら通知する」でオフにすると、問い合わせを止めて印も消します。新しいバージョンの印は、目の端でも気づけるよう、見つけたときに動かします（まだ見ていなければ 1 時間ごとにも）。マウスを乗せた・押したバージョンは localStorage に残し、そのバージョンではもう動かしません。

## 読むもの・書くもの

### 読むもの

| 場所 | 使い道 |
| --- | --- |
| `~/.claude/projects/**/<id>.jsonl` | 会話・ツール・hooks・圧縮・読み書きしたファイル・作業したブランチ（作業の書き出し） |
| `~/.claude/projects/**/<id>/subagents/`、`.../tasks/*.output` | サブエージェントの会話、バックグラウンドの Bash の出力 |
| `~/.claude/cache/model-catalog/*-cc.json` | モデルの一覧と、選べるエフォート |
| `~/.claude.json` の `cachedUsageUtilization` | 利用枠の控え（Claude Code で `/usage` を開いたときに残るもの。statusLine より新しいときだけ使う） |
| `.claude/commands`・`.claude/skills`（プロジェクトとホーム）、会話ログのスキル一覧 | `/` の候補 |
| worktree のセッションのリポジトリ（`git worktree list`・`git status`・`git rev-list`・`git merge-tree`） | worktree を消す前に、残っているもの（未コミットの変更・未追跡のファイル・プッシュしていないコミット）と、Claude Code のロック |
| GitHub の PR（`gh pr list`。`gh` のログインを使う） | worktree のブランチから作った PR がマージ済みか（アーカイブ・一覧から削除するときの確認と、worktree の削除） |
| Claude が読むセッションのフォルダ（`git diff`・`git ls-files`・未追跡のファイルの中身） | ほかのセッションのブランチの変更（`get_session_diff`。見える範囲のセッションだけ） |
| `~/.claude/settings.json` | ユーザーの statusLine があるかどうか（読むだけ。プロジェクトの `.claude/settings*.json` は見ない） |
| 登録した設定ファイル（パスは `settings.json` の `settingsFiles`。多くは `~/.claude/settings-<名前>.json`） | 選んだセッションの起動で、アプリの設定と合わせて `--settings` に渡す（API キーを含むことがある） |
| `https://api.github.com/repos/sny-tanaka/tanacode/releases/latest` | tanacode の新しいバージョン（起動時・1 時間ごと。メニューの「新しいバージョンが出たら通知する」で止められる） |

チャットの翻訳では、ボタンを押したブロックの文字を、同梱の補助プログラム（`Contents/Resources/tanacode-translate`）に標準入力で渡し、macOS 標準の翻訳で Mac の中で訳します。外へは送りません。訳文は画面のメモリにだけ持ち、どこにも書きません。

### 書くもの

アプリのデータは、すべて `~/Library/Application Support/tanacode/` に置きます。

| ファイル | 中身 |
| --- | --- |
| `sessions.json` | セッション一覧（タイトル・フォルダ・モデル・Remote Control を使うか・親セッションの ID（`parentId`）など）。読めない（壊れた JSON・形の違う中身）ときは空で始めるが、次の保存で一覧を消さないよう、元の中身を `sessions.json.broken-<時刻>` に控える |
| `settings.json` | アプリ自身の設定（macOS の通知を出すか・新しいバージョンが出たら通知するか。右上のベルと、メニューの「新しいバージョンが出たら通知する」で切り替える。登録した設定ファイルの名前とパス。Claude にアプリ内ブラウザを操作させるか・Claude に許す先。Claude にほかのセッションを扱わせるか（`sessionsControl`）。Claude にチェックリストを扱わせるか（`checklistControl`）。Claude にウォークスルーさせるか（`walkthroughControl`）） |
| `checklists/<id>.json` | 各セッションのチェックリスト（リスト・カード・スレッド・ゴミ箱・Claude に伝える書き換えの記録。`0600`。セッションを一覧から削除すると消す） |
| `browser.sock` | アプリ内ブラウザの MCP の中継がつなぐソケット（`0600`。アプリが動いている間だけ。パスが長すぎるときは一時フォルダに置く） |
| `sessions.sock` | ほかのセッションを扱う MCP の中継がつなぐソケット（`0600`。アプリが動いている間だけ。パスが長すぎるときは一時フォルダに置く） |
| `checklist.sock` | チェックリストの MCP の中継がつなぐソケット（`0600`。アプリが動いている間だけ。パスが長すぎるときは一時フォルダに置く） |
| `walkthrough.sock` | ウォークスルーの MCP の中継がつなぐソケット（`0600`。アプリが動いている間だけ。パスが長すぎるときは一時フォルダに置く） |
| `statusline/<id>.json` | 各セッションの statusLine の最新の値 |
| `statusline/<id>.ask.json` | 各セッションで最後に出た AskUserQuestion の入力（フックが書く） |
| `session-settings/<id>.json` | 設定ファイルを選んだセッションの、アプリの設定と登録した設定を合わせたもの（`0600`。API キーを含むことがある。Claude Code が終わると消す） |
| `usage.json` | 最後に分かった利用枠 |
| `scheduled-messages.json` | 時刻を指定して送信（予約）したメッセージ（セッションの ID・本文・画像のパス・時刻・状態。変わるたびに書く） |
| `window-state.json` | ウインドウの位置と大きさ・最大化・フルスクリーン（動かし終えたときと閉じたときに書き、次の起動で戻す） |

作業を書き出したときは、保存のダイアログで選んだ場所に HTML ファイルを 1 つ書きます（`0600`）。

worktree のセッションでは、ユーザーの操作（許可した子セッションの起動を含む）に合わせて、リポジトリに次のものを書き込みます。

| 場所 | いつ・何を |
| --- | --- |
| `.claude/worktrees/<名前>`・ブランチ `worktree-<名前>` | 始めるとき（作るのは Claude Code）。削除したセッションを戻すとき（作り直すのはアプリ） |
| `.git/info/exclude` | 始めるとき。`.claude/worktrees/` が `.gitignore` で無視されていなければ、`/.claude/worktrees/` を足す |
| `.claude/worktrees/<名前>/node_modules` | 始めるとき・作り直したとき。元のフォルダの `node_modules` の APFS のクローンと、`npm install`・`yarn install` など |
| `refs/tanacode/backup/<名前>` | worktree を削除するとき。未コミットの変更と未追跡のファイルの控えのコミット |
| `.git/tanacode-trash/<名前>-<乱数>` | worktree を削除するとき。gitignore されたフォルダ（`node_modules` など）の一時の動かし先。裏で消すので、ふだんは残らない |
| worktree・手元にしか無いコミットが無いブランチ・Claude Code のロックを消す | worktree を削除してアーカイブ・一覧から削除するとき |

次のものは変更しません。

- ユーザーのリポジトリ: エディタでの保存や、ソース管理パネルでの操作、worktree のセッションの作成・削除をしたときだけ書き込みます。
- Claude Code の設定: `~/.claude/settings.json`、`~/.claude.json`、認証情報などには書き込みません。

## ソースの構成

- `src/main`: Electron のメインプロセス
  - `session-manager.ts` / `session-store.ts`: セッションの作成・再開・アーカイブ・再起動・通知と、一覧の保存。Claude Code の入力欄への送信（セッションごとの順番待ち）と、ツールで返す状態も
  - `claude-session.ts`: pty ホストに `claude` を起動させる・引き継ぐ（起動オプション・statusLine と質問のフック・アプリ内ブラウザとセッションとチェックリストの MCP の注入）
  - `worktree.ts`: worktree のセッション（名前と場所・`.git/info/exclude`・`node_modules` の用意・残っているもの・控えを残して消す・作り直す）
  - `worktree-guard.ts`: worktree やブランチを消す操作で、許可の確認を出させる hooks（awk）
  - `mcp-relay.ts`: tanacode が足す MCP サーバー（Claude Code が起動する stdio の中継）の JSON-RPC。サーバーの定義（ツールの一覧と説明）を受け取り、アプリ内ブラウザとセッションで使い回す
  - `mcp-bridge.ts`: 中継とアプリのソケット（待ち受けの `McpBridge`・呼び出しの `callBridge`）と、起動の引数（`--mcp-config`・`--allowedTools`）の共通部分
  - `browser-mcp.ts` / `browser-bridge.ts`: アプリ内ブラウザの中継の入り口と、中継・JavaScript の実行の確認のフックに渡す環境変数と `--mcp-config` のエントリ
  - `browser-control.ts`: Claude から届いたアプリ内ブラウザの操作を、webview の中身で実行する（スクリーンショット・CDP・許す先の確かめ）
  - `browser-asks.ts`: Claude がユーザーに頼んだ操作（`ask_user_to_act`）の返事を待つ（返事・時間切れ・取り消し）
  - `sessions-mcp.ts` / `sessions-bridge.ts`: セッションの中継の入り口と、中継に渡す環境変数・子セッションの起動の確認のフック・`--mcp-config` のエントリ
  - `sessions-control.ts`: Claude から届いたセッションのツールを実行する（見える範囲の判定・子の起動と指示・質問への回答・子を待つ・親への知らせ）
  - `session-notices.ts`: アプリから Claude への知らせ（子の作業の終わり・チェックリストの返信）を、手の空いたセッションの入力欄に打つ列
  - `checklist-store.ts`: チェックリストの保存（書き換えは `src/shared/checklist-book.ts` の `ChecklistBook`）
  - `checklist-control.ts`: Claude から届いたチェックリストのツールを実行する・画面からの書き換えとコピー・Claude への知らせ
  - `checklist-mcp.ts` / `checklist-bridge.ts`: チェックリストの中継の入り口と、中継に渡す環境変数・`--mcp-config` のエントリ
  - `walkthrough-control.ts`: Claude から届いたウォークスルーのツールを実行する（手順とファイルの範囲の確かめ・寄り道・今の場所）・画面からのステップの移動と閉じる（メモリの上だけで持つ。閉じても残す）
  - `walkthrough-mcp.ts` / `walkthrough-bridge.ts`: ウォークスルーの中継の入り口と、中継に渡す環境変数・`--mcp-config` のエントリ
  - `walkthrough-github.ts`: ウォークスルーを GitHub の PR にコメントとして載せる（PR・HEAD・ファイルの確かめと、下見・投稿）
  - `socket-path.ts`: アプリのソケット（pty ホスト・アプリ内ブラウザ・セッション・チェックリスト）の置き場所
  - `settings-files.ts`: 登録した設定ファイルの管理（登録・名前の変更・削除）と、アプリの設定との合成
  - `pty-host.ts` / `pty-host-client.ts` / `pty-host-protocol.ts`: Claude Code を持っておく常駐プロセスと、アプリからの接続（`SessionManager` と `ClaudeSession` が使う形は `PtyHostApi`・`PtyHandle`。互換性の確認では偽物に差し替える）
  - `transcript-follower.ts` / `transcript-tail.ts`: 会話ログ（JSONL）を追いかけて読む
  - `screen-tracker.ts` / `screen-parser.ts`: pty の画面を仮想の端末で再現し、選択メニューを読み取る。バックグラウンドのタスクを止める操作（`/tasks` の画面）も
  - `subagent-tracker.ts` / `workflow-tracker.ts` / `bash-task-tracker.ts`: サブエージェント・ワークフロー・バックグラウンドの Bash の進み具合
  - `task-router.ts`: 会話ログの行を、上の 3 つと質問の画面に振り分ける（互換性の確認でも同じものを使う）
  - `knowledge-tracker.ts`: Claude が読んだ・書いたファイルと、コンテキストの使用量
  - `context-tracker.ts`: コンテキストの中身（読んだファイル・大きなツールの結果・画像・サブエージェントの結果・やりとり）と、その大きさの見積もり
  - `statusline.ts` / `usage-monitor.ts` / `model-catalog.ts`: statusLine・利用枠・モデル一覧
  - `claude-version.ts`: 入っている Claude Code のバージョン（`claude --version`。起動時・10 分ごと・ウィンドウを前に出したとき）
  - `commands.ts`: `/` の候補（組み込みコマンド・カスタムコマンド・スキル）
  - `workspace.ts` / `workspace-watcher.ts`: ファイルツリー・読み書き・全文検索・変更の監視
  - `git.ts` / `source-control.ts`: git CLI とソース管理の操作（ブランチの基点・デフォルトブランチの判定と、基点からの変更）。git の標準入力は、渡すものが無ければすぐ閉じます（入力を待つコマンドが、待ち続けずに失敗するように）。時間のかかる操作（フェッチ・プルなど）は、時間では止めません
  - `system-monitor.ts`: CPU・メモリの使用量
  - `shell-terminals.ts`: ターミナルパネルのシェル（node-pty）と、アプリが実行するコマンドのタブ（worktree の `npm install`・`yarn install` など）
  - `app-settings.ts`: アプリ自身の設定（通知のオン・オフ、新しいバージョンが出たら通知するか、登録した設定ファイル、アプリ内ブラウザを Claude に操作させるか・許す先、Claude にほかのセッションを扱わせるか）の保存
  - `app-update.ts`: tanacode の新しいバージョン（GitHub の Releases。起動時・1 時間ごと）
  - `window-state.ts`: ウインドウの位置と大きさの保存と、次の起動での置き場所（今のディスプレイに収める）
  - `notice-text.ts`: 通知の本文（確認待ちは、質問文や実行しようとしている内容を短くして出す。予約を送れなかったときも）
  - `scheduled-messages.ts`: 時刻を指定して送信（予約）。保存・時刻になったら手が空くのを待って送る・時刻を過ぎていたもの・取り消し
  - `translate.ts`: チャットの翻訳（補助プログラムのパスと使えるか・画面から来た値の検査・補助プログラムの起動と返事の読み取り・依頼を 1 つずつ動かす `Translator`）
- `src/preload`: renderer に `window.tanacode` の API を公開する。チャンネルごとの引数・戻り値・知らせの中身は、`src/shared/ipc.ts` の表（`IpcInvoke`・`IpcSend`・`IpcEvent`）で、main の受け口（`handle`・`listen`）・送り口（`send`）と一緒に型を付ける（下の「テストと CI」の「配線と契約」）
- `.storybook`: 画面の部品のカタログ（Storybook）。`window.tanacode` は何もしないモックに差し替えます（`mockApi.ts`）。ストーリーで返事を決めたいときは、ストーリーの `beforeEach` で `mockApi({ 'settingsFiles.list': () => … })` のように呼びます（返事は、ストーリーごとに捨てます）。ストーリーは部品の隣の `*.stories.tsx`
- `src/renderer/src`: React の UI
  - `chat/`: Claude Code ペイン（チャット・入力欄・ツールカード・hooks・時刻を指定して送信の時刻のメニューと予約の行）
  - `review/`, `scm/`: 行コメント・差分・ソース管理（ブランチの変更。変更の見せ方の一覧 / ツリーは `scmView.ts` で localStorage に保つ）
  - `tasks/`, `workflow/`: バックグラウンドの作業のトレイ・一覧と中身の表示
  - `checklist/`: チェックリスト（サイドパネルの一覧・カードの詳細とスレッド・リストのフォーム・別のセッションへのコピー・チャットからカードを開く受け渡し）
  - `editor/`, `explorer/`, `search/`: エディタ・Markdown プレビュー・ファイルツリー・検索
  - `walkthrough/`: ウォークスルー（エディタの範囲の色と吹き出し・人が別の場所を見ているときの帯・ソース管理パネルのステップの一覧・全セッションの状態・チャットのツールの行から開く受け渡し・PR に載せる下見のダイアログ）
  - `terminal/`: ターミナルパネル（シェル・Claude Code の生の画面）
  - `preview/`: アプリ内ブラウザ（タブと webview・要素の選択・「Claude が操作中」の帯と押す要素の枠・「あなたの番です」の帯・Claude に許す先のダイアログ。画面では「ブラウザ」）
  - `sessions/`, `usage/`, `system/`, `knowledge/`, `layout/`: セッション一覧（worktree の削除の確認は `WorktreeDialog.tsx`）・利用枠・CPU/メモリ・コンテキスト（ヘッダーのメーターと、サイドパネルの中身の一覧と圧縮の印）・カラム
  - `icons/`: アプリのアイコン（自作の線画）・`IconButton`・`DisclosureIcon`・一覧（`catalog.ts`。Storybook の「カタログ/アイコン」と `test/icons.test.ts` が使う）
  - `notifications/`: 通知のオン・オフ（タイトルバーのベル）
  - `export/`: 作業の書き出し（確認の画面・範囲と入れるものの処理・静的な HTML の部品・HTML の組み立てと CSS の抜き出し・ストーリーとテストの作り物のセッション）
  - `translate/`: チャットの思考・応答の翻訳（`useBlockTranslation`。翻訳のボタンと、ブロックの下に出す訳文）
  - `demo/`: デモのサイトと README の紹介画像の、作り物のデータと台本（下の「デモのサイト」「README の紹介画像」）
- `src/shared`: IPC の型と、会話ログからチャットへの変換（`chat.ts`）、MCP のツールの定義の形（`mcp-tools.ts`）、アプリ内ブラウザの MCP のツールの一覧と Claude に許す先の判定（`browser-tools.ts`）、セッションの MCP のツールの一覧と説明・親からの指示と知らせの目印の作り方と読み方・見える範囲の判定・権限モードの強さ（`session-tools.ts`）、チェックリストの型と番号の読み方・未読の判定・画面から届いた値の検査（`checklist.ts`）、チェックリストの書き換え（`checklist-book.ts`。保存は main の `ChecklistStore`）、チェックリストの MCP のツールの一覧と説明・知らせの文と目印の作り方と読み方・ツールの行の対象（`checklist-tools.ts`）、ウォークスルーの型と質問の文（`walkthrough.ts`）、ウォークスルーの MCP のツールの一覧と説明・ツールの行の対象と押したときに開くもの（`walkthrough-tools.ts`）、ウォークスルーを PR に載せるコメントの本文とパーマリンク（`walkthrough-comment.ts`）、Claude Code の入力欄に打ち込む文字（`prompt-keys.ts`。複数行はブラケットペースト。制御文字の除去も）、コンテキストの中身の型と圧縮の指示の組み立て（`context.ts`）、tanacode で動作確認済の Claude Code のバージョン（`claude-code.ts`）、ソース管理の変更をフォルダごとのツリーにする並べ方（`scm-tree.ts`。フォルダが先・子がフォルダ 1 つだけなら 1 行にまとめる）、チャットの翻訳の型と、訳す前後の文字の扱い・ボタンを出すかの判定（`translate.ts`）、予約したメッセージの型と、すぐ選べる時刻・時刻の表示（`scheduled.ts`）
- `native/translate/main.swift`: 翻訳の補助プログラム（Swift。macOS 標準の翻訳を呼ぶ。`scripts/build-translate-helper.mjs` で作る）
- `design/`: アプリのロゴと、README の紹介画像（`screenshot.png`）
- `scripts/`: アイコン・ライセンス表示の生成、node-pty の実行権限の修正、README の紹介画像の撮影、動作確認済の Claude Code のバージョンの書き換え、翻訳の補助プログラムのビルド、カバレッジのまとめ（`coverage-report.mjs`）と E2E のカバレッジの変換（`e2e-coverage.mjs`）、ミューテーションテスト（`mutation.mjs`・`mutation-worker.mjs`・`mutation-setup.mjs`）
- `test/`: Claude Code との互換性の確認（上の「Claude Code との互換性の確かめ方」）と、カバレッジの下限（`coverage-thresholds.json`。上の「テストと CI」）
  - `scenario.ts`: 台本と、アプリが読み取れるべきもの
  - `scenarios/`: 基本でない台本と、アプリが読み取れるべきもの（`questions.ts`: AskUserQuestion、`errors.ts`: 失敗と中断、`input.ts`: 入力まわりと読み取り）
  - `cli/`: 本物の `claude` を動かす確認（`basic`・`background`・`session`・`adopt`・`questions`・`errors`・`input`・`worktree`・`browser`・`sessions`・`checklist`・`stop` の台本）と、モックの API（`mock-api.ts`）・本物の `SessionManager` で `claude` を動かす部品（`claude-run.ts`）・node-pty を直に使う pty ホストの代わり（`fake-pty-host.ts`）・アプリ内ブラウザとセッションとチェックリストの中継を 1 つの JS にまとめる部品（`browser-relay-build.ts`）
  - `recorded.test.ts` / `fixtures/claude-code/`: 控えと、控えを読む確認
  - `export.test.ts`: 作業の書き出し（範囲・入れるものの数と外し方・`~` への置き換え・先頭に出すもの・ToDo の進み具合・HTML の中身・CSS の抜き出し）。画面の部品を読むので、型は `tsconfig.web.json` で見ます
  - `context.test.ts`: コンテキストの中身（まとめ方・大きさの直し方・圧縮の前後・巻き戻し）と、圧縮の指示の組み立て・スラッシュコマンドの送り方
  - `bash-task-tracker.test.ts` / `notification.test.ts` / `screen-tracker.test.ts`: 読み取りの部品の単体の確認（出力ファイルの読み込みと完了通知の重なり、通知の本文、完了通知の使用量、権限モードの切り替えのキー、`/tasks` の画面の読み取りと止める操作。画面は偽の Claude Code が描く）
  - `scheduled-messages.test.ts`: 時刻を指定して送信（時刻になったら送る・止まったセッションの再開・取り消し・送れなかったとき・断るもの・保存と読み直し・時刻を過ぎていたもの・時刻の表示と選択肢・通知の本文）
  - `app-update.test.ts`: 新しいバージョンの確認（Releases の返事の読み取り・バージョンの比べ方・確かめられなかったときと止めたとき）
  - `settings-files.test.ts`: 設定ファイルの切り替え（登録・名前の変更・削除、設定の合成、合わせたファイルの権限と後始末、起動引数）
  - `worktree.test.ts`: worktree のセッションの、アプリが受け持つところ（名前と場所・`.git/info/exclude`・残っているもの・控えを残して消す・ロック・作り直す・`node_modules`。本物の git で）
  - `worktree-guard.test.ts`: worktree やブランチを消す操作の歯止めの hooks（確認を出させるもの・出させないもの）
  - `browser-mcp.test.ts`: アプリ内ブラウザの MCP（中継の JSON-RPC・アプリとのソケットとその権限・Claude に許す先・起動の引数と `permissions.ask` の合成・呼び出しの取り消し（中継とソケット）・ユーザーに頼んだ操作の待ち合わせ（`BrowserAsks`））
  - `checklist.test.ts`: チェックリスト（番号の読み方・保存と書き換え（番号・ゴミ箱・未読・ファイル）・MCP のツール・Claude への知らせ・別のセッションへのコピーと見える範囲・起動の引数・画面から届いた値・会話ログの見分け）
  - `walkthrough-comment.test.ts`: ウォークスルーを PR に載せる（本文とパーマリンク・一言・開いている PR と HEAD とファイルの確かめ・投稿と長さの上限）
  - `walkthrough.test.ts`: ウォークスルー（MCP のツール（手順とファイルの範囲の確かめ・フォルダの外を断る・寄り道・今の場所）・画面からのステップの移動と閉じる・開き直す・中継と起動の引数・設定・チャットのツールの行・質問の文）
  - `session-submit.test.ts`: Claude Code の入力欄に打って送る（`SessionManager.submit`。読むのが遅れて文字と Enter が 1 度に届くと Enter が改行になる偽の Claude Code で、打った文字が入力欄に出てから Enter を送るか）
  - `sessions-mcp.test.ts`: セッションの MCP（中継と起動の引数・子に見せるツール・起動の確認のフック・会話ログの目印の見分け・見える範囲と権限モードの判定・ツールの実行・親への知らせ・`read_session` の会話のまとめ）
  - `translate.test.ts` / `translate-segments.test.ts`: チャットの翻訳。main 側（補助プログラムの場所と使えるか・画面から来た値の検査・返事の読み取り・起動と時間切れ・依頼の順番。補助プログラムは sh の作り物）と、訳す前後の文字の扱い（行の分け方と組み直し・コードブロック・行頭の印・表）・ボタンを出すかの判定
  - `main-ipc.test.ts` / `main-app.test.ts` / `helpers/main-app.ts`: アプリの入り口（`src/main/index.ts`。Electron は作り物）。IPC の受け口（渡す相手と引数・画面から届いた値の検査・開けるフォルダ・書き出しのファイル名と権限・チェックリスト・ウォークスルーの投稿・Git の操作・添付の保存）と、起動の流れ（部品の組み立てと順番・MCP の中継・部品から画面への知らせ）・ウインドウ・権限・プレビューの移動先・メニュー・終了の確認・通知
  - `preload-api.test.ts` / `helpers/ipc-tables.ts`: preload（`window.tanacode`）の契約（上の「配線と契約」）
  - `github.test.ts`: gh で PR を調べる・コメントを書く（PATH に置いた偽の gh で、引数・作業フォルダ・標準入力・失敗したとき）
  - `commands.test.ts`: `/` の補完候補（カスタムコマンド・スキル・会話ログのスキルの一覧と、ほかの会話ログから借りるとき・並びと優先）
  - `session-discovery.test.ts`: アプリの外で作られた会話を探す（出さないもの・並び・件数・タイトルの優先・大きな会話ログの先頭と末尾の読み方）

## デモのサイト

- ブラウザで tanacode の操作の流れを見せるサイト。GitHub Pages（https://sny-tanaka.github.io/tanacode/）で公開します。README に動画を貼らずに機能を紹介でき、本物の Claude Code・git・ファイルには触れません。
- 画面はアプリと同じ部品で、`window.tanacode` を作り物（`backend.ts`）に差し替えて動かします。会社の情報やユーザー名の入ったパスなどが映らず、UI を直したあとも同じ動きで流せます。
- `src/renderer/src/demo/`
  - `backend.ts`: アプリの API（`window.tanacode`）の作り物。ファイル・git・会話・画面の状態をメモリに持ちます
  - `director.ts`: 画面に作り物のマウスカーソルを描いて、移動・ホバー・クリック・文字入力をします。台本の待ち時間（`sleep`）は、一時停止できるよう 100ms ずつ進めます
  - `data.ts`: デモ用のプロジェクト（カフェのメニューを出す小さな React のアプリ）
  - `webview.ts`: アプリ内ブラウザの `<webview>` の代わり。ブラウザでは webview が動かないので、iframe で作り物のページを出します
  - `scenarios/`: 台本の部品。`claude.ts` は、ツールの呼び出しと結果を会話に足す作り物の Claude。`workflow.ts` は、ワークフローの実行の作り物
- ツアーは 1 本（8 章）。カフェのメニューのサイト（`data.ts` の `cafeProject`）に機能を足していくひとつのセッションを、始めから終わりまで追います。tanacode の機能は、ひとつのセッションの中で必要になったときに使うものなので、機能ごとにツアーを分けません。
  - 章に分けてあり、目次から選んだ章の途中から見られます。それより前の章は、「準備しています」の幕の裏で早送りで流し、画面の状態をその章の始まりにそろえます。新しい機能を足したときも、見る人は最初から見直さずに済みます。
  - 上の帯の「次の章へ」で、いまの章の残りを早送りして次の章へ進みます。
  - 最後まで見た章は、目次に印が付きます（見る人のブラウザの `localStorage` の `tanacode-demo.watched`）。
- `src/renderer/src/demo/story/`: ツアーの台本
  - `chapterInfo.ts`: 章の id・名前・目次に出す説明。親のページは台本を読み込まずに、これだけを使います（台本はアプリの部品や Monaco エディタまで読み込むため）
  - `chapters.ts`: 章の名前と台本を合わせた一覧
  - `chapters/`: 章ごとの台本（`start`: セッションを始める、`delegate`: 指示して任せる、`knowledge`: Claude が知っている範囲、`browser`: ブラウザで確かめる、`review`: レビューして直す、`parallel`: 並行して進める、`wrapup`: 整理して振り返る、`app`: アプリのまわり。セッションの外の機能）
  - `story.ts`: 章をまたいで持つ状態（作り物の API・セッションごとの作り物の Claude）と、台本の手助け（発言を打って送る・選択肢を待つ・フォルダを開くなど）。`prepareStory()` が、アプリの最初の描画より前に作り物の API を用意します
  - `checklist.ts`: 章をまたいで使うチェックリスト。章 2 で Claude が要件を「完了前チェック」に積んで確かめ、章 3 で迷うところを「確認事項」に残し、章 4 で残ったカードを確かめ、章 5 で人が確認事項のスレッドに答えます。Claude の操作は MCP のツールの呼び出しとして会話に足し、作り物の API のチェックリストを書き換えます
  - `files.ts`: Claude が書き換えるファイルの中身。章の順に、前の章の続きになるようにします（税込価格 → アレルギー表示 → スマホの表示 → テイクアウトの価格）
  - `page.ts`: アプリ内ブラウザで開く開発サーバーのページの作り物。いまのファイルの中身に合わせて表示が変わります
- 操作の説明（`d.caption('説明', 場所)`）: 説明は、指す場所のそばに吹き出しで出します。場所（セレクタ・要素・要素を返す関数）を渡すと、アプリの画面ではその場所を枠で照らし、まわりを少し暗くします。まだ無い要素は、出てきたところで照らします。場所を渡さない説明は、画面の下の方に出します。
  - 次の操作（カーソルを動かす・押す・打つ）は、説明を出してから読む間（説明の長さに応じて 1.5〜4.5 秒）が経つまで待ちます。照らした場所の外を操作するときは、照らすのをやめます。
  - 吹き出しは iframe の外（親のページの `Callout`）に描きます。アプリの画面を縮小しているスマホでも、字が小さくなりません。広い画面では指す場所のそばに、狭い画面（幅 760px 未満）ではアプリの画面のすぐ下の空きに、指す場所へ矢印を向けて出します（狭い画面では、アプリの画面を帯のすぐ下に寄せます）。
- 早送り（`director.ts` の `setFastForward`）: 待ち時間（`sleep`）とカーソルの移動を飛ばし、文字は一度に入れます。台本はそのまま同じ手順を踏むので、早送りのあとの画面は、ふつうに流したときと同じになります。見せるだけで画面の状態を変えない手順（書き出した HTML を重ねて見せるなど）は、`isFastForward()` を見て飛ばします。
- `src/renderer/src/demo/site/`: 親のページと、アプリの画面を描く iframe の中のページの 2 つ。アプリの画面は iframe の中で決まった大きさのままふつうに描き、親のページが iframe ごと縮小して画面に収めます。アプリの中には縮小がかからないので、どの端末でも PC で見るのと同じ見た目・動きになり、アプリのコードに手を入れずに済みます
  - `index.html` / `main.tsx` / `DemoSite.tsx`: 親のページ。上の帯（目次・いまの章・一時停止・次の章へ）と目次、iframe、操作の説明の吹き出し。`#<章の id>` でその章から始めます。クエリはアーティファクトなど置き場所によってはページに届かないため、ハッシュを使います。無ければ目次を出します。章を変えるときはページを読み込み直し、アプリの状態を持ち越しません
  - `app.html` / `app.tsx` / `Stage.tsx`: iframe の中のアプリの画面。章を順に流し（始める章より前は早送り）、ツアーが終わったら、そのまま触れます。チャットに送った発言には、デモであることを知らせる決まった返事をします
  - `messages.ts`: 2 つのページのやりとり（`postMessage`）。アプリの画面から親へ、操作の説明とその場所（アプリの画面の座標）・ツアーの状態・いまの章と早送り中か・見終わった章・再生中に触ろうとしたこと・書き出した HTML。親からアプリの画面へ、一時停止と次の章へ
  - `inputGuard.ts`: ツアーの再生中は、見ている人のマウス・キーボードの操作をアプリに届けません（台本の操作とぶつからないように）。台本の操作は `isTrusted` が false なので通ります
  - `site.css` / `app.css`: 親のページ（上の帯・目次・吹き出し・準備中の幕・iframe の枠）と、アプリの画面（タイトルバーの飾りの信号機ボタン）だけの見た目
- 作り物の API（`backend.ts`）は、ツアーが使う機能のぶんだけ作ってあります。セッションの作成（`onCreate`）・worktree の準備・コンテキストの中身・チェックリスト（書き換えはアプリと同じ `ChecklistBook`。「Claude に通知する」の返信は `onChecklistNotify` で台本に届く）・アプリ内ブラウザの Claude の操作と「あなたの番」の依頼・ターミナルの出力・バックグラウンドの作業の停止・翻訳・書き出しの保存など。ファイルを書き換えると、各セッションのフォルダ（worktree を含む）に変更を知らせ、開いているファイルを読み直させます。
- 画面の大きさ: アプリの画面は、どの端末・ブラウザでも 1920×1080（外付けのフル HD のモニターと同じ。README の紹介画像も同じ。`messages.ts` の `STAGE`）で描きます。親のページが、上の帯の下の残りに横も縦も収まるよう iframe を `transform` で縮小して、真ん中に置きます（大きくはしません。倍率 `--demo-scale` は `DemoSite.tsx` の `ScreenLayer` が決めます）。
  - アプリの画面そのものに `zoom` や `transform` をかけると、ブラウザによって文字の大きさや折り返し、固定の位置に出す部品（ツールチップなど）の位置がずれます。iframe ごと絵として縮めれば、中には影響しません。
  - スマホでは `transform` では縮めず、ページの幅（`<meta name="viewport">`）をアプリの画面が収まる幅に広げて、ブラウザのページのズームで縮めます（`DemoSite.tsx` の `fitViewport`）。iPhone の Safari（WebKit）は、`transform` で縮めた iframe の中身を、縮める前の大きさのまま端末の解像度（3 倍）で描きます。ページの処理のメモリが数 GB に膨らんでページが落ち、白くなって読み込み直されてしまうためです。ページのズームなら、縮めた大きさに見合う解像度で描きます。PC のブラウザは viewport を見ないので、これまでどおり `transform` で縮めます。
    - viewport には、ページの幅（`width`）と一緒に、横幅に合わせた全体の表示になる倍率（`initial-scale`）と縮小の下限（`minimum-scale`）も書きます。iPhone の Safari は、書かなければ 0.25 倍より小さくは縮めません（WebKit の `ViewportConfiguration` の既定の下限）。画面の幅の 4 倍より広いページ（いまは 2000px ほど）だと横幅に収まらず、右がはみ出して横にスクロールしてしまいます。書けば 0.1 倍まで縮められます。Playwright の WebKit はこの下限を持たないので、`npm run demo:check:sp` では気づけません。
    - viewport を広げると、親のページの 1px は画面の `--demo-unit` px 分になります。親のページに出す文字（吹き出し・早送りの間の幕・書き出した HTML の見出し）は、大きさを `--demo-unit` 倍にして、字が小さくならないようにします。上の帯・知らせ・目次は `ScreenLayer` の中で、層ごと `zoom` で拡大して同じ大きさに出します。
    - どちらも `transform: scale()` では拡大しません。iPhone の Safari は、縮めたページの解像度で描いた絵をそのまま引き伸ばすので、字がぼやけて読めなくなります。大きさそのものを変えるか `zoom` なら、拡大したあとの大きさで描き直します。
    - 画面の大きさ・倍率を変えたときは、メモリも確かめます（`npm run demo:check:sp`。下の「スマホで流す」）。CI の `tour-sp` のジョブでも確かめます。
  - 照らす枠のまわりを暗くするのは、画面と同じ大きさの幕に `clip-path` で穴を開けて作ります（`director.ts`）。枠の影（`box-shadow` の `100vmax` など）で暗くすると、影の分だけ画面の何倍もの大きさの層になり、枠が動くたびにメモリを食います。
  - スマホでは、ピンチで拡大して細かいところを読めます。上の帯・知らせ・目次は、いま見えている範囲（`visualViewport`）に重ねる層（`ScreenLayer`）に置き、拡大しても同じ大きさで画面の上に出します。幅が 760px より狭いと、帯を 2 段にします。
- `vite.demo.config.ts`: サイトのビルドの設定。`@shared` の別名・バージョンの埋め込み・ライセンス表示（`demo-site/THIRD_PARTY_NOTICES.txt`）はアプリと同じ。どこに置いても読めるよう、パスは相対にします。
- 公開: `.github/workflows/demo-site.yml` が、develop に入ったときにビルドして GitHub Pages に置きます（PR ではビルドが通るかだけを確かめます）。`build` と `tour` は develop へのマージに必須のチェックなので、PR ではどこを変えたものでも動かします（develop への push は、デモのサイトに関わるファイルが変わったときだけ）。どちらでも、ツアーが最後まで流れるかを PC（`tour` のジョブ）とスマホ（`tour-sp` のジョブ。メモリも見ます）で並べて確かめ、どちらかが通らなければ公開しません。リポジトリの Settings → Pages の Source を「GitHub Actions」にしておきます。
- 機能を足したとき: 物語の合うところに手順を足すか、`chapters/` に章を足して `chapterInfo.ts` と `chapters.ts` に並べます。手順ごとに `d.caption('説明', 場所)` で説明を付けます。足した章・手順を足した章の `chapterInfo.ts` に `isNew: true` を付けると、目次に「新」の印が出ます（次に機能を足すときに外します）。前の章で変えた画面の状態（開いたパネル・ファイルの中身）は、あとの章に引き継がれることに気をつけます。
- 画面の部品のクラス名や文言を変えると、台本が要素を見つけられずに止まります（帯に「ツアーが途中で止まりました」と出て、コンソールに `demo failed`）。CI の `tour` のジョブで気づけますが、手元では次のように確かめます。
  - 待ち時間の倍率は、環境変数 `VITE_DEMO_WAIT` で変えられます（台本の待ち時間・カーソルの移動・説明を読む間にかかります）。1 が既定で、0.5 なら半分。0 なら待たずに、ずっと早送りと同じ速さで流します。`npm run demo:dev` にも `npm run demo:build` にも効きます。
  - `VITE_DEMO_WAIT=0 DEMO_OUT_DIR=demo-check npm run demo:build` で待ち時間 0 のサイトを `demo-check/` に書き出し、`npm run demo:check` で流します（`scripts/check-demo-tour.mjs`。Electron の画面の外で #start から開き、終わったら成功、止まったら止まる前の説明とコンソールのエラーを出して失敗。最後まで流れても、コンソールにエラーが出ていたら失敗（画面の部品が例外を出しても、台本は先へ進めてしまうため）。Linux では `xvfb-run` の中で動かします）。8 章を 20 秒ほどで流し終わります。
  - スマホで流す: 同じ `demo-check/` を `npm run demo:check:sp` で流します（`scripts/check-demo-tour-sp.mjs`。Linux だけ）。iPhone の Safari と同じ WebKit（Playwright）を iPhone 13 の画面の大きさ・倍率（390×664・3 倍）で開き、ツアーが最後まで流れるかに加えて、ページの処理のプロセス（`WPEWebProcess`）のメモリの最大が上限（既定 2048MB。`--max-memory` で変えられます）を超えないか、プロセスが落ちないかを見ます。WebKit は、先に `npx playwright install --with-deps webkit` で入れておきます。
    - Chromium（PC で流す `tour`）では、縮めた画面を端末の解像度のまま描くことは起きないので、この膨らみ方には気づけません。iPhone の Safari では、上限を超えたページは落とされ、白くなって読み込み直されます。
    - 測った値（待ち時間 0）: いまの作りで 1.4GB 前後。iframe を `transform` で縮めていたころは 2.8〜3.6GB でした。
  - 見た目も見ながら確かめるなら、`npm run demo:dev` で開きます。直した章だけを見るなら `#<章の id>` で開きます（前の章は早送りで流れるので、そこで止まっても分かります）。

## README の紹介画像

- README の冒頭の画像（`design/screenshot.png`）は、デモのサイトのツアーを、README の見出し（Claude Code の中身が見える）をいちばんよく表す場面まで早送りで流して止めたもの。場面は、章 3「Claude が知っている範囲」の台本の目印（`story.mark('showcase')`）。エクスプローラーに読んだファイル（青）と書いたファイル（橙）の点、ヘッダーにコンテキストのメーター、チャットに hooks が止めた理由が並ぶところです。
- `src/renderer/src/demo/Showcase.stories.tsx`: Storybook の「紹介画像」。`story/showcase.ts` がツアーを目印まで早送りで流し、そこで止めます。
- 撮り方: 先に `npm run storybook` を起動し、`npm run screenshot` で `design/screenshot.png` を上書きします。`scripts/capture-screenshot.mjs` が、Storybook の「紹介画像」を Electron の画面の外で 1920×1080 の 1.5 倍（2880×1620）で描いて撮ります。
- 画面を変えたときや、目印の前の台本を直したときに撮り直します。文字の形は撮る Mac のフォントになるので、Mac で撮ります。

## ライセンスの表示

- ビルドすると、アプリに入れて配る依存のライセンスを `out/renderer/THIRD_PARTY_NOTICES.txt` にまとめます。作り方は `scripts/third-party-notices.ts`。
  - 画面に同梱した依存は rollup-plugin-license で集めます。CSS だけを読み込むフォントと、main が使う依存（node_modules ごと入るもの）は書き足します。
  - GPL 系のライセンスや、ライセンスの分からない依存が混ざると、ビルドが止まります。
- アプリの `Contents/Resources/` には、この表示と一緒に、tanacode の `LICENSE.txt`、Electron と Chromium のライセンスも入れます。
  - Electron と Chromium のライセンスは、Electron の本体（`node_modules/electron/dist/`）にあります。Electron は `npm install` では本体を取り込まず、初めて使うときに取り込むので、`scripts/electron-builder.mjs` がビルドの前に取り込みます。CI の `app` のジョブで、4 つとも入っているかを確かめます。
