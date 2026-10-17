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

2026-09-30 に直したときに決めた、守るべき決まり（2026-10-17 に、チャットを stream-json でやりとりする作りに合わせて書き直し）。点検のたびに、次のチェックリストを実際のソースと照らし合わせます。ファイルや名前が変わっていたら、今の場所を探して確かめます。

### チェックリスト

**チャットの Markdown**（`src/renderer/src/chat/Markdown.tsx`）

- 生の HTML（ブロック・インライン）は描かず、エスケープして文字で表示（`renderer.html` と `escapeHtml`）。
- DOMPurify は明示の許可リスト（`SANITIZE` の `ALLOWED_TAGS`・`ALLOWED_ATTR`、`ALLOW_DATA_ATTR: false`・`ALLOW_ARIA_ATTR: false`）。style・class・button・input などを足していないか。書き出し（`markdownHtml`）も同じ `SANITIZE` を通るか。
- タスクリストのチェックボックスは文字（☑・☐）。入力部品は作りません。
- ▶ 実行ボタンは、サニタイズのあとに作成。対象はシェルの言語（`SHELL_LANG`）のコードだけ。実行するコマンドは画面の文字ではなく、marked のトークン（`renderer.code` の `token.text`）から `stripControlChars` を通して控えたもの。`pre` の数とコマンドの数が合わないときは、ボタンを付けません。
- 外部の画像（`http(s):`・`//`）は読み込まず、リンクに置き換え（`src/renderer/src/markdown.ts` の `replaceExternalImages`。`srcset` も削除）。文書に入れる前（DocumentFragment の中）で呼んでいるか。

**制御文字**（`src/shared/paste.ts` の `stripControlChars`。画面側は `src/renderer/src/chat/sanitize.ts` の再エクスポートか、`@shared/paste` から読み込む）

- C0（`\n`・`\t` 以外）・DEL・C1・双方向の制御文字（U+061C・U+200E・U+200F・U+202A〜U+202E・U+2066〜U+2069）の除去と、CR（`\r\n`・`\r`）を `\n` にそろえる処理。ソースの正規表現は `\u` の書き方で（生の双方向の文字をソースに入れない）。
- Claude Code・pty・シェルに渡す文字列は、必ずここを通します。今の通り道は次のとおり。
  - チャットの発言（main の `SessionManager.submit`）: 本文と札（`pasted_content`）を通してから、stream-json の user の行にして送ります。呼び出し元は、画面の `submitToClaude`（IPC `sessions:submit`）と `submitWhenReady`（親セッションからの指示・親への知らせ・予約・最適化圧縮）。添付は文字で送らず、中身の頭で PNG・JPEG・GIF・WebP と分かったものだけを画像のブロックにします（`imageBlock`・`imageMediaType`）。
  - 待っている要求への返事: `answer_question` の自由記述と、`answer_permission` の断る理由。
  - ターミナルモードの TUI に貼るもの: 画面の `writePaste`（`pasteIntoClaudeScreen`）と main の `pasteIntoTerminal`。どちらも `bracketedPaste(stripControlChars(…))` にしてから書き、Enter は送りません（人が押します）。
  - 入力欄に差し込むもの（`chat/insertInput.ts`・`ChatInput` の貼り付け・`preview/picker.ts`）、▶ 実行のコマンド（`chat/Markdown.tsx`・`terminal/TerminalPanel.tsx`。新しいシェルのタブにだけ書く）、人のターミナルに打つツール（`readTypeInput`。改行は断る）。
  - 新しく書く所が増えていないか（`grep -rn "pty.write\|shell.write" src/renderer`、`grep -rn "\.write(\|client\.send\|client\.respond\|sendLine\|pasteIntoTerminal\|pasteIntoClaudeScreen" src/main src/renderer`）。
- stream-json の行は、`JSON.stringify` した 1 行だけを送ります（`src/main/stream/client.ts`）。値の中の改行や ESC で、行が割れたりキーとして読まれたりしません。画面からの生のキー入力（IPC `PtyWrite`）は pty にだけ届き、チャットの標準入力（パイプ）には書けません（pty ホストの `write` は pty だけ、`send` はパイプだけ）。
- ブラケットペースト（`\x1b[200~ … \x1b[201~`）は、ターミナルモードの TUI に貼るときだけ、いつも使います（`bracketedPaste`）。中の文は先に `stripControlChars` を通し、`\x1b[201~` で囲みから抜けられないようにします。チャットでは使いません（長い貼り付けは `pasted_content` で渡す）。
- `codeBlock`・`inlineCode` のフェンスは、中身の最も長いバッククォートの連続より長く。

