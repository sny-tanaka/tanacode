# Claude Code の stream-json のイベントと tanacode の対応

Claude Code がチャット（`claude -p` の stream-json）で出すイベントと、会話ログ（jsonl）に書く system の行の一覧です。それぞれ、どんなイベントか、Agent SDK の型にあるか、tanacode が対応しているかを並べました。開発者向けの文書で、仕組みと確かめ方は [CONTRIBUTING.md](../CONTRIBUTING.md) の「Claude Code との互換性の確かめ方」にあります。

- 対象: Claude Code 2.1.302・Agent SDK（`@anthropic-ai/claude-agent-sdk`）0.3.302・tanacode 2.0.1
- 調べた日: 2026-10-18
- その時点の写しです。Claude Code の更新で種類は増えます。調べ直し方は最後の節（スキル `/claude-code-events`）にあります。

## 前提

- SDK の型（`sdk.d.ts` の `SDKMessage`）は 39 種類（うち system は 28 種類）。Claude Code は、型に無い種類も出します。
- SDK は、型に無い種類も捨てずにアプリへ渡します。SDK が自分で受け取って渡さないのは、`keep_alive`・制御の要求と返事・`transcript_mirror` だけです。
- tanacode の読み取り（`src/main/stream/client.ts` の `StreamClient`）は、知らない種類を捨てて数え、コンソールに警告を出します。落ちることはありません。毎日の確認（`claude-code-check.yml`）は、台本で起こした場面で知らない種類が 0 かを確かめています。
- 「出る条件」の多くは、Claude Code の本体のコードを読んでの推測です。実際に動かして確かめたのは、取り直し（接続が途中で切れる）と、モデルが断る場面と、圧縮（`/compact`・自動の圧縮・その失敗・PreCompact フックで止めた自動の圧縮）と auto モードの判定待ち（`permission_check_status`。`test/cli/progress.test.ts`）です。

## 凡例

| 印 | 意味 |
| --- | --- |
| ✅ | 使っている |
| 🔷 | 受け取るだけ（形を確かめて、何もしない） |
| ⏭ | 意図して捨てる（`client.ts` の `IGNORED_KINDS`） |
| ⚠️ | 知らない種類（警告を出して数え、捨てる） |
| ❌ | エラーで返す（Claude Code からの要求） |

「SDK」の列は、Agent SDK の型に定義があるか。

## 1. 出力の行（system 以外）

| イベント | どんなイベントか | SDK | tanacode |
| --- | --- | --- | --- |
| `user` | 送った発言の戻り（`--replay-user-messages`）と、ツールの結果 | 有 | ✅ スマホから届いた発言でのターンの始まり。ツールの結果の控え |
| `assistant` | 応答（ブロックごと） | 有 | ✅ ツールの呼び出しの控え・モデル・コンテキストの量 |
| `result` | ターンの終わり | 有 | ✅ ターンを閉じる処理 |
| `stream_event` | 書いている途中の応答（`--include-partial-messages`） | 有 | ✅ 進み具合と、書いている途中の文。追加の欄の一部は未対応（4 節） |
| `tool_progress` | ツールの実行中の経過 | 有 | ✅ 進み具合 |
| `rate_limit_event` | 利用枠の状態 | 有 | ✅ 利用枠の表示 |
| `conversation_reset` | /clear での新しい会話 | 有 | ✅ 書いている途中の文を捨て、コンテキストの量を空に |
| `command_lifecycle` | 送った発言の受け付け（順番待ち・取り込み・終わり） | 無 | ✅ 送信中の表示 |
| `control_request`・`control_response`・`control_cancel_request` | 制御の要求・返事・取り下げ | 有 | ✅ 3 節も参照 |
| `keep_alive` | 時間ごとに出る、生きている知らせ | 無 | ⏭ SDK も自分で捨てる |
| `tool_use_summary` | ツールの呼び出しのまとめの一言 | 有 | ⚠️ 出る条件は不明。試した場面では出なかった |
| `prompt_suggestion` | 次の発言の予想 | 有 | ⚠️ `promptSuggestions` を有効にしたときだけ。tanacode では出ない見込み |
| `auth_status` | ログインの進み具合 | 有 | ⚠️ `enableAuthStatus` のときだけ。tanacode では出ない見込み |
| `active_goal` | /goal の目標の状態 | 無 | ⚠️ クラウドの開発環境の変数を受け継いだときは、起動直後に出た。tanacode と同じ環境では出なかった |
| `autocompact_state` | 自動の圧縮の設定（窓・しきい値） | 無 | ⚠️ 同上 |
| `transcript_mirror` | 会話ログの写し | 無 | SessionStore を使う SDK だけ。tanacode では出ない |

