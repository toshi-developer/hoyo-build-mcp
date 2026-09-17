#!/usr/bin/env node
// 崩壊：スターレイル 育成相談用 MCPサーバー
// データ元: Mihomo API（非公式）。ゲーム内「サポートキャラ」欄に表示中のキャラのみ取得可能。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fetchEnka, normalize } from "./enka.js";

const API = "https://api.mihomo.me/sr_info_parsed";
const LANG = process.env.HSR_LANG || "jp";
const DEFAULT_UID = process.env.HSR_UID || "";
const DATA_DIR = process.env.HSR_DATA_DIR || path.join(os.homedir(), ".hsr-build-mcp");
const MIN_FETCH_INTERVAL_MS = 60 * 1000; // 取得しすぎ防止

// ---------- HoYoLAB 戦績（所持キャラ全件） ----------
// Mihomo はサポートキャラ欄の分しか読めないため、所持キャラ全件は HoYoLAB の
// 戦績APIから取る。ログインCookieと DS ヘッダ（公式クライアント由来のソルトで
// 計算する署名）が要る。ソルトはHoYoLAB側の更新で変わるので環境変数で差し替える。
const HOYO_HOST = "https://bbs-api-os.hoyolab.com";
const HOYO_COOKIE = process.env.HOYOLAB_COOKIE || "";
const HOYO_SALT = process.env.HOYOLAB_DS_SALT || "6s25p5ox5y14umn1p61aqyyvbvvl3lrt";
const HOYO_DS_VARIANT = process.env.HOYOLAB_DS_VARIANT || "v1"; // v1 | v2
const HOYO_APP_VERSION = process.env.HOYOLAB_APP_VERSION || "1.5.0";

// UIDの先頭桁でサーバーが決まる
function hoyoRegion(uid) {
  if (process.env.HSR_REGION) return process.env.HSR_REGION;
  return { 6: "prod_official_usa", 7: "prod_official_eur", 8: "prod_official_asia", 9: "prod_official_cht" }[uid[0]]
    || "prod_official_asia";
}

const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");

function hoyoDs(query) {
  const t = Math.floor(Date.now() / 1000);
  if (HOYO_DS_VARIANT === "v2") {
    const r = String(Math.floor(Math.random() * 100000) + 100000);
    return `${t},${r},${md5(`salt=${HOYO_SALT}&t=${t}&r=${r}&b=&q=${query}`)}`;
  }
  const cs = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const r = Array.from({ length: 6 }, () => cs[Math.floor(Math.random() * cs.length)]).join("");
  return `${t},${r},${md5(`salt=${HOYO_SALT}&t=${t}&r=${r}`)}`;
}

async function hoyoGet(endpoint, params) {
  if (!HOYO_COOKIE) {
    throw new Error("環境変数 HOYOLAB_COOKIE が未設定です。HoYoLAB にログインした状態の ltuid_v2 と ltoken_v2 を設定してください。");
  }
  const query = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
  const res = await fetch(`${HOYO_HOST}${endpoint}?${query}`, {
    headers: {
      DS: hoyoDs(query),
      Cookie: HOYO_COOKIE,
      "x-rpc-app_version": HOYO_APP_VERSION,
      "x-rpc-client_type": "5",
      "x-rpc-language": "ja-jp",
      Referer: "https://act.hoyolab.com/",
      Origin: "https://act.hoyolab.com",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    },
  });
  const j = await res.json().catch(() => ({ retcode: -1, message: `HTTP ${res.status}（JSONで応答せず）` }));
  if (j.retcode !== 0) {
    const hint = {
      "-100": "Cookieが無効か期限切れ。ltoken_v2 を取り直してください。",
      "10001": "Cookieが無効か期限切れ。ltoken_v2 を取り直してください。",
      "-10001": "DS署名が通っていません。HOYOLAB_DS_SALT / HOYOLAB_DS_VARIANT / HOYOLAB_APP_VERSION を見直してください。",
      "10102": "戦績が非公開です。HoYoLABの設定で戦績を公開にしてください。",
      "1034": "HoYoLAB側がbot判定しました。ブラウザでHoYoLABを開いて認証を通してから再試行してください。",
    }[String(j.retcode)] || "";
    throw new Error(`HoYoLAB APIエラー: retcode=${j.retcode} ${j.message}${hint ? ` / ${hint}` : ""}`);
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
    headers: { "User-Agent": "hsr-build-mcp/1.0 (personal use)" },
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

const server = new McpServer({ name: "hsr-build", version: "1.0.0" });

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
      const endpoint = detail ? "/game_record/hkrpg/api/avatar/info" : "/game_record/hkrpg/api/avatar/basic";
      const params = { role_id: u, server: hoyoRegion(u) };
      if (detail) params.need_wiki = "false";

      const data = await hoyoGet(endpoint, params);
      if (raw) return text(data);

      const list = data.avatar_list ?? data.list ?? [];
      // 後のセッションでも参照できるように保存しておく
      const file = path.join(DATA_DIR, "roster", `${u}.json`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify({ _fetched_at: new Date().toISOString(), avatar_list: list }, null, 2));

      return text({
        取得日時: new Date().toISOString(),
        サーバー: hoyoRegion(u),
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
  "指定キャラの育成状況を詳しく返す（最終ステータス、天賦/スキルLv、武器・音動機・光円錐、聖遺物/ディスク/遺物のメイン・サブステ）。",
  {
    game: z.enum(["genshin", "zzz", "hsr"]),
    name: z.string().describe("キャラ名（部分一致可）"),
    uid: z.string().optional(),
    refresh: z.boolean().optional().describe("APIから再取得するか（既定: false）"),
  },
  async ({ game, name, uid, refresh = false }) => {
    try {
      const u = resolveGameUid(game, uid);
      if (game === "hsr") {
        const { data } = await getLatest(u, { refresh });
        const c = findCharacter(data, name);
        if (!c) return fail(new Error(`「${name}」が見つかりません。表示中: ${(data.characters ?? []).map((x) => x.name).join("、")}`));
        return text({ ゲーム: GAME_JA.hsr, 取得日時: data._fetched_at, ...detailCharacter(c) });
      }
      const { data } = await enkaLatest(game, u, { refresh });
      const c = enkaFindCharacter(data, name);
      if (!c) return fail(new Error(`「${name}」が見つかりません。表示中: ${(data.characters ?? []).map((x) => x.名前).join("、")}`));
      const base = stripInternal(c);
      if (game === "genshin") {
        return text({
          ゲーム: GAME_JA.genshin, 取得日時: data._fetched_at, ...base,
          最終ステータス: c._stats, 天賦: c._talents, 武器詳細: c._weapon, 聖遺物: c._artifacts,
        });
      }
      return text({
        ゲーム: GAME_JA.zzz, 取得日時: data._fetched_at, ...base,
        スキル: c._skills, 音動機詳細: c._weapon, ドライバディスク: c._discs,
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
