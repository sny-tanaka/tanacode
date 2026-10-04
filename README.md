<!-- GitHub のスマホアプリは <picture> でのテーマの切り替えに対応していないので、どちらのテーマでも読める背景付きの 1 枚にする -->
<h1 align="center">
  <img src="design/logo-banner.png" width="520" alt="tanacode" />
</h1>

<h3 align="center">Claude Code に任せた作業を、横で見て確かめられる macOS アプリ</h3>

<p align="center">
  <a href="https://github.com/sny-tanaka/tanacode/releases/latest"><img src="https://img.shields.io/github/v/release/sny-tanaka/tanacode?label=%E6%9C%80%E6%96%B0%E3%83%90%E3%83%BC%E3%82%B8%E3%83%A7%E3%83%B3&color=2ea043" alt="最新バージョン" /></a>
  <img src="https://img.shields.io/badge/macOS-13%20%E4%BB%A5%E9%99%8D-555555?logo=apple" alt="対応する macOS: 13 以降" />
  <a href="https://github.com/sny-tanaka/tanacode/actions/workflows/claude-code-check.yml"><img src="https://img.shields.io/badge/%E5%8B%95%E4%BD%9C%E7%A2%BA%E8%AA%8D%E6%B8%88%E3%81%AE%20Claude%20Code-2.1.289-d4835c" alt="動作確認済の Claude Code: 2.1.289" /></a>
  <img src="https://img.shields.io/badge/%E3%83%A9%E3%82%A4%E3%82%BB%E3%83%B3%E3%82%B9-MIT-2f6fd6" alt="ライセンス: MIT" />
</p>

<p align="center">
  <a href="https://sny-tanaka.github.io/tanacode/"><b>ブラウザでデモを試す</b></a> ・
  <a href="#インストール"><b>インストール</b></a> ・
  <a href="GUIDE.md"><b>使い方</b></a>
</p>

Claude Code（`claude` CLI）と IDE をひとつにしたデスクトップアプリ。コードを書くのは Claude に任せて、あなたは確認と小さな修正だけ。Claude がいま何をしているか・何を読んだか・並行して何が動いているかを、チャットの横に表示します。中で動くのは、インストール済みの `claude` CLI そのもの。

<sub>個人が作っている非公式のツール。Anthropic の公式製品ではなく、Anthropic の承認や支援も受けていません。</sub>

<p align="center">
  <img src="design/screenshot.png" width="100%" alt="tanacode の画面。親子のセッションと状態の印が並ぶ一覧・Claude Code とのチャットとバックグラウンドの作業のトレイ・ソース管理・ブランチの差分を 1 つのウインドウに並べた様子" />
</p>

## まずはブラウザで

