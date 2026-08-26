// ============================================================================
// qr_test.mjs — proving js/lib/qr.js produces codes a real scanner can read.
//
// THE PROBLEM THIS TEST SOLVES
// There is no QR decoder available here. BarcodeDetector does not exist in
// Chrome on Windows or Linux (it is a phone and macOS API), the npm registry
// is unreachable from this machine, and nothing in node_modules reads a
// barcode. So an encoder written from the spec could be confidently wrong and
// nothing would say so until somebody pointed a phone at the screen.
//
// So the oracle is built here, deliberately in a different shape from the
// encoder: the encoder DRAWS function patterns with loops, this decodes them
// with a geometric predicate; the encoder walks the zigzag placing bits, this
// walks it collecting them.
//
// The load-bearing check is the Reed-Solomon SYNDROMES. If a single module is
// misplaced, or the block interleaving is off by one, or a mask is applied to
// the wrong region, the de-interleaved blocks stop satisfying their parity —
// and passing that by accident is about 2^-80. Zero syndromes plus a payload
// that round-trips is as close to "a scanner will read this" as can be had
// without a scanner.
//
// The GF(256) field is checked separately and from first principles, because
// it is the one thing the encoder and this decoder would otherwise share.
//
//   usage:  node tests/qr_test.mjs
// ============================================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = { console, TextEncoder, TextDecoder };
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.runInContext(readFileSync(join(ROOT, "js/lib/qr.js"), "utf8"),
  vm.createContext(sandbox), { filename: "qr.js" });
const QR = sandbox.QR;

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  PASS  " + msg); }
  else { fail++; console.log("  FAIL  " + msg + (detail ? "\n        " + detail : "")); }
};
const section = (s) => console.log("\n" + s);

// ---------------------------------------------------------------------------
//  The spec's tables, written out a second time on purpose. A typo in either
//  copy shows up as a decode failure rather than as agreement.
// ---------------------------------------------------------------------------
const ECC_PER_BLOCK = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};
const NUM_BLOCKS = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};
const FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };
const LEVEL_OF = { 1: "L", 0: "M", 3: "Q", 2: "H" };

// ---- GF(256), built here by a different route -----------------------------
// The encoder builds exp/log by doubling. This multiplies carry-lessly and
// reduces by the primitive polynomial each time, which is the definition
// rather than a table walk.
function gfMulDirect(a, b) {
  let result = 0;
  for (let i = 7; i >= 0; i--) {
    result = (result << 1) ^ ((result >>> 7) * 0x11D);
    result ^= ((b >>> i) & 1) * a;
  }
  return result & 0xFF;
}
const EXP = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; x = gfMulDirect(x, 2); }
}

function rawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}
function alignPositions(ver) {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  const step = (ver === 32) ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const size = ver * 4 + 17, out = [6];
  for (let pos = size - 7; out.length < numAlign; pos -= step) out.splice(1, 0, pos);
  return out;
}

// A geometric predicate rather than a drawing routine: this is where the two
// implementations are least alike, and therefore where a placement bug in
// either one shows up.
function isFunctionModule(x, y, ver) {
  const size = ver * 4 + 17;
  if (x === 6 || y === 6) return true;                                   // timing
  if (x < 9 && y < 9) return true;                                       // finder + format, TL
  if (x >= size - 8 && y < 9) return true;                               // finder + format, TR
  if (x < 9 && y >= size - 8) return true;                               // finder + format, BL
  if (ver >= 7) {
    if (x >= size - 11 && x <= size - 9 && y <= 5) return true;          // version, TR
    if (y >= size - 11 && y <= size - 9 && x <= 5) return true;          // version, BL
  }
  const pos = alignPositions(ver), last = pos.length - 1;
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      if (Math.abs(x - pos[i]) <= 2 && Math.abs(y - pos[j]) <= 2) return true;
    }
  }
  return false;
}

function maskBit(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return x * y % 2 + x * y % 3 === 0;
    case 6: return (x * y % 2 + x * y % 3) % 2 === 0;
    case 7: return ((x + y) % 2 + x * y % 3) % 2 === 0;
  }
  throw new Error("bad mask " + mask);
}

/** Read the 15 format bits from the top-left copy and BCH-correct them. */
function readFormat(code) {
  const bits = [];
  for (let k = 0; k <= 5; k++) bits[k] = code.get(8, k) ? 1 : 0;
  bits[6] = code.get(8, 7) ? 1 : 0;
  bits[7] = code.get(8, 8) ? 1 : 0;
  bits[8] = code.get(7, 8) ? 1 : 0;
  for (let k = 9; k < 15; k++) bits[k] = code.get(14 - k, 8) ? 1 : 0;
  let raw = 0;
  for (let k = 0; k < 15; k++) raw |= bits[k] << k;

  // All 32 legal format strings, generated here, and the closest one wins.
  let best = -1, bestDist = 99, bestData = -1;
  for (let d = 0; d < 32; d++) {
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const val = (((d << 10) | rem) ^ 0x5412) & 0x7FFF;
    let dist = 0, diff = val ^ raw;
    while (diff) { dist += diff & 1; diff >>>= 1; }
    if (dist < bestDist) { bestDist = dist; best = val; bestData = d; }
  }
  return { distance: bestDist, level: LEVEL_OF[bestData >> 3], mask: bestData & 7 };
}

