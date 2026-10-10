---
name: security
description: tanacode のセキュリティの対応の手順。Dependabot の警告・脆弱性の非公開の報告（Private vulnerability reporting）・コードスキャンとシークレットスキャンの警告への対応や、セキュリティの観点でのコードの点検をするときに使います。
---

# セキュリティの対応

対象のリポジトリは `sny-tanaka/tanacode`（公開・既定のブランチは develop）。場面は 4 つ。

- A. Dependabot の警告
- B. 脆弱性の非公開の報告（Private vulnerability reporting）
- C. コードの点検（セキュリティの観点）
- D. コードスキャン・シークレットスキャンの警告

## 共通の決まり

- develop に直接プッシュしません。作業用のブランチ（例: `fix/security-<パッケージ名>`）→ develop 向けの PR（`gh pr create --base develop`）。マージはオーナー。
- 次の操作の前は、必ず AskUserQuestion でユーザーに確かめます。推奨の選択肢を先頭に置き、ラベルの末尾に「(推奨)」。
  - コミット・プッシュ・PR の作成
  - GitHub への書き込み（アラートの却下、アドバイザリの受け入れ・作成・公開、一時的な非公開フォークの作成、報告者への返信）
- 直すか見送るかは、ユーザーが決めます。見送るときは、見送る理由と、あとで直すときの直し方をユーザーに伝えます。
- ユーザーへの報告・質問は日本語。
- まだ公開されていない脆弱性（B と、C で見つけた重いもの）の中身は、直した版を出すまで Issue・公開のブランチ・PR・コミットメッセージに書きません。

## A. Dependabot の警告

### 1. 一覧の取得

```bash
gh api repos/sny-tanaka/tanacode/dependabot/alerts --paginate --jq '.[] | select(.state=="open") | {number, severity: .security_advisory.severity, package: .dependency.package.name, scope: .dependency.scope, relationship: .dependency.relationship, range: .security_vulnerability.vulnerable_version_range, patched: .security_vulnerability.first_patched_version.identifier, summary: .security_advisory.summary, ghsa: .security_advisory.ghsa_id}'
```

詳しい説明は `gh api repos/sny-tanaka/tanacode/dependabot/alerts/<number> --jq '.security_advisory.description'`。

### 2. どこから入っているかの調査

```bash
npm ls <パッケージ>             # 依存の木。親のパッケージと版
npm ls <パッケージ> --omit=dev  # dependencies の側から入っているか
```

### 3. 配るアプリに入るかの判断

Dependabot の scope は、package.json の dependencies / devDependencies のどちらから入っているかだけで決まります。**scope が `development` でも、アプリに入ることがあります。** 判断の前に `electron.vite.config.ts` と `package.json`（dependencies・devDependencies・`build.files`）を読み、次の前提が変わっていないかを確かめます。

- main・preload: electron-vite 5 の `build.externalizeDeps`（既定で有効）が、`dependencies` に書いたものだけを外に出します（まとめずに、実行時に node_modules から読み込み）。devDependencies は、import されていれば out/ にまとめられます。
- renderer: 外に出すものは無し。import したものは dependencies・devDependencies の区別なく out/renderer にまとめられます。mermaid・marked・dompurify・monaco-editor・react などは devDependencies ですが、画面に入ります。
- electron-builder: `build.files` は `out/**` と package.json。これとは別に、`dependencies` とその依存を node_modules ごとアプリに入れます。
- electron: devDependencies ですが、アプリの実行環境そのもの。electron の警告は、アプリに入るものとして扱います。
- アプリに入らないもの: Storybook・vite・electron-builder・typescript など、ビルドや開発のときだけ使う道具（影響は開発者のマシンだけ）。

確かめ方:

```bash
npm ls <パッケージ> --omit=dev                                  # (empty) でなければ dependencies の側から
npm run build
grep -n "^<パッケージ>@" out/renderer/THIRD_PARTY_NOTICES.txt   # renderer にまとめた依存の一覧（rollup-plugin-license の書き出し）
grep -rn "from '<親のパッケージ>" src/main src/preload src/shared  # main・preload からの import の有無
```

