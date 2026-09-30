---
name: release
description: tanacode の新しい版（vX.Y.Z）をリリースする手順。版を上げる PR・タグのプッシュ・GitHub Actions の見守り・下書きの点検・公開まで。新しい版を出すときに使います。
disable-model-invocation: true
---

# リリースの手順

新しい版をリリースするための手順書。タグ `vX.Y.Z` をプッシュすると、`.github/workflows/release.yml` が Apple Silicon 用と Intel 用の zip と pkg を作り、`SHA256SUMS.txt` と SHA-256 の表を付けて GitHub Releases の下書きに置きます。公開は下書きを点検してから。

以下の `X.Y.Z` は新しい版、`<前のタグ>` は直前のリリースのタグ（例: `v0.1.2`）に置き換えます。リポジトリは `sny-tanaka/tanacode`。

## 決まり

- develop には直接プッシュしません。作業用のブランチ → develop 向けの PR → マージはオーナー。
  - develop のルールセットは承認 1 件が必要。オーナーは例外として、PR の画面の「Merge without waiting for requirements to be met (bypass rules)」で squash マージします。
  - エージェントは PR をマージしません。
- 次の 3 か所では、必ず AskUserQuestion でユーザーに確かめてから進めます。推奨の選択肢を先頭に置き、ラベルの末尾に「(推奨)」。
  - コミット（とプッシュ・PR の作成）の前
  - タグのプッシュの前
  - リリースの公開の前
- タグの削除・下書きの削除など、取り消しにくい操作も、同じく AskUserQuestion で確かめてから。
- 署名・公証は無し。利用者には README の手順で開いてもらいます。

## 1. 準備

1. develop が最新でクリーンか確かめます。

   ```bash
   git fetch origin --tags
   git switch develop
   git pull --ff-only
   git status --short
   ```

   `git status --short` に何か出たら、そこで止めてユーザーに伝えます（勝手に退避・破棄はしません）。

2. 前のタグと、そこからの変更を見ます。

   ```bash
   git describe --tags --abbrev=0
   git log <前のタグ>..develop --oneline
   gh pr list --state merged --base develop --limit 50 --json number,title,mergedAt
   ```

   PR の一覧は、前のタグの日付より後にマージされたものだけを拾います。

3. 変更点の一覧をまとめてユーザーに見せ、版の上げ方を AskUserQuestion で確かめます。
   - patch（不具合の修正・文書だけ）と minor（機能の追加・変更）のうち、変更の中身に合う方を先頭に「(推奨)」。
   - 新しい版 `X.Y.Z` がここで決まります。`git ls-remote --tags origin vX.Y.Z` で、同じタグがまだ無いことも確かめます。

## 2. 版を上げる PR

1. ブランチを作り、版を上げます。`npm version` は `package.json` と `package-lock.json` の両方を書き換えます。

   ```bash
   git switch -c release/vX.Y.Z
   npm version X.Y.Z --no-git-tag-version
   git diff --stat
   npm run typecheck
   ```

   確かめること
   - `git diff --stat` に出るのが `package.json` と `package-lock.json` の 2 つだけ
   - `npm run typecheck` が通ること。通らなければ止めてユーザーに伝えます（このブランチでは直しません。直しは別の PR で）

2. AskUserQuestion で、コミット・プッシュ・PR の作成をしてよいか確かめます。
3. コミットしてプッシュし、develop 向けの PR を作ります。コミットメッセージと PR は日本語。

   ```bash
   git commit -am "chore: vX.Y.Z にする"
   git push -u origin release/vX.Y.Z
   gh pr create --base develop --title "chore: vX.Y.Z にする" --body-file <本文のファイル>
   ```

   PR の本文には、1 でまとめた変更点の一覧（PR の番号付き）。本文のファイルは `mktemp` などで作る一時ファイルに。

4. PR の URL をユーザーに伝え、マージを待ちます。マージは上の「決まり」のとおりオーナーが行います。マージされたかは次で確かめます。

   ```bash
   gh pr view <PR の番号> --json state,mergeCommit --jq '{state, oid: .mergeCommit.oid}'
   ```

   `state` が `MERGED` になるまで先へ進みません。

## 3. タグを付けてプッシュ

1. develop を最新にし、マージされたコミットにいることを確かめます。

   ```bash
   git switch develop
   git pull --ff-only
   git rev-parse HEAD
   node -p 'require("./package.json").version'
   ```

   確かめること
   - `git rev-parse HEAD` が、PR の `mergeCommit.oid` と同じ
   - `version` が `X.Y.Z`（ずれていると Actions の「バージョンを確かめる」で止まります）

