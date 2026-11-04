---
name: release
description: tanacode の新しいバージョン（vX.Y.Z）をリリースする手順。引数は新しいバージョン（例 0.1.4）。省くと、変更点から patch・minor・major のどれを上げるかを提案します。バージョンを上げる PR・タグのプッシュ・GitHub Actions の見守り・下書きの点検・公開まで。新しいバージョンを出すときに使います。
argument-hint: "[X.Y.Z]"
disable-model-invocation: true
---

# リリースの手順

新しいバージョンをリリースするための手順書。タグ `vX.Y.Z` をプッシュすると、`.github/workflows/release.yml` が Apple Silicon 用と Intel 用の zip と pkg を作り、`SHA256SUMS.txt` を付けて GitHub Releases の下書きに置きます。下書きの説明は、ダウンロードの表と、畳んだ PR の一覧（自動で作る What's Changed）・SHA-256 の表だけ。先頭の変更点（「変更点の書き方」の形）は、このスキルが足します。公開は下書きを点検してから。

以下の `X.Y.Z` は新しいバージョン（`/release 0.1.4` の引数。省いたときは 1 の 3 で決めたもの）、`<前のタグ>` は直前のリリースのタグ（例: `v0.1.2`）に置き換えます。リポジトリは `sny-tanaka/tanacode`。

## 手元と cloud の違い

手順は同じで、GitHub を操作する道具だけが違います。始める前に `gh auth status` を実行し、通らなければ cloud として進めます。

| 場所 | GitHub の操作 | タグ付け・点検・公開 |
| --- | --- | --- |
| 手元（`gh` が使える） | この手順の `gh` のコマンド | 手元でタグをプッシュし、`gh` で点検・公開 |
| Claude Code の cloud のセッション | MCP のツール（`mcp__github__*`）。`gh` は使えません | Actions を手動で起動して任せます（タグのプッシュは、セッションの中継が 403 で断るため） |

- cloud では、各節の「cloud では」の手順に置き換えます。
- cloud の Actions の起動は、どちらも develop で行います（`mcp__github__actions_run_trigger` の `run_workflow`、`ref` は `develop`）。
  - `release.yml` に `version`: ビルドが通ってからタグを付け、下書きを作る
  - `release-publish.yml` に `version`・`notes`: 下書きを点検し、変更点を足して公開する

## 決まり

- **オーナーの操作は、なしにします**。確認を挟まず、バージョンを上げる PR のマージから公開まで進めます。`/release` を呼んだこと自体が、リリースしてよいという指示です。
- develop には直接プッシュしません。作業用のブランチ → develop 向けの PR → squash マージ。
  - develop のルールセットは、PR を通すことを求めます（承認の数は 0）。
  - **バージョンを上げる PR に限り、CI がすべて通っていれば、エージェントがマージします**（オーナーの指示。2026-10-01）。ほかの PR は、これまでどおりオーナーがマージします。
  - マージするのは、変更が `package.json` と `package-lock.json` の `version` だけの PR（2 の 1 で確かめた PR）に限ります。
- 手を止めてユーザーに聞くのは、次の場合だけです。選択を伴うので AskUserQuestion を使い、推奨の選択肢を先頭に置いて、ラベルの末尾に「(推奨)」。
  - 引数でバージョンが渡されていないとき（1 の 3。提案を添えて聞きます）
  - 点検（5）で、期待と違うものが見つかったとき（公開はしません）
  - 失敗の原因が 4 の表の中になく、どうするか決められないとき
  - タグの削除・下書きの削除など、取り消しにくい操作（7）
- Apple の署名・公証は無し（自己署名の証明書で署名します。証明書は環境 release の Secrets に置いてあり、無いとワークフローが止まります）。利用者には README の手順で開いてもらいます。

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

   cloud では、PR の一覧を `mcp__github__search_pull_requests`（`repo:sny-tanaka/tanacode is:merged base:develop merged:>=<前のタグの日付>`）で拾います。本文まで取ると大きいので、`fields` で `number`・`title` に絞り、要る PR だけ本文を読みます。

