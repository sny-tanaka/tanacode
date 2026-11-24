# 遠隔操作の確かめの道具

スマホからの遠隔操作（Issue #464）の「先に確かめること」を試すための道具。tanacode 本体には入れず、このブランチ（`spike/remote-probe`）はマージしません。

- `server.mjs` と `public/`: iPhone で開く確かめのページと、それを配る小さなサーバー。127.0.0.1 だけで待ち受け、前に `tailscale serve` を置いて iPhone から開きます。
- `electron/`: Electron の中で確かめること（utilityProcess での待ち受け・webview の screencast）。
- 記録は `data/` に書きます（Git には入れない）。Tailscale のユーザーのヘッダー（メールアドレスなど）は、あるかどうかだけを残し、値は書きません。

## 私用の Mac で、iPhone から試す

外からの通信を止めていない Mac で行います（会社の Mac では使いません）。

### 1. 準備
1. Mac と iPhone に Tailscale を入れ、同じアカウントでログインします。
2. Tailscale の管理画面（DNS の設定）で、MagicDNS と HTTPS Certificates を有効にします。`tailscale serve` の HTTPS に要ります。証明書を取ると、Mac の名前が証明書の公開記録に載るので、名前に個人名などを入れないでください。
3. リポジトリを取ってきて、このブランチに切り替え、道具の依存を入れます。

```
git clone https://github.com/sny-tanaka/tanacode.git
```

```
cd tanacode
```

```
git switch spike/remote-probe
```

```
cd tools/remote-probe
```

```
npm ci
```

### 2. サーバーを動かして tailnet に出す
サーバーを起動します（ターミナルは開いたままにします）。

```
npm start
```

別のターミナルで、tailnet に出します。表示された `https://<Mac の名前>.<tailnet の名前>.ts.net` を控えます。

```
tailscale serve --bg 8787
```

### 3. iPhone で試す
上から順に試し、うまくいかなかったところは、画面の文をそのまま控えてください。

1. iPhone の Tailscale をオンにします。
2. **Safari** で、控えた URL の末尾に `#code=probe123` を付けて開きます。
3. 「2. 接続元とヘッダー」の「調べる」と、「3. Cookie」の「置く」を押します。
4. 共有ボタンから「ホーム画面に追加」を選びます。
5. ホーム画面のアイコンから開きます（ここからは **PWA** での試しです）。
6. 「1. 開き方」を見ます（`hash` が `#code=probe123` のまま残っているか、`markFromBrowser` が見えるか）。
7. 「3. Cookie」の「確かめる」を押します（Safari で置いた Cookie が写っているか）。
8. 「4. 束縛の鍵」の「作る」と「確かめる」を押します。
9. 「5. パスキー」の「登録する」を押し、続けて「ログインする」を何度か押します。
10. 「6. カメラ」の「開く」を押します。
11. 「7. Web Push」の「購読する」を押して許可し、「送ってもらう」を押します。PWA を閉じてから、Mac の別のターミナルで次を実行し、閉じていても届くかも見ます。

```
curl -s -X POST http://127.0.0.1:8787/api/push/send -H 'content-type: application/json' -d '{}'
```

12. 「8. WebSocket」の「つなぐ」を押します。
13. 「9. 結果を送る」の「送る」を押します。

### 4. 日をまたいで試す
PWA の中の鍵とパスキーが残るかを見ます。次のそれぞれのあとに、PWA で「4. 束縛の鍵」の「確かめる」と「5. パスキー」の「ログインする」を押し、「9. 結果を送る」で送ります。

- PWA を閉じて開き直したあと
- iPhone を再起動したあと
- 数日（できれば 1 週間）たったあと

### 5. 終わったら
使わない間は、tailnet に出すのをやめます。

```
tailscale serve reset
```

結果は `data/results.jsonl` と `data/requests.jsonl` にあります。この 2 つのファイルを渡してください。

## Electron の中で確かめる（どの Mac でもよい）

リポジトリのいちばん上で `npm ci` を済ませてから、`tools/remote-probe` で実行します。記録は `data/electron-<種類>.jsonl` に書きます。

utilityProcess の中で HTTP・WebSocket を待ち受け、WebAuthn のライブラリが動くか。

```
../../node_modules/.bin/electron electron/main.cjs utility
```

webview の screencast の絵が、画面ロック・ディスプレイのスリープの間も届くか。小さな窓が出たら、そのまま 4 分待つ間に、次を 1 回ずつ行います。

- ⌃⌘Q で画面をロックし、30 秒たってから戻る
- 別のターミナルで `pmset displaysleepnow` を実行し、30 秒たってからキーを押して戻る

```
../../node_modules/.bin/electron electron/main.cjs screencast --seconds=240
```

`--minimize-after=秒` で途中から窓を最小化、`--hide-after=秒` で窓を隠します。`--no-throttle` を付けると、隠れた窓で描くのを止める仕組みを外して試します。

## 分かったこと

2026-11-24 に、会社の Mac（Electron 45.2.3）で確かめたこと。

- utilityProcess: HTTP・WebSocket の待ち受け、`@simplewebauthn/server` の読み込みと実行、main との伝文が、どれも動きました（先に確かめること 10）。
- screencast: 窓が出ている間は、5 秒で約 50 枚・約 90KB（390×844 に縮めた JPEG、品質 50、時刻が 0.1 秒ごとに変わるページ）。窓を最小化するか隠すと、数秒で 0 枚になりました。`--no-throttle`（backgroundThrottling を切る・描くのを止めるスイッチを外す）でも同じでした。tanacode の窓が画面に出ていないと、アプリ内ブラウザの絵はスマホに届きません。
