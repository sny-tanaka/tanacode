---
name: claude-code-events
description: Claude Code が stream-json で出すイベント・会話ログにだけ書く system の行・tanacode への要求を、Claude Code の本体と Agent SDK の型から集めて、tanacode の対応と突き合わせる手順。引数は調べる Claude Code のバージョン（省くと動作確認済のバージョン）。本物の claude をモックの API につないで行を録り、tanacode の読み取りに流すところまで。結果で docs/claude-code-events.md を直します。新しい Claude Code に追従するときや、知らない種類の行が出たときに使います。
argument-hint: "[X.Y.Z]"
disable-model-invocation: true
---

# Claude Code のイベントの調べ方

Claude Code が出す行の種類を、次の 3 つから集めて突き合わせ、[docs/claude-code-events.md](../../../docs/claude-code-events.md) を直すための手順書。

- Agent SDK の型（`sdk.d.ts` の `SDKMessage`）
- Claude Code の本体（JavaScript のソースが文字のまま入った 1 つの実行ファイル）の中の名前
- 本物の `claude -p` をモックの API につないで録った行

SDK の型には無い種類も、Claude Code は出します。SDK はそれも捨てずにアプリへ渡すので、型だけを見ていると見落とします。毎日の確認（`claude-code-check.yml`）で気づけるのも、台本で起こした場面に出た種類だけです。このスキルは、その外側を確かめます。

以下の `<作業>` は使い捨てのフォルダ、`<バージョン>` は調べる Claude Code のバージョン、`<スキル>` は `.claude/skills/claude-code-events` に置き換えます。作業はリポジトリの一番上のフォルダで行います。

## 決まり

- 取ってきた Claude Code・SDK は、リポジトリの外の使い捨てのフォルダに置きます。クラウドの開発環境なら scratchpad、手元の Mac なら `mktemp -d` で作ったフォルダ。リポジトリには入れず、コミットもしません。
- 取ってくるときは、インストールのスクリプトを動かしません（`--ignore-scripts`）。取ってきたフォルダの中から node やビルドの道具を動かさず、パスを引数で渡します。
- 本物の `claude` は、モックの API にだけつなぎます（`scripts/record.mjs`）。API キーは使わず、料金もかかりません。ユーザーの `~/.claude` には触らず、HOME は使い捨てのフォルダにします。
- 環境変数は、`test/cli/claude-run.ts` と同じ最小限にします（`record.mjs` がそうします）。クラウドの開発環境の変数（`CLAUDE_CODE_*` など）を受け継ぐと、ふだんは出ない種類（`active_goal`・`autocompact_state`・`commands_changed`）が出ます。
- 本体のコードを読んで分かったこと（推測）と、動かして確かめたこと（実測）は、分けて書きます。
- 不具合を見つけたら、ユーザーに報告して、Issue を立てるか確かめます。立てるときは、リポジトリの不具合の報告のテンプレート（`.github/ISSUE_TEMPLATE/bug_report.yml`）の見出しに合わせます。コミット・プッシュ・PR も、頼まれてから。

## 0. バージョンを決める

1. 調べる Claude Code のバージョン: 引数があればそれ。無ければ、動作確認済のバージョン（`src/shared/claude-code.ts` の `VERIFIED_CLAUDE_CODE_VERSION`）。最新は `npm view @anthropic-ai/claude-code version` で分かります。
2. SDK のバージョン: SDK の末尾の数は、Claude Code の末尾の数と同じです（Claude Code 2.1.302 = SDK 0.3.302）。あるかを確かめます。

   ```bash
   npm view @anthropic-ai/claude-agent-sdk@0.3.<末尾> version
   ```

   無ければ、いちばん近いバージョンを使い、そのことを一覧に書きます。

## 1. 取ってくる

```bash
npm install --no-save --ignore-scripts --prefix <作業>/pkg \
  @anthropic-ai/claude-code@<バージョン> @anthropic-ai/claude-agent-sdk@<SDK のバージョン>
```

- Claude Code の実体: `<作業>/pkg/node_modules/@anthropic-ai/claude-code-<OS>-<CPU>/claude`（Apple Silicon の Mac は `claude-code-darwin-arm64`、Intel は `claude-code-darwin-x64`、Linux は `claude-code-linux-x64`）。`--version` で、調べるバージョンかを確かめます。
- SDK の型: `<作業>/pkg/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`

## 2. 突き合わせる

```bash
node <スキル>/scripts/kinds.mjs --cli <Claude Code の実体> --sdk <sdk.d.ts> --json <作業>/kinds.json > <作業>/kinds.md
```

`kinds.md` に、次のものが出ます（数十秒かかる）。

- **system の行**: subtype ごとに、SDK の型にあるか・会話の処理の行から stream-json に出すか・本体に書かれた数・そのうち会話ログ用らしいもの（`timestamp`・`isMeta` の付いた行）・tanacode が使うか・意図して捨てるか・知らないか（`src/main/stream/client.ts` の `SYSTEM_CHECKS`・`IGNORED_KINDS`）・tanacode の会話ログの読み取り（`src/shared/chat.ts` の `toChatEvents`）が読むか・意図して捨てるか（`IGNORED_SYSTEM`）。どちらでもないものは、会話ログに出れば、チャットに未知のイベントとして出ます（stream-json の知らない種類も同じ）
- **system 以外の行**: 出力の待ち行列に入れる種類（`enqueue({type:…})` と、目印から見つけた出力の関数）と、会話の処理の行の振り分けにある種類
- **本体からアプリへの要求**（`sendRequest({subtype:…})`）
- **stream_event の追加の欄**

