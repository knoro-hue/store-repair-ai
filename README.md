# 修繕AI判定（店舗向けスマホWebツール）

店舗で修繕が必要な箇所を見つけたら、**写真を撮って AI（Gemini）に送るだけ**で次のことができます。

- **緊急かどうかを即判定** → 緊急なら赤い画面で「今すぐやること」チェックリストと本社への電話ボタンを表示
- **足りない情報をAIが質問** → 選んで答えると再判定。必要なら追加で撮る写真も指示
- **緊急でなくても放置したときのリスクを表示**（時期・可能性・影響・放置時の費用感）
- **修繕稟議基準 第3条①の記載事項**（リスク区分／緊急案件の該当有無／実施前提か／見積取得基準）を自動で判定
- **本社への依頼文を自動作成** → 写真付きでメール・LINE・Teamsに共有、またはコピー
- 判定履歴をスマホ内に保存（30件）

## 使い方（おすすめ：APIキー方式）
1. 本社の担当者が [Google AI Studio](https://aistudio.google.com/apikey) で Gemini APIキーを作る（スマホで可）
2. ツールの「設定」にキーを貼り付けて保存 →「他のスマホ用の設定リンクを送る」で各店舗に送る
3. 店舗はリンクを開くだけで設定完了。以降は **撮影 → 入力 → ボタン1つ → 判定結果がツールに表示**

設定リンクのキーは URL の `#` 以降に入れており、サーバーやアクセスログには送られません。ただしリンク自体はキーと同じ扱いです（社外に転送しない）。
キーの悪用を防ぐため、Google Cloud コンソールの「APIとサービス → 認証情報」でキーに **HTTPリファラー制限（`https://knoro-hue.github.io/*`）** と **API制限（Generative Language API のみ）** をかけ、予算アラートを設定してください。

その他のモード：中継サーバー経由（キーを端末に置かない）／APIキーなし（Geminiアプリへ手動で貼り付け）／[Gem](gem/README.md)

> **APIキーなしで使いたい場合は [`gem/`](gem/README.md) を参照**（Gemini の Gem に基準を登録して使う方法。サーバーもキーも不要です）。

判定基準は `criteria.js` にまとめてあります。基準を見直したら（第3条②）このファイルを編集するだけで反映されます。

## 構成

```
index.html      画面
app.js          画面の動きとGemini呼び出し
criteria.js     修繕稟議基準（ここを編集すれば判定ルールが変わる）
gem/            APIキー不要版（Gemini の Gem 用の指示文）
worker/         Gemini中継サーバー（Cloudflare Workers）※APIキーを隠すためのもの
```

ビルドは不要です。静的ファイルなので GitHub Pages でそのまま公開できます。

## 導入手順

### 1. Gemini APIキーを取得
[Google AI Studio](https://aistudio.google.com/apikey) でAPIキーを作ります。
**店舗の写真をAIの学習に使わせない**ため、課金を有効にした（有料枠の）プロジェクトのキーを使ってください。無料枠では入力データがGoogleの改善に使われることがあります（[Gemini API 利用規約](https://ai.google.dev/gemini-api/terms)）。

### 2. GitHub Pages で公開
1. このリポジトリを GitHub に push する
2. Settings → Pages → Branch を `main` / `/ (root)` にして保存
3. `https://<ユーザー名>.github.io/<リポジトリ名>/` で開ける

### 3. 中継サーバーを用意（推奨）
APIキーをスマホに入れると漏れる危険があるので、Cloudflare Workers（無料枠あり）で中継します。

```bash
cd worker
npm i -g wrangler
wrangler login
# wrangler.toml の ALLOWED_ORIGIN を https://<ユーザー名>.github.io に書き換えてから
wrangler secret put GEMINI_API_KEY
wrangler secret put STORE_PASSCODE
wrangler deploy
```

表示された `https://store-repair-ai-proxy.xxxx.workers.dev` が中継サーバーのURLです。

### 4. 店舗に配布
次のようなURLを店舗に配ると、中継URL・本社連絡先が最初から入った状態で開きます（パスコードだけ店舗で入力）。

```
https://<ユーザー名>.github.io/<リポジトリ名>/?proxy=https://store-repair-ai-proxy.xxxx.workers.dev&tel=03-0000-0000&mail=repair@example.co.jp
```

ホーム画面に追加すればアプリのように使えます。

> 中継サーバーなしでも、設定画面に Gemini APIキーを入れるだけで使えます（初期設定はこちら）。ただし端末にキーが残るため、多店舗に配る場合は中継サーバーをおすすめします。

## モデル
初期値は `gemini-3.8-flash` です（2026年11月時点のGA版 Flash。[モデル一覧](https://ai.google.dev/gemini-api/docs/models)）。設定画面で変更できます。中継サーバーを使う場合は、`wrangler.toml` の `ALLOWED_MODELS` に入っているモデルしか使えません。

## 注意
- AIの判定は**一次判断の補助**です。最終判断・承認は部門長が行います（第4条）。
- 写真に顧客の顔やレシートが写らないよう、店舗に周知してください。
- 履歴はその端末のブラウザにだけ保存されます。本社で一覧管理したい場合は、kintone、Googleスプレッドシート、SharePointなどへの送信を追加してください。
