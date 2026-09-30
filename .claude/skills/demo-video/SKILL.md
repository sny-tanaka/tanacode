---
name: demo-video
description: README のデモ動画を録り直して差し替える手順。録画・コマの確認・GitHub へのアップロード・README の URL の差し替え・develop 向けの PR まで。画面を変えて README の動画が古くなったときや、デモの台本（src/renderer/src/demo/scenarios/）を直したときに使います。
disable-model-invocation: true
---

# README のデモ動画を録り直して差し替える

README の動画は、Storybook の「デモ」のストーリーを `scripts/record-demo.mjs` で録った MP4 を、GitHub にアップロードした URL（`https://github.com/user-attachments/assets/…`）で 1 行ずつ貼ったもの。仕組みは `CONTRIBUTING.md` の「デモ動画の仕組み」を見てください。

ユーザーへの質問は、選択を伴うもの（Yes/No も含む）はすべて AskUserQuestion で聞きます。

## 前提

- ffmpeg が入っていること（`ffmpeg -version` で確認。無ければ `brew install ffmpeg` をユーザーに頼みます）
- `npm run storybook` が動いていること（http://localhost:6006）。`curl -s -o /dev/null -w '%{http_code}\n' http://localhost:6006/index.json` が `200` なら起動済み。起動していなければ、ユーザーに起動を頼むか、起動してよいかを聞きます

## 動画の名前と README の場所

| 動画の名前 | 中身 | README の場所 |
| --- | --- | --- |
| `基本` | チャット・ツール・質問・バックグラウンドの作業・エディタ | 冒頭の「基本の流れ」のすぐ下 |
| `ワークフロー` | ワークフローのフロー図とエージェントごとの会話 | 「並行して動く作業を見失わない」 |
| `複数のセッション` | 並行するセッションの状態の印 | 「どのセッションが手待ちか、一目で」 |
| `見える化` | Claude が知っている範囲・コンテキスト・hooks・利用枠 | 「Claude が何を読んだか、ファイルツリーで」 |
| `レビュー` | ブランチの変更のレビューと差分の行へのコメント | 「プッシュ前に、変更を PR のようにレビュー」 |
| `プレビュー` | アプリ内プレビューと要素の選択 | 「画面を指さして「ここを直して」」 |

README の見出しは変わることがあります。差し替える前に `grep -n 'user-attachments' README.md` で行を出し、前後の見出しで対応を確かめます。台本は `src/renderer/src/demo/scenarios/`、ストーリーは `src/renderer/src/demo/Demo.stories.tsx`（ストーリーの名前 = 動画の名前）。

## 手順

### 1. 録る動画を決める

1. 変えた画面・部品を確かめます（`git log`・`git diff develop...HEAD --stat` など）。
2. 上の表から関係しそうな動画を選び、AskUserQuestion で録る動画を決めます（複数選択。関係が深いものを先頭に「(推奨)」付きで）。

### 2. 録る

動画ごとに 1 本ずつ実行します。

```bash
npm run demo:record -- <動画の名前>
```

- `demo-videos/<動画の名前>.mp4` と、コマの画像の `demo-videos/<動画の名前>.frames/` ができます（`demo-videos/` は git に入れません）。
- 台本が終わるまで実時間どおりにかかります（1 本 1〜2 分ほど。上限は 5 分）。
- 画面の大きさは 1440×900 を 1.5 倍（2160×1350）。`ワークフロー` だけは `scripts/record-demo.mjs` の `SIZES` で広い画面にしています。

うまくいかないとき

- 「Storybook に繋がりません」: `npm run storybook` が動いていません。
- 「ffmpeg が見つからないので、コマだけ残しました」: ffmpeg を入れてから、表示されたコマンドで MP4 にします。
- 5 分かかって止まった、動画の途中で動きが止まる: 台本が例外で止まっています。Storybook の「デモ」のストーリーをブラウザで開き、コンソールの `demo failed` と `demo: 要素が見つかりません` を見ます。画面の部品のクラス名や文言を変えたときは、台本のセレクタや `d.byText(...)` の文言を合わせます。