### 4. 悪用される可能性の見積もり

- 問題の関数・機能を、親のパッケージやアプリが実際に呼ぶか（`grep -rn "<関数名>" node_modules/<親のパッケージ>/`、`src/`、ビルドした `out/`）。
- 呼ぶなら、外から来た値が渡るか。外から来る値は SECURITY.md の「対象の例」（会話ログ・ツールの出力、エディタの Markdown のプレビュー、アプリ内プレビューのページ、表示した中身から起きるコマンドの実行）。
- 結果は「アプリに入るか」「呼ばれるか」「外の値が届くか」「重大度」の 4 つにまとめてユーザーに伝えます。

### 5. 直し方（上から順に試します）

1. 普通の更新: `npm update <パッケージ>` → `npm ls <パッケージ>` で、すべて直った版になったか。
2. 親のパッケージを上げる: `npm view <親> version`、`npm view <親>@<版> dependencies` で、直った版を使う親の版があるか。あれば package.json の親の版を上げて `npm install`。メジャーの更新は、変更点を読んでから。
3. 親が版を固定しているとき: package.json の `overrides`。

   ```json
   "overrides": { "<パッケージ>": "<直った版>" }
   ```

   `npm install` のあと、`npm ls <パッケージ>` で `overridden` と直った版になっているか。親が決めた範囲の外の版にするので、親の動作の確認が要ります。

直った版は、Dependabot の `first_patched_version` をうのみにしません。`npm view <パッケージ>@<版> deprecated` で、取り下げ（Bad release など）が無いかを確かめます。

### 6. 直すか見送るかの確認

3〜5 の結果を見せて AskUserQuestion で聞きます。選択肢の例: 直す / 見送り、アラートは開いたまま / 見送り、アラートを却下。見送るときは、理由と直し方（5 のどの方法で、どの版にするか）を伝えます。

却下（ユーザーが選んだときだけ・書き込みの前に確認）:

```bash
gh api -X PATCH repos/sny-tanaka/tanacode/dependabot/alerts/<number> \
  -f state=dismissed -f dismissed_reason=tolerable_risk -f dismissed_comment='<理由>'
```

`dismissed_reason` は `fix_started`・`inaccurate`・`no_bandwidth`・`not_used`・`tolerable_risk` のどれか。

### 7. 直したあとの確認

1. 作業用のブランチで直します。
2. `npm run typecheck`
3. `npm run build`
4. 影響する画面を Storybook（`npm run storybook`、http://localhost:6006）で確かめます（例: mermaid なら図を描く部品）。影響する部品の story が無いときは、確かめ方（story を足す・開発版のアプリで見る）をユーザーに AskUserQuestion で相談します。
5. コミット・プッシュ・PR の作成は、ユーザーに確かめてから。PR の説明には、警告の番号・直し方・確かめたこと。
6. アラートは、PR が develop にマージされたあとに自動で閉じます。

### 実例（2026-09-30）

- 警告: lodash-es 4.17.23 の 2 件（高: `_.template` のコード注入、中: `_.unset`・`_.omit` のプロトタイプ汚染）。scope は development。
- 入り方: mermaid → chevrotain（lodash-es を `4.17.23` に固定）と dagre-d3-es。mermaid はエディタの Markdown のプレビュー（`src/renderer/src/editor/MarkdownPreview.tsx`）から読み込むので、renderer にまとめられてアプリに入ります。
- 直し方: 固定のため普通の更新では上がらず、直すなら `overrides` で 4.18.1 以上（4.18.0 は取り下げ）。

## B. 脆弱性の非公開の報告（Private vulnerability reporting）

### 0. SECURITY.md の確認

書いてある約束に合わせます。今の約束は次のとおり（変わっていないか毎回確認）。