インストールせずに、[デモ](https://sny-tanaka.github.io/tanacode/)で実際の画面を操作できます。ひとつのセッションの作業を始めから終わりまで追う、8 章のツアー。気になる章から直接開くこともできます。

1. [セッションを始める](https://sny-tanaka.github.io/tanacode/#start)
2. [指示して任せる](https://sny-tanaka.github.io/tanacode/#delegate)
3. [Claude が知っている範囲](https://sny-tanaka.github.io/tanacode/#knowledge)
4. [ブラウザで確かめる](https://sny-tanaka.github.io/tanacode/#browser)
5. [レビューして直す](https://sny-tanaka.github.io/tanacode/#review)
6. [並行して進める](https://sny-tanaka.github.io/tanacode/#parallel)
7. [整理して振り返る](https://sny-tanaka.github.io/tanacode/#wrapup)
8. [アプリのまわり](https://sny-tanaka.github.io/tanacode/#app)

<sub>デモは作り物のデータで動くため、本物の Claude には繋がりません。</sub>

## Claude Code に任せるときの、こんな困りごとに

### 任せている間、何をしているのか分からない

ツールの操作は 1 行に畳んで表示。質問や許可の確認には、チャットのボタンで回答。書き換わったファイルとサブエージェントの動きも、その場で見えます。

[デモで見る →](https://sny-tanaka.github.io/tanacode/#delegate)

### Claude がどのファイルを読んだのか分からない

今の会話で Claude が読んだファイルは青、書いたファイルは橙の点をファイルツリーに。圧縮で要約に置き換わったファイルも区別。コンテキストの使用量はメーター、hooks の出力と止めた理由はチャットに表示します。

[デモで見る →](https://sny-tanaka.github.io/tanacode/#knowledge)

### 画面のどこを直してほしいか、言葉で伝えにくい

開発中のページをアプリの中で表示。クリックで選んだ要素のセレクタ・HTML・画像を、そのまま Claude への指示に添付。直したあとは、Claude も同じブラウザでページを開き、スクリーンショット・コンソール・クリックで自分で確認（MCP。別に入れるものは無し。開けるのは localhost などの開発用の先だけ）。ログインなど Claude にできない操作は、作業の途中であなたに依頼。済んだらボタンを押すだけで、Claude が続きから再開します。

[デモで見る →](https://sny-tanaka.github.io/tanacode/#browser)

### 変更が多くて、プッシュ前にレビューしにくい

ブランチが分岐したところからの変更（コミット済みも含む）を、プルリクエストのような一覧で確認。差分の行に付けたコメントは、次の指示に添えて Claude へ。GitHub に PR を作る必要は無し。

[デモで見る →](https://sny-tanaka.github.io/tanacode/#review)

### 並行して動かすと、どれが手待ちか見失う

セッションの状態（作業中・完了待ち・質問への回答待ち・新しい応答）を、一覧の印で区別。見ていないセッションの完了や確認は、macOS の通知で。サブエージェント・ワークフロー・バックグラウンドの Bash は、動いている間は入力欄の上に並び、そこから止めることもできます。セッションごとに `claude --worktree` で作業フォルダとブランチを分けるので、同じリポジトリでも変更がぶつかりません。

[デモで見る →](https://sny-tanaka.github.io/tanacode/#parallel)

### 長くなった会話の整理と振り返りが手間

残すもの・捨てるものを選んでコンテキストを圧縮。英語などで返ってきた思考と応答は、ボタン 1 つで日本語に翻訳（macOS 標準の翻訳で Mac の中で訳すので、外へは送りません。macOS 15 以降）。作業の流れは、チャットと同じ見た目の 1 枚の HTML に書き出せます。

[デモで見る →](https://sny-tanaka.github.io/tanacode/#wrapup)

### 利用枠や Claude Code の更新が気になる

5 時間枠と週の枠の使用率とリセットまでの時間、この Mac の CPU とメモリの使用量を常に表示。入っている Claude Code が動作確認済のバージョンと違えば、ステータスバーの印でお知らせ。tanacode の新しいバージョンが出たときも、タイトルバーの印で分かります。

[デモで見る →](https://sny-tanaka.github.io/tanacode/#app)

## いつもの Claude Code のまま

- 中で動くのは、インストール済みの `claude` CLI そのもの。スキル・CLAUDE.md・hooks・MCP の設定が**そのまま有効**
- ターミナルで始めた会話も**取り込み可能**
- アプリを閉じても **Claude Code は動いたまま**。Remote Control でスマホからも続行可能
- Claude Code の設定（`~/.claude/settings.json` など）への**書き込みは無し**。tanacode 自身が情報を外へ送る仕組みも無し

ほかにも、親のセッションの Claude が子のセッションに作業を分けて指示する親子セッション、会話を続けたまま Claude Code だけを再起動する機能、Monaco エディタ・ターミナル・git の操作など。詳しくは [GUIDE.md](GUIDE.md) へ。

## 必要なもの

- macOS 13 以降（Apple Silicon・Intel）
  - チャットの翻訳だけは macOS 15 以降（macOS 標準の翻訳を使うため）
- [Claude Code](https://code.claude.com/docs)（`claude` CLI）
  - ターミナルで一度 `claude` を起動し、初回のセットアップ（テーマの選択とログイン）を済ませておきます
  - tanacode で動作確認済のバージョンは 2.1.289。違うバージョンのときは、ステータスバーのバージョンに警告の印が付きます（マウスを乗せると理由を表示）
  - 最新の Claude Code で動くかも、毎日自動で確認。それでも Claude Code の更新で、一部の表示や操作が動かなくなる場合あり

## インストール

### Homebrew（おすすめ）

```bash
brew install --cask sny-tanaka/tanacode/tanacode
```

[Homebrew](https://brew.sh/) で入れて、`brew upgrade` で更新できます。[Releases](https://github.com/sny-tanaka/tanacode/releases) の zip を、その Mac（Apple Silicon・Intel）に合わせて入れます。署名が無くても、macOS の警告は出ません。tap（[sny-tanaka/homebrew-tanacode](https://github.com/sny-tanaka/homebrew-tanacode)）の cask が、インストールと更新のたびに tanacode.app だけからダウンロードの印（quarantine 属性）を外すため。下の zip の手順の `xattr` と同じことを、Homebrew が代わりに行います。

### ビルド済みのアプリ（Releases）

[Releases](https://github.com/sny-tanaka/tanacode/releases) から、Mac に合ったものをダウンロード。

| Mac | ファイル |
| --- | --- |
| Apple Silicon（M1 以降） | `tanacode-<バージョン>-mac-arm64.pkg`（または `.zip`） |
| Intel | `tanacode-<バージョン>-mac-x64.pkg`（または `.zip`） |

> **署名について**
>
> 個人で作っているため、Apple の署名は未取得。初回だけ macOS の警告が出るので、次の手順で許可します。

<details>
<summary>インストーラー（pkg）で入れる場合</summary>

1. pkg を開きます。署名していないので、初回は「開けません」「Apple は検証できませんでした」などと出るため、「完了」で閉じます
2. システム設定 →「プライバシーとセキュリティ」の下の方にある、tanacode の「このまま開く」を押します
3. インストーラーの手順に沿って進めます（途中で Mac のパスワードを入力）。「アプリケーション」フォルダに入ります

インストーラーで入れたアプリはダウンロードの印が付かないので、そのまま起動できます。

</details>

<details>
<summary>zip で入れる場合</summary>

1. zip を開き、`tanacode.app` を「アプリケーション」フォルダへ移します
2. 署名していないので、そのままでは「壊れているため開けません」などと出て起動できません。一度だけ、ターミナルで次のコマンドを実行してダウンロードの印を外します

   ```bash
   xattr -dr com.apple.quarantine /Applications/tanacode.app
   ```

   このコマンドは、tanacode.app だけから、macOS がダウンロードしたアプリに付ける実行前の確認の印（quarantine 属性）を外すもの。Releases 以外から手に入れたファイルには使わないでください。

</details>

### ソースからビルド

手元でビルドしたアプリにはダウンロードの印が付かないので、署名が無くても macOS の警告は出ません。

必要なもの: Node.js 22・git・Xcode Command Line Tools（チャットの翻訳に使う `swiftc`。無くてもビルドでき、翻訳のボタンが出ないだけ）

```bash
git clone https://github.com/sny-tanaka/tanacode.git
cd tanacode
npm install
npm run install-app
```

ビルドして `/Applications/tanacode.app` に入れます。Apple Silicon・Intel のどちらでも、その Mac に合わせて作ります。

### 更新

自動アップデートは無し。新しいバージョンが出ると、タイトルバーのバージョンの右に青いダウンロードの印が出ます（GitHub の Releases を 1 時間ごとに確認）。リポジトリの Watch → Custom → Releases でも通知を受け取れます。

- **Homebrew で入れた場合**: メニューの「ファイル → Claude Code も止めて終了」で終了してから、次を実行します（tap の cask は、新しいバージョンの公開と同時に新しくなります）

  ```bash
  brew upgrade --cask tanacode
  ```

- **ビルド済みのアプリの場合**: 新しいバージョンを入れる前に、メニューの「ファイル → Claude Code も止めて終了」で終了します。アプリの入れ替えで、動いている Claude Code が途中で切れないようにするためです

- **ソースから入れた場合**: 次を実行してから tanacode を終了し、終了のダイアログで「動かしたまま終了」を選んで起動し直します。動いている Claude Code は止まらず、新しいバージョンがそのまま引き継ぎます

  ```bash
  git pull
  npm install
  npm run install-app
  ```

### アンインストール

メニューの「ファイル → Claude Code も止めて終了」で終了してから、次を削除。

- `/Applications/tanacode.app`
- `~/Library/Application Support/tanacode/`

Homebrew で入れた場合は、終了してから `brew uninstall --cask --zap tanacode` で、両方を消せます。

Claude Code の会話ログ（`~/.claude/`）は Claude Code のものなので残ります。

## ドキュメント

| 読むもの | 内容 |
| --- | --- |
| [GUIDE.md](GUIDE.md) | はじめの一歩・画面の見方・機能ごとの使い方・ショートカット・データの扱い・制限・困ったとき |
| [CONTRIBUTING.md](CONTRIBUTING.md) | ソースからのビルド・貢献の流れ・仕組み・ソースの構成 |

不具合・要望は [Issues](https://github.com/sny-tanaka/tanacode/issues) へ。

画面と文書は日本語のみ。英語対応は検討中のため、要望があれば [Issues](https://github.com/sny-tanaka/tanacode/issues) へ。

## ライセンス

[MIT](LICENSE)

同梱している依存のライセンスは、アプリの `Contents/Resources/THIRD_PARTY_NOTICES.txt` を参照。

<sub>「Claude」「Claude Code」は Anthropic, PBC の商標。</sub>