### 3. 確かめる

動画からコマを取り出し、画像として Read で見ます。

```bash
mkdir -p demo-videos/check/<動画の名前>
# 長さ
ffprobe -v error -show_entries format=duration -of csv=p=0 "demo-videos/<動画の名前>.mp4"
# 3 秒ごとに 1 枚、幅 1080 で
ffmpeg -v error -i "demo-videos/<動画の名前>.mp4" -vf "fps=1/3,scale=1080:-1" "demo-videos/check/<動画の名前>/%03d.jpg"
# 気になる時刻の 1 枚（例: 12.5 秒）
ffmpeg -v error -ss 12.5 -i "demo-videos/<動画の名前>.mp4" -frames:v 1 "demo-videos/check/<動画の名前>/at-12.5.jpg"
```

細かいところは、`demo-videos/<動画の名前>.frames/` の元のコマ（2160×1350）を直接見ます。

見るところ

- 白いコマ（特に始まり。Storybook の読み込み中の画面）
- 切れた画面（横に長い図やパネルが画面の外にはみ出していないか）
- 作り物のカーソルとクリックの位置のずれ（押したはずのボタンやメニューが開かないままになっていないか）
- 古いロゴ・古い版の表示・古い文言が残っていないか
- 変えた画面が、意図どおりに映っているか

問題があれば、台本（`src/renderer/src/demo/scenarios/`）かアプリの側を直して、手順 2 から録り直します。過去にあった例

- Monaco のコメントのグリフ（行番号の横の ＋）のクリックが不安定 → 合成したクリックが効かないときは、エディタのアクション（`tanacode.addComment`）経由で書き始めるように（`scenarios/review.ts`）
- 横に長いワークフローの図が切れる → `scripts/record-demo.mjs` の `SIZES` で、広い画面を低い倍率で描く形に（出来上がりの大きさはほかと同じ）

確かめ終えたら、見た結果（問題の有無と気になるコマ）をユーザーに短く伝えます。

### 4. GitHub にアップロードする

GitHub は、README の中の `<video>` やリポジトリに置いた MP4 を再生しません。GitHub にアップロードした動画の URL を使います。

このリポジトリの Issue を新しく作る画面（https://github.com/sny-tanaka/tanacode/issues/new）の本文の欄に動画を入れると、投稿しなくてもアップロードされ、`https://github.com/user-attachments/assets/…` の URL が欄に入ります。欄には URL だけが入り、ファイル名は残りません。何本かあるときは 1 本ずつ入れ、入れた順番で動画との対応を取ります。

エージェントがやるときは、ユーザーの Chrome（Claude in Chrome。GitHub にログイン済みのもの）を使います。始める前に AskUserQuestion で、エージェントがやるか、ユーザーが自分でやるかを聞きます。

エージェントがやる場合

1. `tabs_create_mcp` で新しいタブを作り、`navigate` で https://github.com/sny-tanaka/tanacode/issues/new を開きます。ログインの画面が出たら止めて、ユーザーにログインを頼みます（パスワードは入れません）。
2. `find` か `read_page` で、本文の欄のファイルの入力欄（`input[type=file]`）の ref を探します。入力欄やボタンはクリックしません（OS のファイル選択の画面が開き、操作できないため）。
3. `file_upload` で、動画を 1 本だけ渡します。`paths` はリポジトリの絶対パス（`git rev-parse --show-toplevel`）＋ `demo-videos/<動画の名前>.mp4`。
   - 1 回に渡せるのは合計 10 MB まで。動画は 1〜2 MB ほどなので、1 本ずつなら収まります。
   - 日本語のファイル名で渡せないときは、`demo-videos/upload/` に英数字の名前（例: `basic.mp4`）でコピーしてから渡します。