- 直すのは最新の版だけ。
- 最初の返事は 1 週間以内が目安。直す時期の約束は無し。
- 対象の例・対象外の例（Claude Code そのもの・ユーザー自身が実行したコマンド・Apple の署名が無いこと）。

### 1. 届いた報告の確認

```bash
gh api repos/sny-tanaka/tanacode/security-advisories --jq '.[] | select(.state=="triage") | {ghsa_id, summary, severity, created_at, html_url}'
gh api repos/sny-tanaka/tanacode/security-advisories/<ghsa_id> --jq '{summary, description, severity, vulnerabilities, credits}'
```

### 2. 流れ

1. 再現の確認: 報告の手順を、最新の版の手元のソースで試します。開発版で確かめるときは、ふだんのデータを使わない別の userData で。再現の結果と、SECURITY.md の対象に入るかをまとめます。
2. 受け入れるか・重大度を、ユーザーと AskUserQuestion で決めます。
   - 受け入れ: GitHub の画面で報告を受け入れ、下書き（draft）のアドバイザリにします。重大度（CVSS）・影響する版・直る版もここで。
   - 対象外・再現しない: 理由を添えて閉じます（返信・閉じるのは確認のあと）。Claude Code そのものの問題なら、Anthropic の窓口を案内。
3. 報告者への最初の返事: アドバイザリのコメント欄で。文面をユーザーに見せ、確認してから送ります。
4. 直しは公開のブランチに先に出しません。アドバイザリの一時的な非公開フォークで作業します。
   - 作り方: GitHub の画面の「Start a temporary private fork」、または `gh api -X POST repos/sny-tanaka/tanacode/security-advisories/<ghsa_id>/forks`（作成の前に確認）。
   - 非公開フォークに作業用のブランチを push し、GitHub の画面でアドバイザリの中から PR を作ります。
   - 手元では `npm run typecheck`・`npm run build`・Storybook で確かめます。コミットメッセージにも悪用の仕方は書きません。
5. マージ: GitHub の画面で、アドバイザリの PR をマージします（オーナーが実施）。マージした時点で直しは公開されるので、マージから次のリリースまでの間を空けません。
6. 直した版をリリース: `release` スキルの手順で。
7. アドバイザリを公開: 公開の前に、影響する版・直る版・重大度・説明を見直し、credits に報告者が入っているかを確かめます（入っていなければ足す）。CVE が要るかもユーザーに聞きます（GitHub の画面で申請できます）。公開は確認のあと、GitHub の画面で。
8. 報告者へのお礼と、直した版の案内（送る前に確認）。

GitHub の画面の細かい操作は変わることがあります。迷ったら GitHub の公式のドキュメント（Privately reporting a security vulnerability / Collaborating in a temporary private fork）を読んでから進めます。

## C. コードの点検（セキュリティの観点）

2026-09-30 に直したときに決めた、守るべき決まり。点検のたびに、次のチェックリストを実際のソースと照らし合わせます。ファイルや名前が変わっていたら、今の場所を探して確かめます。

### チェックリスト

**チャットの Markdown**（`src/renderer/src/chat/Markdown.tsx`）

- 生の HTML（ブロック・インライン）は描かず、エスケープして文字で表示（`renderer.html` と `escapeHtml`）。
- DOMPurify は明示の許可リスト（`SANITIZE` の `ALLOWED_TAGS`・`ALLOWED_ATTR`、`ALLOW_DATA_ATTR: false`・`ALLOW_ARIA_ATTR: false`）。style・class・button・input などを足していないか。
- タスクリストのチェックボックスは文字（☑・☐）。入力部品は作りません。
- ▶ 実行ボタンは、サニタイズのあとに作成。実行するコマンドは画面の文字ではなく、marked のトークン（`renderer.code` の `token.text`）から `stripControlChars` を通して控えたもの。`pre` の数とコマンドの数が合わないときは、ボタンを付けません。
- 外部の画像（`http(s):`・`//`）は読み込まず、リンクに置き換え（`src/renderer/src/markdown.ts` の `replaceExternalImages`。`srcset` も削除）。文書に入れる前（DocumentFragment の中）で呼んでいるか。

