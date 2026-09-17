# game-build-mcp

原神・ゼンレスゾーンゼロ・崩壊：スターレイルの育成状況を Claude に読ませる MCP サーバーです。
「この聖遺物どう？」「次は誰を育てるべき？」を、実際の手持ちデータを見ながら相談できます。

ゲームへのログインや自動操作はしません。**読み取りのみ**です。

## できること

データ元は2系統あり、**読める範囲と必要なものが違います。**

| | ショーケース | 所持キャラ全件 |
|---|---|---|
| データ元 | Enka.Network / Mihomo | HoYoLAB 戦績 |
| 読める範囲 | ゲーム内プロフィールに並べたキャラだけ | 持っているキャラすべて |
| 必要なもの | UID だけ | UID ＋ **HoYoLAB のログイン Cookie** |
| 規約面 | 第三者利用を前提にした有志 API | 公式の非公開 API（後述） |

**まずショーケースだけで試すことを勧めます。** Cookie なしで動き、聖遺物やステータスの
詳細までひととおり読めます。「編成を相談したいので手持ち全部を見せたい」となったときに
はじめて Cookie を用意してください。

## 対応タイトル

| ゲーム | `game` | ショーケース | 所持キャラ全件 |
|---|---|---|---|
| 原神 | `genshin` | Enka.Network | HoYoLAB 戦績 |
| ゼンレスゾーンゼロ | `zzz` | Enka.Network | HoYoLAB 戦績 |
| 崩壊：スターレイル | `hsr` | Mihomo API | HoYoLAB 戦績 |

Enka は ID しか返さないため、公開されている変換表（`store/*.json`）を取得して日本語名に
解決しています。変換表は7日間キャッシュします。スタレのショーケースだけ Mihomo を使って
いるのは、`sr_info_parsed` が名前もステータスも整形済みで返してくれるためです。

## ツール

| ツール | 内容 |
|---|---|
| `build_fetch_showcase` | プロフィールとショーケースのキャラ一覧。変化があれば履歴に保存 |
| `build_fetch_roster` | **所持キャラ全件**。編成を考えるときはまずこれ（要 Cookie） |
| `build_get_character` | 1キャラの詳細（最終ステータス・天賦/スキルLv・武器・聖遺物/ディスク/遺物・セット効果） |
| `build_compare_history` | 前回取得時からの変化 |

いずれも `game` に `genshin` / `zzz` / `hsr` を指定します。
`hsr_fetch_showcase` / `hsr_get_character_build` / `hsr_compare_history` / `hsr_fetch_roster`
はスタレ専用の旧ツールで、上記と同等です。

`build_get_character` の `source` でデータ元を選べます。

| `source` | 動き |
|---|---|
| `auto`（既定） | ショーケースを見て、居なければ HoYoLAB 戦績にフォールバック |
| `showcase` | Enka / Mihomo のみ（Cookie 不要） |
| `hoyolab` | HoYoLAB 戦績のみ |

応答には必ず `出典` が入るので、どちらから読んだ値か分かります。

## セットアップ

Node.js 18 以上が要ります。

```bash
git clone https://github.com/toshi-developer/game-build-mcp.git
cd game-build-mcp
npm install

claude mcp add game-build -s user \
  -e GENSHIN_UID=<原神UID> \
  -e ZZZ_UID=<ゼンゼロUID> \
  -e HSR_UID=<スタレUID> \
  -- node "$PWD/server.js"
```

持っているタイトルのぶんだけ指定すれば動きます。確認は `claude mcp list`。

**ゲーム内プロフィールで、見てほしいキャラを公開設定にしておいてください。**

- 原神: プロフィール → 「キャラクター詳細を表示」を有効化し、ショーケースに並べる
- ゼンゼロ: プロフィールに表示するエージェントを設定
- スタレ: サポートキャラ欄に並べる

反映まで数分かかることがあります。

疎通確認は MCP を再登録しなくてもできます。

```bash
GENSHIN_UID=<UID> npm run smoke
```

## 所持キャラ全件を読む（任意）

ショーケースに並べていないキャラまで読みたい場合だけ設定してください。

> [!WARNING]
> `ltoken_v2` は**ログインセッションそのもの**です。これを渡された相手は、あなたの
> HoYoLAB アカウントとして操作できます。**他人に見せない・チャットに貼らない・
> リポジトリやシェル履歴に残さない。** 漏れたと思ったら HoYoLAB でログアウトすれば失効します。

