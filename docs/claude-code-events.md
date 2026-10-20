# Claude Code の stream-json のイベントと tanacode の対応

Claude Code がチャット（`claude -p` の stream-json）で出すイベントと、会話ログ（jsonl）に書く system の行の一覧です。それぞれ、どんなイベントか、Agent SDK の型にあるか、tanacode が対応しているかを並べました。開発者向けの文書で、仕組みと確かめ方は [CONTRIBUTING.md](../CONTRIBUTING.md) の「Claude Code との互換性の確かめ方」にあります。

- 対象: Claude Code 2.1.302・Agent SDK（`@anthropic-ai/claude-agent-sdk`）0.3.302・tanacode 2.0.1 のあとの develop（tanacode の列は、種類を「使う・意図して捨てる・知らない」に分け、知らない種類をチャットに「未知のイベント」として出すようにしたあとのもの）
- 調べた日: 2026-10-18（tanacode の列と、出る条件の一部は 2026-10-19 に直した）
- その時点の写しです。Claude Code の更新で種類は増えます。調べ直し方は最後の節（スキル `/claude-code-events`）にあります。

## 前提

- SDK の型（`sdk.d.ts` の `SDKMessage`）は 39 種類（うち system は 28 種類）。Claude Code は、型に無い種類も出します。
- SDK は、型に無い種類も捨てずにアプリへ渡します。SDK が自分で受け取って渡さないのは、`keep_alive`・制御の要求と返事・`transcript_mirror` だけです。
- tanacode は、どの種類も「使う」「意図して捨てる（理由つき）」「知らない」のどれか 1 つに分けます。stream-json は `src/main/stream/client.ts`（使う: `messageOf`・`SYSTEM_CHECKS`、意図して捨てる: `IGNORED_KINDS`、断る要求: `DECLINED_REQUESTS`）、会話ログは `src/shared/transcript-line.ts`（行の種類を、会話の行・ほかで使う付帯の行・意図して捨てる行・知らない行に分ける。意図して捨てる: `IGNORED_*`）と、`src/shared/chat.ts`（使う: `toChatEvents` の分岐）。どこにも書いていない種類が「知らない」種類です。
- 知らない種類は、数えてコンソールに警告を出し、チャットに「未知のイベント」として出します（仕組みは CONTRIBUTING.md の「チャット」）。落ちることはありません。毎日の確認（`claude-code-check.yml`）は、台本で起こした場面で知らない種類が 0 かを確かめています。
- 「出る条件」の多くは、Claude Code の本体のコードを読んでの推測です。実際に動かして確かめたのは、取り直し（接続が途中で切れる）・モデルが断る場面（同じモデルでの取り直しと、別のモデルでの取り直し）・混雑による予備のモデルへの切り替え（あとの 2 つの行は `test/fixtures/claude-code-events/2.1.302/` に置いた）・圧縮（`/compact`・自動の圧縮・その失敗・PreCompact フックで止めた自動の圧縮）・auto モードの判定待ち（`permission_check_status`。`test/cli/progress.test.ts`）です。

## 凡例

| 印 | 意味 |
| --- | --- |
| ✅ | 使う |
| ⏭ | 意図して捨てる（理由つき。数えず、未知のイベントにもしない）。要求は、理由を付けた一覧で断る（error で返す） |
| ⚠️ | 知らない（数えて警告を出し、チャットに「未知のイベント」として出す）。要求は error で返す |

「SDK」の列は、Agent SDK の型に定義があるか。

## 1. 出力の行（system 以外）