**ターミナルモード**（`src/main/session-manager.ts`・`session-notices.ts`・`sessions-control.ts`、`src/renderer/src/terminal/ClaudeScreen.tsx`）

- ターミナルモード（人が Claude Code の画面で操作している）の間と、切り替えの途中は、Claude 由来の文を TUI に打たないか。チャットの送信（`submit`・`submitWhenReady`）・親の `send_message`・`answer_question`・`answer_permission`・`stop_session`・`configure_session`・`end_session` は、預からずに断ります。予約の送信は失敗として残し、親への知らせは捨てます。
- TUI に貼るのは、人がボタンで頼んだもの（コメント・ウォークスルーの質問・選んだ要素・チェックリストの「Claude に通知する」など）だけか。TUI が許可の確認・質問のメニューを出している間（`tuiAsk`。書くだけの PermissionRequest のフックで知る）は貼らずに預かり、閉じたら順に貼ります。預かっている間にターミナルモードでなくなったら、捨てます。

**権限とウィンドウ**（`src/main/index.ts`・`src/main/browser-windows.ts`）

- 権限の要求・確認は既定で拒否（`restrictPermissions`）。アプリの画面（主ウインドウと、足したプロファイルの画面。`isAppContents`）のメインフレームだけに `APP_PERMISSIONS`（`clipboard-read`・`clipboard-sanitized-write`）。
- プレビューのパーティション（`PREVIEW_PARTITION` = `persist:tanacode-preview`。足したプロファイルは `previewPartition(id)`）には、どの権限も与えず、ダウンロードも止めます（`browser-windows.ts` の `restrictPreviewSession`。ポップアップの見分けに使うので、プレビューのセッションはここで控えます）。
- webview の取り付け（`will-attach-webview`）: preload を消し、`nodeIntegration: false`・`contextIsolation: true`・`sandbox: true`。開くのは http(s) と `about:blank` だけ。
- プレビューのページの移動（`web-contents-created` → `PreviewWindows.watch` の `will-navigate`・`will-frame-navigate`・`will-redirect` → `isPreviewDestination`）: webview のゲストと、プレビューのセッションの `window`（ページが開いたポップアップ）の両方に付けるか。トップのフレームは http(s) と `about:blank` だけ。中のフレーム（iframe）だけ、`about:srcdoc`・`blob:`・`data:` も許可。Claude がアプリ内ブラウザを操作している間のトップのフレームは、許した先へしか移れません（`blocksNavigation`。ポップアップは、開いたタブで許した先かを見る）。
- 新しいウィンドウ: アプリの画面の `setWindowOpenHandler` はいつも deny（開こうとした http(s) は、既定のブラウザで表示）。アプリの画面自身の移動（`will-navigate`）は止めます。webview のゲストとポップアップの `setWindowOpenHandler`（`PreviewWindows.open`）は、http(s) でないものを開かないか（例外は、ポップアップの空のページ `about:blank` だけ。開いてから `location` を移す OAuth のため。そこからの移動は見張りが確かめる）。
  - `disposition` が `new-window` でないもの（リンクの「新しいタブで開く」など）と、features の無い `new-window`（Shift+クリックなど）は deny して、アプリ内ブラウザの新しいタブ（`openFromPage`）で開き、開けなかったときは、Claude が操作していなければ既定のブラウザで表示。
  - ポップアップ（`new-window` で features があるもの）だけ `allow` して、アプリ内ブラウザの外の別ウインドウで開きます（`window.opener` をつなぐため。OAuth のログインの窓）。中身の守りの値は `overrideBrowserWindowOptions` の `webPreferences`（`POPUP_PREFERENCES`。`nodeIntegration: false`・`nodeIntegrationInWorker: false`・`nodeIntegrationInSubFrames: false`・`contextIsolation: true`・`sandbox: true`・`webviewTag: false`・`disableDialogs: true`。ダイアログは、出していない別ウインドウでもほかのアプリの前に出うる）で決め、ウインドウは `createWindow` でアプリが作るか（`create`）。作るときに渡すのは、許すもの（`windowOptions`: 画面に詰めた位置と大きさ・地の色・守りの値）と、Electron が作った中身だけで、`createWindow` に渡ってくる options（ページの features を混ぜたもの。`closable`・`focusable`・`opacity`・`type`・`visibleOnAllWorkspaces`・`frame` など）を使っていないか（止めるものを並べる形にしない）。ページの `beforeunload` で閉じるのを止めさせないか（`will-prevent-unload` を `preventDefault`）。作るときは出さず（`show: false`）、フォーカスを移さずに出しているか（`showInactive`。ページの操作だけで、アプリが前に出て入力を奪わない）。tanacode にフォーカスが無いとき（ほかのアプリを使っているとき）は、フォーカスが来る（`browser-window-focus`）まで出さないか（ほかのアプリの前に出さない）。位置と大きさは、tanacode のウインドウがある画面の `workArea` の中に詰めているか（`popupBounds`。開いたあとの `window.moveTo`・`resizeTo` も `content-bounds-updated` で詰める）。preload を足していないか。partition を指定していないか（開いたページと同じセッションのまま。作ったあとに違うセッションなら閉じる `adopt`）。
  - ポップアップの `setWindowOpenHandler` と見張りは、`web-contents-created` で付けるか（ウインドウを作ったあとで付けると、ポップアップがさらに開くウインドウを Electron がそのまま作る隙ができる）。ポップアップから開くものも、もとのタブのものとして同じ扱い（Claude の操作で許していない先は開かない `allowsPopup`・1 つのタブから 5 個まで `MAX_POPUPS`）。
  - 別ウインドウは Claude の操作の対象にしない（タブに入れない）。アドレス欄が無いので、題に今のページのオリジンを添えるか（`showOrigin`。空のページは `about:blank` と中身を書けるオリジン（`mainFrame.origin`）を添え、ページが書いた題だけにしない。作った直後からアプリ名の題にしない。開く先の URL ではなく、読み込みが確定した URL で決めているか（204 などで確定しない間の中身は、開いたページが書ける空の文書）。オリジンを題の先に置き、ページの題は制御文字・書式の文字を除いて長さを切っているか（`pageTitle`。オリジンを題の帯から押し出させない）。長いホスト名は、左側を省略して右端（登録したドメイン）を残しているか（`shortHost`））。開いたタブが無くなったら閉じるか。

