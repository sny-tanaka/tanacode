# セキュリティ

## 対象の版

脆弱性の修正は、最新の版だけが対象。直した版を出すので、その版へ更新してください。

## 報告の仕方

脆弱性は Issue に書かず、GitHub の Security タブの「Report a vulnerability」から非公開で報告してください。

**含めてほしいもの**

- 影響する版
- 再現の手順
- 想定される影響
- 直し方の案（あれば）

個人で作っているため、最初の返事は 1 週間以内が目安。直す時期は約束できません。

## 対象の例

tanacode が信頼できない中身を扱う箇所。

- チャットに出す会話ログ・ツールの出力の表示
- エディタの Markdown のプレビュー
- アプリ内プレビュー（webview）
- ターミナル・「▶ 実行」など、表示した中身からユーザーの Mac でコマンドやファイル操作が起きうる箇所

## 対象外の例

- Claude Code そのものの脆弱性。報告先は Anthropic の窓口（[Responsible Disclosure Policy](https://www.anthropic.com/responsible-disclosure-policy)）
- ユーザー自身が明示的に実行したコマンドの結果
- Apple の署名が無いことそのもの（[README](README.md#インストール) に記載）
