import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, SwzPatchError, writeSwz } from "./swzPatchUtils";

const ROOT = path.resolve(__dirname, "..", "..");
const POWER_XML = path.join(ROOT, "client", "content", "xml", "PlayerPowerTypes.xml");
const BUFF_XML = path.join(ROOT, "client", "content", "xml", "PlayerBuffTypes.xml");
const CBQ_DIR = path.join(ROOT, "client", "content", "localhost", "p", "cbq");

const BASE_ARMOR_BREAK_BUFF = "ReduceArmor";
const MIST_WALK_ARMOR_BREAK_BUFF = "MistWalkArmorBreak";
const MIST_WALK_ARMOR_BREAK_BUFF_ID = 742;
const MIST_WALK_CLOSE_POWERS = ["MistWalkClose", ...Array.from({ length: 10 }, (_, index) => `MistWalkClose${index + 1}`)];

type PatchStats = {
  powerBlocks: number;
  targetBuffsChanged: number;
  buffTypesChanged: number;
};

function defaultGameSwzPaths(): string[] {
  return ["Game.swz", "Game.en.swz", "Game.tr.swz"]
    .map((fileName) => path.join(CBQ_DIR, fileName))
    .filter((swzPath) => fs.existsSync(swzPath));
}

function mergeStats(...stats: PatchStats[]): PatchStats {
  return stats.reduce(
    (merged, current) => ({
      powerBlocks: merged.powerBlocks + current.powerBlocks,
      targetBuffsChanged: merged.targetBuffsChanged + current.targetBuffsChanged,
      buffTypesChanged: merged.buffTypesChanged + current.buffTypesChanged,
    }),
    { powerBlocks: 0, targetBuffsChanged: 0, buffTypesChanged: 0 },
  );
}

function tagValue(block: string, tag: string): string | null {
  return block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))?.[1] ?? null;
}

function replaceTag(block: string, tag: string, value: string): string {
  if (!new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`).test(block)) {
    throw new SwzPatchError(`Missing ${tag} in block`);
  }
  return block.replace(new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`), `<${tag}>${value}</${tag}>`);
}

function powerBlock(xml: string, powerName: string): string {
  const match = xml.match(new RegExp(`<Power PowerName="${powerName}">[\\s\\S]*?<\\/Power>`));
  if (!match) {
    throw new SwzPatchError(`${powerName} block not found`);
  }
  return match[0];
}

function buffBlock(xml: string, buffName: string): string {
  const match = xml.match(new RegExp(`<BuffType BuffName="${buffName}">[\\s\\S]*?<\\/BuffType>`));
  if (!match) {
    throw new SwzPatchError(`${buffName} block not found`);
  }
  return match[0];
}

function targetBuffs(block: string): string[] {
  return (tagValue(block, "AddTargetBuff") ?? "").split(",").map((part) => part.trim()).filter(Boolean);
}

function addTargetBuff(block: string, buffName: string): { block: string; changed: boolean } {
  const existing = tagValue(block, "AddTargetBuff");
  if (existing === null) {
    const newline = block.includes("\r\n") ? "\r\n" : "\n";
    return {
      block: block.replace("</PowerGroup>", `</PowerGroup>${newline}\t\t<AddTargetBuff>${buffName}</AddTargetBuff>`),
      changed: true,
    };
  }

  const buffs = existing.split(",").map((part) => part.trim()).filter(Boolean);
  if (buffs.includes(buffName)) {
    return { block, changed: false };
  }

  return {
    block: replaceTag(block, "AddTargetBuff", [...buffs, buffName].join(",")),
    changed: true,
  };
}

export function patchMistWalkPowerXml(xml: string): { xml: string; stats: PatchStats } {
  const stats: PatchStats = { powerBlocks: 0, targetBuffsChanged: 0, buffTypesChanged: 0 };
  const targetPowers = new Set(MIST_WALK_CLOSE_POWERS);

  const patchedXml = xml.replace(/<Power PowerName="([^"]+)">[\s\S]*?<\/Power>/g, (block, powerName: string) => {
    if (!targetPowers.has(powerName)) {
      return block;
    }

    stats.powerBlocks += 1;
    if (tagValue(block, "PowerGroup") !== "MistWalk" || tagValue(block, "TargetMethod") !== "PBAoE") {
      throw new SwzPatchError(`${powerName} is not the Mist Walk close AoE power`);
    }

    const patched = addTargetBuff(block, MIST_WALK_ARMOR_BREAK_BUFF);
    if (patched.changed) {
      stats.targetBuffsChanged += 1;
    }
    return patched.block;
  });

  return { xml: patchedXml, stats };
}

function expectedMistWalkArmorBreakBlock(xml: string): string {
  let cloned = buffBlock(xml, BASE_ARMOR_BREAK_BUFF).replace(
    `BuffName="${BASE_ARMOR_BREAK_BUFF}"`,
    `BuffName="${MIST_WALK_ARMOR_BREAK_BUFF}"`,
  );
  cloned = replaceTag(cloned, "BuffID", String(MIST_WALK_ARMOR_BREAK_BUFF_ID));
  cloned = replaceTag(cloned, "Duration", "3000");
  return `\t${cloned}`;
}