**CSP**（`src/renderer/index.html`）

- `img-src 'self' data: blob:`（外部の画像を読まない）、`frame-src 'none'`、`script-src 'self'`。ゆるめる変更が無いか。

**設定ファイル**（`src/main/statusline.ts`・`settings-files.ts`・`claude-config.ts`）

- `--settings` に写す statusLine は、ユーザーの設定（`claudeConfigDir` の `settings.json`）か、登録した設定ファイルのものだけ（`userStatusLineCommand`）。プロジェクトの `.claude/settings*.json` から読んでいないか。チャット（`-p`）では statusLine は動かず、ターミナルモードの TUI だけで動きます。
- プロジェクトの設定から読むのは、最初の権限モード（`permissions.defaultMode`。`settingsDefaultMode`）だけ。そこに bypassPermissions があっても使わないか（`startMode`）。

**ほかのセッションを扱う MCP**（`src/main/sessions-control.ts`・`sessions-bridge.ts`・`session-manager.ts`・`requests.ts`・`pending-questions.ts`、`src/shared/session-tools.ts`。2026-10-03 に決めたこと。許可の確認への回答と子の片付けは 2026-10-12。答え方は 2026-10-17 に stream-json の要求に合わせて書き直し）

- 質問と許可の確認は、Claude Code が stream-json の制御の要求 `can_use_tool` で送ったものだけを、待っている要求として持ちます（AskUserQuestion は `PendingQuestions`、ほかは `pendingPermission`）。答えは `control_response` で、待っている `request_id` に 1 回だけ（`StreamClient.respond`）。人が先に答えた・取り下げられた（`control_cancel_request`）要求には答えません。形の読めない AskUserQuestion は deny し、許可の確認としても出しません。
- 質問への回答（`answer_question`）
  - 親が渡した質問の文が、今の質問（まだ答えていない最初の 1 問。`normalizeText` で比べる）と同じときだけ答えるか。
  - 選べるのは、その質問の選択肢の名前（単一選択は 1 つ）と、`stripControlChars` を通した自由記述だけか。複数の質問は 1 問ずつためて、そろったら 1 つの返事にします（`answerPendingQuestion`）。
  - 許可の確認が出ているときは、`answer_permission` を使うよう断るか。