## 2. system の行（stream-json に出るもの）

### tanacode が使っているもの

| subtype | どんなイベントか | SDK | tanacode |
| --- | --- | --- | --- |
| `init` | 起動・/clear のあとの、セッションの情報 | 有 | ✅ 権限モード・モデル・バージョン。会話ログの乗り換え |
| `status` | 圧縮中・応答待ち・権限モードの変化 | 有 | ✅ 権限モード。作業中の表示の「会話を圧縮しています」（compacting から null まで）と、圧縮の失敗（`compact_result`・`compact_error`）のチャットへの表示 |
| `bridge_state` | Remote Control のつながり | 無 | ✅ つながっているかの表示 |
| `task_started` | 裏のタスクの始まり | 有 | ✅ タスクを止めるときの ID |
| `task_notification` | 裏のタスクの終わり | 有 | ✅ 止めたタスクの終わり |
| `hook_started` | フックの始まり | 有 | ✅ フックの時間 |
| `hook_response` | フックの終わり（`--include-hook-events`） | 有 | ✅ 何も出力しなかったフックの、チャットへの表示 |
| `api_retry` | API の再試行 | 有 | ✅ チャットの「再試行中」 |
| `commands_changed` | / のコマンドの一覧の途中での変化（スキルのファイルを足した・プラグインを読み直したなど） | 有 | ✅ 入力欄の / の候補と記録を差し替える。プロジェクトのスキルのファイルを足すと出る（実測。`test/cli/commands-changed.test.ts`） |
| `permission_check_status` | auto モードの判定を 4 秒より長く待っている（checking）・待ち終えた（done） | 無 | ✅ 作業中の表示の「安全を確認しています」 |

### 受け取るだけのもの

| subtype | どんなイベントか | SDK | tanacode |
| --- | --- | --- | --- |
| `compact_boundary` | 圧縮の区切り | 有 | 🔷 区切りは会話ログの行から出す |
| `informational` | お知らせの文（フックの理由・コマンドの出力など） | 有 | 🔷 チャットには会話ログの行から出す |
| `task_progress` | 裏のタスクの経過 | 有 | 🔷 |
| `task_updated` | 裏のタスクの状態の変化 | 有 | 🔷 常駐のホストの控えの規則（`RETAIN_RULES`）でだけ使う。終わったら控えを捨てる |
| `background_tasks_changed` | 裏のタスクの一覧の変化 | 有 | 🔷 |
| `thinking_tokens` | 思考のトークン数 | 有 | 🔷 |
| `hook_progress` | フックの経過 | 有 | 🔷 |
| `local_command` | /context などローカルのコマンド | 無 | 🔷 SDK の型にあるのは `local_command_output` だが、Claude Code はその名前で出していない |

### 意図して捨てるもの

| subtype | どんなイベントか | SDK | tanacode |
| --- | --- | --- | --- |
| `task_summary` | ターンの途中の「今していること」の一言（Remote Control 用） | 無 | ⏭ |
| `post_turn_summary` | ターンごとのまとめ（Remote Control 用） | 無 | ⏭ |

### tanacode が知らないもの

**対応を考えたいもの**

