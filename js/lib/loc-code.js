// ============================================================================
//  loc-code.js — the nine characters, and what they protect.
//
//  A share code looks like  K7M-2Q9-F3T  and is nine Crockford Base32
//  characters. It is the whole secret: whoever can say it can see the pin, and
//  nobody else can — including this application's own database.
//
//    positions 1-5   LOCATOR, minted by the server (loc_share.sql) as a keyed
//                    Feistel permutation of a sequence counter. Bijective, so
//                    two shares can NEVER collide. Nothing here can produce it.
//    positions 6-8   SECRET, 15 random bits chosen HERE and never transmitted
//                    in any form. This is what makes the server unable to read
//                    a share it is storing.
//    position  9     CHECK, one parity symbol over GF(2^5), proven below to
//                    catch every single-character typo and every swap of two
//                    characters. Not a security device — a politeness one: a
//                    code misheard on the phone fails in the hand instead of
//                    after a round trip.
//
//  ── Why Crockford Base32 ───────────────────────────────────────────────────
//  Its alphabet is 0-9 then A-Z with I, L, O and U removed. I/1, L/1 and O/0
//  are exactly the pairs that go wrong when a code is read aloud or copied off
//  a screen, and dropping U means no three-letter group can spell something a
//  person would be embarrassed to read out. Decoding folds O to 0 and I/L to 1,
//  so those mistakes are not even errors.
//
//  ── The check symbol, and why it is this and not a Luhn digit ──────────────
//  Treat each character as an element of GF(2^5), the field of 32 elements,
//  built with the primitive polynomial x^5 + x^2 + 1. Let a be its generator
//  (a = 2). A code d[0..8] is well-formed exactly when
//
//        SUM over i of  a^i * d[i]   =   0        (i = 0..8, arithmetic in GF(32))
//
//  so the writer sets d[8] = (SUM over i<8 of a^i*d[i]) / a^8.
//
//  ONE WRONG CHARACTER at position i changes the sum by a^i * e where e is the
//  difference and e != 0. A product of two non-zero field elements is non-zero,
//  so the sum moves off zero and the code is rejected. Always.
//
//  TWO CHARACTERS SWAPPED, positions i and j, changes the sum by
//  (a^i + a^j)(d[i] + d[j])  — addition is XOR here, so signs vanish. a has
//  order 31, and every position index is below 9, so a^i != a^j whenever i != j
//  and the left factor is non-zero; the right factor is non-zero whenever the
//  two characters actually differ. Again a product of non-zeros. Always caught.
//
//  A Luhn digit misses roughly a tenth of transpositions, and a plain "hash the
//  code and keep a character" misses one error in thirty-two. This misses none
//  of either kind, for four lines of table lookup. tests/loc_code_test.mjs
//  checks all 9 * 31 single-character errors and all 36 swaps on random codes,
//  exhaustively rather than by sampling.
//
//  ── Deriving the two things the code is worth ──────────────────────────────
//      root   = PBKDF2-SHA256(code, "pawa-loc-v1", 210000)
//      handle = HKDF(root, "handle")   -> what the server stores, hashed again
//                                         with a server-side pepper
//      key    = HKDF(root, "key")      -> AES-256-GCM over the coordinates
//
//  One slow step, split two fast ways. The slow step is what an attacker who
//  stole the database has to repeat for every candidate code; making the lookup
//  handle cheap would have handed them the codes at plain-SHA-256 speed and
//  made the encryption pointless.
//
//  The AES-GCM additional data is the handle, so a ciphertext lifted out of one
//  row and dropped into another does not decrypt. Same discipline as
//  js/lib/p-crypto.js, and for the same reason.
//
//  No network, no DOM, no storage. Everything here is a pure function of its
//  arguments, which is what lets tests/loc_code_test.mjs drive the real file
//  under Node instead of a copy of it.
// ============================================================================