- 許可の確認には、親も答えられる（`answer_permission`。2026-10-12 に決めたこと。それまでは「親は答えない」）。次の守りが外れていないか。
  - 親が返せるのは、今回だけ許す（`updatedPermissions` なし）・理由を添えて断る（deny）・断って止める（interrupt）の 3 つだけか。「今後は聞かない」（`permission_suggestions` を足す `always`）や、権限モードを変える答え（`accept-edits` の setMode）を親の道から作る引数を、足していないか。許すときに理由を付けたら、断るか。
  - 親が読んだ確認にだけ答えるか。`permission_id` は `can_use_tool` の `request_id`。今いちばん前の確認（`pendingPermission`）の ID と違えば、何も答えません。同じコマンドの 2 回目の確認は、別の ID。
  - 親に見せる入力は `can_use_tool` の `input` の全文で、許すときもそのまま `updatedInput` に返すか（読んだものと動くものをずらさない）。JSON が 3 万文字（`MAX_PERMISSION_INPUT_CHARS`）を超えるものと、人だけが答えられるもの（`humanOnlyReason`: プランの承認・`requires_user_interaction`・安全の確かめ・`permissions.ask` の規則・`default_to_no`。ほかに、アプリ内ブラウザの `BrowserControl.humanOnly`: 許す先の外を開く `navigate` と、今のタブのページが許す先でもそのタブで人が許したオリジンでもない（タブが無い・空のときも）`evaluate`。親が読むときと答えるときの、そのときのページで決める。`evaluate` は、確認のフックが答えたときのページのオリジン（同じ式の控え `EvaluateMark`）と、動くときのページのオリジン（実行するコードの先頭で比べる）の両方が合うときだけ動く。コンソールの記録は、許した先のフレームの文だけを Claude に返すか（`visibleLog`。別オリジンの iframe・移る途中の前のページ・フレームの分からない文は、数だけ。オリジンが "null" のときに URL のオリジンで決めるのは、トップのフレームだけか）。失敗した通信（`get_failed_requests`・ページの様子の「失敗した通信 N 件」）も、同じ決まりで、許した先のページ・フレームの通信だけを返すか（`requestSource`: 文書の読み込みは読み込もうとした先のオリジン、ほかの通信は出したオリジン `initiatorOrigin` と出したフレーム。出したオリジンが無い・不透明なものも返さない。除いたものは数だけ）。今のタブのページが許していない先なら、ほかの読むツールと同じく断るか（`current`）。スクリーンショット・`get_text`・`get_accessibility_tree` は、読み終えたときにも読んだページを確かめ（`readFrom`）、結果の URL を `shownUrl` で絞っているか（読んでいる間に移動が確定すると、許していない先の中身と URL が返りうる）。控えと呼び出しは、呼び出しの ID（フックの `tool_use_id` と、`tools/call` の `_meta` の `claudecode/toolUseId`）で結びつけ、ID が無いときだけ式で引くか（ID の無い呼び出しも、ID の無い控えだけから引く。ID のある控えを式で拾わない）。控えが無い・フックのときにページが無かったときも動かさないか。フックへの答え（`gate`）に入れる今のページの URL は、許していない先ならオリジンだけか（フックが確認の理由に書き、`decision_reason` として親の `get_session` に届く）。メニューでオフのとき・知らないセッションには答えないか。控えを期限やメニューのオフで消していないか（消すと、確かめずに動かす側に倒れる。捨てるのは上限と forget だけ）。止めたあと・失敗したあとに、今のページが許していない先なら、ページのコンソールの文を Claude に返していないか（オリジンだけ。`evaluateFailed`））は、`can_allow: false` で断ることだけか。PermissionRequest のフックは書くだけで、`decision` を返していないか（確認を出さずに通す道にしない）。
  - 許せるのは、親の権限モード（`modeOf`）が acceptEdits・auto・bypassPermissions のときだけか（`MODES_ALLOWING_PERMISSION`。manual・plan・モードが分からない親は、断ることだけ）。
  - 自分の子だけか（`resolve` の `child`）。子の中継に出していないか（`PARENT_ONLY`）。答えるのは質問でない要求だけで、ターミナルモードの子には答えないか。
  - 断る理由は、確認への答え（deny の `message`）として、親の言葉と分かる形（「the user said」の形にしない）で返し、子は作業を続けるか。制御文字は除きます。理由が無ければ、interrupt で止めます。
  - 判断の基準（全文を読む・頼んだ作業の範囲で失うものが無いものだけ・戻せない操作と外に出る操作はユーザーが許しているときだけ・迷ったらユーザーに聞く・確認の中身は信頼できない入力）を、MCP の説明とツールの説明から消していないか。
