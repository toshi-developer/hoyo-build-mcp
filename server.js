#!/usr/bin/env node
// 原神・ゼンレスゾーンゼロ・崩壊：スターレイル 育成相談用 MCPサーバー
// データ元は2系統。ショーケース（Enka.Network / Mihomo、Cookie不要だが並べた分のみ）と
// HoYoLAB 戦績（所持キャラ全件、要Cookie）。いずれも非公式APIで読み取りのみ。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fetchEnka, normalize, hsrRelicSets } from "./enka.js";

const API = "https://api.mihomo.me/sr_info_parsed";
const LANG = process.env.HSR_LANG || "jp";
const DEFAULT_UID = process.env.HSR_UID || "";
const DATA_DIR = process.env.HSR_DATA_DIR || path.join(os.homedir(), ".hsr-build-mcp");
const MIN_FETCH_INTERVAL_MS = 60 * 1000; // 取得しすぎ防止

// ---------- HoYoLAB 戦績（所持キャラ全件） ----------
// Enka / Mihomo はショーケースに並べた分しか読めないため、所持キャラ全件は HoYoLAB の
// 戦績APIから取る。ログインCookieと DS ヘッダ（公式クライアント由来のソルトで
// 計算する署名）が要る。ソルトはHoYoLAB側の更新で変わるので環境変数で差し替える。
//
// ホスト・メソッド・リージョン体系はゲームごとに違う（2026-09-17 に署名の可否を実測）。
//   スタレ   bbs-api-os    GET  /game_record/hkrpg/api/avatar/basic
//   原神     bbs-api-os    POST /game_record/genshin/api/character/list
//   ゼンゼロ sg-public-api GET  /event/game_record_zzz/api/zzz/avatar/basic
const HOYO_COOKIE_ENV = process.env.HOYOLAB_COOKIE || "";
const HOYO_COOKIE_FILE = process.env.HOYOLAB_COOKIE_FILE || path.join(DATA_DIR, ".hoyolab-cookie");
const HOYO_SALT = process.env.HOYOLAB_DS_SALT || "6s25p5ox5y14umn1p61aqyyvbvvl3lrt";
const HOYO_DS_VARIANT = process.env.HOYOLAB_DS_VARIANT || "v1"; // v1 | v2
const HOYO_APP_VERSION = process.env.HOYOLAB_APP_VERSION || "1.5.0";

// ltoken_v2 はログインセッションそのもの。`claude mcp add -e HOYOLAB_COOKIE=...` は
// ~/.claude.json とシェル履歴に平文で残るため、ファイルからも読めるようにしておく。
let hoyoCookieCache;
async function hoyoCookie() {
  if (hoyoCookieCache !== undefined) return hoyoCookieCache;
  if (HOYO_COOKIE_ENV) return (hoyoCookieCache = HOYO_COOKIE_ENV.trim());
  try {
    hoyoCookieCache = (await fs.readFile(HOYO_COOKIE_FILE, "utf8")).trim();
  } catch {
    hoyoCookieCache = "";
  }
  return hoyoCookieCache;
}

const HOYO_GAMES = {
  hsr: {
    host: "https://bbs-api-os.hoyolab.com",
    regionEnv: "HSR_REGION",
    region: (uid) => ({ 6: "prod_official_usa", 7: "prod_official_eur", 8: "prod_official_asia", 9: "prod_official_cht" })[uid[0]] || "prod_official_asia",
    basic: { method: "GET", path: "/game_record/hkrpg/api/avatar/basic" },
    detail: { method: "GET", path: "/game_record/hkrpg/api/avatar/info", extra: { need_wiki: "false" } },
  },
  genshin: {
    host: "https://bbs-api-os.hoyolab.com",
    regionEnv: "GENSHIN_REGION",
    region: (uid) => ({ 6: "os_usa", 7: "os_euro", 8: "os_asia", 9: "os_cht" })[uid[0]] || "os_asia",
    basic: { method: "POST", path: "/game_record/genshin/api/character/list" },
    detail: { method: "POST", path: "/game_record/genshin/api/character/detail" },
  },
  zzz: {
    host: "https://sg-public-api.hoyolab.com",
    regionEnv: "ZZZ_REGION",
    // ゼンゼロだけ先頭2桁でサーバーが決まる
    region: (uid) => ({ 10: "prod_gf_us", 13: "prod_gf_jp", 15: "prod_gf_eu", 17: "prod_gf_sg" })[uid.slice(0, 2)] || "prod_gf_jp",
    basic: { method: "GET", path: "/event/game_record_zzz/api/zzz/avatar/basic" },
    detail: { method: "GET", path: "/event/game_record_zzz/api/zzz/avatar/info" },
  },
};

// UIDの先頭桁でサーバーが決まる。体系はゲームごとに違う。
function hoyoRegion(game, uid) {
  const g = HOYO_GAMES[game];
  if (!g) throw new Error(`HoYoLAB 戦績に未対応のゲームです: ${game}`);
  return process.env[g.regionEnv] || g.region(String(uid));
}

const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");

function hoyoDs(query, body = "") {
  const t = Math.floor(Date.now() / 1000);
  if (HOYO_DS_VARIANT === "v2") {
    const r = String(Math.floor(Math.random() * 100000) + 100000);
    return `${t},${r},${md5(`salt=${HOYO_SALT}&t=${t}&r=${r}&b=${body}&q=${query}`)}`;
  }
  const cs = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const r = Array.from({ length: 6 }, () => cs[Math.floor(Math.random() * cs.length)]).join("");
  return `${t},${r},${md5(`salt=${HOYO_SALT}&t=${t}&r=${r}`)}`;
}

