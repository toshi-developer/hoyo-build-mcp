// 実データを使った疎通確認。MCP を再登録せず stdio で直接叩く。
//
//   GENSHIN_UID=... ZZZ_UID=... HSR_UID=... npm run smoke
//
// 設定されている UID のぶんだけ確認する。ネットワークが要る。
// HoYoLAB の Cookie（~/.hsr-build-mcp/.hoyolab-cookie）があれば所持キャラ全件の
// 確認まで、無ければショーケースのぶんだけ確認して残りはスキップする。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ROOT = new URL("..", import.meta.url).pathname;
const UID = { genshin: process.env.GENSHIN_UID, zzz: process.env.ZZZ_UID, hsr: process.env.HSR_UID };
const GAMES = Object.keys(UID).filter((g) => UID[g]);
if (!GAMES.length) {
  console.error("GENSHIN_UID / ZZZ_UID / HSR_UID のいずれも設定されていません。");
  process.exit(2);
}
const dataDir = process.env.HSR_DATA_DIR || path.join(os.homedir(), ".hsr-build-mcp");
const hasCookie = !!process.env.HOYOLAB_COOKIE
  || fs.existsSync(process.env.HOYOLAB_COOKIE_FILE || path.join(dataDir, ".hoyolab-cookie"));

const srv = spawn("node", ["server.js"], { cwd: ROOT, env: process.env, stdio: ["pipe", "pipe", "inherit"] });
let buf = "", id = 0;
const waiting = new Map();
srv.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  }
});
const send = (method, params) => new Promise((res) => {
  const n = ++id; waiting.set(n, res);
  srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
});

await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

let ng = 0, skip = 0;
async function check(label, name, args, verify) {
  const r = await send("tools/call", { name, arguments: args });
  const body = r.result?.content?.[0]?.text ?? "";
  let ok = false, note = "";
  try {
    const j = JSON.parse(body);
    ok = !r.result?.isError && verify(j) !== false;
    if (!ok) note = body.slice(0, 160);
  } catch {
    ok = !r.result?.isError;
    if (!ok) note = body.slice(0, 160);
  }
  if (!ok) ng++;
  console.log(`${ok ? "OK  " : "NG  "} ${label}${ok ? "" : `\n      ${note}`}`);
}
// エラーが返ることを期待するチェック
async function checkFails(label, name, args) {
  const r = await send("tools/call", { name, arguments: args });
  const ok = !!r.result?.isError;
  if (!ok) ng++;
  console.log(`${ok ? "OK  " : "NG  "} ${label}${ok ? "" : "\n      エラーになるはずが成功した"}`);
}
const skipped = (label, why) => { skip++; console.log(`--  ${label}（${why}）`); };

// ツールが揃っているか
{
  const t = await send("tools/list", {});
  const names = t.result.tools.map((x) => x.name);
  const want = ["build_fetch_showcase", "build_get_character", "build_fetch_roster", "build_compare_history"];
  const missing = want.filter((w) => !names.includes(w));
  console.log(`${missing.length ? "NG  " : "OK  "} ツール定義（${names.length}本）${missing.length ? ` 不足: ${missing}` : ""}`);
  if (missing.length) ng++;
}

for (const game of GAMES) {
  // ショーケース（Cookie 不要）
  let showcased = [];
  await check(`${game}: ショーケース取得`, "build_fetch_showcase", { game, refresh: false }, (j) => {
    showcased = (j.キャラ ?? []).map((c) => c.名前 ?? c.名前);
    console.log(`      → ${showcased.length} 体: ${showcased.slice(0, 4).join("、")}${showcased.length > 4 ? " ほか" : ""}`);
    return Array.isArray(j.キャラ);
  });
  if (showcased[0]) {
    await check(`${game}: ショーケースのキャラ詳細`, "build_get_character",
      { game, name: showcased[0], source: "showcase" }, (j) => !!j.出典);
  } else {
    skipped(`${game}: ショーケースのキャラ詳細`, "ショーケースが空");
  }

  // HoYoLAB 戦績（Cookie 必要）
  if (!hasCookie) { skipped(`${game}: 所持キャラ全件`, "Cookie 未設定"); continue; }

  let owned = [];
  await check(`${game}: 所持キャラ全件`, "build_fetch_roster", { game }, (j) => {
    owned = (j.キャラ ?? []).map((c) => c.名前);
    console.log(`      → ${j.所持キャラ数} 体（サーバー ${j.サーバー}）`);
    const unresolved = JSON.stringify(j.キャラ ?? []).match(/未確認ID/g);
    if (unresolved) { console.log(`      ! 未解決IDが ${unresolved.length} 件`); return false; }
    return owned.length > 0;
  });

  // ショーケースに出していないキャラを HoYoLAB から引けるか
  const outside = owned.find((n) => !showcased.includes(n));
  if (outside) {
    await check(`${game}: ショーケース外のキャラ詳細（${outside}）`, "build_get_character",
      { game, name: outside }, (j) => String(j.出典 ?? "").includes("HoYoLAB"));
    await checkFails(`${game}: source=showcase はショーケース外を拒否する`, "build_get_character",
      { game, name: outside, source: "showcase" });
  } else {
    skipped(`${game}: ショーケース外のキャラ詳細`, "全員ショーケースに出ている");
  }
}

console.log(`\n失敗 ${ng} 件 / スキップ ${skip} 件`);
srv.kill();
process.exit(ng ? 1 : 0);
