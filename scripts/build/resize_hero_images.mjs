// Resize every JPG in bus web/data/ in place.
// Backs up originals to bus web/data/_originals/ (skips if already backed up).
// Target: max 1200px wide, JPEG quality 70.
// Skips files already at/below the target dimensions.

import { Jimp } from "jimp";
import { readdir, readFile, writeFile, stat, mkdir, copyFile, access } from "node:fs/promises";
import { join } from "node:path";
import jpeg from "jpeg-js";

// Bump jpeg-js memory cap so very-large unsplash JPGs don't get rejected.
// Default is 512MB; some 5000x6000 source files need ~600MB to decode.
const JPEG_DECODE_OPTS = { maxMemoryUsageInMB: 2048, maxResolutionInMP: 600 };

const DATA_DIR = join(process.cwd(), "data");
const BACKUP_DIR = join(DATA_DIR, "_originals");
const TARGET_WIDTH = 1200;
const QUALITY = 70;

await mkdir(BACKUP_DIR, { recursive: true });

const files = (await readdir(DATA_DIR))
  .filter(f => /\.jpe?g$/i.test(f));

let totalBefore = 0, totalAfter = 0, skipped = 0;

for (const name of files) {
  const path = join(DATA_DIR, name);
  const backupPath = join(BACKUP_DIR, name);

  const before = (await stat(path)).size;
  totalBefore += before;

  let alreadyBackedUp = true;
  try { await access(backupPath); } catch { alreadyBackedUp = false; }
  if (!alreadyBackedUp) await copyFile(path, backupPath);

  // Decode via jpeg-js directly so we can bump its memory cap, then hand the
  // raw bitmap to Jimp for the resize.
  const raw = await readFile(path);
  const decoded = jpeg.decode(raw, { ...JPEG_DECODE_OPTS, useTArray: true });
  const img = new Jimp({ width: decoded.width, height: decoded.height, data: Buffer.from(decoded.data) });

  const w = img.bitmap.width;
  if (w <= TARGET_WIDTH && before < 500_000) {
    skipped++;
    totalAfter += before;
    console.log(`${name}: ${(before/1024).toFixed(0)}KB  (skip — already small)`);
    continue;
  }

  if (w > TARGET_WIDTH) img.resize({ w: TARGET_WIDTH });
  const encoded = jpeg.encode(img.bitmap, QUALITY);
  await writeFile(path, encoded.data);

  const after = (await stat(path)).size;
  totalAfter += after;
  const pct = ((1 - after / before) * 100).toFixed(1);
  console.log(`${name}: ${(before/1024).toFixed(0)}KB → ${(after/1024).toFixed(0)}KB (-${pct}%)`);
}

console.log(`\nProcessed ${files.length} files (${skipped} skipped).`);
console.log(`Total: ${(totalBefore/1024/1024).toFixed(1)}MB → ${(totalAfter/1024/1024).toFixed(1)}MB ` +
  `(-${((1 - totalAfter/totalBefore) * 100).toFixed(1)}%)`);
