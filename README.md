# hsr-build-mcp

原神・ゼンレスゾーンゼロ・崩壊：スターレイルの育成状況を Claude に読ませる MCP サーバー。
ゲームへのログインや自動操作は一切しません。公開されているショーケース情報だけを読みます。

## 対応タイトルとデータ元

| ゲーム | `game` | データ元 |
|---|---|---|
| 原神 | `genshin` | Enka.Network（非公式） |
| ゼンレスゾーンゼロ | `zzz` | Enka.Network（非公式） |
| 崩壊：スターレイル | `hsr` | Mihomo API（非公式） |

Enka は ID しか返さないため、公開されている変換表（`store/*.json`）を取得して
日本語名に解決しています。変換表は `~/.hsr-build-mcp/assets/` に7日間キャッシュします。

スタレだけ Mihomo を使っているのは、`sr_info_parsed` が名前もステータスも整形済みで
返してくれるためです。Enka に寄せると自前で組み立て直すことになり、質が下がります。

## ツール

### 3タイトル共通

| ツール | 内容 |
|---|---|
| `build_fetch_showcase` | プロフィールとショーケースのキャラ一覧。変化があれば履歴に保存 |
| `build_get_character` | 1キャラの詳細（最終ステータス・天賦/スキルLv・武器・聖遺物/ディスク/遺物） |
| `build_compare_history` | 前回取得時からの変化 |

いずれも `game` に `genshin` / `zzz` / `hsr` を指定します。

### スタレ専用（従来のもの）

| ツール | 内容 |
|---|---|
| `hsr_fetch_showcase` / `hsr_get_character_build` / `hsr_compare_history` | 上記の `game:"hsr"` と同等 |
| `hsr_fetch_roster` | HoYoLAB の戦績から**所持キャラ全件**。要 `HOYOLAB_COOKIE` |

## 前提

- Node.js 18 以上
- **ゲーム内プロフィールで、見てほしいキャラを公開設定にしておく**
  - 原神: プロフィール → キャラクター詳細を表示 を有効化＋ショーケースに並べる
  - ゼンゼロ: プロフィールに表示するエージェントを設定
  - スタレ: サポートキャラ欄に並べる
  - **ここに出していないキャラは読めません。** 反映まで数分かかることがあります

## セットアップ

```bash
cd hsr-build-mcp
npm install

claude mcp add hsr-build -s user \
  -e HSR_UID=<スタレUID> \
  -e GENSHIN_UID=<原神UID> \
  -e ZZZ_UID=<ゼンゼロUID> \
  -- node /フルパス/hsr-build-mcp/server.js
```

確認は `claude mcp list`。

### 環境変数

| 変数 | 既定値 | 説明 |
|---|---|---|
| `HSR_UID` / `GENSHIN_UID` / `ZZZ_UID` | なし | 各ゲームの既定UID（ツール引数でも指定可） |
| `HSR_LANG` | `jp` | スタレの表示言語 |
| `HSR_DATA_DIR` | `~/.hsr-build-mcp` | 履歴・変換表の保存先 |
| `HOYOLAB_COOKIE` | なし | `hsr_fetch_roster` 用。HoYoLAB の `ltuid_v2` と `ltoken_v2` |

## 使い方の例

- 「原神の最新データ取ってきて」
- 「雷電将軍の聖遺物見て、どこを厳選すべきか教えて」
- 「ゼンゼロの星見雅のディスク、今の構成でいい？」
- 「遺物変えたから再取得して、前と比べて」

## 保存されるもの

```
~/.hsr-build-mcp/
├── snapshots/<UID>/            # スタレ（従来の場所）
├── snapshots/<game>/<UID>/     # 原神・ゼンゼロ
├── roster/<UID>.json           # hsr_fetch_roster の結果
└── assets/                     # Enka の変換表キャッシュ（7日）
```

同じ内容なら保存しません。変化があったときだけ履歴が増えます。

## 注意

- Mihomo / Enka はいずれも**有志運営の非公式API**です。仕様変更や停止があり得ます
- 同じUIDの再取得は**1分に1回**まで（Enka の `ttl` も 60 秒）
- 原神の聖遺物セット名のうち、Enka の辞書に無いものは
  `(未収録セットID:15020 / 2セット:元素チャージ効率+20.0%)` のように
  **IDとセット効果で表示します**。名前を推測すると助言を誤らせるためです