3. 新しいバージョン `X.Y.Z` を決めます。
   - 引数で渡されていれば、それを使います（聞きません）。
   - 渡されていないときは、2 の変更を 1 つずつ読んで上げ方を提案し、AskUserQuestion で確かめます（下の「バージョンの上げ方の決め方」）。
   - `git ls-remote --tags origin vX.Y.Z` で、同じタグがまだ無いことを確かめます。あれば止めてユーザーに伝えます。

   **バージョンの上げ方の決め方**

   PR のタイトルの頭（`feat:`・`fix:` など）は目安にとどめ、本文と差分で、使う人から見て何が変わるかを確かめます。変更ごとに次の表で分け、いちばん大きいものを提案にします。

   | 上げ方 | 当てはまる変更 |
   | --- | --- |
   | major（`X+1.0.0`） | 使う人が何かし直さないと、今までどおりに使えなくなる変更。保存した設定・セッションを引き継げない、機能やメニューを無くす、対応する macOS や Claude Code の下限を上げる、インストールや更新の手順が変わる、など |
   | minor（`X.Y+1.0`） | それまで無かった機能の追加。今までの使い方はそのまま通るもの |
   | patch（`X.Y.Z+1`） | 今ある機能の改善（扱えるもの・使える場面を増やす、動きや画面を良くする）、不具合の修正、見た目の小さな直し、動作確認済の Claude Code の更新、性能の改善。使い方は変わらないもの |
   | 数えない | 文書・CI・テスト・開発の道具だけの変更（アプリの中身が変わらないもの） |

   - minor か patch かは、その機能そのものが前のバージョンに無かったかで分けます。今ある機能で扱えるもの・使える場面を増やしただけなら、PR のタイトルが `feat:` でも、機能の改善なので patch です（オーナーの指示。2026-10-15）。
     - 例: 入力欄の `@` で渡せるものに、ワークスペースに追加したフォルダのファイルを足した（#215）のは、`@` で渡す機能がもとからあるので patch（v1.7.1）。ワークスペースにフォルダを追加できるようにした（#212）のは、その機能そのものが無かったので minor（v1.7.0）
   - 数えない変更しか無いときは、リリースしなくてよいかもしれないと伝え、patch を推奨にして聞きます。
   - 0.x の間に major に当たる変更があったときも、そのまま major（1.0.0）を推奨にします。1.0.0 は節目なので、説明に理由をはっきり書きます。
   - 聞く前に、変更ごとの分け方（PR の番号・タイトル・上げ方・理由を一言）を文章で見せます。
   - AskUserQuestion の選択肢は patch・minor・major の 3 つ。ラベルは `0.3.0（minor）` のように新しいバージョンと上げ方を並べ、提案を先頭にして末尾に「(推奨)」。説明には、そのバージョンにする理由（推奨でないものは、選ぶとしたらどんなときか）を書きます。
4. 変更点を、下の「変更点の書き方」の形でまとめます。2 の PR の本文と、5 の下書きの説明に使います。

## 変更点の書き方

読むのは tanacode を使う人。「何が変わって、自分に関係あるか」が 10 秒でわかることを目指します。長い箇条書きを並べず、表で一覧にし、説明が要るものだけ後ろで詳しく書きます。

````markdown
<まとめ>

## 変更点

| 種類 | 内容 | PR |
| --- | --- | --- |
| 追加 | <一行> | #39 |
| 変更 | <一行> | #38 |
| 修正 | <一行> | #35 |
| その他 | <一行> | #37 |

## 詳しく

### <表の内容と同じ一行>

<一、二文の説明>

- <補足>
````

