// ============================================================================
// house_room_spec_test.mjs — what a listing can say about ONE space.
//
// Three things this covers, all of them facts a renter decides on and none of
// which the old schema had a box for:
//
//   SIZE is a bracket. Square metres were asked for and almost never given —
//   an agent in a room in Tabata has no tape measure, and a number typed to
//   fill a box is worse than none because it looks surveyed. Small / medium /
//   large, plus the line telling the reader the photos are the real measure.
//
//   CHARACTERISTICS are open. Bathroom inside or outside, tiles, sink board,
//   and anything at all the agent types. A typed one must survive exactly as
//   written and behave like an offered one everywhere downstream.
//
//   ZERO MEANS FREE. "Water: 0" and "Water: bure" are among the best things a
//   listing can say and used to render "Ask the agent".
//
// Everything is asserted in BOTH languages, because a half-translated
// catalogue is worse than an English one: you cannot tell which half you are
// reading.
//
// This half runs house-spec.js on its own: no server, no browser, no network.
// What the FORM does with this catalogue is covered where it can be driven
// reliably (house_spec_page_test.mjs drives the reader's side end to end).
//
//   usage:  node tests/house_room_spec_test.mjs   (no server needed)
// ============================================================================
import { readFileSync } from "node:fs";
import vm from "node:vm";


let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; process.stdout.write("  PASS  " + msg + "\n"); }
  else { fail++; process.stdout.write("  FAIL  " + msg + (detail ? "\n        " + detail : "") + "\n"); }
};

// ---------------------------------------------------------------- the shape
// Run house-spec.js on its own: no server, no browser, no network.
function specIn(langCode) {
  const src = readFileSync("js/lib/house-spec.js", "utf8");
  const ctx = { window: { getLang: () => langCode }, console };
  ctx.window.window = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.window.HouseSpec;
}

process.stdout.write("\n1. The catalogue answers in the language being read\n");
const EN = specIn("en"), SW = specIn("sw");
ok(EN.SIZE_BANDS.map((b) => EN.say(b)).join("/") === "Small/Medium/Large",
   "size brackets in English", EN.SIZE_BANDS.map((b) => EN.say(b)).join("/"));
ok(SW.SIZE_BANDS.map((b) => SW.say(b)).join("/") === "Kidogo/Wastani/Kubwa",
   "size brackets in Swahili", SW.SIZE_BANDS.map((b) => SW.say(b)).join("/"));
ok(/photos/i.test(EN.sizeNote()) && /picha/i.test(SW.sizeNote()),
   "and both say the photos are the real measure",
   EN.sizeNote() + " | " + SW.sizeNote());
ok(EN.featureLabel("bath_inside") === "Bathroom inside the room" &&
   SW.featureLabel("bath_inside") === "Bafu ndani ya chumba",
   "a characteristic reads in both languages",
   EN.featureLabel("bath_inside") + " | " + SW.featureLabel("bath_inside"));
ok(EN.featureLabel("sink_board") === "Sink board fitted" &&
   SW.featureLabel("sink_board") === "Sinki na meza ya jiko",
   "including the sink board");
// Every catalogue entry must carry both halves. One missing `sw` is exactly
// the drift this file's own comment warns about.
const missing = [];
EN.FEATURE_GROUPS.forEach((g) => {
  if (!g.title.en || !g.title.sw) missing.push("group:" + g.key);
  g.items.forEach((it) => { if (!it.en || !it.sw) missing.push(it.key); });
});
EN.SIZE_BANDS.forEach((b) => {
  if (!b.en || !b.sw || !b.hint.en || !b.hint.sw) missing.push("size:" + b.key);
});
ok(missing.length === 0, "every catalogue entry is translated, none half-done",
   missing.join(", "));

process.stdout.write("\n2. An agent's own words survive as written\n");
const typed = EN.featureLabels(["tiles", "Mango tree at the door", "sink_board"]);
ok(typed[1] === "Mango tree at the door",
   "free text is kept verbatim, not matched to the catalogue", JSON.stringify(typed));