(function () {
  "use strict";

  var g = typeof globalThis !== "undefined" ? globalThis : window;

  var ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  var CODE_LEN = 9;            // 5 locator + 3 secret + 1 check
  var SECRET_CHARS = 3;        // 15 bits chosen on this device
  var KDF_SALT = "pawa-loc-v1";
  var PBKDF2_ROUNDS = 210000;  // same cost as p-crypto.js's backup KDF

  function subtle() {
    var c = g.crypto || g.msCrypto;
    if (!c || !c.subtle) {
      throw new Error("Location codes need a secure page (https:// or localhost).");
    }
    return c.subtle;
  }
  function randomBytes(n) {
    var b = new Uint8Array(n);
    (g.crypto || g.msCrypto).getRandomValues(b);
    return b;
  }
  function utf8(s) { return new TextEncoder().encode(String(s)); }
  function fromUtf8(b) { return new TextDecoder().decode(b); }

  function hex(buf) {
    var v = new Uint8Array(buf), out = "";
    for (var i = 0; i < v.length; i++) out += (v[i] < 16 ? "0" : "") + v[i].toString(16);
    return out;
  }
  function b64u(buf) {
    var v = new Uint8Array(buf), s = "";
    for (var i = 0; i < v.length; i++) s += String.fromCharCode(v[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function unb64u(str) {
    var s = String(str).replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    var bin = atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // Node's vm sandbox has no btoa/atob unless the host put them there.
  if (typeof g.btoa !== "function" && typeof Buffer !== "undefined") {
    g.btoa = function (s) { return Buffer.from(s, "binary").toString("base64"); };
    g.atob = function (s) { return Buffer.from(s, "base64").toString("binary"); };
  }

  // ---- GF(2^5) --------------------------------------------------------------
  // x^5 + x^2 + 1 is primitive over GF(2), so doubling walks all 31 non-zero
  // elements before returning to 1. Two tables and multiplication is a lookup.
  var EXP = new Uint8Array(62), LOG = new Uint8Array(32);
  (function buildTables() {
    var x = 1;
    for (var i = 0; i < 31; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 32) x ^= 0x25;          // reduce by x^5 + x^2 + 1
    }
    for (var j = 31; j < 62; j++) EXP[j] = EXP[j - 31];
  })();
  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }
  function gfDiv(a, b) {
    if (b === 0) throw new Error("divide by zero in GF(32)");
    if (a === 0) return 0;
    return EXP[(LOG[a] - LOG[b] + 31) % 31];
  }

  /** The running parity of a symbol array: SUM a^i * d[i]. Zero means valid. */
  function parity(symbols) {
    var acc = 0;
    for (var i = 0; i < symbols.length; i++) acc ^= gfMul(EXP[i % 31], symbols[i]);
    return acc;
  }

  /** The check character for an 8-symbol payload. */
  function checkSymbol(payloadSymbols) {
    return gfDiv(parity(payloadSymbols), EXP[payloadSymbols.length]);
  }

  // ---- alphabet ------------------------------------------------------------
  function toSymbols(code) {
    var out = [];
    for (var i = 0; i < code.length; i++) {
      var v = ALPHABET.indexOf(code[i]);
      if (v < 0) return null;
      out.push(v);
    }
    return out;
  }
  function fromSymbols(symbols) {
    var s = "";
    for (var i = 0; i < symbols.length; i++) s += ALPHABET[symbols[i]];
    return s;
  }

  /**
   * Anything a person might type, turned into the canonical nine characters —
   * or as close as it gets. Spaces, dashes and dots are separators; O becomes
   * 0 and I/L become 1, which is Crockford's rule and the reason those letters
   * are not in the alphabet in the first place.
   */
  function normalize(input) {
    var raw = String(input == null ? "" : input).toUpperCase().replace(/[^0-9A-Z]/g, "");
    var out = "";
    for (var i = 0; i < raw.length; i++) {
      var c = raw[i];
      if (c === "O") c = "0";
      else if (c === "I" || c === "L") c = "1";
      out += c;
    }
    return out;
  }

  /** K7M2Q9F3T -> K7M-2Q9-F3T. Three groups of three read like a phone number. */
  function format(code) {
    var c = normalize(code);
    if (c.length !== CODE_LEN) return c;
    return c.slice(0, 3) + "-" + c.slice(3, 6) + "-" + c.slice(6, 9);
  }

  /**
   * Why a code is not acceptable, in a word the caller can turn into a
   * sentence: "short", "long", "chars", "check", or null when it is fine.
   */
  function problem(input) {
    var c = normalize(input);
    if (c.length < CODE_LEN) return "short";
    if (c.length > CODE_LEN) return "long";
    var sym = toSymbols(c);
    if (!sym) return "chars";
    if (parity(sym) !== 0) return "check";
    return null;
  }
  function isValid(input) { return problem(input) === null; }

  /**
   * Finish a code from the five characters the server minted: add this
   * device's own three, then the check character.
   *
   * The randomness comes from crypto.getRandomValues and is drawn as whole
   * bytes reduced by rejection, never `% 32` on a random byte — 256 is a
   * multiple of 32 so it would happen to be fair here, but the habit of
   * reaching for modulo is how biased codes get written elsewhere.
   */
  function completeCode(locator) {
    var loc = normalize(locator);
    if (loc.length !== CODE_LEN - SECRET_CHARS - 1) {
      throw new Error("The locator from the server is the wrong length.");
    }
    if (!toSymbols(loc)) throw new Error("The locator from the server is not Base32.");

    var secret = "";
    while (secret.length < SECRET_CHARS) {
      var b = randomBytes(1)[0];
      if (b >= 224) continue;                 // 224 = 7*32; reject the short tail
      secret += ALPHABET[b % 32];
    }
    var payload = loc + secret;
    return payload + ALPHABET[checkSymbol(toSymbols(payload))];
  }

  // ---- key derivation -------------------------------------------------------
  var derivedCache = new Map();   // code -> promise, so open+manage cost one KDF

  async function derive(code) {
    var c = normalize(code);
    if (problem(c)) throw new Error("That code is not a valid share code.");
    if (derivedCache.has(c)) return derivedCache.get(c);

    var p = (async function () {
      var base = await subtle().importKey("raw", utf8(c), "PBKDF2", false, ["deriveBits"]);
      var root = await subtle().deriveBits(
        { name: "PBKDF2", salt: utf8(KDF_SALT), iterations: PBKDF2_ROUNDS, hash: "SHA-256" },
        base, 256);
      var rootKey = await subtle().importKey("raw", root, "HKDF", false, ["deriveBits"]);
      var split = async function (info) {
        return subtle().deriveBits(
          { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8(info) },
          rootKey, 256);
      };
      var handleBits = await split("pawa-loc-handle-v1");
      var keyBits = await split("pawa-loc-key-v1");
      return {
        handle: hex(handleBits),
        key: await subtle().importKey("raw", keyBits, "AES-GCM", false, ["encrypt", "decrypt"]),
      };
    })();

    derivedCache.set(c, p);
    return p;
  }

  /**
   * Encrypt a place under its code.
   *
   * `place` is { lat, lng, acc, label, at }. It is JSON so that a later version
   * can add a field without breaking an older reader, and small enough that the
   * ciphertext length says nothing useful about it.
   */
  async function seal(code, place) {
    var d = await derive(code);
    var iv = randomBytes(12);
    var body = await subtle().encrypt(
      { name: "AES-GCM", iv: iv, additionalData: utf8(d.handle) },
      d.key, utf8(JSON.stringify(place)));
    return { handle: d.handle, cipher: b64u(body), iv: b64u(iv) };
  }

  /** The other direction. Throws if the code is wrong or the row was tampered with. */
  async function open(code, cipher, iv) {
    var d = await derive(code);
    var plain;
    try {
      plain = await subtle().decrypt(
        { name: "AES-GCM", iv: unb64u(iv), additionalData: utf8(d.handle) },
        d.key, unb64u(cipher));
    } catch (_) {
      throw new Error("That code did not open this share.");
    }
    return JSON.parse(fromUtf8(plain));
  }

  /** A 256-bit token the sender keeps, and its hash, which is all the server gets. */
  async function revokeToken() {
    var tok = b64u(randomBytes(32));
    var h = await subtle().digest("SHA-256", utf8(tok));
    return { token: tok, hash: hex(h) };
  }
  async function revokeHash(token) {
    return hex(await subtle().digest("SHA-256", utf8(String(token))));
  }

  /**
   * Round a fix to a grid, for someone who wants to say "this neighbourhood"
   * rather than "this doorstep".
   *
   * A degree of latitude is 111,320 m everywhere; a degree of longitude only at
   * the equator, shrinking by cos(latitude) towards the poles. So the longitude
   * step is divided by that cosine and the cells stay roughly square.
   *
   * The cosine is taken from the ALREADY-SNAPPED latitude, not the raw one.
   * Taking it from the raw latitude looks identical and is wrong: every fix
   * would get a very slightly different longitude step, so two people standing
   * at one shop would coarsen to two points a millimetre apart and the whole
   * point of snapping — that a place has one coarse answer — would be lost.
   * The result is rounded to 7 decimals (about a centimetre) for the same
   * reason: floating point residue is not information.
   *
   * Snapping rather than adding noise also means re-sharing does not walk: a
   * coarse point coarsens to itself.
   */
  function coarsen(lat, lng, metres) {
    var m = Math.max(1, Number(metres) || 0);
    var round7 = function (x) { return Number(x.toFixed(7)); };
    var dLat = m / 111320;
    var latC = round7(Math.round(Number(lat) / dLat) * dLat);
    var cos = Math.cos((latC * Math.PI) / 180);
    var dLng = m / (111320 * Math.max(0.01, Math.abs(cos)));
    return { lat: latC, lng: round7(Math.round(Number(lng) / dLng) * dLng) };
  }

  g.LocCode = {
    ALPHABET: ALPHABET,
    CODE_LEN: CODE_LEN,
    normalize: normalize,
    format: format,
    problem: problem,
    isValid: isValid,
    completeCode: completeCode,
    checkSymbol: checkSymbol,
    parity: parity,
    toSymbols: toSymbols,
    fromSymbols: fromSymbols,
    derive: derive,
    seal: seal,
    open: open,
    revokeToken: revokeToken,
    revokeHash: revokeHash,
    coarsen: coarsen,
  };
})();