| イベント | どんなイベントか | SDK | tanacode |
| --- | --- | --- | --- |
| `user` | 送った発言の戻り（`--replay-user-messages`）と、ツールの結果 | 有 | ✅ スマホから届いた発言でのターンの始まり。ツールの結果の控え |
| `assistant` | 応答（ブロックごと） | 有 | ✅ ツールの呼び出しの控え・ExitPlanMode のプランの控え・モデル・コンテキストの量 |
| `result` | ターンの終わり | 有 | ✅ ターンを閉じる処理。`api_error` が `usage_limit_reached` なら、利用枠で止まったことの補い（`subtype` は `success` のまま・時刻は無い。2.1.302 で実測） |
| `stream_event` | 書いている途中の応答（`--include-partial-messages`） | 有 | ✅ 進み具合と、書いている途中の文（4 節） |
| `tool_progress` | ツールの実行中の経過 | 有 | ✅ 進み具合 |
| `rate_limit_event` | 利用枠の状態 | 有 | ✅ 利用枠の表示。`status` が `rejected` なら、枠が戻る時刻（`resetsAt`）を、利用枠で止まったときの補いに控える |
| `conversation_reset` | /clear での新しい会話 | 有 | ✅ 書いている途中の文を捨て、コンテキストの量を空に |
| `command_lifecycle` | 送った発言の受け付け（順番待ち・取り込み・終わり） | 無 | ✅ 送信中の表示 |
| `control_request`・`control_response`・`control_cancel_request` | 制御の要求・返事・取り下げ | 有 | ✅ 3 節も参照 |
| `keep_alive` | 時間ごとに出る、生きている知らせ | 無 | ⏭ 時間で出る知らせ（SDK も自分で捨てる） |
| `tool_use_summary` | ツールの呼び出しのまとめの一言 | 有 | ⏭ 使い道がない（ツールの行はチャットで畳んで出している）。出る条件は不明で、試した場面では出なかった |
| `prompt_suggestion` | 次の発言の予想 | 有 | ⏭ tanacode の起動のしかたでは出ない（`promptSuggestions` を有効にしたときだけ） |
| `auth_status` | ログインの進み具合 | 有 | ⏭ tanacode の起動のしかたでは出ない（`enableAuthStatus` のときだけ） |
| `transcript_mirror` | 会話ログの写し | 無 | ⏭ tanacode の起動のしかたでは出ない（SessionStore を使う SDK だけ） |
| `active_goal` | /goal の目標の状態 | 無 | ⏭ クラウドの開発環境向け（その環境の変数を受け継いだときは、起動直後に出た。tanacode と同じ環境では出なかった） |
| `autocompact_state` | 自動の圧縮の設定（窓・しきい値） | 無 | ⏭ 同上 |

## 2. system の行（stream-json に出るもの）

### 使うもの

| subtype | どんなイベントか | SDK | tanacode |
| --- | --- | --- | --- |
| `init` | 起動・/clear のあとの、セッションの情報 | 有 | ✅ 権限モード・モデル・バージョン。会話ログの乗り換え |
| `status` | 圧縮中（`compacting`）・圧縮の成否（`compact_result`・`compact_error`）・応答待ち・権限モードの変化 | 有 | ✅ 権限モード。作業中の表示の「会話を圧縮しています」（compacting から null まで）と、圧縮の失敗（`compact_result`・`compact_error`）のチャットへの表示 |
| `bridge_state` | Remote Control のつながり | 無 | ✅ つながっているかの表示 |
| `task_started` | 裏のタスクの始まり | 有 | ✅ タスクを止めるときの ID |
| `task_notification` | 裏のタスクの終わり | 有 | ✅ 止めたタスクの終わり |
| `hook_started` | フックの始まり | 有 | ✅ フックの時間 |
| `hook_response` | フックの終わり（`--include-hook-events`） | 有 | ✅ 何も出力しなかったフックの、チャットへの表示 |
| `api_retry` | API の再試行 | 有 | ✅ チャットの「再試行中」 |
| `notification` | 警告（起動時のエフォートやコンテキストの上限・メモリの停止・plan を抜けたら auto が使えなかった・組織の方針で使えないモデルなど） | 有 | ✅ チャットのお知らせ（文はそのまま。ほかの道で出すもの・tanacode 自身が起こしたもの・一時的なものは出さない。`stream/notification.ts`） |
| `commands_changed` | / のコマンドの一覧の途中での変化（スキルのファイルを足した・プラグインを読み直したなど） | 有 | ✅ 入力欄の / の候補と記録を差し替える。プロジェクトのスキルのファイルを足すと出る（実測。`test/cli/commands-changed.test.ts`） |
| `model_refusal_fallback` | 断られた応答の取り消しと、別のモデルでの取り直し（`retracted_message_uuids`） | 有 | ✅ 取り消された応答を、書いている途中の文から外す。お知らせは会話ログの行から（5 節） |
| `permission_check_status` | auto モードの判定を 4 秒より長く待っている（checking）・待ち終えた（done） | 無 | ✅ 作業中の表示の「安全を確認しています」 |
| `elicitation_complete` | MCP サーバーの URL での質問の完了（MCP の `notifications/elicitation/complete` を中継。`mcp_server_name`・`elicitation_id`） | 有 | ✅ ページを開いたあとの、完了を待っているカードを閉じる（実測。`test/cli/elicitation.test.ts`） |