// kind は "basic"（一覧）か "detail"（遺物・スキルまで）
async function hoyoRequest(game, kind, uid, extraParams = {}) {
  const g = HOYO_GAMES[game];
  if (!g) throw new Error(`HoYoLAB 戦績に未対応のゲームです: ${game}`);
  const spec = g[kind];
  if (!spec) throw new Error(`${GAME_JA[game] ?? game}には ${kind} のエンドポイントがありません。`);

  const cookie = await hoyoCookie();
  if (!cookie) {
    throw new Error(
      `HoYoLAB の Cookie が未設定です。HoYoLAB にログインした状態の ltuid_v2 と ltoken_v2 を、` +
      `${HOYO_COOKIE_FILE} に 1行（例: ltuid_v2=...; ltoken_v2=...）で保存するか、環境変数 HOYOLAB_COOKIE に設定してください。`
    );
  }

  const params = { role_id: String(uid), server: hoyoRegion(game, uid), ...(spec.extra ?? {}), ...extraParams };
  const query = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
  const post = spec.method === "POST";
  const body = post ? JSON.stringify(params) : undefined;

  const res = await fetch(post ? `${g.host}${spec.path}` : `${g.host}${spec.path}?${query}`, {
    method: spec.method,
    headers: {
      DS: hoyoDs(post ? "" : query, body ?? ""),
      Cookie: cookie,
      ...(post ? { "Content-Type": "application/json" } : {}),
      "x-rpc-app_version": HOYO_APP_VERSION,
      "x-rpc-client_type": "5",
      // ゼンゼロ(sg-public-api)は x-rpc-language を見ず x-rpc-lang を見る。両方送る。
      "x-rpc-language": "ja-jp",
      "x-rpc-lang": "ja-jp",
      Referer: "https://act.hoyolab.com/",
      Origin: "https://act.hoyolab.com",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    },
    body,
  });

  const j = await res.json().catch(() => ({ retcode: -1, message: `HTTP ${res.status}（JSONで応答せず）` }));
  if (j.retcode !== 0) {
    const hint = {
      "-100": "Cookieが無効か期限切れ。ltoken_v2 を取り直してください。",
      "10001": "Cookieが無効か期限切れ。ltoken_v2 を取り直してください。",
      "-10001": "DS署名が通っていません。HOYOLAB_DS_SALT / HOYOLAB_DS_VARIANT / HOYOLAB_APP_VERSION を見直してください。",
      "10102": "戦績が非公開です。HoYoLABの設定で戦績を公開にしてください。",
      "-1": "リージョン指定が誤っている可能性があります。" + `${g.regionEnv} で上書きできます（現在: ${hoyoRegion(game, uid)}）。`,
      "1034": "HoYoLAB側がbot判定しました。ブラウザでHoYoLABを開いて認証を通してから再試行してください。",
    }[String(j.retcode)] || "";
    throw new Error(`HoYoLAB APIエラー(${GAME_JA[game] ?? game}): retcode=${j.retcode} ${j.message}${hint ? ` / ${hint}` : ""}`);
  }
  return j.data;
}

const ELEMENT_JA = { ice: "氷", fire: "炎", physical: "物理", wind: "風", lightning: "雷", quantum: "量子", imaginary: "虚数" };
const PATH_JA = {
  Knight: "存護", Warrior: "壊滅", Rogue: "巡狩", Mage: "智識", Shaman: "調和", Warlock: "虚無", Priest: "豊穣", Memory: "記憶",
};

function summarizeRosterAvatar(a) {
  return {
    名前: a.name,
    レア: a.rarity,
    Lv: a.level,
    星魂: a.rank ?? 0,
    属性: ELEMENT_JA[a.element] ?? a.element ?? null,
    運命: PATH_JA[a.base_type] ?? a.base_type ?? null,
    光円錐: a.equip ? `${a.equip.name} Lv${a.equip.level} 重畳${a.equip.rank}` : "なし",
  };
}

// ---------- データ取得・保存 ----------

const lastFetch = new Map();

function resolveUid(uid) {
  const u = String(uid || DEFAULT_UID).trim();
  if (!/^\d{9,10}$/.test(u)) {
    throw new Error("UIDが未指定か形式が不正です。引数 uid か環境変数 HSR_UID を設定してください。");
  }
  return u;
}

async function fetchFromApi(uid) {
  const res = await fetch(`${API}/${uid}?lang=${LANG}`, {
    headers: { "User-Agent": "game-build-mcp/1.1 (+https://github.com/toshi-developer/game-build-mcp)" },
  });
  if (!res.ok) {
    const hint =
      res.status === 404 ? "（UIDが存在しないか、サポートキャラが非公開の可能性）" :
      res.status === 429 ? "（アクセス過多。少し時間をおいてください）" : "";
    throw new Error(`Mihomo APIエラー: HTTP ${res.status}${hint}`);
  }
  return res.json();
}

function snapDir(uid) {
  return path.join(DATA_DIR, "snapshots", uid);
}

async function listSnapshots(uid) {
  try {
    const files = (await fs.readdir(snapDir(uid))).filter((f) => f.endsWith(".json")).sort();
    return files.map((f) => path.join(snapDir(uid), f));
  } catch {
    return [];
  }
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

// 内容が変わったときだけスナップショットを保存
async function saveSnapshot(uid, data) {
  const dir = snapDir(uid);
  await fs.mkdir(dir, { recursive: true });
  const hash = crypto.createHash("sha1").update(JSON.stringify(data.characters ?? [])).digest("hex");
  const files = await listSnapshots(uid);
  if (files.length) {
    const prev = await readJson(files[files.length - 1]);
    if (prev._hash === hash) return { saved: false, file: files[files.length - 1] };
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `${stamp}.json`);
  await fs.writeFile(file, JSON.stringify({ _hash: hash, _fetched_at: new Date().toISOString(), ...data }));
  return { saved: true, file };
}

async function getLatest(uid, { refresh = false } = {}) {
  const files = await listSnapshots(uid);
  const recent = Date.now() - (lastFetch.get(uid) || 0) < MIN_FETCH_INTERVAL_MS;
  if (refresh && !recent) {
    const data = await fetchFromApi(uid);
    lastFetch.set(uid, Date.now());
    const r = await saveSnapshot(uid, data);
    return { data: await readJson(r.file), newSnapshot: r.saved };
  }
  if (files.length) return { data: await readJson(files[files.length - 1]), newSnapshot: false };
  return getLatest(uid, { refresh: true });
}

// ---------- 整形 ----------

const norm = (s) =>
  String(s ?? "")
    .replace(/[\u3041-\u3096]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60)) // ひらがな→カタカナ
    .replace(/[\s・•·「」]/g, "")
    .toLowerCase();

