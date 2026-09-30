---
name: update-app
description: 自分の Mac の /Applications/tanacode.app を、手元のソースからビルドした版に入れ替える手順。ビルドと入れ替え・pty ホストの形（PROTOCOL）が変わったかの確認・起動し直しの案内まで。ソースから入れたアプリを更新するときに使います。
disable-model-invocation: true
---

# 自分の Mac のアプリの更新

`npm run install-app` で、ソースからビルドしたアプリに `/Applications/tanacode.app` を入れ替える手順書。作業はリポジトリの一番上のフォルダで行います。

## 決まり

- アプリの終了・起動は、ユーザーに頼みます。エージェントは tanacode を終了・起動しません。
- ユーザーの動いている pty ホストや、その中の `claude` のプロセスを勝手に止めません。止める必要が出たときは、AskUserQuestion で確かめます（推奨の選択肢を先頭に置き、ラベルの末尾に「(推奨)」）。
- `/Applications/tanacode.app` の中のファイルを `cp` などで上書きしません。動いているアプリや pty ホストのファイルを上書きすると、macOS が署名の確認でプロセスを止めることがあるためです。入れ替えは必ず `npm run install-app` で。
- git の操作は、最新にするための `git pull` まで。コミット・プッシュはしません。

## 仕組み

- `npm run install-app` は、`npm run dist` でビルドしてから `node scripts/install-app.mjs` を実行します。
  - `npm run dist`: `electron-vite build` と `electron-builder --mac` で、その Mac に合わせたアプリを作ります。Apple Silicon では `dist/mac-arm64/tanacode.app`、Intel では `dist/mac/tanacode.app`（署名なし）。
  - `scripts/install-app.mjs`: 動いているアプリの上に上書きせず、次の順で入れ替えます。
    1. 前回の途中で止まったときの残り（`/Applications/.tanacode.app.incoming`・`/Applications/.tanacode.app.outgoing`）の削除
    2. `ditto` で、新しいアプリを `/Applications/.tanacode.app.incoming` にコピー（シンボリックリンクや拡張属性ごと）
    3. 今の `/Applications/tanacode.app` の名前を `.tanacode.app.outgoing` に付け替え
    4. `.tanacode.app.incoming` の名前を `/Applications/tanacode.app` に付け替え
    5. `.tanacode.app.outgoing` の削除
  - 古いファイルが消えても、動いているアプリと pty ホスト・Claude Code はそのまま動き続けます。次に起動したときから新しい版。
- アプリを起動し直すと、新しい版が、pty ホストの中で動いていた Claude Code をそのまま引き継ぎます。
- ただし、アプリと pty ホストのやりとりの形（`src/main/pty-host-protocol.ts` の `PROTOCOL`）が違うと、起動した新しい版は古いホストを Claude Code ごと止めて、ホストを起動し直します（`src/main/pty-host-client.ts` の `connect`）。止まったセッションは、選ぶと `claude --resume` で会話を再開します。途中のターンは中断されます。

## 1. ソースの準備

1. 今のブランチと、手元の変更を確かめます。

   ```bash
   git branch --show-current
   git status --short
   ```

   `install-app` は、今の作業ツリーをそのままビルドします。develop 以外のブランチにいる、または手元に変更があるときは、AskUserQuestion で確かめます。
   - 選択肢の例: 「今の作業ツリーのままビルド」「develop の最新にしてからビルド」。手元に変更があるときは前者を先頭に「(推奨)」（勝手に退避・破棄はしません）。
2. develop の最新にするときは、次を実行します。

   ```bash
   git switch develop
   git pull --ff-only
   npm install
   ```

   `npm install` のあとに `git status --short` で `package-lock.json` が変わっていたら、ユーザーに伝えます（コミットはしません）。

## 2. PROTOCOL が変わるかの確認（入れ替えの前に）

入れ替えると古いアプリの中身が消えるので、必ず `install-app` の前に確かめます。

1. 今入っているアプリの版と `PROTOCOL` を見ます。`PROTOCOL` はビルドしたコードの `PROTOCOL = <数>` の形で `app.asar` に入っています。

   ```bash
   /usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" /Applications/tanacode.app/Contents/Info.plist
   grep -aoE "PROTOCOL = [0-9]+" /Applications/tanacode.app/Contents/Resources/app.asar | sort -u
   ```