- **まとめ**: 見出しを付けず、説明のいちばん上に 1〜2 文。`v0.1.6 から 4 つの変更。` のように数を言い、いちばん大きい変更を一言で。
- **表**
  - 種類は 4 つだけ。「追加」（新しい機能）・「変更」（今までの動きや見た目が変わる）・「修正」（不具合の修正）・「その他」（動作確認済の Claude Code の更新など、使う人に関わる小さなもの）。この順に並べます。
  - 内容は一行（40 文字くらいまで）。使う人の言葉で、何ができるようになったか・どう変わったかを書きます。「〜できるようにする」より「〜できる」のように、今の状態で書きます。
  - PR は `#39` の形（GitHub がリンクにします）。
  - 載せないもの: バージョンを上げる PR、文書・CI・テスト・開発の道具だけの変更。これらは末尾の畳んだ「PR の一覧」に残るので、それで足ります。
  - **前のリリースに無かった機能への直しは、行にしません**。同じバージョンの中で足した機能を、リリースの前に直した PR（不具合・見た目・動きの調整）は、使う人から見れば初めからその形の機能です。「修正」「変更」には載せず、その機能の行の PR に番号を足し（`#62・#75`）、内容と「詳しく」は直したあとの形で書きます。
    - 例: コンテキストの圧縮を選べる機能を足し（#62）、リリースの前に見た目を直した（#75）→「追加 | コンテキストの中身を見て、圧縮で残すもの・捨てるものを選べる | #62・#75」の 1 行だけ
    - 見分け方: 直した機能が前のタグにあったかを確かめます。その機能を足した PR が前のタグより後にマージされていれば新しい機能です。迷ったら `git grep <機能の言葉> <前のタグ> -- GUIDE.md src` で、前のタグの文書やソースにあるかを見ます。
    - 1 つの PR が前からある機能と新しい機能の両方を直しているときは、前からある機能の分だけを「修正」に書きます。
    - 新しい機能を広げる PR（新しい機能の上に、別の機能を足すもの）は、これまでどおり「追加」の行にしてかまいません。
- **詳しく**
  - 表の一行で伝わらないものだけ。足りれば節ごと省きます。
  - 見出しは表の内容と同じ一行にして、表から探せるようにします。
  - 一、二文の説明のあとに、箇条書きを 5 つまで。入れ子にしません。
  - 使い方（どこを押すか）・気をつけること・前との違いを書きます。原因やコードの中の仕組みは書きません（PR に書いてあります）。
- 使う人に関わる変更が 1 つも無いときは、まとめに「使う人から見た変更は無し」と書き、表と「詳しく」は省きます。

## 2. バージョンを上げる PR

1. ブランチを作り、バージョンを上げます。`npm version` は `package.json` と `package-lock.json` の両方を書き換えます。

   ```bash
   git switch -c release/vX.Y.Z
   npm version X.Y.Z --no-git-tag-version
   git diff --stat
   ```

   確かめること
   - `git diff --stat` に出るのが `package.json` と `package-lock.json` の 2 つだけ
   - 型チェックとテストは、手元では流しません。この PR の CI（4）で流れ、`release.yml` は流しません（develop に入っているかだけを見ます）

2. コミットしてプッシュし、develop 向けの PR を作ります。コミットメッセージと PR は日本語。

   ```bash
   git commit -am "chore: vX.Y.Z にする"
   git push -u origin release/vX.Y.Z
   gh pr create --base develop --title "chore: vX.Y.Z にする" --body-file <本文のファイル>
   ```

   PR の本文には、1 でまとめた変更点の一覧（PR の番号付き）。本文のファイルは `mktemp` などで作る一時ファイルに。

3. PR の URL をユーザーに伝えます。
4. CI がすべて終わるまで待ちます。

   ```bash
   gh pr checks <PR の番号> --watch
   ```

   確かめること
   - すべて `pass`（`skipping` は可。たとえば PR では動かない `update` ジョブ）
   - `gh pr view <PR の番号> --json mergeStateStatus --jq .mergeStateStatus` が `CLEAN`
   - どれかが `fail` なら、マージせずに止めて、ユーザーに伝えます（このブランチでは直しません）

5. 通っていれば、squash マージします。ユーザーには聞きません。

   ```bash
   gh pr merge <PR の番号> --squash
   gh pr view <PR の番号> --json state,mergeCommit --jq '{state, oid: .mergeCommit.oid}'
   ```

   `state` が `MERGED` になるまで先へ進みません。待っているあいだにオーナーが先にマージしていたときは、そのまま「3. タグを付けてプッシュ」へ進みます。閉じられた（`CLOSED`）ときは止めて、ユーザーに伝えます。

**cloud では**

- プッシュは `git push -u origin release/vX.Y.Z` のまま（ブランチは通ります）。PR は `mcp__github__create_pull_request` で作ります。
- CI は `mcp__claude-code-remote__subscribe_pr_activity` で PR を見張り、終わった知らせを待ちます（Bash の `sleep` で待ちません）。知らせが来たら、`mcp__github__pull_request_read` の `get_check_runs` ですべて `success`（`skipped` は可）、`get` で `mergeable_state` が `clean` かを確かめます。
- マージは `mcp__github__merge_pull_request`（`merge_method: squash`、`expectedHeadSha` に PR の head の SHA）。返事の `sha` がマージコミットです。マージしたら PR の見張りを外します（`unsubscribe_pr_activity`）。

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

