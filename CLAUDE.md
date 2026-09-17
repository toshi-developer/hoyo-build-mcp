# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

原神・ゼンレスゾーンゼロ・崩壊：スターレイルの育成状況を Claude に読ませる MCP サーバー。
**個人の趣味であり案件ではない。** 納品先もクライアントもいないため、ワークスペース共通の
業務ルール（応募文レビュー・ココナラ運用・3営業日ルール等）は適用しない。

ゲームへのログインや自動操作はしない。公開されているショーケース情報だけを読む。

## まず読むもの

` docs/handover.md ` — 設計判断の理由と**未解決の検討事項**。着手前に必ず読む。

## 構成

| ファイル | 役割 |
|---|---|
| `server.js` | MCP 本体。ツール定義・スナップショット保存・スタレ(Mihomo)・HoYoLAB 戦績 |
| `enka.js` | Enka.Network アダプタ。原神・ゼンゼロの ID→日本語名の解決と整形、スタレの遺物セット名 |
| `scripts/smoke.mjs` | 実データでの疎通確認（stdio で直接叩く）。要ネットワーク＋Cookie |

データ元はゲームごとに違う。**統一しているのは入口（`build_*` ツール）だけ。**

| ゲーム | `game` | ショーケース（Cookie不要・並べた分だけ） | 所持キャラ全件（要Cookie） |
|---|---|---|---|
| 原神 | `genshin` | Enka.Network（ID のみ返るので変換表が要る） | HoYoLAB 戦績 |
| ゼンゼロ | `zzz` | Enka.Network（同上） | HoYoLAB 戦績 |
| スタレ | `hsr` | Mihomo `sr_info_parsed`（整形済み） | HoYoLAB 戦績 |

## ツール

| ツール | 内容 |
|---|---|
| `build_fetch_showcase` | プロフィールとショーケースのキャラ一覧（`game` で切替） |
| `build_fetch_roster` | **所持キャラ全件**（HoYoLAB 戦績）。編成を考えるときはまずこれ |
| `build_get_character` | 1キャラの詳細。`source` でデータ元を選べる（既定 `auto`） |
| `build_compare_history` | 前回取得時からの変化 |
| `hsr_*` 4本 | スタレ専用（従来のもの） |

**データ元は2系統ある。** ショーケース（Enka / Mihomo）は Cookie 不要だが並べたキャラしか
読めない。HoYoLAB 戦績は所持キャラ全件を読めるが Cookie が要る。`build_get_character` の
`source=auto` は「ショーケースに居なければ HoYoLAB」で、応答の `出典` にどちらか出る。

## 開発時の注意

- **`npm install` してから動かす。** 依存は `@modelcontextprotocol/sdk` と `zod` のみ
- 動作確認は MCP を再登録せずに直接叩ける。`node -e` や stdio 経由の簡易クライアントで
  `tools/list` → `tools/call` を投げるのが早い
- **変換表は `~/.hsr-build-mcp/assets/` に7日キャッシュ**。取得元は Enka の `store/*.json`
- **同一UIDの再取得は1分に1回**（`MIN_FETCH_INTERVAL_MS`）。Enka の `ttl` も 60 秒
- **名前が引けない ID を推測で埋めない。** 助言を誤らせる。ID とセット効果を出して
  識別できる形にする（`giSetLabel` がその実装。`unknownId()` も同じ方針）
- **HoYoLAB は項目名を自分で返す**（原神 `property_map` / ゼンゼロ `property_name` /
  スタレ `property_info`）ので変換表が要らない。数値のままなのはスタレの `base_type`、
  原神の `element` 語彙、ゼンゼロの `element_type` / `avatar_profession` だけで、
  いずれも公開変換表と実データで裏を取ってから定数にしてある（`server.js` のコメント参照）
- **ゼンゼロは `x-rpc-language` を見ない。** `x-rpc-lang` が要る（両方送っている）

## MCP 登録

```bash
npm install
claude mcp add game-build -s user \
  -e HSR_UID=<スタレUID> -e GENSHIN_UID=<原神UID> -e ZZZ_UID=<ゼンゼロUID> \
  -- node /絶対パス/game-build-mcp/server.js
```

`~/.hsr-build-mcp/` は履歴と変換表の保存先で、リポジトリ外。`HSR_DATA_DIR` で変えられる。

## 注意

- Mihomo / Enka はいずれも**有志運営の非公式API**。仕様変更・停止があり得る
- **アシスタントの知識は2026年5月時点まで。** それ以降のキャラ・武器・セットは把握していない。
  取得したデータとユーザーの認識を頼りに助言する
- 編成やビルドを断定する前に、**実データを取得して現状を確認する**