### 意図して捨てるもの

| subtype | どんなイベントか | SDK | tanacode（捨てる理由） |
| --- | --- | --- | --- |
| `task_summary` | ターンの途中の「今していること」の一言（Remote Control 用） | 無 | ⏭ Remote Control 向けの内部用 |
| `post_turn_summary` | ターンごとのまとめ（Remote Control 用） | 無 | ⏭ 同上 |
| `compact_boundary` | 圧縮の区切り | 有 | ⏭ ほかの道で足りている（区切りは会話ログの行から出す） |
| `informational` | お知らせの文（フックの理由・コマンドの出力など） | 有 | ⏭ ほかの道で足りている（会話ログの行から出す） |
| `local_command` | /context などローカルのコマンド | 無 | ⏭ ほかの道で足りている（会話ログの行から出す）。SDK の型にあるのは `local_command_output` だが、Claude Code はその名前で出していない |
| `task_progress` | 裏のタスクの経過 | 有 | ⏭ ほかの道で足りている（裏のタスクは会話ログとタスクの出力のファイルから数える） |
| `task_updated` | 裏のタスクの状態の変化 | 有 | ⏭ 同上。常駐のホストの控えの規則（`RETAIN_RULES`）でだけ使う（終わったら控えを捨てる） |
| `background_tasks_changed` | 裏のタスクの一覧の変化 | 有 | ⏭ 同上 |
| `thinking_tokens` | 思考のトークン数 | 有 | ⏭ ほかの道で足りている（進み具合は `stream_event` から作る） |
| `hook_progress` | フックの経過 | 有 | ⏭ ほかの道で足りている（フックは `hook_started`・`hook_response` と会話ログから） |
| `permission_denied` | auto モードの判定や規則による、確認なしの拒否 | 有 | ⏭ ほかの道で足りている（理由はツールの結果に出る） |
| `session_title_changed` | セッションの名前の変化 | 無 | ⏭ ほかの道で足りている（会話ログの `custom-title`） |
| `code_change_published` | PR の作成などの公開 | 無 | ⏭ ほかの道で足りている（会話ログの `pr-link`） |
| `worker_shutting_down` | 理由つきの、Remote Control の接続の終わり | 有 | ⏭ ほかの道で足りている（`bridge_state`） |
| `model_refusal_no_fallback` | 断られたが、取り直さなかった | 有 | ⏭ 中身（`content`）が空。断られた応答そのものは会話ログに出る |
| `model_fallback` | 混雑などによる、予備のモデルへの切り替え | 無 | ⏭ ほかの道で足りている（お知らせは会話ログの同じ行から出す。5 節。同じ `uuid`。実測）。設定の `fallbackModel` か `--fallback-model` があるときだけ出る（tanacode は付けない） |
| `memory_recall` | 思い出したメモリ | 有 | ⏭ ほかの道で足りている（お知らせは会話ログの attachment の `relevant_memories` から出す。5 節） |
| `session_state_changed` | セッションの状態（idle・running・requires_action） | 有 | ⏭ tanacode の起動のしかたでは出ない（`CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` などを付けたときだけ） |
| `plugin_install` | プラグインのインストールの進み具合 | 有 | ⏭ tanacode の起動のしかたでは出ない（`CLAUDE_CODE_SYNC_PLUGIN_INSTALL` のときだけ） |
| `mirror_error` | 会話ログの写しの失敗 | 有 | ⏭ tanacode の起動のしかたでは出ない（SessionStore を使う SDK だけ） |
| `control_request_progress` | アプリが送った side_question の進み具合 | 有 | ⏭ tanacode の起動のしかたでは出ない（side_question を送らない） |
| `model_consent_fallback` | 人が選んだ、モデルの切り替え | 無 | ⏭ tanacode の起動のしかたでは出ない（モデルを選ばせない） |
| `cloud_session_delta` | クラウドのセッションの変化 | 無 | ⏭ クラウド向け |
| `vcs_state_changed` | push・merge などの git の変化 | 無 | ⏭ クラウド・Remote Control 向け |
| `file_attachments_missing` | Remote Control で届くはずの添付ファイルが無い | 無 | ⏭ Remote Control 向け |
| `peer_message_hold` | ほかのセッションからの知らせの保留 | 無 | ⏭ 別の機能（Claude Code のセッションのあいだの知らせ）向け |
| `feedback_draft_queued` | フィードバックの下書き | 無 | ⏭ 別の機能（フィードバック）向け |
| `instruction_size_warning` | CLAUDE.md などが大きすぎるという警告 | 無 | ⏭ 別の機能向け（機能フラグ付き） |
| `ui_invalidate`・`ui_panes`・`ui_scroll`・`ui_focus` | プラグインの画面の部品の更新 | 無 | ⏭ 別の機能（画面をつないだクライアント）向け |
| `per_turn_effort_changed` | ターンごとのエフォートの変化 | 無 | ⏭ 使い道がない |