3. タグをプッシュします（プッシュすると Actions が動き出します）。

   ```bash
   git push origin vX.Y.Z
   ```

**cloud では**

タグは付けず（プッシュは 403 で断られます）、`release.yml` を手動で起動します。ワークフローがビルドの通ったコミットにタグを付けます。

1. 1 と同じく develop を最新にし、`git rev-parse HEAD` がマージコミットと同じことを確かめます。違う（マージのあとに別のコミットが入った）ときは、そのコミットもリリースに入るので、止めてユーザーに伝えます。
2. `mcp__github__actions_run_trigger` で起動します。

   | 項目 | 値 |
   | --- | --- |
   | `method` | `run_workflow` |
   | `workflow_id` | `release.yml` |
   | `ref` | `develop` |
   | `inputs` | `{"version": "X.Y.Z"}` |

   - ワークフローは、develop から起動したか・`X.Y.Z` の形か・同じタグがまだ無いかを先に確かめ、合わなければビルドの前に止まります。
   - 「バージョンを確かめる」で `package.json` の `version` と比べるのは、タグのプッシュのときと同じです。

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
   | 「バージョンを確かめる」で止まる | タグと `package.json` の `version` のずれ。タグを付けたコミットの取り違えか、バージョンを上げる PR がまだマージされていないかのどちらか。7 の手順でタグを付け直し |
   | 「翻訳の補助プログラムを作れませんでした」、または「翻訳の補助プログラムを確かめる」で止まる | チャットの翻訳の補助プログラム（Swift）を作れなかったか、アプリに入らなかった。ランナーの `swiftc`（Xcode）か `native/translate/main.swift` のコンパイルエラーをログで確かめ、直しを PR で入れ、7 の手順で作り直し |
   | `npm ci` やダウンロードの一時的な失敗 | コードを変えずに `gh run rerun <run の id> --failed` で再実行 |
   | 「Releases の下書きを作る」で GitHub の 5xx | 返事がエラーでも、GitHub 側では下書きができていることがあり、すぐには一覧に出ません。このステップは、作り直す前に残った下書きを消し、もう一度作ります。それでも止まったときは、コードを変えずに `gh run rerun <run の id> --failed` で再実行（再実行でも、作る前に残りを消します）。あとから残りが出てきても、5 のスクリプトが添付で見分けます |
   | そのほか | ログの要点をユーザーに伝えて、どうするか AskUserQuestion で確かめます |

## 5. 下書きの点検

点検と公開は、`scripts/release-publish.sh` で行います（cloud の `release-publish.yml` も同じスクリプトを使います）。リリースを手で打った命令で公開しません。

- **タグで選んで公開しない**（`gh release edit vX.Y.Z --draft=false` など）。同じタグに下書きが 2 つあると、点検していない方が選ばれます（v2.8.1 で、添付の無い方が公開された）
- **ID で選ぶときも、タグ名を必ず渡す**。渡さないと、GitHub は下書きの仮の名前（`untagged-…`）でタグを作って公開します（v2.8.2 の 1 回目）
- 公開したリリースは immutable で、添付もタグ名もあとから変えられず、消しても同じタグ名を使い直せません。だから点検は公開の前に、確かめは公開のあとにもします

1. 下書きの様子を見ます。下書きは `gh release view vX.Y.Z` では見つからないことがあるので、API で見ます。

   ```bash
   gh api repos/sny-tanaka/tanacode/releases --jq '.[] | select(.tag_name == "vX.Y.Z") | {id, draft, html_url, assets: [.assets[].name]}'
   ```

   下書きが 2 つ以上あるとき（失敗した試みの残り）も、スクリプトは添付が 5 つそろったものだけを選び、ほかは使わずに知らせます。残りを消すかは、公開のあとでユーザーに聞きます。

2. 変更点（まとめ・「## 変更点」・「## 詳しく」）を、1 の 4 でまとめた形で一時ファイルに書きます。聞かずに毎回足します。