4. アップロードが終わるまで待ち（欄の「Uploading…」が URL に変わるまで）、`read_page` か `get_page_text` で本文の欄の中身を読んで、新しく入った URL を控えます。
5. 何本かあるときは、3〜4 を 1 本ずつ繰り返します。控えた URL と動画の名前の対応をユーザーに見せます。
6. Issue は投稿しません（「Submit new issue」などは押しません）。`tabs_close_mcp` でタブごと閉じます。「変更を破棄しますか」の確認ダイアログは見えないことがあるので、画面の中のボタンで閉じようとしません。
7. Issue が作られていないことを確かめます。

   ```bash
   gh issue list --repo sny-tanaka/tanacode --state all --limit 5
   ```

   意図しない Issue があれば、ユーザーに伝えます（エージェントは消しません）。

ユーザーが自分でやる場合は、次の手順を伝えて、URL を貼ってもらいます。

1. https://github.com/sny-tanaka/tanacode/issues/new を開きます（投稿はしません）。
2. 本文の欄に、録り直した動画を 1 本ずつ順にドラッグします。
3. 入った `https://github.com/user-attachments/assets/…` の URL を、どの動画のものか分かるように控えます。
4. Issue は投稿せずに閉じます（下書きの破棄の確認が出たら破棄）。

### 5. README の URL を差し替えて PR を出す

develop に直接プッシュしません。作業用のブランチから develop 向けの PR を出し、マージはオーナーに任せます。

1. develop の最新から作業用のブランチを作ります。

   ```bash
   git fetch origin
   git switch -c docs/demo-video origin/develop
   ```

   画面の変更と同じブランチで出すときは、そのブランチのままで構いません。どちらにするかは AskUserQuestion で聞きます。
2. `grep -n 'user-attachments' README.md` で行を出し、該当する行の URL だけを新しいものに置き換えます（行の前後の文や見出しは変えません）。
3. `git diff README.md` を見せ、AskUserQuestion でコミットしてよいかを確かめます。
4. コミットしてプッシュし、PR を作ります。コミットメッセージと PR の説明は日本語。

   ```bash
   git add README.md
   git commit -m "docs: README のデモ動画（<動画の名前>）を録り直したものに差し替える"
   git push -u origin HEAD
   gh pr create --base develop --title "docs: README のデモ動画を差し替える" --body "<録り直した動画と、変えた画面の説明>"
   ```

5. PR の URL をユーザーに伝えます。

### 6. マージのあとに確かめる

PR がマージされたら、ログインしていない状態で README の画面に動画が埋め込まれるかを確かめます。

```bash
# README の画面の <video>。private-user-images の署名付きの URL が、動画の数だけ出れば OK
curl -s -L https://github.com/sny-tanaka/tanacode | grep -oE '<video src="[^"]+"'

# 1 本を取り出して、先頭だけ取れるか（206 video/mp4 なら OK）
URL=$(curl -s -L https://github.com/sny-tanaka/tanacode | grep -oE '<video src="[^"]+"' | head -1 | sed -E 's/<video src="([^"]+)"/\1/; s/&amp;/\&/g')
curl -s -r 0-1023 -o /dev/null -w '%{http_code} %{content_type}\n' "$URL"
```

- 署名付きの URL は数分で切れます。取り出したらすぐに試します。
- 新しい URL が出ない: README が既定のブランチに入っていないか、URL の行の前後に空行が無いかを確かめます（URL は 1 行だけで置く）。
- GitHub のスマホアプリでは、動画は埋め込まれずリンクになり、タップで再生されます。これは正常。

### 7. 片付け

`demo-videos/` の不要なファイル（`<動画の名前>.frames/`・`check/`・`upload/`・古い MP4）を消すかどうかを、AskUserQuestion で聞きます。消すと決まったものだけを消します。
