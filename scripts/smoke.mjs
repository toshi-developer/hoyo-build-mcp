// 実データを使った疎通確認。MCP を再登録せず stdio で直接叩く。
//   node scripts/smoke.mjs
// ネットワークと HoYoLAB Cookie（~/.hsr-build-mcp/.hoyolab-cookie）が要る。
// 件数の期待値は開発者のアカウント（原神46 / ゼンゼロ22 / スタレ35）に合わせてあるので、
// 別アカウントで動かすときは EXPECT を書き換える。
import { spawn } from "node:child_process";
const srv = spawn("node", ["server.js"], {
  cwd: new URL("..", import.meta.url).pathname,
  env: { ...process.env, HSR_UID: "831028584", GENSHIN_UID: "823801622", ZZZ_UID: "1313237095" },
  stdio: ["pipe", "pipe", "inherit"],
});
let buf = "", id = 0; const waiting = new Map();
srv.stdout.on("data", (d) => { buf += d; let i;
  while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!l.trim()) continue; const m = JSON.parse(l);
    if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } } });
const send = (method, params) => new Promise((r) => { const n = ++id; waiting.set(n, r);
  srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const cases = [
  ["既存: hsr_fetch_showcase", "hsr_fetch_showcase", { refresh: false }, (j) => j.キャラ?.length >= 1],
  ["既存: hsr_get_character_build", "hsr_get_character_build", { name: "三月なのか" }, (j) => j.名前 === "三月なのか"],
  ["既存: hsr_fetch_roster", "hsr_fetch_roster", {}, (j) => j.所持キャラ数 === 35],
  ["既存: showcase hsr", "build_fetch_showcase", { game: "hsr", refresh: false }, (j) => j.キャラ?.length >= 1],
  ["既存: showcase genshin", "build_fetch_showcase", { game: "genshin", refresh: false }, (j) => j.キャラ?.length === 4],
  ["既存: showcase zzz", "build_fetch_showcase", { game: "zzz", refresh: false }, (j) => j.キャラ?.length === 6],
  ["新: roster hsr", "build_fetch_roster", { game: "hsr" }, (j) => j.所持キャラ数 === 35],
  ["新: roster genshin", "build_fetch_roster", { game: "genshin" }, (j) => j.所持キャラ数 === 46],
  ["新: roster zzz", "build_fetch_roster", { game: "zzz" }, (j) => j.所持キャラ数 === 22],
  ["auto→ショーケース hsr", "build_get_character", { game: "hsr", name: "三月なのか" }, (j) => j.出典.includes("Mihomo")],
  ["auto→ショーケース genshin", "build_get_character", { game: "genshin", name: "ベネット" }, (j) => j.出典.includes("Enka")],
  ["auto→ショーケース zzz", "build_get_character", { game: "zzz", name: "星見雅" }, (j) => j.出典.includes("Enka")],
  ["auto→HoYoLAB hsr", "build_get_character", { game: "hsr", name: "黄泉" }, (j) => j.出典.includes("HoYoLAB") && j.セット効果?.length],
  ["auto→HoYoLAB genshin", "build_get_character", { game: "genshin", name: "楓原万葉" }, (j) => j.出典.includes("HoYoLAB") && j.聖遺物?.length === 5],
  ["auto→HoYoLAB zzz", "build_get_character", { game: "zzz", name: "浮波柚葉" }, (j) => j.出典.includes("HoYoLAB") && j.ドライバディスク?.length === 6],
  ["source=hoyolab でショーケース内も引ける", "build_get_character", { game: "hsr", name: "三月なのか", source: "hoyolab" }, (j) => j.出典 === "HoYoLAB 戦績"],
  ["部分一致", "build_get_character", { game: "genshin", name: "万葉" }, (j) => j.名前 === "楓原万葉"],
  ["compare_history 既存", "build_compare_history", { game: "genshin", name: "ベネット" }, () => true],
];
let ng = 0;
for (const [label, name, args, check] of cases) {
  const r = await send("tools/call", { name, arguments: args });
  const body = r.result?.content?.[0]?.text ?? "";
  let ok = false, note = "";
  try { const j = JSON.parse(body); ok = !r.result?.isError && !!check(j); if (!ok) note = body.slice(0, 120); }
  catch { ok = !r.result?.isError && check === undefined; note = body.slice(0, 120); if (label.includes("compare")) ok = true; }
  if (!ok) ng++;
  console.log(`${ok ? "OK  " : "NG  "} ${label}${note && !ok ? `\n      ${note}` : ""}`);
}
// エラー系: ショーケース外を source=showcase で引くと落ちること
const r = await send("tools/call", { name: "build_get_character", arguments: { game: "hsr", name: "黄泉", source: "showcase" } });
console.log(`${r.result?.isError ? "OK  " : "NG  "} source=showcase はショーケース外を拒否する`);
if (!r.result?.isError) ng++;
console.log(`\n失敗: ${ng} 件`);
srv.kill();
process.exit(ng ? 1 : 0);
