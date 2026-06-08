import * as fs from "fs";
import * as path from "path";
import { assertReduceArmorDuration } from "../scripts/patch_gameswz_reduce_armor_duration";
import { parseSwz } from "../scripts/swzPatchUtils";

const ROOT = path.resolve(__dirname, "..", "..");
const BUFF_XML = path.join(ROOT, "client", "content", "xml", "PlayerBuffTypes.xml");
const CBQ_DIR = path.join(ROOT, "client", "content", "localhost", "p", "cbq");

function swzPlayerBuffTypes(swzPath: string): string {
  const chunk = parseSwz(swzPath).chunks.find((entry) => entry.xml.includes("<PlayerBuffTypes"));
  if (!chunk) {
    throw new Error(`${path.basename(swzPath)} must contain PlayerBuffTypes`);
  }
  return chunk.xml;
}

assertReduceArmorDuration(fs.readFileSync(BUFF_XML, "utf8"), "loose XML");

for (const fileName of ["Game.swz", "Game.en.swz", "Game.tr.swz"]) {
  assertReduceArmorDuration(swzPlayerBuffTypes(path.join(CBQ_DIR, fileName)), fileName);
}

console.log("reduce_armor_duration_regression passed");