### tanacode が知らないもの

中身か使い方が分からないもの。起きたら、チャットに未知のイベントとして出ます。

| subtype | どんなイベントか | SDK | 出る条件 |
| --- | --- | --- | --- |
| `files_persisted` | ファイルの保存（クラウド） | 有 | 不明 |
| `session_metadata` | セッションの付帯情報（成果物など） | 無 | 不明 |
| `dev_intent` | 開発の種類（iOS アプリなど）の検出 | 無 | 不明 |
| `tool_host_result` | ツールのホストの結果 | 無 | 不明 |
| `turn_handoff_available` | ターンの引き継ぎ | 無 | 不明（クラウド向けか） |
| `turn_preempted` | すぐ続けて送った発言による、ターンの打ち切り | 無 | 機能フラグ `tengu_zippy_spindle`（既定は off）が有効で、応答が出る前に `priority: "next"` の発言が届いたとき（本体のコードからの推測） |
| `ui_toast`・`ui_status`・`ui_log` | プラグインの通知・状態・ログ | 無 | stream-json のとき |

## 3. Claude Code からアプリへの要求（control_request）

| subtype | どんなイベントか | tanacode |
| --- | --- | --- |
| `can_use_tool` | 許可の確認・AskUserQuestion・ExitPlanMode など | ✅ 画面で聞いて答える |
| `elicitation` | MCP サーバーから人への質問（フォームの形と URL の形） | ✅ チャットのカードで聞いて答える（`action` と `content`。error で返すと Claude Code は取り消しにする）。答える前に作業を止めると、`control_cancel_request` で取り下げられる（実測。`test/cli/elicitation.test.ts`） |
| `hook_callback` | アプリが登録したフックの呼び出し | ⏭ 断る。tanacode は登録しないので来ない |
| `mcp_message` | アプリの中の MCP サーバーへの中継 | ⏭ 断る。同上 |
| `request_user_dialog` | アプリが宣言した種類のダイアログ | ⏭ 断る。tanacode は宣言しないので来ない |
| `oauth_token_refresh`・`host_auth_token_refresh` | 認証の更新 | ⏭ 断る。アプリが認証を渡す形のときだけ来る（tanacode は渡さない） |
| `remote_control_work_secret` | Remote Control の鍵 | ⏭ 断る。アプリが鍵を渡す形のときだけ来る（tanacode は渡さない） |
| `register_device_hooks`・`upload_device_hook_template` | デバイスのフック | ⚠️ 知らない（error で返す）。条件は不明 |