export function patchMistWalkBuffXml(xml: string): { xml: string; stats: PatchStats } {
  const stats: PatchStats = { powerBlocks: 0, targetBuffsChanged: 0, buffTypesChanged: 0 };
  const expected = expectedMistWalkArmorBreakBlock(xml);
  const existing = xml.match(new RegExp(`\\r?\\n\\s*<BuffType BuffName="${MIST_WALK_ARMOR_BREAK_BUFF}">[\\s\\S]*?\\r?\\n\\s*<\\/BuffType>`));

  if (existing) {
    const replacement = `\r\n${expected}`;
    if (existing[0] === replacement) {
      return { xml, stats };
    }
    stats.buffTypesChanged = 1;
    return { xml: xml.replace(existing[0], replacement), stats };
  }

  stats.buffTypesChanged = 1;
  return {
    xml: xml.replace(buffBlock(xml, BASE_ARMOR_BREAK_BUFF), `${buffBlock(xml, BASE_ARMOR_BREAK_BUFF)}\r\n${expected}`),
    stats,
  };
}

export function assertMistWalkArmorBreak(powerXml: string, buffXml: string, label: string): void {
  for (const powerName of MIST_WALK_CLOSE_POWERS) {
    const block = powerBlock(powerXml, powerName);
    if (!targetBuffs(block).includes(MIST_WALK_ARMOR_BREAK_BUFF)) {
      throw new SwzPatchError(`${label}: ${powerName} must apply ${MIST_WALK_ARMOR_BREAK_BUFF}`);
    }
  }

  const mistBuff = buffBlock(buffXml, MIST_WALK_ARMOR_BREAK_BUFF);
  if (tagValue(mistBuff, "BuffID") !== String(MIST_WALK_ARMOR_BREAK_BUFF_ID)) {
    throw new SwzPatchError(`${label}: ${MIST_WALK_ARMOR_BREAK_BUFF} BuffID must be ${MIST_WALK_ARMOR_BREAK_BUFF_ID}`);
  }
  if (tagValue(mistBuff, "Duration") !== "3000") {
    throw new SwzPatchError(`${label}: ${MIST_WALK_ARMOR_BREAK_BUFF} must last 3000ms`);
  }
  if (tagValue(mistBuff, "MagicDefense") !== "-0.2" || tagValue(mistBuff, "MeleeDefense") !== "-0.2") {
    throw new SwzPatchError(`${label}: ${MIST_WALK_ARMOR_BREAK_BUFF} must match Armor Break defense reduction`);
  }
  if (tagValue(buffBlock(buffXml, BASE_ARMOR_BREAK_BUFF), "Duration") !== "3000") {
    throw new SwzPatchError(`${label}: global ${BASE_ARMOR_BREAK_BUFF} duration must be 3000ms`);
  }
}

function patchXmlFile(verifyOnly: boolean): PatchStats {
  const powerOriginal = fs.readFileSync(POWER_XML, "utf8");
  const buffOriginal = fs.readFileSync(BUFF_XML, "utf8");
  const powerPatched = patchMistWalkPowerXml(powerOriginal);
  const buffPatched = patchMistWalkBuffXml(buffOriginal);
  const powerXmlToVerify = verifyOnly ? powerOriginal : powerPatched.xml;
  const buffXmlToVerify = verifyOnly ? buffOriginal : buffPatched.xml;
  assertMistWalkArmorBreak(powerXmlToVerify, buffXmlToVerify, "loose XML");

  if (!verifyOnly) {
    if (powerPatched.xml !== powerOriginal) {
      fs.writeFileSync(POWER_XML, powerPatched.xml, "utf8");
    }
    if (buffPatched.xml !== buffOriginal) {
      fs.writeFileSync(BUFF_XML, buffPatched.xml, "utf8");
    }
  }

  return mergeStats(powerPatched.stats, buffPatched.stats);
}

function patchSwz(swzPath: string, verifyOnly: boolean): PatchStats {
  const ctx = parseSwz(swzPath);
  const powerChunk = ctx.chunks.find((chunk) => chunk.xml.includes("<PlayerPowerTypes"));
  const buffChunk = ctx.chunks.find((chunk) => chunk.xml.includes("<PlayerBuffTypes"));
  if (!powerChunk || !buffChunk) {
    throw new SwzPatchError(`${path.basename(swzPath)} missing PlayerPowerTypes or PlayerBuffTypes`);
  }

  const powerPatched = patchMistWalkPowerXml(powerChunk.xml);
  const buffPatched = patchMistWalkBuffXml(buffChunk.xml);
  const powerXmlToVerify = verifyOnly ? powerChunk.xml : powerPatched.xml;
  const buffXmlToVerify = verifyOnly ? buffChunk.xml : buffPatched.xml;
  assertMistWalkArmorBreak(powerXmlToVerify, buffXmlToVerify, path.basename(swzPath));

  if (!verifyOnly && (powerPatched.xml !== powerChunk.xml || buffPatched.xml !== buffChunk.xml)) {
    ensureBackup(swzPath);
    powerChunk.xml = powerPatched.xml;
    buffChunk.xml = buffPatched.xml;
    writeSwz(ctx);
  }

  return mergeStats(powerPatched.stats, buffPatched.stats);
}

function main(): void {
  const verifyOnly = process.argv.includes("--verify") || process.argv.includes("--dry-run");
  const swzPaths = defaultGameSwzPaths();
  const stats = mergeStats(patchXmlFile(verifyOnly), ...swzPaths.map((swzPath) => patchSwz(swzPath, verifyOnly)));

  console.log(JSON.stringify({ verifyOnly, swzPaths, stats }, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[patch_gameswz_mist_walk_armor_break] ${message}`);
    process.exit(1);
  }
}