function findCharacter(data, name) {
  const chars = data.characters ?? [];
  const q = norm(name);
  return chars.find((c) => norm(c.name) === q) || chars.find((c) => norm(c.name).includes(q));
}

const disp = (a) => a?.display ?? (a?.percent ? `${(a.value * 100).toFixed(1)}%` : String(Math.round((a?.value ?? 0) * 10) / 10));

function mergeStats(c) {
  // attributes(基礎) + additions(追加) を合算して最終ステータスに
  const map = new Map();
  for (const list of [c.attributes ?? [], c.additions ?? []]) {
    for (const a of list) {
      const cur = map.get(a.field) || { name: a.name, value: 0, percent: a.percent };
      cur.value += a.value ?? 0;
      map.set(a.field, cur);
    }
  }
  return [...map.values()].map((a) => ({ name: a.name, display: disp({ value: a.value, percent: a.percent }) }));
}

function statsObject(c) {
  const o = {};
  for (const list of [c.attributes ?? [], c.additions ?? []]) {
    for (const a of list) o[a.name] = { value: (o[a.name]?.value ?? 0) + (a.value ?? 0), percent: a.percent };
  }
  return o;
}

function summarizeCharacter(c) {
  const lc = c.light_cone;
  return {
    名前: c.name,
    レア: c.rarity,
    Lv: c.level,
    星魂: c.rank,
    属性: c.element?.name,
    運命: c.path?.name,
    光円錐: lc ? `${lc.name} Lv${lc.level} 重畳${lc.rank}` : "なし",
    遺物セット: (c.relic_sets ?? []).map((s) => `${s.name}(${s.num}セット)`),
  };
}

function detailCharacter(c) {
  const lc = c.light_cone;
  return {
    ...summarizeCharacter(c),
    最終ステータス: mergeStats(c),
    軌跡: (c.skills ?? []).map((s) => `${s.type_text ?? s.type}: ${s.name} Lv${s.level}/${s.max_level}`),
    光円錐詳細: lc
      ? { 名前: lc.name, 運命: lc.path?.name, Lv: lc.level, 重畳: lc.rank, ステータス: (lc.attributes ?? []).map((a) => `${a.name} ${disp(a)}`) }
      : null,
    遺物: (c.relics ?? []).map((r) => ({
      名前: r.name,
      セット: r.set_name,
      Lv: r.level,
      メイン: r.main_affix ? `${r.main_affix.name} ${disp(r.main_affix)}` : null,
      サブ: (r.sub_affix ?? []).map((s) => `${s.name} ${disp(s)}${s.count ? `（${s.count}回）` : ""}`),
    })),
    セット効果: (c.relic_sets ?? []).map((s) => `${s.name} ${s.num}セット: ${s.desc ?? ""}`),
  };
}

const text = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: `エラー: ${e.message}` }] });

// ---------- MCPサーバー ----------

const server = new McpServer({ name: "game-build", version: "1.1.0" });