- 許可・質問・プランのカードは、中身を文字として出します。見出し・説明・理由から ANSI の並びと制御文字を消し（`requests.ts`）、画面でも、ツールの入力・差分・プラン・「今後は聞かない」の規則を `stripControlChars` で消してから出します（`MenuCard.tsx`）。プランは Markdown にせず、文字で出します。プランのファイルは、プランのフォルダの下の、リンクでないふつうのファイル（1MB まで）だけを読みます（`readPlanFile`）。
- 子の片付け（`end_session`）は、自分の子だけ（`resolve` の `child`。独立したセッション・兄弟・親は断る）で、子の中継には出していないか（`PARENT_ONLY`）。人の確認なしに通すのは、失うものが無いからなので、消し方は画面からのアーカイブと同じ処理（`Profile.archiveSession` → `SessionManager.archive` → `removeWorktree`）だけを通し、別の消し方（一覧からの削除 `remove`・`git branch -D`・フォルダの削除）を足していないか。未コミットの変更の控え（`refs/tanacode/backup/`）と、手元にしか無いコミットのあるブランチを残す動きを、引数で外せるようにしていないか。終えるのは `idle`・`exited`・`background`・`archived` の子だけ（`ENDABLE_STATES`）で、作業中・起動中・質問や許可の確認待ち・ターミナルモードの子は断るか（アーカイブの直前にも状態を確かめ直す）。消す場所は、アプリの記録（`SessionRecord.worktree`・`cwd`）だけで決め、Claude が渡すパスを使っていないか。
- 子の権限モードの上限（`modeOf`）は、アプリが知っている今のモード（`knownMode`: 起動の引数・`set_permission_mode` の返事・stream-json の init と status・会話ログの本体の発言の行の `permissionMode`。サブエージェントの行は読まない。ターミナルモードの間は、書くだけのフックの `permission_mode` も）。分からないとき・知らない名前は manual。画面の文字からは読みません。子の起動のモードは `launchMode` に残し、`open`・`restart`・ターミナルモードの切り替え（`relaunchMode`）でもそれより強くせず、bypassPermissions も引き継がないか。
- 子への指示・親への知らせ・予約は、stream-json の発言（`priority: 'later'`）として送ります（`submit`・`submitWhenReady`）。作業中なら、Claude Code が今のターンのあとに回します。確認への答えは `control_response` だけなので、送った文が確認の選択になる道はありません。質問・確認を待っている子への `send_message` は断り、`answer_question`・`answer_permission` を案内するか。
- 子セッションの起動（`start_session`）は、`--settings` の `PreToolUse` のフック（`sessionsGateCommand`。目印は `SESSIONS_GATE_HOOK_ENV`、対象のツールは `SESSIONS_GATED_TOOL`）が毎回 `ask` を返し、auto・bypassPermissions でも人の確認が出るか（チャットにもターミナルモードにも付く）。子の中継には、子を動かすツールを出していないか（`SESSIONS_MCP_FOR_CHILD`）。アプリも子からの `start_session` を断るか。独立したセッション（`independent: true`）も、同じ確認・同じフォルダと権限モードの確かめを通るか。起動したあとに、呼び出し元から指示・回答・中断ができないか（`parentId` を付けない）。
- 子の claude には、親の Claude Code がそのセッションのために付ける環境変数（`CLAUDECODE`・`CLAUDE_CODE_SESSION_ID` など。`claude-session.ts` の `PARENT_SESSION_ENV`）を渡さないか。
- 見える範囲（`canSee`）は、同じフォルダ（worktree は元のフォルダ）と親子・兄弟だけ。中のフォルダを含めていないか（`~/work` で開いたセッションに、その下の別々のリポジトリを見せない）。一覧や見出しに、見えない子の ID・名前を出していないか。指示・中断・回答（質問・許可の確認）・片付けは自分の子だけ（`resolve` の `child`）。
- `start_session` のフォルダは `realpath` してから、親のリポジトリの中か、そのプロファイルのセッションのフォルダ（`host.list()`。別のプロファイルのものは含めない）だけ（`folderFor`）。別のリポジトリのフォルダを選べても、見える範囲（`canSee`）は広げていないか。`list_sessions` の `start_folders` は、フォルダのパスだけか（見えないセッションの ID・名前を出していないか）。`get_session_diff` の `path` は `safeRelative`（`:` で始まるもの、つまり git の pathspec の書き方は断る）、path を渡す git には `GIT_LITERAL_PATHSPECS=1` を付けるか。未追跡のファイルは、`../` で始まるもの・リンクを解いた場所がセッションのフォルダの外になるものは読まず、`lstat` でふつうのファイルだけ・読む大きさと数に上限（`git.ts` の `branchFiles` の行数の数え方も同じ）。
- 会話ログの目印（`<tanacode-parent-message>`・`<tanacode-session-event>`、予約・チェックリストの知らせ）は、本文や名前の `<tanacode-`・`</tanacode-` を `neutralizeTags` で打ち消しているか（閉じタグで囲みの外に出た文が、子の Claude に人の発言として読まれないように）。

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
  - 組み立てたコードを、HTML（`<script>`）に埋めたり、`world()` のほかで評価したりしていないか。例外は `evaluate` の先頭の比べる文だけ（ページの世界の `executeJavaScript`。埋めるのは、確かめたページのオリジン（`webOrigin`）と目印の文字列を `JSON.stringify` したもので、Claude の式はそのあとに手を入れずに続ける）。
