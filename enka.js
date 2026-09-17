// Enka.Network アダプタ（原神 / ゼンレスゾーンゼロ）
// Enka は ID しか返さないため、公開されている変換表（store/*.json）を取得して名前を解決する。
// スタレは Mihomo の parsed API のほうが整形済みで扱いやすいため、そちらを使い続ける（server.js 側）。
import fs from "node:fs/promises";
import path from "node:path";

const ENKA = "https://enka.network/api";
const ASSET = "https://raw.githubusercontent.com/EnkaNetwork/API-docs/master/store";
const UA = "game-build-mcp/1.1 (+https://github.com/toshi-developer/game-build-mcp)";
const ASSET_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const GAMES = {
  genshin: { label: "原神", uidPath: (u) => `${ENKA}/uid/${u}` },
  zzz: { label: "ゼンレスゾーンゼロ", uidPath: (u) => `${ENKA}/zzz/uid/${u}` },
};

// ---------- 変換表のキャッシュ ----------

async function asset(dataDir, rel) {
  const file = path.join(dataDir, "assets", rel.replace(/\//g, "_"));
  try {
    const st = await fs.stat(file);
    if (Date.now() - st.mtimeMs < ASSET_TTL_MS) return JSON.parse(await fs.readFile(file, "utf8"));
  } catch { /* 無ければ取りに行く */ }

  const res = await fetch(`${ASSET}/${rel}`, { headers: { "User-Agent": UA } });
  if (!res.ok) {
    // 期限切れでも手元にあるなら使う（ネットワーク断でも動くように）
    try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { /* noop */ }
    throw new Error(`変換表の取得に失敗しました: ${rel} (HTTP ${res.status})`);
  }
  const body = await res.text();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body);
  return JSON.parse(body);
}

// ---------- 取得 ----------

export async function fetchEnka(game, uid) {
  const g = GAMES[game];
  if (!g) throw new Error(`未対応のゲームです: ${game}`);
  // 末尾スラッシュを付けると 308 になるので付けない
  const res = await fetch(g.uidPath(uid), { headers: { "User-Agent": UA } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let msg = "";
    try { msg = JSON.parse(body).message || ""; } catch { /* noop */ }
    const hint =
      res.status === 404 ? "（UIDが存在しないか、プロフィールが非公開の可能性）" :
      res.status === 424 ? "（ゲーム側のメンテナンス中）" :
      res.status === 429 ? "（アクセス過多。ttl の秒数を空けてください）" : "";
    throw new Error(`Enka APIエラー: HTTP ${res.status} ${msg}${hint}`);
  }
  return res.json();
}

// ---------- 原神 ----------

const GI_PROP_JA = {
  FIGHT_PROP_HP: "HP", FIGHT_PROP_HP_PERCENT: "HP%", FIGHT_PROP_BASE_HP: "基礎HP",
  FIGHT_PROP_ATTACK: "攻撃力", FIGHT_PROP_ATTACK_PERCENT: "攻撃力%", FIGHT_PROP_BASE_ATTACK: "基礎攻撃力",
  FIGHT_PROP_DEFENSE: "防御力", FIGHT_PROP_DEFENSE_PERCENT: "防御力%", FIGHT_PROP_BASE_DEFENSE: "基礎防御力",
  FIGHT_PROP_CRITICAL: "会心率", FIGHT_PROP_CRITICAL_HURT: "会心ダメージ",
  FIGHT_PROP_CHARGE_EFFICIENCY: "元素チャージ効率", FIGHT_PROP_ELEMENT_MASTERY: "元素熟知",
  FIGHT_PROP_HEAL_ADD: "与える治療効果", FIGHT_PROP_HEALED_ADD: "受ける治療効果",
  FIGHT_PROP_PHYSICAL_ADD_HURT: "物理ダメージ",
  FIGHT_PROP_FIRE_ADD_HURT: "炎元素ダメージ", FIGHT_PROP_ELEC_ADD_HURT: "雷元素ダメージ",
  FIGHT_PROP_WATER_ADD_HURT: "水元素ダメージ", FIGHT_PROP_GRASS_ADD_HURT: "草元素ダメージ",
  FIGHT_PROP_WIND_ADD_HURT: "風元素ダメージ", FIGHT_PROP_ROCK_ADD_HURT: "岩元素ダメージ",
  FIGHT_PROP_ICE_ADD_HURT: "氷元素ダメージ",
};
const GI_PROP_PERCENT = new Set(Object.keys(GI_PROP_JA).filter((k) => /PERCENT|CRITICAL|EFFICIENCY|ADD_HURT|HEAL/.test(k)));

// fightPropMap（最終ステータス）のうち相談で使うものだけ
const GI_FIGHT = [
  ["2000", "HP", false], ["2001", "攻撃力", false], ["2002", "防御力", false],
  ["28", "元素熟知", false], ["20", "会心率", true], ["22", "会心ダメージ", true],
  ["23", "元素チャージ効率", true], ["26", "与える治療効果", true], ["30", "物理ダメージ", true],
  ["40", "炎元素ダメージ", true], ["41", "雷元素ダメージ", true], ["42", "水元素ダメージ", true],
  ["43", "草元素ダメージ", true], ["44", "風元素ダメージ", true], ["45", "岩元素ダメージ", true],
  ["46", "氷元素ダメージ", true],
];

// AddProps 等で使われる数値の FIGHT_PROP
const GI_PROP_NUM_JA = {
  1: "基礎HP", 2: "HP", 3: "HP%", 4: "基礎攻撃力", 5: "攻撃力", 6: "攻撃力%",
  7: "基礎防御力", 8: "防御力", 9: "防御力%", 20: "会心率", 22: "会心ダメージ",
  23: "元素チャージ効率", 26: "与える治療効果", 28: "元素熟知", 29: "物理耐性",
  30: "物理ダメージ", 40: "炎元素ダメージ", 41: "雷元素ダメージ", 42: "水元素ダメージ",
  43: "草元素ダメージ", 44: "風元素ダメージ", 45: "岩元素ダメージ", 46: "氷元素ダメージ",
  50: "炎元素耐性", 51: "雷元素耐性", 52: "水元素耐性", 53: "草元素耐性",
  54: "風元素耐性", 55: "岩元素耐性", 56: "氷元素耐性",
};
const GI_NUM_PERCENT = new Set([3, 6, 9, 20, 22, 23, 26, 29, 30, 40, 41, 42, 43, 44, 45, 46, 50, 51, 52, 53, 54, 55, 56]);

const GI_SLOT_JA = {
  EQUIP_BRACER: "生の花", EQUIP_NECKLACE: "死の羽", EQUIP_SHOES: "時の砂",
  EQUIP_RING: "空の杯", EQUIP_DRESS: "理の冠",
};
const GI_ELEMENT_JA = { Fire: "炎", Water: "水", Wind: "風", Electric: "雷", Grass: "草", Ice: "氷", Rock: "岩" };

const num = (v, pct) => (pct ? `${(v * 100).toFixed(1)}%` : String(Math.round(v)));

async function giAssets(dataDir) {
  // 聖遺物のセット名は gi/locs.json ではなく共通の loc.json 側にあるためマージする
  const [avatars, weapons, locs, topLoc, relics] = await Promise.all([
    asset(dataDir, "gi/avatars.json"),
    asset(dataDir, "gi/weapons.json"),
    asset(dataDir, "gi/locs.json"),
    asset(dataDir, "loc.json"),
    asset(dataDir, "gi/relics.json"),
  ]);
  const pick = (o) => o?.ja ?? o?.en ?? {};
  return { avatars, weapons, relics, loc: { ...pick(locs), ...pick(topLoc) } };
}

// Enka の辞書に無いセットがある。名前を推測すると助言を誤らせるので、
// セットIDと「2セット効果」を機械的に出して識別できるようにする。
function giSetLabel(relics, loc, hash, itemId) {
  const known = loc[String(hash)];
  if (known) return known;
  const item = relics?.Items?.[String(itemId)];
  const set = item ? relics?.Sets?.[String(item.SetId)] : null;
  if (!set) return `(未収録セット:${hash})`;
  const bonus = Object.entries(set.AddProps ?? {})
    .map(([k, v]) => {
      const n = Number(k);
      const label = GI_PROP_NUM_JA[n] ?? `prop${k}`;
      return `${label}+${GI_NUM_PERCENT.has(n) ? `${(v * 100).toFixed(1)}%` : v}`;
    })
    .join(" ");
  return `(未収録セットID:${item.SetId}${bonus ? ` / 2セット:${bonus}` : ""})`;
}

export async function normalizeGenshin(raw, dataDir) {
  const { avatars, weapons, relics, loc } = await giAssets(dataDir);
  const L = (h) => loc[String(h)] ?? `(ID:${h})`;
  const p = raw.playerInfo ?? {};

  const characters = (raw.avatarInfoList ?? []).map((a) => {
    const meta = avatars[String(a.avatarId)] ?? avatars[`${a.avatarId}-${a.skillDepotId}`] ?? {};
    const name = meta.NameTextMapHash ? L(meta.NameTextMapHash) : `(ID:${a.avatarId})`;
    const level = Number(a.propMap?.["4001"]?.val ?? 0);
    const ascension = Number(a.propMap?.["1002"]?.val ?? 0);

    let weapon = null;
    const artifacts = [];
    for (const e of a.equipList ?? []) {
      const flat = e.flat ?? {};
      if (e.weapon) {
        const wmeta = weapons[String(e.itemId)] ?? {};
        weapon = {
          名前: wmeta.NameTextMapHash ? L(wmeta.NameTextMapHash) : L(flat.nameTextMapHash),
          レア: flat.rankLevel,
          Lv: e.weapon.level,
          精錬: (Object.values(e.weapon.affixMap ?? {})[0] ?? 0) + 1,
          ステータス: (flat.weaponStats ?? []).map((s) => `${GI_PROP_JA[s.appendPropId] ?? s.appendPropId} ${s.statValue}`),
        };
      } else if (e.reliquary) {
        const main = flat.reliquaryMainstat ?? {};
        artifacts.push({
          部位: GI_SLOT_JA[flat.equipType] ?? flat.equipType,
          セット: giSetLabel(relics, loc, flat.setNameTextMapHash, e.itemId),
          レア: flat.rankLevel,
          強化: `+${(e.reliquary.level ?? 1) - 1}`,
          メイン: main.mainPropId ? `${GI_PROP_JA[main.mainPropId] ?? main.mainPropId} ${main.statValue}` : null,
          サブ: (flat.reliquarySubstats ?? []).map((s) => `${GI_PROP_JA[s.appendPropId] ?? s.appendPropId} ${s.statValue}`),
        });
      }
    }

    const setCount = {};
    for (const r of artifacts) setCount[r.セット] = (setCount[r.セット] ?? 0) + 1;

    const fp = a.fightPropMap ?? {};
    const statsRaw = {};
    const stats = [];
    for (const [k, label, pct] of GI_FIGHT) {
      const v = fp[k];
      if (v === undefined) continue;
      if (pct && Math.abs(v) < 1e-9) continue; // 0%の元素ダメバフは省く
      statsRaw[label] = { value: v, percent: pct };
      stats.push(`${label} ${num(v, pct)}`);
    }

    const order = meta.SkillOrder ?? [];
    const talents = order.map((id, i) => {
      const lv = a.skillLevelMap?.[String(id)] ?? 0;
      const extra = a.proudSkillExtraLevelMap?.[String((meta.ProudMap ?? {})[String(id)])] ?? 0;
      return `${["通常攻撃", "元素スキル", "元素爆発"][i] ?? `天賦${i + 1}`}: Lv${lv}${extra ? `(+${extra})` : ""}`;
    });

    return {
      名前: name,
      属性: GI_ELEMENT_JA[meta.Element] ?? meta.Element ?? null,
      レア: meta.QualityType === "QUALITY_ORANGE" ? 5 : meta.QualityType === "QUALITY_PURPLE" ? 4 : null,
      Lv: level,
      突破: ascension,
      命ノ星座: (a.talentIdList ?? []).length,
      好感度: a.fetterInfo?.expLevel ?? null,
      武器: weapon ? `${weapon.名前} Lv${weapon.Lv} 精錬${weapon.精錬}` : "なし",
      聖遺物セット: Object.entries(setCount).map(([n, c]) => `${n}(${c})`),
      _weapon: weapon,
      _artifacts: artifacts,
      _talents: talents,
      _stats: stats,
      _statsRaw: statsRaw,
    };
  });

  return {
    player: {
      名前: p.nickname, Lv: p.level, 世界ランク: p.worldLevel,
      達成数: p.finishAchievementNum,
      深境螺旋: p.towerFloorIndex ? `第${p.towerFloorIndex}層 ${p.towerLevelIndex}間` : null,
      UID: raw.uid,
    },
    characters,
    ttl: raw.ttl,
  };
}

// ---------- ゼンレスゾーンゼロ ----------

async function zzzAssets(dataDir) {
  const [avatars, weapons, equipments, locs, property] = await Promise.all([
    asset(dataDir, "zzz/avatars.json"),
    asset(dataDir, "zzz/weapons.json"),
    asset(dataDir, "zzz/equipments.json"),
    asset(dataDir, "zzz/locs.json"),
    asset(dataDir, "zzz/property.json"),
  ]);
  return { avatars, weapons, equipments, property, loc: locs.ja ?? locs.en ?? {} };
}

const ZZZ_PROFESSION_JA = {
  Attack: "強攻", Stun: "撃破", Anomaly: "異常", Support: "支援", Defense: "防護", Rupture: "命破",
};
const ZZZ_ELEMENT_JA = {
  Fire: "炎", Ice: "氷", Elec: "電気", Ether: "エーテル", Physics: "物理",
  Frost: "霜", FireFrost: "烈霜", AuricInk: "玄墨",
};
const ZZZ_SKILL_JA = ["通常攻撃", "回避", "支援攻撃", "特殊スキル", "連携スキル", "終結スキル", "コアスキル"];

function zzzProp(property, loc, id) {
  const p = property[String(id)];
  if (!p) return { name: `(ID:${id})`, percent: false };
  return { name: loc[p.Name] ?? p.Name ?? `(ID:${id})`, percent: String(p.Format ?? "").includes("%") };
}
// ZZZ の数値は ×100 で入っている（例: 300 → 3.0%）
const zzzVal = (v, pct) => (pct ? `${(v / 100).toFixed(1)}%` : String(v));

export async function normalizeZZZ(raw, dataDir) {
  const { avatars, weapons, equipments, property, loc } = await zzzAssets(dataDir);
  const pi = raw.PlayerInfo ?? {};
  const social = pi.SocialDetail ?? {};
  const prof = social.ProfileDetail ?? {};

  const characters = (pi.ShowcaseDetail?.AvatarList ?? []).map((a) => {
    const meta = avatars[String(a.Id)] ?? {};
    const name = loc[meta.Name] ?? meta.Name ?? `(ID:${a.Id})`;

    let weapon = null;
    if (a.Weapon) {
      const wmeta = weapons[String(a.Weapon.Id)] ?? {};
      weapon = {
        名前: loc[wmeta.ItemName] ?? wmeta.ItemName ?? `(ID:${a.Weapon.Id})`,
        レア: wmeta.Rarity,
        Lv: a.Weapon.Level,
        突破: a.Weapon.BreakLevel,
        重畳: (a.Weapon.UpgradeLevel ?? 0) + 1,
      };
    }

    const discs = (a.EquippedList ?? []).map((slot) => {
      const eq = slot.Equipment ?? {};
      const item = equipments.Items?.[String(eq.Id)];
      const suit = item ? equipments.Suits?.[String(item.SuitId)] : null;
      const fmt = (list) => (list ?? []).map((x) => {
        const p = zzzProp(property, loc, x.PropertyId);
        return `${p.name} ${zzzVal(x.PropertyValue, p.percent)}${x.PropertyLevel > 1 ? `(+${x.PropertyLevel - 1})` : ""}`;
      });
      return {
        スロット: slot.Slot,
        セット: suit ? (loc[suit.Name] ?? suit.Name) : "(不明)",
        レア: item?.Rarity,
        Lv: eq.Level,
        メイン: fmt(eq.MainPropertyList).join(" / "),
        サブ: fmt(eq.RandomPropertyList),
      };
    });

    const setCount = {};
    for (const d of discs) setCount[d.セット] = (setCount[d.セット] ?? 0) + 1;

    const skills = (a.SkillLevelList ?? [])
      .slice()
      .sort((x, y) => x.Index - y.Index)
      .map((s) => `${ZZZ_SKILL_JA[s.Index] ?? `スキル${s.Index}`}: Lv${s.Level}`);

    return {
      名前: name,
      レア: meta.Rarity === 4 ? "S" : meta.Rarity === 3 ? "A" : meta.Rarity,
      特性: ZZZ_PROFESSION_JA[meta.ProfessionType] ?? meta.ProfessionType ?? null,
      属性: (meta.ElementTypes ?? []).map((e) => ZZZ_ELEMENT_JA[e] ?? e).join("/") || null,
      Lv: a.Level,
      突破: a.PromotionLevel,
      心象映画: a.TalentLevel ?? 0,
      コアスキル: a.CoreSkillEnhancement ?? 0,
      音動機: weapon ? `${weapon.名前} Lv${weapon.Lv} 重畳${weapon.重畳}` : "なし",
      ディスクセット: Object.entries(setCount).map(([n, c]) => `${n}(${c})`),
      _weapon: weapon,
      _discs: discs,
      _skills: skills,
    };
  });

  return {
    player: {
      名前: prof.Nickname ?? "(非公開)",
      Lv: prof.Level ?? null,
      称号: social.Desc || null,
      UID: raw.uid,
    },
    characters,
    ttl: raw.ttl,
  };
}

export async function normalize(game, raw, dataDir) {
  if (game === "genshin") return normalizeGenshin(raw, dataDir);
  if (game === "zzz") return normalizeZZZ(raw, dataDir);
  throw new Error(`未対応のゲームです: ${game}`);
}

// ---------- スタレの遺物セット（HoYoLAB 戦績の整形に使う） ----------
// HoYoLAB は遺物の「部位名」は返すがセット名を返さない。Enka の公開表で解決する。
// hsr/relics.json の Items が 遺物ID→SetID、Sets が SetID→名前ハッシュ＋セット効果。
// 名前ハッシュは hsr/hsr.json の ja で引く。名前が引けないセットは推測で埋めない。
export async function hsrRelicSets(dataDir) {
  const [relics, loc] = await Promise.all([asset(dataDir, "hsr/relics.json"), asset(dataDir, "hsr/hsr.json")]);
  const ja = { ...(loc.en ?? {}), ...(loc.ja ?? {}) };
  const items = relics.Items ?? {};
  const sets = relics.Sets ?? {};
  return {
    setIdOf: (relicId) => items[String(relicId)]?.SetID ?? null,
    setName: (setId) => ja[String(sets[String(setId)]?.Name)] ?? null,
    // セット効果は props から機械的に導く（2セット/4セットの判定込み）
    setProps: (setId, count) => {
      const skills = sets[String(setId)]?.SetSkills ?? {};
      const out = [];
      for (const n of Object.keys(skills).map(Number).sort((a, b) => a - b)) {
        if (n > count) continue;
        const props = skills[String(n)]?.props ?? {};
        const body = Object.entries(props).map(([k, v]) => `${k} ${v > 0 && v < 1 ? `${(v * 100).toFixed(1)}%` : v}`).join(" / ");
        out.push(`${n}セット${body ? `: ${body}` : "（効果は数値化されていません）"}`);
      }
      return out;
    },
  };
}