/** Walk the zigzag collecting the bits the encoder placed. */
function readCodewords(code, ver, mask) {
  const size = code.size, bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let k = 0; k < 2; k++) {
        const x = right - k;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (isFunctionModule(x, y, ver)) continue;
        let bit = code.get(x, y) ? 1 : 0;
        if (maskBit(mask, x, y)) bit ^= 1;
        bits.push(bit);
      }
    }
  }
  const raw = Math.floor(rawDataModules(ver) / 8);
  const out = new Uint8Array(raw);
  for (let i = 0; i < raw * 8; i++) out[i >>> 3] |= bits[i] << (7 - (i & 7));
  return out;
}

/**
 * Undo the interleaving.
 *
 * Every block is read back into a uniform-length array with the ECC at the
 * end, exactly the shape the encoder interleaved out of, and then compacted
 * to data||ecc so the syndromes can be taken over a contiguous codeword.
 */
function deinterleave(codewords, ver, level) {
  const numBlocks = NUM_BLOCKS[level][ver];
  const eccLen = ECC_PER_BLOCK[level][ver];
  const raw = codewords.length;
  const numShortBlocks = numBlocks - raw % numBlocks;
  const shortBlockLen = Math.floor(raw / numBlocks);
  const shortDataLen = shortBlockLen - eccLen;

  const padded = [];
  for (let b = 0; b < numBlocks; b++) padded.push(new Uint8Array(shortBlockLen + 1));
  let n = 0;
  for (let c = 0; c < shortBlockLen + 1; c++) {
    for (let b = 0; b < numBlocks; b++) {
      if (c !== shortDataLen || b >= numShortBlocks) padded[b][c] = codewords[n++];
    }
  }

  const dataLens = [], blocks = [];
  for (let b = 0; b < numBlocks; b++) {
    const datLen = shortDataLen + (b < numShortBlocks ? 0 : 1);
    const blk = new Uint8Array(datLen + eccLen);
    blk.set(padded[b].subarray(0, datLen), 0);
    blk.set(padded[b].subarray(padded[b].length - eccLen), datLen);
    dataLens.push(datLen);
    blocks.push(blk);
  }
  return { blocks, eccLen, dataLens, numBlocks };
}

/** Syndromes: the block polynomial evaluated at alpha^0 .. alpha^(eccLen-1). */
function syndromesZero(block, eccLen) {
  for (let i = 0; i < eccLen; i++) {
    let acc = 0;
    for (let j = 0; j < block.length; j++) acc = gfMulDirect(acc, EXP[i]) ^ block[j];
    if (acc !== 0) return false;
  }
  return true;
}

/** The whole thing: matrix in, original string out. */
function decode(code) {
  const ver = (code.size - 17) / 4;
  const fmt = readFormat(code);
  const codewords = readCodewords(code, ver, fmt.mask);
  const { blocks, eccLen, dataLens, numBlocks } = deinterleave(codewords, ver, fmt.level);

  for (const b of blocks) {
    if (!syndromesZero(b, eccLen)) return { error: "Reed-Solomon parity failed", fmt };
  }

  // Data halves of the blocks, back in order.
  const data = [];
  for (let b = 0; b < numBlocks; b++) {
    for (let i = 0; i < dataLens[b]; i++) data.push(blocks[b][i]);
  }

  let bitPos = 0;
  const take = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      v = (v << 1) | ((data[bitPos >>> 3] >>> (7 - (bitPos & 7))) & 1);
      bitPos++;
    }
    return v;
  };
  const mode = take(4);
  if (mode !== 4) return { error: "mode was " + mode + ", expected byte mode (4)", fmt };
  const len = take(ver <= 9 ? 8 : 16);
  const bytes = [];
  for (let i = 0; i < len; i++) bytes.push(take(8));
  return { text: new TextDecoder().decode(new Uint8Array(bytes)), fmt, version: ver };
}

// ===========================================================================
section("1. The field the whole thing stands on");
{
  // If GF(256) is wrong, encoder and decoder agree with each other and every
  // real scanner disagrees with both. So it is checked from the definition.
  const seen = new Set();
  for (let i = 0; i < 255; i++) seen.add(EXP[i]);
  ok(seen.size === 255 && !seen.has(0),
     "alpha generates all 255 non-zero elements — it really is primitive");
  ok(EXP[0] === 1 && gfMulDirect(1, 200) === 200, "one is the identity");
  ok(gfMulDirect(0, 137) === 0, "zero annihilates");
  let assoc = true, distrib = true;
  for (let a = 1; a < 40; a++) {
    for (let b = 1; b < 40; b++) {
      if (gfMulDirect(a, b) !== gfMulDirect(b, a)) assoc = false;
      if (gfMulDirect(a, b ^ 7) !== (gfMulDirect(a, b) ^ gfMulDirect(a, 7))) distrib = false;
    }
  }
  ok(assoc, "multiplication commutes");
  ok(distrib, "and distributes over XOR — which is what makes the parity linear");
}