2. ソースの `PROTOCOL` を見ます。

   ```bash
   sed -nE 's/^export const PROTOCOL = ([0-9]+);.*/\1/p' src/main/pty-host-protocol.ts
   ```

3. 1 と 2 の数を比べます。
   - `/Applications/tanacode.app` が無い: 初めてのインストール。PROTOCOL の心配は無し
   - 同じ: 変更無し
   - 違う: この版では、起動し直すと古いホストが Claude Code ごと止まります
   - 1 の `grep` の出力が無い（ビルドの形が変わったなど）: 版の数から判断します。`git log --oneline -- src/main/pty-host-protocol.ts` で `PROTOCOL` を上げたコミットと、その後のタグ（`git tag --contains <コミット>`）を見て、入っている版より新しければ「違う」と扱います
4. 補足: 前回 `install-app` したあとに起動し直していなければ、動いているホストは入っているアプリよりさらに古いことがあります。心当たりをユーザーに聞き、分からなければ `git log -p -- src/main/pty-host-protocol.ts` で `PROTOCOL` の変わった履歴を見せます。

## 3. ビルドと入れ替え

1. 実行します。ビルドに数分かかり、メモリを約 4GB 使います。

   ```bash
   npm run install-app
   ```

   最後に「/Applications/tanacode.app に入れました。…」と出れば成功。

2. 入れ替わったか確かめます。

   ```bash
   /usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" /Applications/tanacode.app/Contents/Info.plist
   grep -aoE "PROTOCOL = [0-9]+" /Applications/tanacode.app/Contents/Resources/app.asar | sort -u
   ls -d /Applications/.tanacode.app.* 2>/dev/null
   ```

   確かめること
   - 版が `package.json` の `version` と同じ
   - `PROTOCOL` がソースと同じ
   - `ls` の出力が無い（途中の残りが無い）

3. 失敗したとき

   | 症状 | 対処 |
   | --- | --- |
   | `JavaScript heap out of memory` | `NODE_OPTIONS=--max-old-space-size=6144 npm run install-app` でやり直し |
   | 「dist/… がありません。先に npm run dist でビルドしてください」 | ビルドが失敗しています。その前のエラーを読んで対処 |
   | `/Applications` への書き込みで `EACCES`・`EPERM` | 権限が足りません。ユーザーに伝え、どうするか AskUserQuestion で確かめます（sudo は使いません） |
   | 途中で止まり、`/Applications/tanacode.app` が無い | `npm run install-app` をもう一度実行すると入ります。ビルドをやり直したくなければ `node scripts/install-app.mjs` だけでも可 |

## 4. 起動し直しの案内

2 の結果で分けます。

- **PROTOCOL が同じ**: ユーザーに次を頼みます。
  1. tanacode の終了。終了のダイアログでは「動かしたまま終了」を選んでもらいます
  2. tanacode の起動し直し。新しい版が、動いていた Claude Code をそのまま引き継ぎます
- **PROTOCOL が違う**: 起動し直すと、動いている Claude Code がすべて止まります。先にこのことを伝え、AskUserQuestion で進め方を確かめます。
  - 選択肢の例: 「作業中のセッションが一区切りしてから起動し直す (推奨)」「今すぐ起動し直す」
  - 起動し直すときは、ユーザーに次を頼みます。
    1. tanacode の終了。終了のダイアログは「Claude Code も止めて終了」「動かしたまま終了」のどちらでもかまいません（新しい版の起動のときに、古いホストは止まります）
    2. tanacode の起動し直し
    3. 止まったセッションは、選ぶと会話を再開します
  - ホストの入れ替えで困ったときは、userData の `~/Library/Application Support/tanacode/pty-host.log` を見ます。

エージェントは、アプリ・pty ホスト・`claude` のプロセスを `kill` などで止めません。

## 最後の報告

ユーザーに、次をまとめて伝えます。

- 入れた版（`CFBundleShortVersionString`）と、ビルドしたブランチ・コミット（`git rev-parse --short HEAD`）
- PROTOCOL が変わったかどうかと、起動し直すときの注意
- ユーザーにしてもらうこと（終了のダイアログでの選択と、起動し直し）