| subtype | どんなイベントか | SDK | tanacode |
| --- | --- | --- | --- |
| `model_fallback` | 混雑などによる、モデルの自動の切り替え | 無 | ⚠️ チャットに何も出ない（TUI では黄色で出る） |
| `notification` | 警告（圧縮の失敗・Stop フックの止めすぎ・モデルのコンテキストやエフォートの上限・メモリの停止など） | 有 | ⚠️ チャットに何も出ない |
| `model_refusal_fallback` | 断られた応答の取り消しと、別のモデルでの取り直し（`retracted_message_uuids`） | 有 | ⚠️ 取り消された応答を外していない（5 節） |
| `model_refusal_no_fallback` | 断られたが、取り直さなかった | 有 | ⚠️ |
| `model_consent_fallback` | 人が選んだ、モデルの切り替え | 無 | ⚠️ |
| `permission_denied` | auto モードの判定や規則による、確認なしの拒否 | 有 | ⚠️ 理由はツールの結果には残る |

**関係の薄いもの（条件付き、または tanacode では出ない見込み）**

| subtype | どんなイベントか | SDK | 出る条件 |
| --- | --- | --- | --- |
| `memory_recall` | 思い出したメモリ | 有 | メモリの機能を使うとき |
| `session_state_changed` | セッションの状態（idle・running・requires_action） | 有 | `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` などを付けたときだけ |
| `control_request_progress` | アプリが送った side_question の進み具合 | 有 | side_question を送ったときだけ（tanacode は送らない） |
| `elicitation_complete` | MCP サーバーの URL での質問の完了 | 有 | MCP サーバーが URL で質問したとき |
| `plugin_install` | プラグインのインストールの進み具合 | 有 | `CLAUDE_CODE_SYNC_PLUGIN_INSTALL` のときだけ |
| `mirror_error` | 会話ログの写しの失敗 | 有 | SessionStore を使う SDK だけ |
| `worker_shutting_down` | 理由つきの、Remote Control の接続の終わり | 有 | Remote Control で、閉じる理由があるとき |
| `files_persisted` | ファイルの保存（クラウド） | 有 | 不明 |
| `turn_preempted` | すぐ続けて送った発言による、ターンの打ち切り | 無 | 機能が有効なとき（条件は不明） |
| `per_turn_effort_changed` | ターンごとのエフォートの変化 | 無 | 不明 |
| `session_title_changed` | セッションの名前の変化 | 無 | 名前が変わったとき |
| `session_metadata` | セッションの付帯情報（成果物など） | 無 | 不明 |
| `vcs_state_changed` | push・merge などの git の変化 | 無 | git のコマンドを動かしたとき |
| `code_change_published` | PR の作成などの公開 | 無 | PR などを作ったとき |
| `file_attachments_missing` | Remote Control で届くはずの添付ファイルが無い | 無 | スマホから添付したとき |
| `peer_message_hold` | ほかのセッションからの知らせの保留 | 無 | セッションのあいだの知らせ |
| `instruction_size_warning` | CLAUDE.md などが大きすぎるという警告 | 無 | 機能フラグ付き |
| `feedback_draft_queued` | フィードバックの下書き | 無 | フィードバックの機能 |
| `dev_intent` | 開発の種類（iOS アプリなど）の検出 | 無 | 不明 |
| `tool_host_result` | ツールのホストの結果 | 無 | 不明 |
| `turn_handoff_available` | ターンの引き継ぎ | 無 | 不明（クラウド向けか） |
| `cloud_session_delta` | クラウドのセッションの変化 | 無 | クラウドのセッション |
| `ui_invalidate`・`ui_panes`・`ui_scroll`・`ui_focus` | プラグインの画面の部品の更新 | 無 | 画面をつないだクライアントがいるときだけ |
| `ui_toast`・`ui_status`・`ui_log` | プラグインの通知・状態・ログ | 無 | stream-json のとき |

## 3. Claude Code からアプリへの要求（control_request）

