// ============================================================================
//  qr.js — a QR encoder, because two people should not have to read thirty
//  digits to each other.
//
//  WHY THIS IS HERE AND NOT AN npm INSTALL
//  The site is served straight from the repo root with no build step, and
//  p-crypto.js already sets the rule this follows: the things that decide
//  whether a message is private have no dependencies. A safety number is one
//  of those things. Roughly 300 lines of well-specified arithmetic is a better
//  trade than a CDN script in the trust path of a verification screen.
//
//  WHAT IT IS
//  QR Model 2, byte mode, versions 1-40, all four error-correction levels,
//  automatic version choice and the full eight-mask penalty search — i.e. an
//  ordinary QR code that ordinary scanners read. It returns a matrix of
//  modules; drawing is the caller's business (see pm-identity-ui.js).
//
//  WHAT IT IS NOT
//  There is no decoder here. Reading a code is the phone's job — Android and
//  Chrome expose BarcodeDetector, which is hardware-accelerated and far better
//  than anything this file could do with a canvas. Where that is missing (iOS
//  Safari, desktop) the thirty digits remain, which is exactly why they were
//  not removed when this arrived.
//
//    QR.encode("text")                     -> { size, get(x, y) }
//    QR.encode("text", { ecc: "H" })
// ============================================================================