3. スクリプトに渡します。点検がすべて通ったときだけ、説明の先頭に変更点を足して公開し、最新のリリースにします。

   ```bash
   scripts/release-publish.sh X.Y.Z <変更点のファイル>
   ```

   スクリプトが確かめること（どれかが合わなければ、何も変えずに `::error::` で止まります）
   - このタグの公開済みのリリースが無いこと
   - 添付が次の 5 つそろった下書きが、ちょうど 1 つあること。ファイル名が README のダウンロードの表と合っていること
     - `tanacode-X.Y.Z-mac-arm64.pkg`・`tanacode-X.Y.Z-mac-arm64.zip`
     - `tanacode-X.Y.Z-mac-x64.pkg`・`tanacode-X.Y.Z-mac-x64.zip`
     - `SHA256SUMS.txt`
   - 説明が `## ダウンロード` から始まり、ダウンロードの表のファイル名が添付と合うこと
   - 説明の SHA-256 の表と `SHA256SUMS.txt` の値が一致すること
   - 公開のあと: タグで引いたリリースが点検した下書き（同じ ID）で、下書きでなく、添付が 5 つあり、最新のリリースがそのタグであること

**cloud では**

- 下書きは `mcp__github__list_releases`（`fields` は `id`・`tag_name`・`draft`・`html_url`）で読み、`tag_name` が `vX.Y.Z` のものを見ます。
- 点検と公開は、6 で `release-publish.yml` が `scripts/release-publish.sh` で行います。変更点は、ここでは書き込まず、6 で渡します。

## 6. 公開

1. 5 の 3 のスクリプトが公開まで行います。止まったときは公開されていません。`::error::` の行と下書きの URL を見せ、AskUserQuestion でどうするか確かめます。
2. スクリプトが「公開を確かめられません」で止まったときは、公開の返事がエラーでも GitHub 側では公開されていることがあります。`gh api repos/sny-tanaka/tanacode/releases --jq '.[] | select(.name == "vX.Y.Z") | {id, tag_name, draft, assets: [.assets[].name]}'` で、どのリリースがどの状態かを見て、ユーザーに伝えます（公開済みのものは直せないので、7 の「公開したあと」）。
3. 新しいバージョンになったか確かめます。

   ```bash
   gh api repos/sny-tanaka/tanacode/releases/latest --jq .tag_name
   curl -s https://img.shields.io/github/v/release/sny-tanaka/tanacode | grep -o '<title>[^<]*</title>'
   ```

   1 つめが `vX.Y.Z`、2 つめが `<title>release: vX.Y.Z</title>` なら公開は完了。README の「最新バージョン」のバッジはこの shields.io の画像。shields.io はキャッシュするので、古いバージョンのままなら数分おいて確かめ直します。

4. Homebrew の tap の cask を新しいバージョンにします。手元の公開は `release-publish.yml` を通らないので、`homebrew.yml` を develop で起動し、4 と同じ要領で見守ります（10 分ほど）。

   ```bash
   gh workflow run homebrew.yml --ref develop -f version=X.Y.Z
   ```

   通れば、`https://github.com/sny-tanaka/homebrew-tanacode/blob/HEAD/Casks/tanacode.rb` の `version` が `X.Y.Z` になります。失敗したときは「Homebrew の cask」の表へ。

**cloud では**

1. `mcp__github__actions_run_trigger` で `release-publish.yml` を起動します。

   | 項目 | 値 |
   | --- | --- |
   | `method` | `run_workflow` |
   | `workflow_id` | `release-publish.yml` |
   | `ref` | `develop` |
   | `inputs` | `{"version": "X.Y.Z", "notes": "<1 の 4 でまとめた変更点（Markdown）>"}` |

   - ワークフローは、5 の 3 と同じスクリプト（`scripts/release-publish.sh`）で点検し、`notes` を先頭に足して公開し、最新のリリースにします。
   - どれかが合わなければ、何も変えずに止まります。ログの `::error::` の行を見て、公開せずにユーザーに伝え、AskUserQuestion でどうするか確かめます。
