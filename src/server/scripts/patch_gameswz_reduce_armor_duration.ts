import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, SwzPatchError, writeSwz } from "./swzPatchUtils";

const ROOT = path.resolve(__dirname, "..", "..");
const BUFF_XML = path.join(ROOT, "client", "content", "xml", "PlayerBuffTypes.xml");
const CBQ_DIR = path.join(ROOT, "client", "content", "localhost", "p", "cbq");
const REDUCE_ARMOR_BUFF = "ReduceArmor";
const REDUCE_ARMOR_DURATION_MS = "3000";

type PatchStats = {
  buffBlocks: number;
  durationsChanged: number;
};

function defaultGameSwzPaths(): string[] {
  return ["Game.swz", "Game.en.swz", "Game.tr.swz"]
    .map((fileName) => path.join(CBQ_DIR, fileName))
    .filter((swzPath) => fs.existsSync(swzPath));
}

function mergeStats(...stats: PatchStats[]): PatchStats {
  return stats.reduce(
    (merged, current) => ({
      buffBlocks: merged.buffBlocks + current.buffBlocks,
      durationsChanged: merged.durationsChanged + current.durationsChanged,
    }),
    { buffBlocks: 0, durationsChanged: 0 },
  );
}

function buffBlock(xml: string, buffName: string): string {
  const match = xml.match(new RegExp(`<BuffType BuffName="${buffName}">[\\s\\S]*?<\\/BuffType>`));
  if (!match) {
    throw new SwzPatchError(`${buffName} block not found`);
  }
  return match[0];
}

function tagValue(block: string, tag: string): string | null {
  return block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))?.[1] ?? null;
}

export function patchReduceArmorDurationXml(xml: string): { xml: string; stats: PatchStats } {
  const stats: PatchStats = { buffBlocks: 0, durationsChanged: 0 };

  const patchedXml = xml.replace(/<BuffType BuffName="ReduceArmor">[\s\S]*?<\/BuffType>/, (block) => {
    stats.buffBlocks += 1;
    const duration = tagValue(block, "Duration");
    if (duration === REDUCE_ARMOR_DURATION_MS) {
      return block;
    }
    if (duration !== "5000") {
      throw new SwzPatchError(`${REDUCE_ARMOR_BUFF} has unexpected Duration ${duration}; expected 5000 or ${REDUCE_ARMOR_DURATION_MS}`);
    }
    stats.durationsChanged += 1;
    return block.replace(/<Duration>[^<]*<\/Duration>/, `<Duration>${REDUCE_ARMOR_DURATION_MS}</Duration>`);
  });

  if (stats.buffBlocks !== 1) {
    throw new SwzPatchError(`${REDUCE_ARMOR_BUFF} block count must be 1, got ${stats.buffBlocks}`);
  }

  return { xml: patchedXml, stats };
}

export function assertReduceArmorDuration(xml: string, label: string): void {
  const block = buffBlock(xml, REDUCE_ARMOR_BUFF);
  if (tagValue(block, "Duration") !== REDUCE_ARMOR_DURATION_MS) {
    throw new SwzPatchError(`${label}: ${REDUCE_ARMOR_BUFF} duration must be ${REDUCE_ARMOR_DURATION_MS}ms`);
  }
  if (tagValue(block, "MagicDefense") !== "-0.2" || tagValue(block, "MeleeDefense") !== "-0.2") {
    throw new SwzPatchError(`${label}: ${REDUCE_ARMOR_BUFF} defense reduction must remain unchanged`);
  }
}

function patchXmlFile(verifyOnly: boolean): PatchStats {
  const original = fs.readFileSync(BUFF_XML, "utf8");
  const patched = patchReduceArmorDurationXml(original);
  const xmlToVerify = verifyOnly ? original : patched.xml;
  assertReduceArmorDuration(xmlToVerify, "PlayerBuffTypes.xml");

  if (!verifyOnly && patched.xml !== original) {
    fs.writeFileSync(BUFF_XML, patched.xml, "utf8");
  }

  return patched.stats;
}

function patchSwz(swzPath: string, verifyOnly: boolean): PatchStats {
  const ctx = parseSwz(swzPath);
  const buffChunk = ctx.chunks.find((chunk) => chunk.xml.includes("<PlayerBuffTypes"));
  if (!buffChunk) {
    throw new SwzPatchError(`${path.basename(swzPath)} missing PlayerBuffTypes`);
  }

  const patched = patchReduceArmorDurationXml(buffChunk.xml);
  const xmlToVerify = verifyOnly ? buffChunk.xml : patched.xml;
  assertReduceArmorDuration(xmlToVerify, path.basename(swzPath));

  if (!verifyOnly && patched.xml !== buffChunk.xml) {
    ensureBackup(swzPath);
    buffChunk.xml = patched.xml;
    writeSwz(ctx);
  }

  return patched.stats;
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
    console.error(`[patch_gameswz_reduce_armor_duration] ${message}`);
    process.exit(1);
  }
}