server.tool(
  "hsr_fetch_showcase",
  "スタレのプレイヤー情報と、サポートキャラ欄に表示中のキャラ一覧を取得する。refresh=trueで最新を取得し、変化があれば履歴に保存する。",
  {
    uid: z.string().optional().describe("ゲームのUID。省略時は環境変数 HSR_UID"),
    refresh: z.boolean().optional().describe("APIから再取得するか（既定: true）"),
  },
  async ({ uid, refresh = true }) => {
    try {
      const u = resolveUid(uid);
      const { data, newSnapshot } = await getLatest(u, { refresh });
      const p = data.player ?? {};
      return text({
        取得日時: data._fetched_at,
        新しい履歴を保存: newSnapshot,
        プレイヤー: { 名前: p.nickname, 開拓レベル: p.level, 均衡レベル: p.world_level, UID: p.uid },
        キャラ: (data.characters ?? []).map(summarizeCharacter),
        注意: "サポートキャラ欄に表示しているキャラのみ取得できます。反映には数分かかることがあります。",
      });
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "hsr_get_character_build",
  "指定キャラの育成状況（最終ステータス、軌跡Lv、光円錐、遺物のメイン/サブステと強化回数、セット効果）を返す。",
  {
    name: z.string().describe("キャラ名（部分一致可。例: ホタル、飲月）"),
    uid: z.string().optional(),
    refresh: z.boolean().optional().describe("APIから再取得するか（既定: false、保存済みデータを使う）"),
  },
  async ({ name, uid, refresh = false }) => {
    try {
      const u = resolveUid(uid);
      const { data } = await getLatest(u, { refresh });
      const c = findCharacter(data, name);
      if (!c) {
        return fail(new Error(`「${name}」が見つかりません。表示中: ${(data.characters ?? []).map((x) => x.name).join("、")}`));
      }
      return text({ 取得日時: data._fetched_at, ...detailCharacter(c) });
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "hsr_compare_history",
  "保存済み履歴から、指定キャラのステータスや装備の変化を比べる（遺物更新の効果確認用）。",
  {
    name: z.string().describe("キャラ名（部分一致可）"),
    uid: z.string().optional(),
  },
  async ({ name, uid }) => {
    try {
      const u = resolveUid(uid);
      const files = await listSnapshots(u);
      const hits = [];
      for (const f of files) {
        const d = await readJson(f);
        const c = findCharacter(d, name);
        if (c) hits.push({ at: d._fetched_at, c });
      }
      if (hits.length < 2) return text(`「${name}」の履歴が${hits.length}件しかないため比較できません。育成後に hsr_fetch_showcase で再取得してください。`);

      const [before, after] = hits.slice(-2);
      const s1 = statsObject(before.c);
      const s2 = statsObject(after.c);
      const statDiff = [];
      for (const k of new Set([...Object.keys(s1), ...Object.keys(s2)])) {
        const a = s1[k]?.value ?? 0;
        const b = s2[k]?.value ?? 0;
        if (Math.abs(b - a) < 1e-6) continue;
        const pct = s1[k]?.percent ?? s2[k]?.percent;
        const f = (v) => (pct ? `${(v * 100).toFixed(1)}%` : (Math.round(v * 10) / 10).toString());
        statDiff.push(`${k}: ${f(a)} → ${f(b)}（${b > a ? "+" : ""}${f(b - a)}）`);
      }
      const summary1 = summarizeCharacter(before.c);
      const summary2 = summarizeCharacter(after.c);
      const changed = Object.keys(summary2).filter((k) => JSON.stringify(summary1[k]) !== JSON.stringify(summary2[k]))
        .map((k) => `${k}: ${JSON.stringify(summary1[k])} → ${JSON.stringify(summary2[k])}`);

      return text({ 比較: `${before.at} → ${after.at}`, 基本情報の変化: changed, ステータス変化: statDiff, 履歴件数: hits.length });
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "hsr_fetch_roster",
  "HoYoLAB の戦績から所持キャラを全件取得する（サポートキャラ欄の制限を受けない）。要 HOYOLAB_COOKIE。detail=true で遺物・軌跡まで取得。",
  {
    uid: z.string().optional().describe("ゲームのUID。省略時は環境変数 HSR_UID"),
    detail: z.boolean().optional().describe("遺物・軌跡まで取得するか（既定: false、名前とLvのみ）"),
    raw: z.boolean().optional().describe("APIの生レスポンスをそのまま返す（応答形式の確認用）"),
  },
  async ({ uid, detail = false, raw = false }) => {
    try {
      const u = resolveUid(uid);
      const data = await hoyoRequest("hsr", detail ? "detail" : "basic", u);
      if (raw) return text(data);

      const list = data.avatar_list ?? data.list ?? [];
      // 後のセッションでも参照できるように保存しておく
      const file = path.join(DATA_DIR, "roster", `${u}.json`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify({ _fetched_at: new Date().toISOString(), avatar_list: list }, null, 2));

      return text({
        取得日時: new Date().toISOString(),
        サーバー: hoyoRegion("hsr", u),
        所持キャラ数: list.length,
        保存先: file,
        キャラ: list.map(summarizeRosterAvatar),
        注意: detail ? undefined : "遺物・軌跡まで見るときは detail=true で再取得してください。",
      });
    } catch (e) {
      return fail(e);
    }
  }
);


// ---------- HoYoLAB 戦績の整形 ----------
// HoYoLAB は項目名を自分で返す（原神 property_map / ゼンゼロ property_name /
// スタレ property_info）ので、Enka のような ID→名前の変換表は要らない。
// 数値のままなのは下の3つだけ。いずれも公開変換表と実データで裏を取ってから載せている。

// スタレの base_type。所持35体を Enka の hsr/avatars.json（AvatarBaseType）と
// 突き合わせて8種すべて一致を確認。うち 6→存護 は Mihomo の出力とも一致（2026-09-17）。
const HSR_PATH_BY_ID = { 1: "壊滅", 2: "巡狩", 3: "智識", 4: "調和", 5: "虚無", 6: "存護", 7: "豊穣", 8: "記憶" };

// 原神。HoYoLAB は Pyro/Hydro 系、Enka は Fire/Water 系で語彙が違う。所持46体を
// Enka の gi/avatars.json と突き合わせて7属性すべて確認（2026-09-17）。
const GI_ELEMENT_BY_HOYO = { Pyro: "炎", Hydro: "水", Anemo: "風", Electro: "雷", Dendro: "草", Geo: "岩", Cryo: "氷" };

// ゼンゼロ。HoYoLAB は数値、Enka の zzz/avatars.json は文字列。所持22体で突き合わせて確認（2026-09-17）。
// 属性の日本語は zzz/locs.json の ja から取れる（AddedDamageRatio_Physics → 物理属性ダメージボーナス 等）。
// 特性（Attack/Stun…）は ja に該当キーが無く日本語の出典が取れないため、Enka の表記のまま出す。
const ZZZ_ELEMENT_BY_ID = { 200: "物理", 201: "炎", 202: "氷", 203: "電気", 205: "エーテル" };
const ZZZ_PROFESSION_BY_ID = { 1: "Attack", 2: "Stun", 3: "Anomaly", 4: "Support", 5: "Defense", 6: "Rupture" };

// 引けない ID は推測で埋めず、識別できる形で出す（giSetLabel と同じ方針）
const unknownId = (v) => `(未確認ID:${v})`;

function rosterEntries(game, data) {
  if (game === "hsr") {
    return (data.avatar_list ?? []).map((a) => ({
      _id: a.id,
      名前: a.name,
      レア: a.rarity,
      Lv: a.level,
      星魂: a.rank ?? 0,
      属性: ELEMENT_JA[a.element] ?? a.element ?? null,
      運命: HSR_PATH_BY_ID[a.base_type] ?? unknownId(a.base_type),
      光円錐: a.equip ? `${a.equip.name} Lv${a.equip.level} 重畳${a.equip.rank}` : "なし",
    }));
  }
  if (game === "genshin") {
    return (data.list ?? []).map((c) => ({
      _id: c.id,
      名前: c.name,
      レア: c.rarity,
      Lv: c.level,
      命ノ星座: c.actived_constellation_num ?? 0,
      属性: GI_ELEMENT_BY_HOYO[c.element] ?? unknownId(c.element),
      好感度: c.fetter,
      武器: c.weapon ? `${c.weapon.name} Lv${c.weapon.level} 精錬${c.weapon.affix_level}` : "なし",
    }));
  }
  return (data.avatar_list ?? []).map((a) => ({
    _id: a.id,
    名前: a.name_mi18n,
    フルネーム: a.full_name_mi18n,
    レア: a.rarity,
    Lv: a.level,
    凸: a.rank ?? 0,
    属性: ZZZ_ELEMENT_BY_ID[a.element_type] ?? unknownId(a.element_type),
    特性: ZZZ_PROFESSION_BY_ID[a.avatar_profession] ?? unknownId(a.avatar_profession),
    陣営: a.camp_name_mi18n,
  }));
}

function rosterFile(game, uid) {
  return path.join(DATA_DIR, "roster", game, `${uid}.json`);
}

// 所持キャラ一覧。1分以内の再取得は保存済みを返す（HoYoLAB を叩きすぎない）
async function getRoster(game, uid, { refresh = true } = {}) {
  const key = `roster:${game}:${uid}`;
  const file = rosterFile(game, uid);
  const recent = Date.now() - (lastFetch.get(key) || 0) < MIN_FETCH_INTERVAL_MS;
  if (!refresh || recent) {
    try { return await readJson(file); } catch { /* 無ければ取りに行く */ }
  }
  const data = await hoyoRequest(game, "basic", uid);
  lastFetch.set(key, Date.now());
  const saved = { _fetched_at: new Date().toISOString(), サーバー: hoyoRegion(game, uid), キャラ: rosterEntries(game, data) };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(saved, null, 2));
  return saved;
}

function findRosterEntry(roster, name) {
  const q = norm(name);
  const cs = roster.キャラ ?? [];
  return cs.find((c) => norm(c.名前) === q)
    || cs.find((c) => norm(c.フルネーム ?? "") === q)
    || cs.find((c) => norm(c.名前).includes(q))
    || cs.find((c) => norm(c.フルネーム ?? "").includes(q));
}

// ---------- HoYoLAB の詳細（ショーケースに出していないキャラも読める） ----------

// 「0」「0.0%」のような実質ゼロの表示値か
const isZeroStat = (v) => /^0(\.0+)?%?$/.test(String(v ?? "").trim());
// ゼロでも常に出す主要ステータス（見て「無い」と分かることに意味があるもの）
const GI_CORE_STATS = new Set(["HP上限", "攻撃力", "防御力", "会心率", "会心ダメージ", "元素熟知", "元素チャージ効率"]);

function giHoyoDetail(c, propertyMap) {
  const pname = (t) => propertyMap?.[String(t)]?.name ?? `(プロパティID:${t})`;
  // 同じ property_type が base/extra/element に重複して出るのでまとめる
  const stats = new Map();
  for (const list of [c.selected_properties, c.base_properties, c.extra_properties, c.element_properties]) {
    for (const p of list ?? []) if (!stats.has(p.property_type)) stats.set(p.property_type, p);
  }
  // セット効果は実際に着けている個数で判定する
  const counts = new Map();
  for (const r of c.relics ?? []) if (r.set?.id) counts.set(r.set.id, (counts.get(r.set.id) ?? 0) + 1);
  const setEffects = [];
  for (const r of c.relics ?? []) {
    if (!r.set?.id || setEffects.some((s) => s._id === r.set.id)) continue;
    const n = counts.get(r.set.id);
    setEffects.push({
      _id: r.set.id,
      セット: `${r.set.name}（${n}個）`,
      効果: (r.set.affixes ?? []).filter((a) => a.activation_number <= n).map((a) => `${a.activation_number}セット: ${a.effect}`),
    });
  }
  return {
    名前: c.base?.name,
    レア: c.base?.rarity,
    Lv: c.base?.level,
    命ノ星座: c.base?.actived_constellation_num ?? 0,
    属性: GI_ELEMENT_BY_HOYO[c.base?.element] ?? unknownId(c.base?.element),
    好感度: c.base?.fetter,
    武器: c.weapon
      ? {
          名前: c.weapon.name, 種類: c.weapon.type_name, Lv: c.weapon.level, レア: c.weapon.rarity,
          精錬: c.weapon.affix_level, 突破: c.weapon.promote_level,
          メイン: c.weapon.main_property ? `${pname(c.weapon.main_property.property_type)} ${c.weapon.main_property.final}` : null,
          サブ: c.weapon.sub_property ? `${pname(c.weapon.sub_property.property_type)} ${c.weapon.sub_property.final}` : null,
        }
      : "なし",
    // 未強化の元素ダメージ/耐性が 0.0% のまま大量に並ぶので、値のあるものと主要ステータスだけ出す
    最終ステータス: [...stats.values()]
      .filter((p) => GI_CORE_STATS.has(pname(p.property_type)) || !isZeroStat(p.final))
      .map((p) => `${pname(p.property_type)} ${p.final}`),
    天賦: (c.skills ?? []).map((s) => `${s.name} Lv${s.level}`),
    命ノ星座詳細: (c.constellations ?? []).map((k) => `${k.pos}凸 ${k.name}${k.is_actived ? "" : "（未解放）"}`),
    聖遺物: (c.relics ?? []).map((r) => ({
      部位: r.pos_name, 名前: r.name, セット: r.set?.name, Lv: r.level, レア: r.rarity,
      メイン: `${pname(r.main_property.property_type)} ${r.main_property.value}`,
      サブ: (r.sub_property_list ?? []).map((s) => `${pname(s.property_type)} ${s.value}${s.times ? `（強化${s.times}回）` : ""}`),
    })),
    セット効果: setEffects.map(({ _id, ...rest }) => rest),
  };
}

function zzzHoyoDetail(c) {
  const prop = (p) => `${p.property_name} ${p.base}`;
  const suits = new Map();
  for (const d of c.equip ?? []) if (d.equip_suit?.suit_id) suits.set(d.equip_suit.suit_id, d.equip_suit);
  return {
    名前: c.name_mi18n,
    フルネーム: c.full_name_mi18n,
    レア: c.rarity,
    Lv: c.level,
    凸: c.rank ?? 0,
    属性: ZZZ_ELEMENT_BY_ID[c.element_type] ?? unknownId(c.element_type),
    特性: ZZZ_PROFESSION_BY_ID[c.avatar_profession] ?? unknownId(c.avatar_profession),
    陣営: c.camp_name_mi18n,
    音動機: c.weapon
      ? {
          名前: c.weapon.name, Lv: c.weapon.level, レア: c.weapon.rarity, 重畳: c.weapon.star,
          メイン: (c.weapon.main_properties ?? []).map(prop),
          サブ: (c.weapon.properties ?? []).map(prop),
          効果: c.weapon.talent_title,
        }
      : "なし",
    最終ステータス: (c.properties ?? []).map((p) => `${p.property_name} ${p.final}`),
    スキル: (c.skills ?? []).map((s) => `${s.items?.[0]?.title ?? `種別${s.skill_type}`} Lv${s.level}`),
    ドライバディスク: (c.equip ?? []).map((d) => ({
      名前: d.name, Lv: d.level, レア: d.rarity,
      メイン: (d.main_properties ?? []).map(prop),
      サブ: (d.properties ?? []).map((p) => `${p.property_name} ${p.base}${p.level > 1 ? `(+${p.level - 1})` : ""}`),
    })),
    セット効果: [...suits.values()].filter((s) => s.own >= 2).map((s) => ({
      セット: `${s.name}（${s.own}個）`,
      効果: [s.own >= 2 ? `2セット: ${s.desc1}` : null, s.own >= 4 ? `4セット: ${s.desc2}` : null].filter(Boolean),
    })),
    // 1個だけで効果が出ていないディスクも、厳選の余地として見えるようにしておく
    効果の出ていないセット: [...suits.values()].filter((s) => s.own < 2).map((s) => `${s.name}（${s.own}個）`),
    凸詳細: (c.ranks ?? []).map((r) => `${r.id}凸 ${r.name}${r.is_unlocked === false ? "（未解放）" : ""}`),
  };
}

function hsrHoyoDetail(a, propertyInfo, sets) {
  const pname = (t) => propertyInfo?.[String(t)]?.name ?? `(プロパティID:${t})`;
  const setIdOf = (r) => sets?.setIdOf(r.id) ?? null;
  const relic = (r) => ({
    名前: r.name,
    セット: (setIdOf(r) && sets.setName(setIdOf(r))) || (setIdOf(r) ? `(未収録セットID:${setIdOf(r)})` : null),
    Lv: r.level, レア: r.rarity,
    メイン: `${pname(r.main_property.property_type)} ${r.main_property.value}`,
    サブ: (r.properties ?? []).map((s) => `${pname(s.property_type)} ${s.value}${s.times ? `（強化${s.times}回）` : ""}`),
  });
  // 遺物とオーナメントをセットIDでまとめて、実際に着けている個数で効果を出す
  const counts = new Map();
  for (const r of [...(a.relics ?? []), ...(a.ornaments ?? [])]) {
    const id = setIdOf(r);
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const setEffects = [...counts.entries()].map(([id, n]) => ({
    セット: `${sets.setName(id) ?? `(未収録セットID:${id})`}（${n}個）`,
    効果: sets.setProps(id, n),
  }));
  return {
    名前: a.name,
    レア: a.rarity,
    Lv: a.level,
    星魂: a.rank ?? 0,
    属性: ELEMENT_JA[a.element] ?? a.element ?? null,
    運命: HSR_PATH_BY_ID[a.base_type] ?? unknownId(a.base_type),
    光円錐: a.equip ? { 名前: a.equip.name, Lv: a.equip.level, 重畳: a.equip.rank, レア: a.equip.rarity } : "なし",
    最終ステータス: (a.properties ?? []).map((p) => `${pname(p.property_type)} ${p.final}`),
    軌跡: (a.skills ?? []).filter((s) => s.point_type === 2)
      .map((s) => `${s.remake}: ${s.skill_stages?.[0]?.name ?? ""} Lv${s.level}`.replace("  ", " ")),
    追加能力: (a.skills ?? []).filter((s) => s.point_type === 3)
      .map((s) => `${s.skill_stages?.[0]?.name ?? s.remake}${s.is_activated ? "" : "（未解放）"}`),
    ステータスボーナス解放数: (a.skills ?? []).filter((s) => s.point_type === 1 && s.is_activated).length,
    遺物: (a.relics ?? []).map(relic),
    オーナメント: (a.ornaments ?? []).map(relic),
    セット効果: setEffects,
    星魂詳細: (a.ranks ?? []).map((r) => `${r.pos}凸 ${String(r.name).replace(/\n/g, "")}${r.is_unlocked ? "" : "（未解放）"}`),
  };
}

// 名前からキャラを引いて、HoYoLAB の詳細を整形して返す。見つからなければ null。
async function hoyoCharacterDetail(game, uid, name) {
  const roster = await getRoster(game, uid, { refresh: false });
  const entry = findRosterEntry(roster, name);
  if (!entry) return { found: false, roster };

  if (game === "genshin") {
    const d = await hoyoRequest("genshin", "detail", uid, { character_ids: [entry._id] });
    const c = (d.list ?? [])[0];
    if (!c) return { found: false, roster };
    return { found: true, roster, detail: giHoyoDetail(c, d.property_map) };
  }
  if (game === "zzz") {
    const d = await hoyoRequest("zzz", "detail", uid, { "id_list[]": entry._id, need_wiki: "false" });
    const c = (d.avatar_list ?? [])[0];
    if (!c) return { found: false, roster };
    return { found: true, roster, detail: zzzHoyoDetail(c) };
  }
  // スタレは1回のリクエストで全員分（1MB超）返るので、該当キャラだけ取り出す
  const d = await hoyoRequest("hsr", "detail", uid);
  const a = (d.avatar_list ?? []).find((x) => x.id === entry._id);
  if (!a) return { found: false, roster };
  return { found: true, roster, detail: hsrHoyoDetail(a, d.property_info, await hsrRelicSets(DATA_DIR)) };
}

// ---------- 原神 / ゼンレスゾーンゼロ（Enka.Network） ----------
// スタレは Mihomo の parsed API のほうが整形済みなので、そちらを使い続ける。
// 3タイトルを同じ操作で扱えるように、入口だけ build_* に揃える。

const GAME_JA = { hsr: "崩壊：スターレイル", genshin: "原神", zzz: "ゼンレスゾーンゼロ" };
const GAME_UID_ENV = {
  hsr: () => process.env.HSR_UID || "",
  genshin: () => process.env.GENSHIN_UID || "",
  zzz: () => process.env.ZZZ_UID || "",
};

function resolveGameUid(game, uid) {
  const u = String(uid || GAME_UID_ENV[game]?.() || "").trim();
  if (!/^\d{8,11}$/.test(u)) {
    throw new Error(`${GAME_JA[game] ?? game}のUIDが未指定か形式が不正です。引数 uid か環境変数で指定してください。`);
  }
  return u;
}

function enkaSnapDir(game, uid) {
  return path.join(DATA_DIR, "snapshots", game, uid);
}

async function enkaListSnapshots(game, uid) {
  try {
    const dir = enkaSnapDir(game, uid);
    return (await fs.readdir(dir)).filter((f) => f.endsWith(".json")).sort().map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

async function enkaSave(game, uid, data) {
  const dir = enkaSnapDir(game, uid);
  await fs.mkdir(dir, { recursive: true });
  const hash = crypto.createHash("sha1").update(JSON.stringify(data.characters ?? [])).digest("hex");
  const files = await enkaListSnapshots(game, uid);
  if (files.length) {
    const prev = await readJson(files[files.length - 1]);
    if (prev._hash === hash) return { saved: false, file: files[files.length - 1] };
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `${stamp}.json`);
  await fs.writeFile(file, JSON.stringify({ _hash: hash, _fetched_at: new Date().toISOString(), ...data }));
  return { saved: true, file };
}

async function enkaLatest(game, uid, { refresh = true } = {}) {
  const key = `${game}:${uid}`;
  const files = await enkaListSnapshots(game, uid);
  const recent = Date.now() - (lastFetch.get(key) || 0) < MIN_FETCH_INTERVAL_MS;
  if (refresh && !recent) {
    const raw = await fetchEnka(game, uid);
    const data = await normalize(game, raw, DATA_DIR);
    lastFetch.set(key, Date.now());
    const r = await enkaSave(game, uid, data);
    return { data: await readJson(r.file), newSnapshot: r.saved };
  }
  if (files.length) return { data: await readJson(files[files.length - 1]), newSnapshot: false };
  return enkaLatest(game, uid, { refresh: true });
}

const stripInternal = (c) => Object.fromEntries(Object.entries(c).filter(([k]) => !k.startsWith("_")));

function enkaFindCharacter(data, name) {
  const q = norm(name);
  const cs = data.characters ?? [];
  return cs.find((c) => norm(c.名前) === q) || cs.find((c) => norm(c.名前).includes(q));
}

server.tool(
  "build_fetch_showcase",
  "原神・ゼンゼロ・スタレのプロフィールと、ショーケース（サポートキャラ／表示中エージェント）に出ているキャラ一覧を取得する。変化があれば履歴に保存する。",
  {
    game: z.enum(["genshin", "zzz", "hsr"]).describe("genshin=原神 / zzz=ゼンゼロ / hsr=スタレ"),
    uid: z.string().optional().describe("省略時は環境変数（GENSHIN_UID / ZZZ_UID / HSR_UID）"),
    refresh: z.boolean().optional().describe("APIから再取得するか（既定: true）"),
  },
  async ({ game, uid, refresh = true }) => {
    try {
      const u = resolveGameUid(game, uid);
      if (game === "hsr") {
        const { data, newSnapshot } = await getLatest(u, { refresh });
        const p = data.player ?? {};
        return text({
          ゲーム: GAME_JA.hsr,
          取得日時: data._fetched_at,
          新しい履歴を保存: newSnapshot,
          プレイヤー: { 名前: p.nickname, 開拓レベル: p.level, 均衡レベル: p.world_level, UID: p.uid },
          キャラ: (data.characters ?? []).map(summarizeCharacter),
          注意: "サポートキャラ欄に表示しているキャラのみ取得できます。",
        });
      }
      const { data, newSnapshot } = await enkaLatest(game, u, { refresh });
      return text({
        ゲーム: GAME_JA[game],
        取得日時: data._fetched_at,
        新しい履歴を保存: newSnapshot,
        次の更新まで秒: data.ttl,
        プレイヤー: data.player,
        キャラ: (data.characters ?? []).map(stripInternal),
        注意: "ゲーム内プロフィールで公開設定にしたキャラのみ取得できます。反映には数分かかることがあります。",
      });
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "build_get_character",
  "指定キャラの育成状況を詳しく返す（最終ステータス、天賦/スキルLv、武器・音動機・光円錐、聖遺物/ディスク/遺物のメイン・サブステ、セット効果）。ショーケースに並べていないキャラも HoYoLAB 戦績から読める。",
  {
    game: z.enum(["genshin", "zzz", "hsr"]),
    name: z.string().describe("キャラ名（部分一致可）"),
    uid: z.string().optional(),
    refresh: z.boolean().optional().describe("ショーケース側をAPIから再取得するか（既定: false）"),
    source: z.enum(["auto", "showcase", "hoyolab"]).optional()
      .describe("auto=ショーケースを見て、居なければ HoYoLAB 戦績にフォールバック（既定） / showcase=Enka・Mihomoのみ / hoyolab=HoYoLAB戦績のみ"),
  },
  async ({ game, name, uid, refresh = false, source = "auto" }) => {
    try {
      const u = resolveGameUid(game, uid);

      const fromHoyolab = async (label) => {
        const r = await hoyoCharacterDetail(game, u, name);
        if (!r.found) {
          const owned = (r.roster?.キャラ ?? []).map((c) => c.名前).join("、");
          throw new Error(`「${name}」が所持キャラに見つかりません。所持: ${owned || "（取得できず）"}`);
        }
        return text({ ゲーム: GAME_JA[game], 出典: label, 取得日時: r.roster._fetched_at, ...r.detail });
      };

      if (source === "hoyolab") return await fromHoyolab("HoYoLAB 戦績");

      // ショーケース（従来どおりの経路）
      let showcaseErr = null;
      try {
        if (game === "hsr") {
          const { data } = await getLatest(u, { refresh });
          const c = findCharacter(data, name);
          if (c) return text({ ゲーム: GAME_JA.hsr, 出典: "Mihomo（ショーケース）", 取得日時: data._fetched_at, ...detailCharacter(c) });
        } else {
          const { data } = await enkaLatest(game, u, { refresh });
          const c = enkaFindCharacter(data, name);
          if (c) {
            const base = stripInternal(c);
            return text(
              game === "genshin"
                ? { ゲーム: GAME_JA.genshin, 出典: "Enka.Network（ショーケース）", 取得日時: data._fetched_at, ...base,
                    最終ステータス: c._stats, 天賦: c._talents, 武器詳細: c._weapon, 聖遺物: c._artifacts }
                : { ゲーム: GAME_JA.zzz, 出典: "Enka.Network（ショーケース）", 取得日時: data._fetched_at, ...base,
                    スキル: c._skills, 音動機詳細: c._weapon, ドライバディスク: c._discs }
            );
          }
        }
      } catch (e) {
        if (source === "showcase") throw e;
        showcaseErr = e; // auto なら HoYoLAB を試す
      }

      if (source === "showcase") {
        return fail(new Error(`「${name}」がショーケースに見つかりません。ショーケース外のキャラは source を省略（auto）するか hoyolab にしてください。`));
      }

      const res = await fromHoyolab("HoYoLAB 戦績（ショーケース外）");
      if (showcaseErr) {
        const o = JSON.parse(res.content[0].text);
        return text({ ...o, ショーケース側のエラー: showcaseErr.message });
      }
      return res;
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "build_fetch_roster",
  "HoYoLAB の戦績から所持キャラを全件取得する（ショーケースに並べていないキャラも含む）。編成を考えるときはまずこれ。要 HoYoLAB Cookie。",
  {
    game: z.enum(["genshin", "zzz", "hsr"]).describe("genshin=原神 / zzz=ゼンゼロ / hsr=スタレ"),
    uid: z.string().optional().describe("省略時は環境変数（GENSHIN_UID / ZZZ_UID / HSR_UID）"),
    refresh: z.boolean().optional().describe("APIから再取得するか（既定: true。1分以内の再取得は保存済みを返す）"),
    raw: z.boolean().optional().describe("APIの生レスポンスをそのまま返す（応答形式の確認用）"),
  },
  async ({ game, uid, refresh = true, raw = false }) => {
    try {
      const u = resolveGameUid(game, uid);
      if (raw) return text(await hoyoRequest(game, "basic", u));
      const roster = await getRoster(game, u, { refresh });
      return text({
        ゲーム: GAME_JA[game],
        取得日時: roster._fetched_at,
        サーバー: roster.サーバー,
        出典: "HoYoLAB 戦績",
        所持キャラ数: (roster.キャラ ?? []).length,
        キャラ: (roster.キャラ ?? []).map(stripInternal),
        注意: "育成状況の詳細は build_get_character で1キャラずつ取得してください。",
      });
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "build_compare_history",
  "保存済み履歴から、指定キャラの装備・ステータスの変化を比べる（更新後の効果確認用）。",
  {
    game: z.enum(["genshin", "zzz", "hsr"]),
    name: z.string(),
    uid: z.string().optional(),
  },
  async ({ game, name, uid }) => {
    try {
      const u = resolveGameUid(game, uid);
      if (game === "hsr") {
        // 既存の hsr_compare_history と同じ処理に寄せる
        const files = await listSnapshots(u);
        const hits = [];
        for (const f of files) {
          const d = await readJson(f);
          const c = findCharacter(d, name);
          if (c) hits.push({ at: d._fetched_at, c });
        }
        if (hits.length < 2) return text(`「${name}」の履歴が${hits.length}件しかないため比較できません。`);
        const [before, after] = hits.slice(-2);
        const s1 = statsObject(before.c), s2 = statsObject(after.c);
        const diff = [];
        for (const k of new Set([...Object.keys(s1), ...Object.keys(s2)])) {
          const a = s1[k]?.value ?? 0, b = s2[k]?.value ?? 0;
          if (Math.abs(b - a) < 1e-6) continue;
          const pct = s1[k]?.percent ?? s2[k]?.percent;
          const f = (v) => (pct ? `${(v * 100).toFixed(1)}%` : String(Math.round(v * 10) / 10));
          diff.push(`${k}: ${f(a)} → ${f(b)}`);
        }
        return text({ 比較: `${before.at} → ${after.at}`, ステータス変化: diff, 履歴件数: hits.length });
      }

      const files = await enkaListSnapshots(game, u);
      const hits = [];
      for (const f of files) {
        const d = await readJson(f);
        const c = enkaFindCharacter(d, name);
        if (c) hits.push({ at: d._fetched_at, c });
      }
      if (hits.length < 2) return text(`「${name}」の履歴が${hits.length}件しかないため比較できません。育成後に build_fetch_showcase で再取得してください。`);
      const [before, after] = hits.slice(-2);

      const diff = [];
      if (game === "genshin") {
        const s1 = before.c._statsRaw ?? {}, s2 = after.c._statsRaw ?? {};
        for (const k of new Set([...Object.keys(s1), ...Object.keys(s2)])) {
          const a = s1[k]?.value ?? 0, b = s2[k]?.value ?? 0;
          if (Math.abs(b - a) < 1e-6) continue;
          const pct = s1[k]?.percent ?? s2[k]?.percent;
          const f = (v) => (pct ? `${(v * 100).toFixed(1)}%` : String(Math.round(v)));
          diff.push(`${k}: ${f(a)} → ${f(b)}`);
        }
      }
      const b1 = stripInternal(before.c), b2 = stripInternal(after.c);
      const changed = Object.keys(b2)
        .filter((k) => JSON.stringify(b1[k]) !== JSON.stringify(b2[k]))
        .map((k) => `${k}: ${JSON.stringify(b1[k])} → ${JSON.stringify(b2[k])}`);

      return text({ ゲーム: GAME_JA[game], 比較: `${before.at} → ${after.at}`, 基本情報の変化: changed, ステータス変化: diff, 履歴件数: hits.length });
    } catch (e) {
      return fail(e);
    }
  }
);

await server.connect(new StdioServerTransport());