2. 4 と同じ要領で run を見守ります（1 分ほどで終わります）。
3. `mcp__github__get_latest_release` の `tag_name` が `vX.Y.Z` で、本文の先頭に変更点が入っていれば公開は完了。shields.io のバッジは `curl` で 3 と同じく確かめます。
4. `release-publish.yml` は、公開のあとに `homebrew` のジョブ（`homebrew.yml`）で Homebrew の tap の cask を新しいバージョンにします。このジョブは 10 分ほどかかるので、終わるまで見守ります。通れば、`mcp__github__get_file_contents`（`sny-tanaka/homebrew-tanacode` の `Casks/tanacode.rb`）の `version` が `X.Y.Z` になります。失敗したときは「Homebrew の cask」の表へ。

### Homebrew の cask

`homebrew.yml` は、公開済みのリリースの zip の SHA-256 を `SHA256SUMS.txt` と照らし、tap（`sny-tanaka/homebrew-tanacode`）の `Casks/tanacode.rb` の `version` と `sha256` を書き換えます。プッシュの前に、ランナーの Mac でその cask から入れて、バージョンと quarantine 属性を確かめます。リリースそのものは公開済みなので、ここで失敗しても公開は取り消しません。直してから、develop で `homebrew.yml` を `version` に `X.Y.Z` を渡して起動し直します（cloud では `mcp__github__actions_run_trigger`、`workflow_id` は `homebrew.yml`）。

| 症状 | 原因と対処 |
| --- | --- |
| 「tap の token を作る」で止まる | GitHub App の設定。Environment「homebrew」の `HOMEBREW_TAP_APP_CLIENT_ID`（変数）・`HOMEBREW_TAP_APP_PRIVATE_KEY`（シークレット）と、App が homebrew-tanacode にインストールされているかを、ユーザーに確かめてもらいます |
| ジョブが始まらず、Environment の保護で止まる | develop 以外で起動した。develop で起動し直し |
| 「cask で入れて確かめる」で止まる | ログの `::error::` の行を見ます。Homebrew の書き方の変更（`postflight_steps` など）なら、tap の `Casks/tanacode.rb` の直しをユーザーに伝え、AskUserQuestion でどうするか確かめます |
| ダウンロードの一時的な失敗 | コードを変えずに、失敗したジョブを再実行 |

## 7. 失敗して作り直すとき

- **公開する前**: タグを消し、直しを PR で develop に入れてから、3 の手順でタグを付け直します。タグの削除は AskUserQuestion で確かめてから。

  ```bash
  git tag -d vX.Y.Z
  git push origin :refs/tags/vX.Y.Z
  ```

  失敗した run が残した作りかけの下書きは、次の run の「Releases の下書きを作る」が、作る前に消します（このタグの下書きは、このワークフローしか作らないため）。
- **cloud で公開する前**: タグと下書きは、cloud からは消せません。ユーザーに、手元で `git push origin :refs/tags/vX.Y.Z` を実行してもらいます（AskUserQuestion で確かめてから頼みます。残った下書きは、次の run が作る前に消します）。消えたことを `git ls-remote --tags origin vX.Y.Z` で確かめ、直しを PR で入れてから、3 の「cloud では」で起動し直します。
- **公開したあと**: タグは付け直しません。直しを PR で入れ、バージョンを上げて（例: `X.Y.Z` の次の patch）、1 からやり直します。利用者がすでにダウンロードしているためです。

## 補足

- 配布物を手元で作るなら `npm run release`。`release/` に Apple Silicon 用と Intel 用の zip と pkg を作ります（自己署名の証明書で署名。キーチェーンに無いと止まります）。使っている `dist/` と `/Applications` には触れません。翻訳の補助プログラムを作るので、`swiftc`（Xcode Command Line Tools）が要ります（無いと止まる）。
- パッケージ版は本物の userData と Remote Control 付きで動くので、手元で作ったものを試しに起動しないでください。

## 最後の報告

ユーザーに、次をまとめて伝えます。

- リリースの URL（`https://github.com/sny-tanaka/tanacode/releases/tag/vX.Y.Z`）
- 引数を省いたときは、提案した上げ方とその理由、選ばれたバージョン
- バージョンを上げた PR の URL と、Actions の run の URL
- 点検の結果（添付 5 つ・SHA-256 の一致・ファイル名）
- 説明に足した変更点の有無
- Homebrew の tap の cask が `X.Y.Z` になったか
- 途中で起きた失敗と、その対処（あれば）
