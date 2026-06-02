// One-off: compress the two newly-added home-tile photos in place.
// Mirrors resize_hero_images.mjs (1200px wide, JPEG q70) but scoped to just
// these files so the other already-optimized images aren't re-encoded.
import { Jimp } from "jimp";
import { readFile, writeFile, stat, mkdir, copyFile, access } from "node:fs/promises";
import { join } from "node:path";
import jpeg from "jpeg-js";

const JPEG_DECODE_OPTS = { maxMemoryUsageInMB: 2048, maxResolutionInMP: 600 };
const DATA_DIR = join(process.cwd(), "data");
const BACKUP_DIR = join(DATA_DIR, "_originals");
const TARGET_WIDTH = 1200;
const QUALITY = 70;

const TARGETS = [
  "breno-assis-r3WAWU5Fi5Q-unsplash.jpg",
  "maxim-hopman--16na5rDDRk-unsplash.jpg",
];

await mkdir(BACKUP_DIR, { recursive: true });

for (const name of TARGETS) {
  const path = join(DATA_DIR, name);
  const backupPath = join(BACKUP_DIR, name);
  const before = (await stat(path)).size;

  let alreadyBackedUp = true;
  try { await access(backupPath); } catch { alreadyBackedUp = false; }
  if (!alreadyBackedUp) await copyFile(path, backupPath);

  const raw = await readFile(path);
  const decoded = jpeg.decode(raw, { ...JPEG_DECODE_OPTS, useTArray: true });
  const img = new Jimp({ width: decoded.width, height: decoded.height, data: Buffer.from(decoded.data) });

  const w = img.bitmap.width;
  if (w > TARGET_WIDTH) img.resize({ w: TARGET_WIDTH });
  const encoded = jpeg.encode(img.bitmap, QUALITY);
  await writeFile(path, encoded.data);

  const after = (await stat(path)).size;
  const pct = ((1 - after / before) * 100).toFixed(1);
  console.log(`${name}: ${w}px src → ${Math.min(w, TARGET_WIDTH)}px  ${(before/1024).toFixed(0)}KB → ${(after/1024).toFixed(0)}KB (-${pct}%)`);
}