## 4. stream_event に付く追加の欄

| 欄 | どんな情報か | tanacode |
| --- | --- | --- |
| `abandoned_blocks` | 取り直しのために捨てた、応答のブロックの位置（`{ api_message_id, from_block_index }`。`message_stop` に付く） | ✅ 捨てたブロックを、書いている途中の文から外す（`stream/partial.ts`。#238） |
| `api_message_id` | 応答の ID | 未使用（`event.message.id` を使う） |
| `ttft_ms` | 最初の文字までの時間 | 未使用 |
| `thinking_display` | 思考の出し方 | 未使用 |
| `text_runs_joined` | 文のかたまりをつないだ印 | 未使用 |
| `user_message_uuid`・`user_message_uuids` | どの発言への応答か | 未使用 |

## 5. 会話ログ（jsonl）にだけ書く system の行

stream-json には出ません。Claude Code は、会話の処理が作った system の行のうち、決まった 12 種類（`status`・`init`・`notification`・`api_retry`・`compact_boundary`・`model_fallback` など）だけを stream-json に出します。tanacode はチャットを会話ログから作る（`src/shared/chat.ts` の `toChatEvents`）ので、こちらでの対応がチャットの表示になります。意図して捨てるものは `src/shared/transcript-line.ts` の `IGNORED_SYSTEM` に並べ、どこにも無い subtype は未知のイベントとして出します。system 以外の行（付帯情報の行・attachment・応答と発言のブロック）の分け方も `transcript-line.ts` にあります（`SIDE_TYPES`・`IGNORED_TYPES`・`IGNORED_ATTACHMENTS`・`IGNORED_ASSISTANT_BLOCKS`）。

| subtype | どんなイベントか | tanacode のチャット |
| --- | --- | --- |
| `turn_duration` | ターンの長さ | ✅ ターンの終わり |
| `stop_hook_summary` | Stop フックのまとめ | ✅ フックの表示 |
| `api_error` | API のエラー | ✅ エラーの表示 |
| `bridge_status` | Remote Control の URL | ✅ |
| `local_command` | ローカルのコマンド | ✅ |
| `informational` | お知らせの文 | ✅ |
| `compact_boundary` | 圧縮の区切り | ✅ |
| `model_fallback` | 予備のモデルへの切り替え | ✅ お知らせ「X から Y に切り替えました」（開くと Claude Code の説明）。stream-json にも同じ `uuid` で出る（実測） |
| `model_refusal_fallback` | 断られた応答の取り消し（`retractedMessageUuids`） | ✅ お知らせ「X が応答を断ったので、Y で取り直しました」。取り消された行はチャットから外す（`chat-log.ts` の `retract`。Claude Code も、会話を再開するときに外す）。2.1.302 は、取り消した応答を会話ログに書かない（ツールを実行したものも。実測）。別のモデルでの取り直しは Anthropic の API のときだけで、1 回目の拒否は同じモデルで取り直す。断りの種類ごとの既定の取り直し先の表が本体にあり、設定しなくても起きうる（本体のコードからの推測） |
| `memory_saved` | メモリの保存（`writtenPaths`） | ✅ お知らせ「メモリを N 件保存しました」（開くとファイルの名前） |
| `away_summary`・`permission_retry`・`scheduled_task_fire`・`rewind_stand_in`・`cloud_session_status`・`file_snapshot` | 離れていた間のまとめ・許可のやり直し・予約の実行・巻き戻しの代わりの行・クラウドの状態・ファイルの控え | ⏭ クラウド・Remote Control・別の機能向け |
| `model_refusal_no_fallback` | 断られたが、取り直さなかった | ⏭ 中身が空（断られた応答そのものは、応答の行に出る） |
| `model_consent_fallback` | 人が選んだ、モデルの切り替え | ⏭ tanacode の起動のしかたでは出ない（モデルを選ばせない） |
| `agents_killed` | 裏のエージェントの停止 | ⏭ 使い道がない（止めたことは、裏のタスクの終わりで分かる） |

