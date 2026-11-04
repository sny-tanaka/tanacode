#!/usr/bin/env bash
# release.yml が作った Releases の下書きを点検し、説明の先頭に変更点を足して公開する（/release の「5. 下書きの点検」と「6. 公開」）。
# 手元（/release）と release-publish.yml の両方から使う。点検で期待と違うものが見つかったら、何も変えずに止める。
#
#   scripts/release-publish.sh <X.Y.Z> [変更点のファイル]
#
# 公開は、タグではなく、点検した下書きの ID を指し、タグ名も渡して行う。v2.8.1 と v2.8.2 で、次の 2 つが起きたため。
# - タグで選ぶ（gh release edit vX.Y.Z）と、同じタグに下書きが 2 つあるとき、点検していない方（添付の無い方）が選ばれた。
#   release.yml の下書き作りが GitHub の 502 を受けて失敗扱いになったのに、GitHub 側では下書きができていて、再実行で 2 つめができた。
#   1 つめは、しばらく一覧（GET releases）に出なかった
# - ID で選んでもタグ名を渡さないと、GitHub は下書きの仮の名前（untagged-…）でタグを作って公開した
# 公開したリリースは immutable で、添付もタグ名もあとから変えられない。だから公開の前に止め、公開のあとにも確かめる。
set -euo pipefail

fail() { echo "::error::$1" >&2; exit 1; }

VERSION=${1:-}
NOTES_FILE=${2:-}
printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || fail "バージョンは X.Y.Z の形で渡してください（今は '$VERSION'）"
[ -z "$NOTES_FILE" ] || [ -f "$NOTES_FILE" ] || fail "変更点のファイルがありません: $NOTES_FILE"
REPO=${GITHUB_REPOSITORY:-sny-tanaka/tanacode}
export TAG="v$VERSION"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

expected=$(printf '%s\n' "tanacode-$VERSION-mac-arm64.pkg" "tanacode-$VERSION-mac-arm64.zip" \
  "tanacode-$VERSION-mac-x64.pkg" "tanacode-$VERSION-mac-x64.zip" SHA256SUMS.txt | sort | jq -R . | jq -sc .)

# このタグのリリース（下書きも）を全部
gh api --paginate "repos/$REPO/releases" --jq '.[] | select(.tag_name == env.TAG)' | jq -s . > "$work/all.json"
[ "$(jq '[.[] | select(.draft | not)] | length' "$work/all.json")" = 0 ] || fail "$TAG はもう公開済みです（公開したリリースは変えられません）"

# 添付が 5 つそろった下書きが、ちょうど 1 つあること。そろっていない下書き（失敗した試みの残り）は、使わずに知らせる
jq --argjson expected "$expected" '[.[] | select(([.assets[].name] | sort) == $expected)]' "$work/all.json" > "$work/complete.json"
count=$(jq length "$work/complete.json")
[ "$count" = 1 ] || fail "$TAG の、添付が 5 つそろった下書きが 1 つではありません（$count 個）: $(jq -c '[.[] | {id, assets: [.assets[].name]}]' "$work/all.json")"
jq '.[0]' "$work/complete.json" > "$work/release.json"
id=$(jq -r .id "$work/release.json")
others=$(jq -r --argjson id "$id" '[.[] | select(.id != $id) | .id] | join(" ")' "$work/all.json")
[ -z "$others" ] || echo "::warning::$TAG には、ほかにも下書きがあります（使いません。消すかを人に確かめてください）: $others"

# 説明が「## ダウンロード」から始まり（変更点をまだ足していない）、ダウンロードの表のファイル名が添付と合うこと
jq -r .body "$work/release.json" > "$work/body.md"
[ "$(head -n 1 "$work/body.md")" = '## ダウンロード' ] || fail '説明が「## ダウンロード」から始まっていません（変更点を足し済み？）'
grep -q "tanacode-$VERSION-mac-arm64.pkg" "$work/body.md" || fail 'ダウンロードの表のファイル名が添付と合いません'
grep -q "tanacode-$VERSION-mac-x64.pkg" "$work/body.md" || fail 'ダウンロードの表のファイル名が添付と合いません'

# 説明の SHA-256 の表と SHA256SUMS.txt が一致すること
asset_id=$(jq -r '.assets[] | select(.name == "SHA256SUMS.txt") | .id' "$work/release.json")
gh api -H 'Accept: application/octet-stream' "repos/$REPO/releases/assets/$asset_id" | sort > "$work/sums.txt"
sed -nE 's/^\| `([^`]+)` \| `([0-9a-f]{64})` \|$/\2  \1/p' "$work/body.md" | sort > "$work/table.txt"
[ -s "$work/table.txt" ] || fail '説明に SHA-256 の表がありません'
diff "$work/table.txt" "$work/sums.txt" || fail '説明の SHA-256 の表と SHA256SUMS.txt が一致しません'
echo "点検は問題無し: 下書き $id"

# 変更点を先頭に足し、ID とタグ名を指して公開する。返事が 5xx でも GitHub 側では変わっていることがあるので、結果は下で読み直して決める
if [ -n "$NOTES_FILE" ]; then
  { cat "$NOTES_FILE"; printf '\n'; cat "$work/body.md"; } > "$work/new-body.md"
else
  cp "$work/body.md" "$work/new-body.md"
fi
gh api -X PATCH "repos/$REPO/releases/$id" -f tag_name="$TAG" -F draft=false -f make_latest=true -F body=@"$work/new-body.md" > /dev/null \
  || echo "::warning::公開の返事がエラーでした。GitHub 側の状態を読み直して確かめます"

# 公開を確かめる。タグで引いたリリースが点検したもので、タグ名・添付・最新のリリースが合っていること（反映の遅れを見て、何度か読み直す）
for attempt in 1 2 3 4 5 6; do
  published=$(gh api "repos/$REPO/releases/tags/$TAG" 2>/dev/null | jq -c '[.id, .draft, ([.assets[].name] | sort)]' 2>/dev/null || true)
  latest=$(gh api "repos/$REPO/releases/latest" --jq .tag_name 2>/dev/null || true)
  if [ "$published" = "$(jq -nc --argjson id "$id" --argjson expected "$expected" '[$id, false, $expected]')" ] && [ "$latest" = "$TAG" ]; then
    echo "公開しました: https://github.com/$REPO/releases/tag/$TAG"
    exit 0
  fi
  sleep 10
done
fail "公開を確かめられません（タグで引いたリリース: ${published:-なし}・最新のリリース: ${latest:-なし}）。リリース $id の tag_name・draft・添付を見てください"