ok(SW.featureLabels(["Mango tree at the door"])[0] === "Mango tree at the door",
   "and is not mangled when the reader is in Swahili");
ok(EN.featureLabels(["tiles", "TILES", "Tiles"]).length === 1,
   "the same characteristic twice is stored once",
   JSON.stringify(EN.featureLabels(["tiles", "TILES", "Tiles"])));

process.stdout.write("\n3. Zero is an answer, not a gap\n");
for (const [v, want] of [[0, true], ["0", true], ["free", true], ["bure", true],
                         ["Hakuna", true], ["imejumuishwa", true], ["0/=", true]]) {
  const r = EN.parseCost(v);
  ok(r.known && r.free === want, `parseCost(${JSON.stringify(v)}) is stated-as-free`,
     JSON.stringify(r));
}
for (const v of ["", null, undefined, "ask me", "negotiable"]) {
  const r = EN.parseCost(v);
  ok(!r.known, `parseCost(${JSON.stringify(v)}) is honestly unknown`, JSON.stringify(r));
}
ok(EN.parseCost("TZS 5,000").amount === 5000, "a real figure still reads as a figure");
ok(EN.freeLabel() === "Free" && SW.freeLabel() === "Bure",
   "and the word for it is translated");

process.stdout.write("\n4. The shape round-trips through normalize()\n");
const norm = EN.normalize({
  v: 1,
  rooms: [{ kind: "single", price: 60000, period: "month",
            sizeBand: "medium", features: ["tiles", "bath_inside", "My own words"] }],
  groups: [],
});
ok(norm.rooms[0].sizeBand === "medium", "the bracket survives", JSON.stringify(norm.rooms[0]));
ok(norm.rooms[0].features.length === 3, "all three characteristics survive",
   JSON.stringify(norm.rooms[0].features));
const bad = EN.normalize({ rooms: [{ kind: "single", price: 1, sizeBand: "enormous" }] });
ok(bad.rooms[0].sizeBand === null,
   "a bracket that is not one of the three is dropped, not stored",
   JSON.stringify(bad.rooms[0]));
const old = EN.normalize({ rooms: [{ kind: "single", price: 1 }] });
ok(old.rooms[0].sizeBand === null && Array.isArray(old.rooms[0].features) && !old.rooms[0].features.length,
   "a listing saved before any of this still normalizes", JSON.stringify(old.rooms[0]));

// ---------------------------------------------------------------------------
// The characteristics, as a field of their own
// ---------------------------------------------------------------------------
// `features` is the tap-a-chip list of what a room HAS. `traits` is what it is
// LIKE, in the agent's own words, and a fixed set cannot describe a room
// nobody here has seen. The normaliser is a whitelist, so a field it does not
// name is dropped on save with nothing on screen to say so: that is what these
// pin.
const tr = EN.normalize({ rooms: [{
  kind: "single", price: 60000,
  traits: "self-contained, tiled, big windows",
  note: "upstairs, own entrance",
}] });
ok(tr.rooms[0].traits === "self-contained, tiled, big windows",
   "the characteristics survive normalisation", JSON.stringify(tr.rooms[0].traits));
ok(tr.rooms[0].note === "upstairs, own entrance",
   "and the general note stays a separate field beside them",
   JSON.stringify(tr.rooms[0].note));
ok(EN.normalize({ rooms: [{ kind: "x", traits: "a".repeat(500) }] }).rooms[0].traits.length <= 200,
   "they are capped, so one listing cannot carry a phone book");
const only = EN.normalize({ rooms: [{ traits: "quiet side, own gate" }] });
ok(only.rooms.length === 1 && only.rooms[0].traits === "quiet side, own gate",
   "a room DESCRIBED but not named or priced is still a room, rather than everything typed about it being thrown away on save",
   JSON.stringify(only.rooms));

process.stdout.write(`
${pass} passed, ${fail} failed
`);
process.exit(fail ? 1 : 0);