| subtype | どんなイベントか | tanacode |
| --- | --- | --- |
| `can_use_tool` | 許可の確認・AskUserQuestion・ExitPlanMode など | ✅ 画面で聞いて答える |
| `elicitation` | MCP サーバーから人への質問 | ❌ 取り消しになる（ターミナルモードなら答えられる） |
| `hook_callback` | アプリが登録したフックの呼び出し | ❌ tanacode は登録しないので来ない |
| `mcp_message` | アプリの中の MCP サーバーへの中継 | ❌ 同上 |
| `request_user_dialog` | アプリが宣言した種類のダイアログ | ❌ tanacode は宣言しないので来ない |
| `oauth_token_refresh`・`host_auth_token_refresh` | 認証の更新 | ❌ アプリが認証を渡す形のときだけ |
| `remote_control_work_secret` | Remote Control の鍵 | ❌ アプリが鍵を渡す形のときだけ |
| `register_device_hooks`・`upload_device_hook_template` | デバイスのフック | ❌ 条件は不明 |

## 4. stream_event に付く追加の欄

| 欄 | どんな情報か | tanacode |
| --- | --- | --- |
| `abandoned_blocks` | 取り直しのために捨てた、応答のブロックの位置（`{ api_message_id, from_block_index }`。`message_stop` に付く） | ⚠️ 未対応で不具合。取り消された書きかけが、ターンの終わりまで画面に残る（実測。#233） |
| `api_message_id` | 応答の ID | 未使用（`event.message.id` を使う） |
| `ttft_ms` | 最初の文字までの時間 | 未使用 |
| `thinking_display` | 思考の出し方 | 未使用 |
| `text_runs_joined` | 文のかたまりをつないだ印 | 未使用 |
| `user_message_uuid`・`user_message_uuids` | どの発言への応答か | 未使用 |

## 5. 会話ログ（jsonl）にだけ書く system の行

stream-json には出ません。Claude Code は、会話の処理が作った system の行のうち、決まった 12 種類（`status`・`init`・`notification`・`api_retry`・`compact_boundary`・`model_fallback` など）だけを stream-json に出します。tanacode はチャットを会話ログから作る（`src/shared/chat.ts` の `toChatEvents`）ので、こちらでの対応がチャットの表示になります。

| subtype | どんなイベントか | tanacode のチャット |
| --- | --- | --- |
| `turn_duration` | ターンの長さ | ✅ ターンの終わり |
| `stop_hook_summary` | Stop フックのまとめ | ✅ フックの表示 |
| `api_error` | API のエラー | ✅ エラーの表示 |
| `bridge_status` | Remote Control の URL | ✅ |
| `local_command` | ローカルのコマンド | ✅ |
| `informational` | お知らせの文 | ✅ |
| `compact_boundary` | 圧縮の区切り | ✅ |
| `model_fallback` | モデルの自動の切り替え | ⚠️ 出さない |
| `model_refusal_fallback` | 断られた応答の取り消し（`retractedMessageUuids`） | ⚠️ 取り消された応答を外していない。Claude Code は、会話ログを読むときに外す（未確認。断ったときに取り直すモデルの設定でだけ起きる） |
| `model_refusal_no_fallback`・`model_consent_fallback` | 断られた・人が選んだ切り替え | ⚠️ 出さない |
| `away_summary`・`agents_killed`・`memory_saved`・`permission_retry`・`scheduled_task_fire`・`rewind_stand_in`・`cloud_session_status`・`file_snapshot` | 離れていた間のまとめ・裏のエージェントの停止・メモリの保存・許可のやり直し・予約の実行・巻き戻しの代わりの行・クラウドの状態・ファイルの控え | 出さない |

## 調べ直し方

スキル `/claude-code-events`（`.claude/skills/claude-code-events/SKILL.md`）の手順で調べ直します。引数は調べる Claude Code のバージョンです。

- `scripts/kinds.mjs`: Claude Code の本体・SDK の型・tanacode の読み取りから種類を集めて、突き合わせる
- `scripts/record.mjs`: 本物の `claude -p` をモックの API につないで、行と会話ログを録る（ふつうに答える・書いている途中で切る・断る）
- `scripts/feed.ts`: 録った行を tanacode の読み取り（`StreamClient`・`PartialText`）にそのまま流す