読み方:
- 名前は決まった書き方だけを拾うので、数はおおよそです。名前を変数で組み立てている種類や、書く順の違う種類は漏れます。
- 「会話ログ用らしい」「会話の処理の行の振り分けにある」は目安です。最後は 3 の前後のコードで決めます。
- 今の [docs/claude-code-events.md](../../../docs/claude-code-events.md) と見比べて、増えた種類・消えた種類・tanacode の対応が変わった種類を書き出します。

## 3. 前後のコードで分ける

気になる種類（増えたもの・SDK にも tanacode にも無いもの）は、前後のコードを読んで、stream-json に出るか・どんなときに出るかを決めます。

```bash
node <スキル>/scripts/kinds.mjs --cli <Claude Code の実体> --sdk <sdk.d.ts> --context <種類 1>,<種類 2>
```

種類の名前（`"name"`）と欄の名前（`name:`）のどちらでも探し、見つかったところの前後を 3 つまで出します。目印:

- **stream-json に出る**: 出力の待ち行列に入れる関数（2.1.302 では `ki(...)`。中身は `pr().enqueue(e)`）や、`.enqueue({type:…})` に渡しているもの。会話の処理の行を stream-json の行に変える関数（`case"system":switch(e.subtype){ … default:return}` を含む `function*`）で `yield` するもの。
- **会話ログ用**: `timestamp` や `isMeta` の付いた行を作る関数（会話ログに書く形。キャメルケースの欄が多い）。
- **条件付き**: 前後の `if(a.CLAUDE_CODE_…)`（環境変数）・`M.promptSuggestions` のようなオプション・`k(...)` のような機能フラグ。
- 圧縮されたコードなので、関数の名前はバージョンごとに変わります。2.1.302 での名前は、見つける手がかりにだけ使います。

もっと広く探すときは、本体に直に grep します（`-a` で、実行ファイルを文字として読む）。

```bash
grep -aoE '.{0,200}<探す文字>.{0,200}' <Claude Code の実体> | head
```

## 4. 実際に動かす

録った行を tanacode の読み取りに流すスクリプトを、esbuild でまとめます（`src/` を読むので、リポジトリの一番上で）。

```bash
npx esbuild <スキル>/scripts/feed.ts --bundle --platform=node --format=esm --alias:@shared=./src/shared --outfile=<作業>/feed.mjs --log-level=warning
```

場面ごとに録って、流します。

```bash
for s in normal cut refusal refusal-fallback model-fallback; do
  node <スキル>/scripts/record.mjs --cli <Claude Code の実体> --scenario $s --out <作業>/rec-$s
  node <作業>/feed.mjs <作業>/rec-$s/stream.jsonl <作業>/rec-$s/transcript.jsonl
done
```

- `record.mjs`: 本物の `claude -p` を、tanacode と同じ起動の引数（`src/main/stream/protocol.ts` の `STREAM_ARGS` を読む）と、tanacode が付ける環境変数で起動し、`initialize` と発言を 1 つ送ります。`stream.jsonl`（出てきた行）と `transcript.jsonl`（会話ログ）を書き、種類ごとの数と stream_event の追加の欄の数を出します。
  - `normal`: ふつうに答える
  - `cut`: 1 回目のストリーミングを、書いている途中で切る（取り直しの行。`abandoned_blocks` が付く）
  - `refusal`: 1 回目の応答を `stop_reason: "refusal"` で終える（断られたときの行。同じモデルで 1 回だけ取り直す）
  - `refusal-fallback`: はじめのモデルの応答（文とツールの呼び出し）を何度でも断る（`stop_details` の `category` は `cyber`）。同じモデルで 1 回取り直したあと、別のモデルで取り直す（`system/model_refusal_fallback` と `retracted_message_uuids`）。別のモデルでの取り直しは Anthropic の API のときだけなので、`_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1` を付けて起動します
  - `model-fallback`: はじめのモデルを混み合わせ（529）、`--fallback-model` のモデルに切り替えさせる（`system/model_fallback`）
  - `refusal-fallback`・`model-fallback` の行は、アプリが読まない大きな行を除いて、tanacode の `test/fixtures/claude-code-events/<バージョン>/` に置き、`test/chat-notices.test.ts`・`test/session-manager-partial.test.ts` で読みます。Claude Code を上げて形が変わったら、録り直して置き換えます
- `feed.mjs`: 録った行を `StreamClient` に流して、読めない行（`malformed`）と知らない種類（`unknown`）を数えます（毎日の確認と同じ数え方）。`PartialText` にも流して、ターンの終わりの直前に残っている書いている途中の文（`partialBeforeResult`）を出します。
  - 期待: どの場面も `malformed: 0`・`unknown: {}`・`partialBeforeResult: []`。2.1.302 の `cut` では、取り消された書きかけが残ります（#233）。直っていれば `[]` になります。
- 確かめたい場面が増えたら、`record.mjs` に場面（モックの API の返し方）を足します。

## 5. 一覧を直す

[docs/claude-code-events.md](../../../docs/claude-code-events.md) を直します。

- 頭の「対象」（Claude Code・SDK・tanacode のバージョン）と「調べた日」
- 増えた種類・消えた種類・tanacode の対応が変わった種類の行。SDK の列も
- 実測したことは、「実測」と書くか Issue の番号を添えます。推測は「見込み」「不明」と書きます。
- 書き方は AGENTS.md の文書の決まりに合わせます（名詞で止められるところは体言止め、動詞で終わる文は「です・ます」。「版」ではなく「バージョン」）。

## 6. 報告

ユーザーに、次のことを短く伝えます。

- 調べたバージョンと、前の一覧からの変化（増えた・消えた・対応が変わった種類）
- 4 の結果（知らない種類・残った書きかけ）
- 対応を考えたい種類と、見つけた不具合（Issue を立てるかを確かめる）
- 一覧を直したか（コミット・PR は頼まれてから）