1. HoYoLAB で**戦績を公開**にする（アイコン → 個人ホーム → 設定 → 戦績）。タイトルごとに要ります
2. https://www.hoyolab.com にログインした状態で F12 → Application → Cookies →
   `ltoken_v2` と、`ltuid_v2` または `ltmid_v2` の値をコピー
3. ファイルに保存する

```bash
mkdir -p ~/.hsr-build-mcp
install -m 600 /dev/null ~/.hsr-build-mcp/.hoyolab-cookie
cat > ~/.hsr-build-mcp/.hoyolab-cookie
# ltuid_v2=＜値＞; ltoken_v2=＜値＞   ←貼って Ctrl-D
```

`cat >` を使うのはシェル履歴に値を残さないためです。環境変数 `HOYOLAB_COOKIE` でも
渡せますが、`claude mcp add -e HOYOLAB_COOKIE=...` は `~/.claude.json` とシェル履歴に
平文で残るので、ファイル経由を勧めます。

うまくいかないときは応答の `retcode` で切り分けます。

| retcode | 意味 | 対処 |
|---|---|---|
| `-100` / `10001` | Cookie が無効・期限切れ | 取り直す |
| `-10001` | DS 署名が通っていない | 署名ソルトが変わった。`HOYOLAB_DS_*` を差し替える |
| `10102` | 戦績が非公開 | HoYoLAB の設定で公開にする |
| `1034` | bot 判定 | ブラウザで HoYoLAB を開いて認証を通してから再試行 |

**署名ソルトは HoYoLAB 側の更新で変わります。** 壊れる前提の機能だと思ってください。

## 環境変数

| 変数 | 既定値 | 説明 |
|---|---|---|
| `GENSHIN_UID` / `ZZZ_UID` / `HSR_UID` | なし | 各ゲームの既定 UID（ツール引数でも指定可） |
| `HSR_LANG` | `jp` | スタレ（Mihomo）の表示言語 |
| `HSR_DATA_DIR` | `~/.hsr-build-mcp` | 履歴・変換表・Cookie の保存先 |
| `HOYOLAB_COOKIE` | なし | HoYoLAB の Cookie。未設定ならファイルを読む |
| `HOYOLAB_COOKIE_FILE` | `<HSR_DATA_DIR>/.hoyolab-cookie` | Cookie を置くファイル |
| `HOYOLAB_DS_SALT` / `HOYOLAB_DS_VARIANT` / `HOYOLAB_APP_VERSION` | 現行値 | DS 署名が通らなくなったとき差し替える |
| `HSR_REGION` / `GENSHIN_REGION` / `ZZZ_REGION` | UID から自動 | サーバー指定を上書きする |

## 使い方の例

- 「原神の最新データ取ってきて」
- 「雷電将軍の聖遺物見て、どこを厳選すべきか教えて」
- 「手持ち全部見て、いま組める一番強い編成を教えて」
- 「遺物変えたから再取得して、前と比べて」

## 保存されるもの

```
~/.hsr-build-mcp/
├── snapshots/<UID>/            # スタレのショーケース履歴
├── snapshots/<game>/<UID>/     # 原神・ゼンゼロのショーケース履歴
├── roster/<game>/<UID>.json    # 所持キャラ一覧
├── assets/                     # Enka の変換表キャッシュ（7日）
└── .hoyolab-cookie             # HoYoLAB の Cookie（自分で置く）
```

同じ内容なら保存しません。変化があったときだけ履歴が増えます。

## 注意

- **Mihomo / Enka.Network は有志が無償で運営している非公式 API です。**
  仕様変更や停止があり得ます。同一 UID の再取得は1分に1回までに制限していますが、
  むやみに叩かないでください
- **HoYoLAB 戦績の部分は、公式の非公開 API を、公式クライアントの署名を再現して
  叩いています。** 読み取り専用でゲームの自動操作はしませんが、HoYoverse の
  利用規約に沿ったものではありません。使うかどうかはご自身で判断してください
- ゲーム内のデータ（キャラ名・セット名など）は実行時に取得しており、このリポジトリには
  同梱していません
- 原神の聖遺物セット名のうち、Enka の辞書に無いものは
  `(未収録セットID:15020 / 2セット:元素チャージ効率+20.0%)` のように
  **ID とセット効果で表示します**。名前を推測すると助言を誤らせるためです
  （HoYoLAB 側から読むと解決することがあります）

このツールは HoYoverse とは無関係の非公式なものです。
原神 / 崩壊：スターレイル / ゼンレスゾーンゼロ は HoYoverse の商標です。

## ライセンス

MIT License. [LICENSE](LICENSE) を参照してください。