(function () {
  "use strict";

  // ---- the tables ----------------------------------------------------------
  // Index 0 is unused throughout; version numbers are 1-based, as the spec is.
  var ECC = { L: 0, M: 1, Q: 2, H: 3 };
  var FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };   // not the same order. It is a spec quirk.

  var ECC_PER_BLOCK = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  ];
  var NUM_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
  ];

  // Total module count available to data + ECC, before the function patterns
  // are taken out. Computed rather than tabulated: the formula is short and a
  // 40-row table is 40 chances to mistype a number.
  function rawDataModules(ver) {
    var result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }
  function dataCodewords(ver, ecl) {
    return Math.floor(rawDataModules(ver) / 8)
      - ECC_PER_BLOCK[ecl][ver] * NUM_BLOCKS[ecl][ver];
  }
  function alignPositions(ver) {
    if (ver === 1) return [];
    var numAlign = Math.floor(ver / 7) + 2;
    var step = (ver === 32) ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
    var size = ver * 4 + 17, out = [6];
    for (var pos = size - 7; out.length < numAlign; pos -= step) out.splice(1, 0, pos);
    return out;
  }

  // ---- GF(256), the field Reed-Solomon lives in ----------------------------
  // Primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D), as the spec says.
  var EXP = new Uint8Array(256), LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11D;
    }
  })();
  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[(LOG[a] + LOG[b]) % 255];
  }

  /** The generator polynomial for `degree` error-correction codewords. */
  function rsGenerator(degree) {
    var result = new Uint8Array(degree);
    result[degree - 1] = 1;                       // the polynomial x^0
    var root = 1;
    for (var i = 0; i < degree; i++) {
      for (var j = 0; j < degree; j++) {
        result[j] = gfMul(result[j], root);
        if (j + 1 < degree) result[j] ^= result[j + 1];
      }
      root = gfMul(root, 2);
    }
    return result;
  }

  /** The remainder of data / generator — i.e. the error-correction codewords. */
  function rsRemainder(data, generator) {
    var degree = generator.length;
    var result = new Uint8Array(degree);
    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ result[0];
      result.copyWithin(0, 1);
      result[degree - 1] = 0;
      for (var j = 0; j < degree; j++) result[j] ^= gfMul(generator[j], factor);
    }
    return result;
  }

  // ---- the bit stream ------------------------------------------------------
  function utf8Bytes(str) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(str);
    var out = [], s = unescape(encodeURIComponent(str));
    for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
    return new Uint8Array(out);
  }

  // Byte mode only. Alphanumeric mode would pack a little tighter for an
  // all-uppercase payload, but everything encoded here contains lowercase
  // (user ids are hex) and a second mode is a second thing to get wrong.
  function charCountBits(ver) { return ver <= 9 ? 8 : 16; }

  function buildCodewords(bytes, ver, ecl) {
    var bits = [];
    var push = function (val, len) {
      for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
    };
    push(4, 4);                                   // mode indicator: byte
    push(bytes.length, charCountBits(ver));
    for (var i = 0; i < bytes.length; i++) push(bytes[i], 8);

    var capacityBits = dataCodewords(ver, ecl) * 8;
    push(0, Math.min(4, capacityBits - bits.length));      // terminator
    push(0, (8 - bits.length % 8) % 8);                    // to a byte boundary
    // The two alternating pad bytes the spec names, until the block is full.
    for (var pad = 0xEC; bits.length < capacityBits; pad ^= 0xEC ^ 0x11) push(pad, 8);

    var data = new Uint8Array(bits.length / 8);
    for (var b = 0; b < bits.length; b++) data[b >>> 3] |= bits[b] << (7 - (b & 7));
    return data;
  }

  /**
   * Split into blocks, add the ECC of each, then INTERLEAVE.
   *
   * The interleaving is the point of the exercise: a scratch or a thumb over
   * the code damages a contiguous run of modules, and spreading each block's
   * codewords across the whole symbol turns one unrecoverable block into a few
   * recoverable errors in every block.
   */
  function addEcc(data, ver, ecl) {
    var numBlocks = NUM_BLOCKS[ecl][ver];
    var eccLen = ECC_PER_BLOCK[ecl][ver];
    var rawCodewords = Math.floor(rawDataModules(ver) / 8);
    var numShortBlocks = numBlocks - rawCodewords % numBlocks;
    var shortBlockLen = Math.floor(rawCodewords / numBlocks);   // data AND ecc
    var shortDataLen = shortBlockLen - eccLen;

    // EVERY block array is the same length — one longer than a short block —
    // with the ECC pushed to the END. A short block therefore has a one-byte
    // hole where its missing data codeword would be, and the interleaver below
    // skips that one column. Packing short blocks tighter instead looks
    // tidier and is wrong: the ECC of a short block would then start one index
    // earlier than the ECC of a long one, and the interleave would emit two
    // different things from the same column.
    var generator = rsGenerator(eccLen);
    var blocks = [], k = 0;
    for (var i = 0; i < numBlocks; i++) {
      var datLen = shortDataLen + (i < numShortBlocks ? 0 : 1);
      var dat = data.subarray(k, k + datLen);
      k += datLen;
      var block = new Uint8Array(shortBlockLen + 1);
      block.set(dat, 0);
      block.set(rsRemainder(dat, generator), block.length - eccLen);
      blocks.push(block);
    }

    var out = new Uint8Array(rawCodewords), n = 0;
    for (var c = 0; c < blocks[0].length; c++) {
      for (var b = 0; b < numBlocks; b++) {
        if (c !== shortDataLen || b >= numShortBlocks) out[n++] = blocks[b][c];
      }
    }
    return out;
  }

  // ---- the matrix ----------------------------------------------------------
  function Matrix(size) {
    this.size = size;
    this.modules = new Uint8Array(size * size);      // 1 = dark
    this.reserved = new Uint8Array(size * size);     // 1 = a function pattern
  }
  Matrix.prototype.get = function (x, y) { return this.modules[y * this.size + x]; };
  Matrix.prototype.set = function (x, y, dark, isFunction) {
    this.modules[y * this.size + x] = dark ? 1 : 0;
    if (isFunction) this.reserved[y * this.size + x] = 1;
  };
  Matrix.prototype.isReserved = function (x, y) { return this.reserved[y * this.size + x] === 1; };

  function drawFunctionPatterns(m, ver) {
    var size = m.size, i, j;

    // Timing lines.
    for (i = 0; i < size; i++) {
      m.set(6, i, i % 2 === 0, true);
      m.set(i, 6, i % 2 === 0, true);
    }

    // Three finders, each with its separator.
    [[0, 0], [size - 7, 0], [0, size - 7]].forEach(function (p) {
      for (var dy = -1; dy <= 7; dy++) {
        for (var dx = -1; dx <= 7; dx++) {
          var x = p[0] + dx, y = p[1] + dy;
          if (x < 0 || x >= size || y < 0 || y >= size) continue;
          var d = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
          m.set(x, y, d !== 2 && d !== 4, true);
        }
      }
    });

    // Alignment patterns, except where they would sit on a finder.
    var pos = alignPositions(ver);
    for (i = 0; i < pos.length; i++) {
      for (j = 0; j < pos.length; j++) {
        var last = pos.length - 1;
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
        for (var ay = -2; ay <= 2; ay++) {
          for (var ax = -2; ax <= 2; ax++) {
            m.set(pos[i] + ax, pos[j] + ay, Math.max(Math.abs(ax), Math.abs(ay)) !== 1, true);
          }
        }
      }
    }

    // Reserve the format areas, and the one module that is always dark.
    // Index 6 is skipped in both directions: (6,8) and (8,6) belong to the
    // timing lines, which were drawn above and must keep their values. A
    // blanket 0..8 loop here quietly paints two timing modules light, and the
    // symbol still looks like a QR code while failing to scan.
    for (i = 0; i < 9; i++) {
      if (i === 6) continue;
      m.set(i, 8, false, true);
      m.set(8, i, false, true);
    }
    for (i = 0; i < 8; i++) { m.set(size - 1 - i, 8, false, true); m.set(8, size - 1 - i, false, true); }
    m.set(8, size - 8, true, true);

    if (ver >= 7) drawVersion(m, ver);
  }

  function drawVersion(m, ver) {
    var rem = ver;
    for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    var bits = (ver << 12) | rem;
    for (var k = 0; k < 18; k++) {
      var bit = ((bits >>> k) & 1) === 1;
      var a = m.size - 11 + k % 3, b = Math.floor(k / 3);
      m.set(a, b, bit, true);
      m.set(b, a, bit, true);
    }
  }

  function drawFormat(m, ecl, mask) {
    var data = (FORMAT_BITS[ecl] << 3) | mask;
    var rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var bits = ((data << 10) | rem) ^ 0x5412;

    // Two copies, so a damaged corner does not cost the whole symbol.
    for (var k = 0; k <= 5; k++) m.set(8, k, ((bits >>> k) & 1) === 1, true);
    m.set(8, 7, ((bits >>> 6) & 1) === 1, true);
    m.set(8, 8, ((bits >>> 7) & 1) === 1, true);
    m.set(7, 8, ((bits >>> 8) & 1) === 1, true);
    for (k = 9; k < 15; k++) m.set(14 - k, 8, ((bits >>> k) & 1) === 1, true);

    for (k = 0; k < 8; k++) m.set(m.size - 1 - k, 8, ((bits >>> k) & 1) === 1, true);
    for (k = 8; k < 15; k++) m.set(8, m.size - 15 + k, ((bits >>> k) & 1) === 1, true);
    m.set(8, m.size - 8, true, true);
  }

  /** Two columns at a time, upward then downward, skipping the timing column. */
  function drawCodewords(m, data) {
    var size = m.size, i = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;                  // column 6 is the timing line
      for (var vert = 0; vert < size; vert++) {
        for (var k = 0; k < 2; k++) {
          var x = right - k;
          var upward = ((right + 1) & 2) === 0;
          var y = upward ? size - 1 - vert : vert;
          if (m.isReserved(x, y) || i >= data.length * 8) continue;
          m.set(x, y, ((data[i >>> 3] >>> (7 - (i & 7))) & 1) === 1, false);
          i++;
        }
      }
    }
  }

  function applyMask(m, mask) {
    for (var y = 0; y < m.size; y++) {
      for (var x = 0; x < m.size; x++) {
        if (m.isReserved(x, y)) continue;
        var invert;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = x * y % 2 + x * y % 3 === 0; break;
          case 6: invert = (x * y % 2 + x * y % 3) % 2 === 0; break;
          case 7: invert = ((x + y) % 2 + x * y % 3) % 2 === 0; break;
          default: throw new Error("bad mask");
        }
        if (invert) m.modules[y * m.size + x] ^= 1;
      }
    }
  }

  /**
   * The four penalty rules, scored so the least ugly mask wins.
   *
   * "Ugly" is not an aesthetic judgement: runs of one colour and blocks of
   * solid colour are what a scanner mistakes for a finder pattern, and a
   * symbol that is 90% white is one a camera cannot threshold.
   */
  function penalty(m) {
    var size = m.size, score = 0, x, y;
    var N1 = 3, N2 = 3, N3 = 40, N4 = 10;

    // Rule 1: runs of five or more.
    for (y = 0; y < size; y++) {
      var runColor = m.get(0, y), runLen = 1;
      for (x = 1; x < size; x++) {
        if (m.get(x, y) === runColor) { runLen++; if (runLen === 5) score += N1; else if (runLen > 5) score++; }
        else { runColor = m.get(x, y); runLen = 1; }
      }
    }
    for (x = 0; x < size; x++) {
      var rc = m.get(x, 0), rl = 1;
      for (y = 1; y < size; y++) {
        if (m.get(x, y) === rc) { rl++; if (rl === 5) score += N1; else if (rl > 5) score++; }
        else { rc = m.get(x, y); rl = 1; }
      }
    }

    // Rule 2: 2x2 blocks of one colour.
    for (y = 0; y < size - 1; y++) {
      for (x = 0; x < size - 1; x++) {
        var c = m.get(x, y);
        if (c === m.get(x + 1, y) && c === m.get(x, y + 1) && c === m.get(x + 1, y + 1)) score += N2;
      }
    }

    // Rule 3: the finder-lookalike 1:1:3:1:1 with four light modules beside it.
    var A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    var B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    var matches = function (get, i) {
      var okA = true, okB = true;
      for (var k = 0; k < 11; k++) {
        if (get(i + k) !== A[k]) okA = false;
        if (get(i + k) !== B[k]) okB = false;
      }
      return okA || okB;
    };
    for (y = 0; y < size; y++) {
      for (x = 0; x + 11 <= size; x++) {
        if (matches(function (i) { return m.get(i, y); }, x)) score += N3;
      }
    }
    for (x = 0; x < size; x++) {
      for (y = 0; y + 11 <= size; y++) {
        if (matches((function (col) { return function (i) { return m.get(col, i); }; })(x), y)) score += N3;
      }
    }

    // Rule 4: how far the dark proportion strays from half.
    var dark = 0;
    for (var i = 0; i < m.modules.length; i++) dark += m.modules[i];
    var total = size * size;
    var k5 = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    score += Math.max(k5, 0) * N4;
    return score;
  }

  // ---- the entry point -----------------------------------------------------
  /**
   * @param {string} text
   * @param {{ecc?: "L"|"M"|"Q"|"H", minVersion?: number}} [opts]
   * @returns {{size: number, get: function(number, number): boolean}}
   */
  function encode(text, opts) {
    opts = opts || {};
    var level = opts.ecc || "M";
    if (!(level in ECC)) throw new Error("unknown ECC level " + level);
    var ecl = ECC[level];
    var bytes = utf8Bytes(String(text == null ? "" : text));

    var ver = Math.max(1, Math.min(40, opts.minVersion || 1));
    for (; ver <= 40; ver++) {
      var need = 4 + charCountBits(ver) + bytes.length * 8;
      if (need <= dataCodewords(ver, ecl) * 8) break;
    }
    if (ver > 40) throw new Error("too much data for one QR code");

    var m = new Matrix(ver * 4 + 17);
    drawFunctionPatterns(m, ver);
    drawCodewords(m, addEcc(buildCodewords(bytes, ver, ecl), ver, ecl));

    // Every mask is tried and scored; the spec does not let the encoder just
    // pick one, because the wrong mask is a code that reads slowly or not at
    // all under a real camera.
    var best = -1, bestScore = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      drawFormat(m, level, mask);
      applyMask(m, mask);
      var s = penalty(m);
      if (s < bestScore) { bestScore = s; best = mask; }
      applyMask(m, mask);                          // XOR is its own inverse
    }
    drawFormat(m, level, best);
    applyMask(m, best);

    return {
      size: m.size,
      version: ver,
      ecc: level,
      mask: best,
      get: function (x, y) { return m.get(x, y) === 1; },
    };
  }

  window.QR = { encode: encode };
})();