**制御文字**（`src/shared/prompt-keys.ts` の `stripControlChars`。画面側は `src/renderer/src/chat/sanitize.ts` から読み込む）

- C0（`\n`・`\t` 以外）・DEL・C1・双方向の制御文字（U+061C・U+200E・U+200F・U+202A〜U+202E・U+2066〜U+2069）の除去と、CR（`\r\n`・`\r`）を `\n` にそろえる処理。
- Claude（pty）へ送る文字列・シェルに書くコマンドは、必ずここを通します。今の呼び出し元: main の `SessionManager.submit`（チャットの入力欄からの本文と添付のパス・親セッションからの指示・親への知らせ。画面の `submitToClaude` は IPC `sessions:submit` で頼むだけ）、`sessions-control.ts` の `answer_question` の自由記述、画面の `chat/insertInput.ts`、`chat/Markdown.tsx`（▶ 実行のコマンド）、`terminal/TerminalPanel.tsx`、`preview/picker.ts`。新しく pty・シェルに書く所が増えていないか（`grep -rn "pty.write\|shell.write" src/renderer`、`grep -rn "process.write\|\.write(id" src/main`）。
- ブラケットペースト（`\x1b[200~ … \x1b[201~`）は、本文が改行を含むときだけ（`promptKeys`）。
- `codeBlock`・`inlineCode` のフェンスは、中身の最も長いバッククォートの連続より長く。

**権限とウィンドウ**（`src/main/index.ts`）

- 権限の要求・確認は既定で拒否（`restrictPermissions`）。メインのウィンドウのメインフレームだけに `APP_PERMISSIONS`（`clipboard-read`・`clipboard-sanitized-write`）。
- プレビューのパーティション（`PREVIEW_PARTITION` = `persist:tanacode-preview`）には、どの権限も与えません。
- webview の取り付け（`will-attach-webview`）: preload を消し、`nodeIntegration: false`・`contextIsolation: true`・`sandbox: true`。開くのは http(s) と `about:blank` だけ。
- webview のゲストの移動（`web-contents-created` の `will-navigate`・`will-frame-navigate`・`will-redirect` → `isPreviewDestination`）: トップのフレームは http(s) と `about:blank` だけ。中のフレーム（iframe）だけ、`about:srcdoc`・`blob:`・`data:` も許可。
- 新しいウィンドウ（メインのウィンドウ・webview のゲストとも `setWindowOpenHandler`）は開かず、http(s) だけ既定のブラウザで表示。メインのウィンドウ自身の移動（`will-navigate`）は止めます。

**CSP**（`src/renderer/index.html`）

- `img-src 'self' data: blob:`（外部の画像を読まない）、`frame-src 'none'`、`script-src 'self'`。ゆるめる変更が無いか。

**statusLine**（`src/main/statusline.ts`）

- `--settings` に写す statusLine は、ユーザーの `~/.claude/settings.json` のものだけ（`userStatusLineCommand`）。プロジェクトの `.claude/settings*.json` を読んでいないか。

**ほかのセッションを扱う MCP**（`src/main/sessions-control.ts`・`sessions-bridge.ts`・`session-manager.ts`、`src/shared/session-tools.ts`。2026-10-03 に決めたこと）