section("2. A code that decodes back to what went in");
{
  const text = "PM2|9f8c2b1a-4d5e-4f60-8a71-2c3d4e5f6071|305381816519983229585816409962";
  const code = QR.encode(text);
  ok(code.size === code.version * 4 + 17, "the matrix is the size its version says", code.size + "px");
  const got = decode(code);
  ok(!got.error, "it decodes without a Reed-Solomon complaint", got.error);
  ok(got.text === text, "and yields exactly the string that was encoded", got.text);
  ok(got.fmt.distance === 0, "the format information is bit-perfect, not merely correctable");
  ok(got.fmt.level === "M", "at the default error-correction level M");
  ok(got.fmt.mask === code.mask, "and names the mask the encoder chose", String(code.mask));
}

section("3. The structure a scanner looks for first");
{
  const code = QR.encode("finder patterns");
  const size = code.size;
  const finderOk = (ox, oy) => {
    for (let dy = 0; dy < 7; dy++) {
      for (let dx = 0; dx < 7; dx++) {
        const d = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        if (code.get(ox + dx, oy + dy) !== (d !== 2)) return false;
      }
    }
    return true;
  };
  ok(finderOk(0, 0), "the top-left finder is a finder");
  ok(finderOk(size - 7, 0), "so is the top-right");
  ok(finderOk(0, size - 7), "and the bottom-left");
  // The fourth corner carries an ALIGNMENT pattern, whose centre module is
  // dark — so "is it dark" proves nothing. What matters is that it is not a
  // finder, because three finders and one not-finder is how a scanner works
  // out which way up the code is.
  ok(!finderOk(size - 7, size - 7),
     "the fourth corner is NOT a finder — that is how orientation is read");

  let timing = true;
  for (let i = 8; i < size - 8; i++) {
    if (code.get(i, 6) !== (i % 2 === 0)) timing = false;
    if (code.get(6, i) !== (i % 2 === 0)) timing = false;
  }
  ok(timing, "both timing lines alternate for their whole length");
  ok(code.get(8, size - 8), "the module that is always dark, is");
}

section("4. Every level and a lot of lengths");
{
  const levels = ["L", "M", "Q", "H"];
  let allOk = true, worst = "";
  for (const ecc of levels) {
    for (const len of [1, 2, 15, 16, 17, 40, 120, 250, 600, 1200]) {
      let text = "";
      for (let i = 0; i < len; i++) text += "abcdefghijklmnopqrstuvwxyz0123456789"[i % 36];
      const got = decode(QR.encode(text, { ecc }));
      if (got.error || got.text !== text || got.fmt.level !== ecc) {
        allOk = false;
        worst = ecc + "/" + len + ": " + (got.error || "text mismatch");
      }
    }
  }
  ok(allOk, "40 combinations of level and length all round-trip", worst);
}

section("5. Version boundaries, where off-by-one lives");
{
  // The character-count field grows from 8 bits to 16 at version 10, and the
  // alignment patterns arrive at 2 and multiply at 7. Those are the seams.
  let allOk = true, note = "";
  for (let target = 1; target <= 40; target += 1) {
    const code = QR.encode("x", { ecc: "L", minVersion: target });
    const got = decode(code);
    if (got.error || got.text !== "x" || got.version !== target) {
      allOk = false;
      note = "v" + target + ": " + (got.error || "got v" + got.version);
      break;
    }
  }
  ok(allOk, "all 40 versions build and decode, including 7 and 10 where the rules change", note);
}

section("6. Random payloads, because handpicked ones flatter the author");
{
  let bad = 0, example = "";
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789|:-_./ ";
  for (let n = 0; n < 200; n++) {
    const len = 1 + Math.floor(Math.random() * 300);
    let text = "";
    for (let i = 0; i < len; i++) text += alphabet[Math.floor(Math.random() * alphabet.length)];
    const ecc = ["L", "M", "Q", "H"][n % 4];
    const got = decode(QR.encode(text, { ecc }));
    if (got.error || got.text !== text) { bad++; if (!example) example = (got.error || "mismatch") + " len=" + len; }
  }
  ok(bad === 0, "200 random payloads across all four levels round-trip", example);
}

section("7. Non-ASCII, because names here are not all ASCII");
{
  const text = "Juma Mwanga — Nyamagana · Mwanza";
  const got = decode(QR.encode(text));
  ok(!got.error && got.text === text, "UTF-8 survives the trip", got.error || got.text);
}

section("8. Refusing rather than truncating");
{
  let threw = false;
  try {
    let huge = "";
    for (let i = 0; i < 5000; i++) huge += "0123456789";
    QR.encode(huge, { ecc: "H" });
  } catch (_) { threw = true; }
  ok(threw, "more data than any version holds is an error, not a silently clipped code");
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
