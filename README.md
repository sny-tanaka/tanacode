<!-- GitHub のスマホアプリは <picture> でのテーマの切り替えに対応していないので、どちらのテーマでも読める背景付きの 1 枚にする -->
<h1 align="center">
  <img src="design/logo-banner.png" width="520" alt="tanacode" />
</h1>

<h3 align="center">空いた画面に Claude の中身を映す macOS アプリ</h3>

<p align="center">
  <a href="https://github.com/sny-tanaka/tanacode/releases/latest"><img src="https://img.shields.io/github/v/release/sny-tanaka/tanacode?label=%E6%9C%80%E6%96%B0%E7%89%88&color=2ea043" alt="最新版" /></a>
  <img src="https://img.shields.io/badge/macOS-13%20%E4%BB%A5%E9%99%8D-555555?logo=apple" alt="対応する macOS: 13 以降" />
  <img src="https://img.shields.io/badge/%E3%83%A9%E3%82%A4%E3%82%BB%E3%83%B3%E3%82%B9-MIT-2f6fd6" alt="ライセンス: MIT" />
</p>

コードを書くのは Claude に任せて、エディタは確認と小さな修正だけ。空いた場所には、Claude がいま何をしているか・何を読んだか・並行して何が動いているかを表示。

<sub>個人が作っている非公式のツール。Anthropic の公式製品ではなく、Anthropic の承認や支援も受けていません。</sub>

**基本の流れ**: 指示を送る → ツールの操作は 1 行に畳まれる → 質問にはボタンで回答 → 書き換わった行はエディタで確認 → サブエージェントは入力欄の上に並ぶ

https://github.com/user-attachments/assets/37108310-f132-4b9b-8b4d-9740771e311a

## いつもの Claude Code のまま

- 中で動くのは、インストール済みの `claude` CLI そのもの。スキル・CLAUDE.md・hooks・MCP の設定が**そのまま有効**
- ターミナルで始めた会話も**取り込み可能**
- アプリを閉じても **Claude Code は動いたまま**。Remote Control でスマホからも続行可能
- Claude Code の設定（`~/.claude/settings.json` など）への**書き込みは無し**。tanacode 自身が情報を外へ送る仕組みも無し

## 特長

### 並行して動く作業を見失わない

サブエージェント・ワークフロー・バックグラウンドの Bash は、動いている間は入力欄の上に表示。ワークフローは、GitHub Actions のようなフロー図とエージェントごとの会話で追跡。

https://github.com/user-attachments/assets/b0c14f75-fffa-449e-b3af-5f66791da3bb

### どのセッションが手待ちか、一目で

並行して動くセッションの状態（作業中・完了待ち・質問への回答待ち・新しい応答）を、一覧の印で区別。見ていないセッションの完了や確認は、macOS の通知で。

https://github.com/user-attachments/assets/cfd42026-30ad-4b0a-ab53-d4ac370a7567

### Claude が何を読んだか、ファイルツリーで

今の会話で Claude が読んだファイルは青、書いたファイルは橙の点。圧縮で要約に置き換わったファイルも区別。コンテキストの使用量はメーター、hooks の出力と止めた理由はチャットに。

https://github.com/user-attachments/assets/7f3e4fab-1b89-4206-8803-d7c2b5946303

### プッシュ前に、変更を PR のようにレビュー

ブランチが分岐したところからの変更（コミット済みも含む）を、プルリクエストのような一覧で確認。差分の行に付けたコメントは、次の指示に添えて Claude へ。GitHub に PR を作る必要は無し。

https://github.com/user-attachments/assets/df937676-cf42-4f77-b2e0-e2ebceb07acd

### 画面を指さして「ここを直して」

開発中のページをアプリの中で表示。クリックで選んだ要素のセレクタ・HTML・画像を、そのまま Claude への指示に添付。

https://github.com/user-attachments/assets/40edf942-d957-4228-b8e1-048ddd7f964e

### そのほか

- **Claude Code だけ再起動**: 会話を続けたまま Claude Code を起動し直し、CLAUDE.md や設定、スキルの本文の変更を反映
- **利用枠とマシンの状態**: 5 時間枠と週の枠の使用率とリセットまでの時間、CPU とメモリの使用量を常に表示
- **エディタ・ターミナル・ソース管理**: ファイルツリー・Monaco エディタ・ターミナル・git の操作を、チャットと並べて利用

## 必要なもの

- macOS 13 以降（Apple Silicon・Intel）
- [Claude Code](https://code.claude.com/docs)（`claude` CLI）
  - ターミナルで一度 `claude` を起動し、初回のセットアップ（テーマの選択とログイン）を済ませておきます
  - tanacode で動作確認済のバージョンは 2.1.286。違うバージョンのときは、ステータスバーの版に警告の印が付きます（マウスを乗せると理由を表示）
  - 最新の Claude Code で動くかも、毎日自動で確認。それでも Claude Code の更新で、一部の表示や操作が動かなくなる場合あり

## インストール

### ソースからビルド（おすすめ）

手元でビルドしたアプリにはダウンロードの印が付かないので、署名が無くても macOS の警告は出ません。

必要なもの: Node.js 22・git

```bash
git clone https://github.com/sny-tanaka/tanacode.git
cd tanacode
npm install
npm run install-app
```

ビルドして `/Applications/tanacode.app` に入れます。Apple Silicon・Intel のどちらでも、その Mac に合わせて作ります。

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

### 更新

自動アップデートは無し。新しい版は、リポジトリの Watch → Custom → Releases で通知を受け取れます。

- **ソースから入れた場合**: 次を実行してから tanacode を終了し、終了のダイアログで「動かしたまま終了」を選んで起動し直します。動いている Claude Code は止まらず、新しい版がそのまま引き継ぎます

  ```bash
  git pull
  npm install
  npm run install-app
  ```

- **ビルド済みのアプリの場合**: 新しい版を入れる前に、メニューの「ファイル → Claude Code も止めて終了」で終了します。アプリの入れ替えで、動いている Claude Code が途中で切れないようにするためです

### アンインストール

メニューの「ファイル → Claude Code も止めて終了」で終了してから、次を削除。

- `/Applications/tanacode.app`
- `~/Library/Application Support/tanacode/`

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