- 許可の確認には、親は答えない。`answer_question` は、画面のメニューが AskUserQuestion で出した質問（`ScreenTracker.askedQuestions`。フックが書いた質問）に合うときだけ（`isAskedQuestion`）。メニューを質問と見分けるのは ☐・☒ の行なので、コマンドの文字に ☐ があると許可の確認が質問に見えるためです。キーは `chooseIf`（`ScreenTracker.choose` の `expect`）で、送る前に毎回同じ質問か確かめているか。`stateOf` も、AskUserQuestion が無い質問のメニューは `permission` にしているか。
- 子の権限モードの上限（`modeOf`）は、アプリが決めたモード（`knownMode`）と画面のモードの弱いほう。画面のモードの行は会話の中の文でも読めるので、画面の文字だけで上げていないか。子の起動のモードは `launchMode` に残し、`open`・`restart` でもそれより強くしないか。
- 子への指示・親への知らせは、相手の手が空いてから打つ（`submitWhenReady` の `acceptsTyping`：ターンの外・操作待ちでない・入力欄が空・画面の操作の途中でない）。打つ直前と Enter の直前にも確かめ直す（`submit` の `guarded`）。作業中に打つと、そのあいだに出た許可の確認で、Enter や数字が選択になるためです。
- 子セッションの起動（`start_session`）は、`--settings` の `PreToolUse` のフック（`SESSIONS_GATE_COMMAND`）が毎回 `ask` を返し、auto・bypassPermissions でも人の確認が出るか。子の中継には、子を動かすツールを出していないか（`SESSIONS_MCP_FOR_CHILD`）。アプリも子からの `start_session` を断るか。独立したセッション（`independent: true`）も、同じ確認・同じフォルダと権限モードの確かめを通るか。起動したあとに、呼び出し元から指示・回答・中断ができないか（`parentId` を付けない）。
- 見える範囲（`canSee`）は、同じフォルダ（worktree は元のフォルダ）と親子・兄弟だけ。中のフォルダを含めていないか（`~/work` で開いたセッションに、その下の別々のリポジトリを見せない）。一覧や見出しに、見えない子の ID・名前を出していないか。指示・中断・回答は自分の子だけ（`resolve` の `child`）。
- `start_session` のフォルダは `realpath` してから、親のリポジトリの中か、そのプロファイルのセッションのフォルダ（`host.list()`。別のプロファイルのものは含めない）だけ。別のリポジトリのフォルダを選べても、見える範囲（`canSee`）は広げていないか。`list_sessions` の `start_folders` は、フォルダのパスだけか（見えないセッションの ID・名前を出していないか）。`get_session_diff` の `path` は `safeRelative`、未追跡のファイルは `lstat` でふつうのファイルだけ・読む大きさと数に上限（`git.ts` の `branchFiles` の行数の数え方も同じ）。
- 会話ログの目印（`<tanacode-parent-message>`・`<tanacode-session-event>`）は、本文や名前の `<tanacode-`・`</tanacode-` を `neutralizeTags` で打ち消しているか（閉じタグで囲みの外に出た文が、子の Claude に人の発言として読まれないように）。

### まだ直していない項目

見送った・まだ決めていない項目は、公開のリポジトリ（スキル・Issue・PR）に書きません。オーナーの手元のメモ（`MAINTAINING.md` があればその「セキュリティ」の節）で管理します。点検のときは、そのメモがあれば読んで、状況が変わっていないかも確かめます。

### 点検の進め方

1. 点検の範囲をユーザーと決めます（全体か、ブランチの差分か: `git diff develop...HEAD`）。
2. 上のチェックリストを、ソースを読んで 1 つずつ確かめます。外から来る値（SECURITY.md の「対象の例」）が、HTML・pty・シェル・ファイル・git・外部への通信に届く道を追います。
3. 見つけたものは、1 件ずつ次の形でまとめてユーザーに見せます。
   - 重大度（高・中・低）と、その理由
   - 再現の筋書き（誰が・何を仕込むと・何が起きるか）
   - 直し方の案（直す場所と、変えたあとに守られること）
4. どれを直すかを AskUserQuestion で聞きます（複数選べる形で）。見送るものは、理由と直し方をユーザーに伝えます。
5. 直すときは、共通の決まりの流れで（ブランチ → typecheck・build・Storybook → 確認のうえでコミット・PR）。まだ知られていない重いものは、公開の PR に出す前に、B の非公開のアドバイザリの流れにするかをユーザーに聞きます。
6. 直して決めたことは、このチェックリストに足します（足す前にユーザーに確認）。