- `js/command-line-injection`（`src/main/pty-host.ts` の `spawnPipe` の `child_process.spawn`。2026-10-17 に却下）: pty ホストが、ソケットで受け取った起動の頼み（`req.file`・`req.args`）で Claude Code を起動するところ。CodeQL は、ソケットから来た値を利用者が与えた値として扱います。ソケットは自分だけがつなげるもの（待ち受けたらすぐ `chmod 0600`。置き場所は userData か、パスが長いときは `$TMPDIR` で、どちらも 0700 のフォルダの下）。つなげるのは同じユーザーのプロセスだけで、それはもともと何でも実行できます。TUI を起動する `pty.spawn(req.file, req.args)` も、develop から同じ形（CodeQL は node-pty を起動の口として扱わないので、警告が出ない）。同じ形を足すと、その PR でまた出ます。次のことを確かめてから却下します。
  - 起動の値の出どころが、0600 のソケット（`server.listen` の直後の `chmodSync(socketPath, 0o600)`）か、main の中だけか。ソケットの置き場所が `socketPathIn`（userData か `$TMPDIR`）のままか。
  - 起動の引数は、アプリが組み立てたもの（`claude-session.ts` など）か。会話ログ・ツールの出力・ページの中身など外から来た値を、`file` や引数にそのまま入れていないか。
  - シェルを通していないか（`shell: true` や、`sh -c` に渡す文字列を組み立てていないか）。引数は配列のまま渡しているか。

### 3. シークレットスキャンの警告

1. 警告の出たキー・トークンが本物か（テスト用の作り物でないか）を、ユーザーに確かめます。
2. 本物なら、**先に発行元で無効にします**（ユーザーの操作）。公開のリポジトリに入った時点で漏れたものとして扱い、コミットを消すだけでは済ませません。
3. 無効にしたあと、ソースから取り除く直しを PR で入れます。履歴の書き換えは、ユーザーが求めたときだけ。
4. 警告を閉じるのは確認のあと。`resolution` は `revoked`・`false_positive`・`used_in_tests`・`wont_fix` のどれか。

   ```bash
   gh api -X PATCH repos/sny-tanaka/tanacode/secret-scanning/alerts/<number> \
     -f state=resolved -f resolution=revoked
   ```
