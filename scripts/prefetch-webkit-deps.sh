#!/usr/bin/env bash
# WebKit の依存（Playwright の install-deps webkit が apt で入れる .deb）を、ミラーを替えながら並べて落とし、
# apt のキャッシュ（/var/cache/apt/archives）に置く。CI（Linux）だけで使う（deps-cache.yml・demo-site.yml の tour）。
# このあとに install-deps を流すと、apt は置いた .deb を使い（ハッシュは apt が確かめる）、無いものだけを落とす。
#
# apt は 1 つのミラーから 1 つずつ落とすので、ミラーが遅いと止まったように長くかかる。ランナーのミラー（azure.archive.ubuntu.com）が
# 1 つのつながりで 40KB/s ほどしか出ない日があり、140MB を落とすのに 1 時間ほどかかって、打ち切りに当たった。
# そのため、16 個を並べて落とし、10 秒続けて 100KB/s を下回ったら、途中から（-C -）次のミラーで続ける。
# どのミラーも遅いときは、最後の回だけ速さの下限を外して落としきる。
set -uo pipefail

MIRRORS=(
  http://azure.archive.ubuntu.com/ubuntu
  http://archive.ubuntu.com/ubuntu
  http://mirrors.edge.kernel.org/ubuntu
)
ARCHIVES=/var/cache/apt/archives

work=$(mktemp -d)
conf=/etc/apt/apt.conf.d/99-tanacode-print-uris
trap 'sudo rm -f "$conf"; rm -rf "$work"' EXIT

# 落とすものを apt に出させる。Playwright は依存の一覧を出す口を持たないので、install-deps を Print-URIs で流す
# （apt-get は、落として入れる代わりに、落とすものの URI・ファイル名・大きさ・ハッシュを出す）。索引は先に新しくしておく
sudo apt-get update -q > /dev/null
echo 'APT::Get::Print-URIs "true";' | sudo tee "$conf" > /dev/null
sudo env "PATH=$PATH" npx playwright install-deps webkit | grep "\.deb' " > "$work/list" || true
sudo rm -f "$conf"
total=$(wc -l < "$work/list")
if [ "$total" -eq 0 ]; then
  echo "落とす .deb がありません（入っているか、一覧を出せませんでした）"
  exit 0
fi

# 1 つ落とす。$1 は URI、$2 は apt が置くファイル名、$3 は大きさ
fetch() {
  local path=${1#\'}
  path=${path%\'}
  path=pool/${path#*/pool/}
  local name=$2 size=$3 dest="$WORK/$2.part" round mirror start
  if [ "$(stat -c %s "$ARCHIVES/$name" 2> /dev/null)" = "$size" ]; then return 0; fi
  start=$SECONDS
  for round in 1 2 3; do
    for mirror in "${MIRRORS[@]}"; do
      local limit=(--speed-limit 102400 --speed-time 10)
      if [ "$round" -eq 3 ]; then limit=(--max-time 600); fi
      curl -fsSL --connect-timeout 10 "${limit[@]}" -C - -o "$dest" "$mirror/$path" 2> /dev/null
      if [ "$(stat -c %s "$dest" 2> /dev/null)" = "$size" ]; then
        mv "$dest" "$WORK/$name"
        echo "  $name（$size バイト・$((SECONDS - start)) 秒・$mirror）"
        return 0
      fi
      # 大きすぎる（別のものを落とした）ときは、続きからにせず消す
      if [ "$(stat -c %s "$dest" 2> /dev/null || echo 0)" -gt "$size" ]; then rm -f "$dest"; fi
    done
  done
  rm -f "$dest"
  echo "  $name を落とせませんでした（apt に任せます）"
  return 1
}
export -f fetch
export WORK=$work ARCHIVES
export MIRRORS_LIST="${MIRRORS[*]}"

echo "$total 個の .deb を並べて落とします"
start=$SECONDS
# 関数から配列は渡せないので、子のシェルで並べ直す
xargs -P 16 -L 1 bash -c 'MIRRORS=($MIRRORS_LIST); fetch "$@"' _ < <(awk '{ print $1, $2, $3 }' "$work/list")
got=$(find "$work" -name '*.deb' | wc -l)
if [ "$got" -gt 0 ]; then sudo cp "$work"/*.deb "$ARCHIVES/"; fi
echo "$got 個を落として apt のキャッシュに置きました（$((SECONDS - start)) 秒。全部で $total 個）"