## D. コードスキャン・シークレットスキャンの警告

どちらも GitHub の設定でオンにしています（2026-10-10 から。ワークフローのファイルは無し）。

- コードスキャン: CodeQL の default setup。TypeScript とワークフローを、PR・develop への push・週 1 回で解析します。Swift（`native/translate/main.swift`）は、CodeQL の自動ビルドが通る形でないので対象外。
- シークレットスキャン: リポジトリに入ったキーやトークンの警告。プッシュ保護はオフ。

### 1. 一覧の取得

```bash
gh api repos/sny-tanaka/tanacode/code-scanning/alerts --paginate --jq '.[] | select(.state=="open") | {number, severity: (.rule.security_severity_level // .rule.severity), rule: .rule.id, path: .most_recent_instance.location.path, line: .most_recent_instance.location.start_line, message: .most_recent_instance.message.text}'
gh api repos/sny-tanaka/tanacode/secret-scanning/alerts --jq '.[] | select(.state=="open") | {number, type: .secret_type_display_name, created_at, html_url}'
```

今の設定は `gh api repos/sny-tanaka/tanacode/code-scanning/default-setup` と `gh api repos/sny-tanaka/tanacode --jq .security_and_analysis`。

### 2. コードスキャンの警告

1. 指摘された場所を読み、外から来る値（SECURITY.md の「対象の例」）がそこへ届くか、届いたら何が起きるかを確かめます。ルールの説明は `gh api repos/sny-tanaka/tanacode/code-scanning/alerts/<number> --jq .rule.help`。
2. 結果を「本物か・誤検知か」「その理由」「重大度」にまとめてユーザーに見せ、直すか却下するかを AskUserQuestion で聞きます。
3. 本物なら、C の「点検の進め方」の 5 と同じ流れで直します。警告は、直しが develop に入ったあとの解析で自動で閉じます。
4. 却下（ユーザーが選んだときだけ・書き込みの前に確認）:

   ```bash
   gh api -X PATCH repos/sny-tanaka/tanacode/code-scanning/alerts/<number> \
     -f state=dismissed -f "dismissed_reason=false positive" -f dismissed_comment='<理由>'
   ```

   `dismissed_reason` は `false positive`・`won't fix`・`used in tests` のどれか。`dismissed_comment` は 280 文字まで。

### 誤検知と決めたもの

- `js/bad-code-sanitization`（`src/main/browser-control.ts`。2026-10-10 に 8 件を却下）: セレクタなどを `JSON.stringify` して、アプリ内ブラウザで動かすコードに埋めているところ。コードは `world()`（`executeJavaScriptInIsolatedWorld`）で V8 に直接渡し、HTML には埋めません。`JSON.stringify` の結果は正しい JavaScript の文字列なので、値が文字列の外に出ません。同じ書き方を足すと、その PR でまた出ます。次の 2 つを確かめてから却下します。
  - 埋める文字列・配列は `JSON.stringify` を通しているか。数をそのまま埋めるところは、有限の数だと確かめたもの（`numberOr`）だけか。
  - 組み立てたコードを、HTML（`<script>`）に埋めたり、`world()` のほかで評価したりしていないか。

### 3. シークレットスキャンの警告

1. 警告の出たキー・トークンが本物か（テスト用の作り物でないか）を、ユーザーに確かめます。
2. 本物なら、**先に発行元で無効にします**（ユーザーの操作）。公開のリポジトリに入った時点で漏れたものとして扱い、コミットを消すだけでは済ませません。
3. 無効にしたあと、ソースから取り除く直しを PR で入れます。履歴の書き換えは、ユーザーが求めたときだけ。
4. 警告を閉じるのは確認のあと。`resolution` は `revoked`・`false_positive`・`used_in_tests`・`wont_fix` のどれか。

   ```bash
   gh api -X PATCH repos/sny-tanaka/tanacode/secret-scanning/alerts/<number> \
     -f state=resolved -f resolution=revoked
   ```