2. 注釈付きのタグを付けます。

   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z" <mergeCommit.oid>
   ```

3. AskUserQuestion で、タグをプッシュしてよいか確かめます（プッシュすると Actions が動き出します）。
4. タグをプッシュします。

   ```bash
   git push origin vX.Y.Z
   ```

## 4. Actions の見守り

1. 起動した run を探します。プッシュの直後は一覧に出ないことがあるので、数秒おいて確かめ直します。

   ```bash
   gh run list --workflow release.yml --limit 1 --json databaseId,headBranch,status,url
   ```

   `headBranch` が `vX.Y.Z` のものが今回の run。

2. 終わるまで見守ります。数分〜10 分ほどかかるので、Bash の `run_in_background` で動かします。

   ```bash
   gh run watch <run の id> --exit-status
   ```

3. 失敗したら、ログを読んで原因を確かめます。

   ```bash
   gh run view <run の id> --log-failed
   ```

   | 症状 | 原因と対処 |
   | --- | --- |
   | 画面側のビルドで `JavaScript heap out of memory` | Node のメモリ不足。手元のビルドは約 4GB 使い、ランナーの既定の上限（約 2GB）では止まります。v0.1.2 のときに起き、`release.yml` の `npm run release` に `NODE_OPTIONS: --max-old-space-size=6144` を付けました。消えていないか確かめ、足りなければ上限を上げる直しを PR で入れ、7 の手順で作り直し |
   | 「バージョンを確かめる」で止まる | タグと `package.json` の `version` のずれ。タグを付けたコミットの取り違えか、版を上げる PR がまだマージされていないかのどちらか。7 の手順でタグを付け直し |
   | `npm ci` やダウンロードの一時的な失敗 | コードを変えずに `gh run rerun <run の id> --failed` で再実行 |
   | そのほか | ログの要点をユーザーに伝えて、どうするか AskUserQuestion で確かめます |

## 5. 下書きの点検

下書きは `gh release view vX.Y.Z` では見つからないことがあるので、API で見ます。

1. 下書きの中身を見ます。

   ```bash
   gh api repos/sny-tanaka/tanacode/releases --jq '.[] | select(.tag_name == "vX.Y.Z") | {draft, name, html_url, assets: [.assets[].name], body}'
   ```

2. 確かめること
   - `draft` が `true`
   - 添付が次の 5 つ。ファイル名が README のダウンロードの表（`tanacode-<バージョン>-mac-arm64.pkg` など）と合っていること
     - `tanacode-X.Y.Z-mac-arm64.pkg`・`tanacode-X.Y.Z-mac-arm64.zip`
     - `tanacode-X.Y.Z-mac-x64.pkg`・`tanacode-X.Y.Z-mac-x64.zip`
     - `SHA256SUMS.txt`
   - 説明の SHA-256 の表と `SHA256SUMS.txt` の値が一致。次のコマンドで「一致」と出れば問題無し

     ```bash
     diff <(gh api repos/sny-tanaka/tanacode/releases --jq '.[] | select(.tag_name == "vX.Y.Z") | .body' \
              | sed -nE 's/^\| `([^`]+)` \| `([0-9a-f]{64})` \|$/\2  \1/p' | sort) \
          <(gh release download vX.Y.Z -R sny-tanaka/tanacode -p SHA256SUMS.txt -O - | sort) && echo 一致
     ```

     下書きで `gh release download` が失敗するときは、`SHA256SUMS.txt` の添付の id を 1 で見て、`gh api -H "Accept: application/octet-stream" repos/sny-tanaka/tanacode/releases/assets/<添付の id>` で読みます。

3. 説明に変更点の節を足すか、AskUserQuestion でユーザーに聞きます。足すときは、今の説明を一時ファイルに書き出し、SHA-256 の節の後ろに「## 変更点」の節（1 でまとめた一覧）を足してから反映します。SHA-256 の表は変えません。

   ```bash
   gh api repos/sny-tanaka/tanacode/releases --jq '.[] | select(.tag_name == "vX.Y.Z") | .body' > <一時ファイル>
   # 一時ファイルを編集
   gh release edit vX.Y.Z --notes-file <一時ファイル>
   ```

## 6. 公開

1. 5 の点検の結果と下書きの URL を見せて、AskUserQuestion で公開してよいか確かめます。
2. 公開して、最新のリリースにします。

   ```bash
   gh release edit vX.Y.Z --draft=false --latest
   ```

3. 新しい版になったか確かめます。

   ```bash
   gh api repos/sny-tanaka/tanacode/releases/latest --jq .tag_name
   curl -s https://img.shields.io/github/v/release/sny-tanaka/tanacode | grep -o '<title>[^<]*</title>'
   ```

   1 つめが `vX.Y.Z`、2 つめが `<title>release: vX.Y.Z</title>` なら完了。README の「最新版」のバッジはこの shields.io の画像。shields.io はキャッシュするので、古い版のままなら数分おいて確かめ直します。

## 7. 失敗して作り直すとき

- **公開する前**: タグを消し、直しを PR で develop に入れてから、3 の手順でタグを付け直します。タグの削除は AskUserQuestion で確かめてから。

  ```bash
  git tag -d vX.Y.Z
  git push origin :refs/tags/vX.Y.Z
  ```

  失敗した run が作りかけの下書きを残していると、次の run の `gh release create` が止まります。5 の 1 のコマンドで下書きが残っていないか確かめ、残っていれば AskUserQuestion で確かめてから `gh release delete vX.Y.Z -R sny-tanaka/tanacode --yes` で消します（タグは別に消します）。
- **公開したあと**: タグは付け直しません。直しを PR で入れ、版を上げて（例: `X.Y.Z` の次の patch）、1 からやり直します。利用者がすでにダウンロードしているためです。

## 補足

- 配布物を手元で作るなら `npm run release`。`release/` に Apple Silicon 用と Intel 用の zip と pkg を作ります（署名なし）。使っている `dist/` と `/Applications` には触れません。
- パッケージ版は本物の userData と Remote Control 付きで動くので、手元で作ったものを試しに起動しないでください。

## 最後の報告

ユーザーに、次をまとめて伝えます。

- リリースの URL（`https://github.com/sny-tanaka/tanacode/releases/tag/vX.Y.Z`）
- 版を上げた PR の URL と、Actions の run の URL
- 点検の結果（添付 5 つ・SHA-256 の一致・ファイル名）
- 説明に足した変更点の有無
- 途中で起きた失敗と、その対処（あれば）