会話ログの attachment の `relevant_memories`（思い出したメモリ。`memories[].path`）も、お知らせ「メモリを N 件思い出しました」（開くとファイルの名前）にします。`memory_saved` と `relevant_memories` の形が違う（ファイルの一覧が無い・パスでないものが混じる）ときは、未知のイベント（形の崩れ）にします。

会話ログの応答の行のうち、合成の API エラー（`isApiErrorMessage`）で `apiError` が `usage_limit_reached` のものは、プランの利用枠に当たって止まった印として読みます（枠が戻る時刻は `apiErrorParams.rate_limit_info.resetsAt`（秒）、当たった枠は `rateLimitType`。`quotaLimits` にも同じ中身。`src/shared/usage-limit.ts`）。Claude Code は、OAuth のトークンで動いているときだけ、API の 429 と枠のヘッダー（`anthropic-ratelimit-unified-status: rejected` など）をこの形にします（API キーでは、ただの 429 のエラー。2.1.302 で実測）。

会話ログの `api-request`・`api-request-blob`・`api-request-shape`（2.1.301 から）は、API に送った要求の控えです。`api-request-blob` には、前の応答と発言が、API に送った形で `toolUseResult` なしにもう一度入ります（会話ログの行と API に送る 1 通が合わないものだけ。並べて呼んだツールで、前の呼び出しの結果が次の呼び出しより先に書かれたとき・ToolSearch の結果に「Tool loaded.」を足したときなど。2.1.302 で実測）。意図して捨てる行（`IGNORED_TYPES`）で、チャットにも、裏のタスクの追跡（`src/main/task-router.ts`）などほかの読み手にも渡しません（控えの中の結果で、裏のサブエージェントを完了にしないため。行の種類は `src/main/session-manager.ts` の `handleEntry` で 1 回だけ分ける）。

会話ログの attachment の `structured_output`（`data`・`toolUseID`）は、ワークフローのエージェントが、決めた形（スキーマ）で返した結果の控えです。ワークフローのエージェントの会話ログ（`subagents/workflows/<実行の ID>/agent-<ID>.jsonl`）にだけあります。`data` は、`toolUseID` の `StructuredOutput` の呼び出しの `input` と同じで、ワークフローの `journal.jsonl` の、そのエージェントの `result` とも同じです（2.1.296〜2.1.303 の手元の会話ログの 822 行で実測）。チャットでは呼び出しのカードの入力に、タスクの画面ではエージェントの「結果」に同じ中身が出ているので、意図して捨てます（`IGNORED_ATTACHMENTS`）。

## 調べ直し方

スキル `/claude-code-events`（`.claude/skills/claude-code-events/SKILL.md`）の手順で調べ直します。引数は調べる Claude Code のバージョンです。

- `scripts/kinds.mjs`: Claude Code の本体・SDK の型・tanacode の読み取りから種類を集めて、突き合わせる
- `scripts/record.mjs`: 本物の `claude -p` をモックの API につないで、行と会話ログを録る（ふつうに答える・書いている途中で切る・断る）
- `scripts/feed.ts`: 録った行を tanacode の読み取り（`StreamClient`・`PartialText`）にそのまま流す
