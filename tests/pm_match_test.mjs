// ============================================================================
// pm_match_test.mjs — the agent ranking, argued with.
//
// js/lib/pm-match.js decides who a person sees first when they open Agents.
// That is a ranking nobody can eyeball for correctness, because "is Juma
// really a better bet than Neema" has no ground truth. What CAN be checked,
// and is checked here, is that the thing behaves the way its own comments say
// it does:
//
//   · small counts do not get to claim certainty (Wilson);
//   · no evidence and evidence-of-absence are different;
//   · the four place columns are ONE signal, not four (or a regional match
//     alone outranks a ward match somewhere else, and the whole thing tips);
//   · combining candidates never reaches certainty, and gets more pessimistic
//     the more alike the candidates are.
//
// No browser and no database: the file is pure arithmetic on purpose.
//
//   usage:  node tests/pm_match_test.mjs
// ============================================================================
import fs from "fs";
import vm from "vm";

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; process.stdout.write("  PASS  " + msg + "\n"); }
  else { fail++; process.stdout.write("  FAIL  " + msg + (detail !== undefined ? "\n        " + detail : "") + "\n"); }
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const section = (s) => process.stdout.write("\n" + s + "\n");

// The library is a browser IIFE that hangs itself off window. Give it one.
const sandbox = { window: {}, Math, Date, console, isFinite, String, Number };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync("js/lib/pm-match.js", "utf8"), sandbox);
const M = sandbox.window.PMMatch;

const agent = (over) => Object.assign({
  user_id: "u", display_name: "Agent", region: null, area: null, area_kind: null,
  district: null, ward: null, lat: null, lng: null, is_agent: true, reachable: true,
  n_houses: 0, n_services: 0, n_trucks: 0, n_jobs: 0, n_verified: 0, last_listed_at: null,
}, over || {});

// ---------------------------------------------------------------------------
section("The library loads and exposes what it claims to");
ok(!!M, "window.PMMatch exists");
["score", "rank", "shortlist", "band", "wilsonLower", "entropy", "decay", "haversineKm"]
  .forEach((k) => ok(typeof M[k] === "function", `PMMatch.${k} is callable`));

// ---------------------------------------------------------------------------
section("Wilson — the small-sample floor that stops one listing lying");
ok(M.wilsonLower(0, 0) === 0, "no trials is 0, not NaN and not 1");
ok(M.wilsonLower(1, 1) < 0.35,
   "1 out of 1 is nowhere near certain", M.wilsonLower(1, 1).toFixed(3));
ok(M.wilsonLower(1, 1) > 0, "but it is not nothing either", M.wilsonLower(1, 1).toFixed(3));
ok(M.wilsonLower(5, 5) > M.wilsonLower(1, 1),
   "5 of 5 beats 1 of 1 — the same share, more evidence");
ok(M.wilsonLower(50, 50) > M.wilsonLower(5, 5), "and 50 of 50 beats 5 of 5");
ok(M.wilsonLower(50, 50) < 1, "even 50 of 50 stops short of certainty",
   M.wilsonLower(50, 50).toFixed(3));
ok(M.wilsonLower(0, 10) === 0, "0 of 10 floors at 0");
ok(M.wilsonLower(5, 10) < 0.5, "the floor of a half-share sits below a half",
   M.wilsonLower(5, 10).toFixed(3));
ok(M.wilsonLower(20, 10) === M.wilsonLower(10, 10),
   "more successes than trials is clamped rather than trusted");

// ---------------------------------------------------------------------------
section("Entropy — used to describe a mix, never to score one");
ok(M.entropy([0, 0, 0]) === 0, "nothing listed has no spread");
ok(M.entropy([9, 0, 0]) === 0, "everything in one category has no spread");
ok(near(M.entropy([5, 5, 5]), 1, 1e-9), "an even three-way split is fully spread");
ok(M.entropy([8, 1, 1]) < M.entropy([4, 3, 3]), "lopsided is less spread than balanced");
ok(M.entropy([3, 3, 0]) > 0.6 && M.entropy([3, 3, 0]) < 0.7,
   "an even split across two of three sits between — broad, but not as broad as all three",
   M.entropy([3, 3, 0]).toFixed(3));
ok(M.entropy([3, 3, 0]) < M.entropy([3, 3, 3]),
   "and using two categories is less spread than using three");
ok(M.entropy([7]) === 0, "a single-category world has no spread to measure");

// ---------------------------------------------------------------------------
section("Decay and distance");
ok(near(M.decay(0, 180), 1), "touched today is 1");
ok(near(M.decay(180, 180), 0.5), "one half-life is a half");
ok(near(M.decay(360, 180), 0.25), "two half-lives is a quarter");
ok(M.decay(null) === 0 && M.decay(-5) === 0, "missing or impossible ages decay to 0");
ok(M.haversineKm(null, { lat: 1, lng: 1 }) === null, "distance needs both points");
ok(M.haversineKm({ lat: -6.8, lng: 39.28 }, { lat: -6.8, lng: 39.28 }) === 0, "a point is 0 from itself");
{
  // Dar es Salaam to Mwanza is about 1,100 km as the crow flies.
  const km = M.haversineKm({ lat: -6.792, lng: 39.208 }, { lat: -2.516, lng: 32.917 });
  ok(km > 700 && km < 900, "Dar to Mwanza lands in the right order of magnitude", Math.round(km) + " km");
}

// ---------------------------------------------------------------------------
section("No evidence and evidence of absence are not the same thing");
{
  const need = { category: "trucks" };
  const blank = M.score(agent(), need);                                  // lists nothing
  const elsewhere = M.score(agent({ n_houses: 6 }), need);               // lists, but no trucks
  const hasOne = M.score(agent({ n_trucks: 1 }), need);

  ok(near(blank.p, M.PRIOR, 1e-9),
     "somebody who lists nothing scores exactly the prior", blank.p.toFixed(4));
  ok(elsewhere.p < blank.p,
     "six houses and no trucks is worse than no information at all",
     `${elsewhere.p.toFixed(4)} < ${blank.p.toFixed(4)}`);
  ok(hasOne.p > blank.p, "one truck beats no information");
  ok(elsewhere.evidence.some((e) => e.why === "category_absent"),
     "and the reason is named as an absence");
  ok(!blank.evidence.some((e) => e.why.startsWith("category")),
     "while listing nothing produces no category evidence in either direction");
}

// ---------------------------------------------------------------------------
section("Depth and focus — twelve trucks beat one, and one truck among twelve houses does not");
{
  const need = { category: "trucks" };
  const one = M.score(agent({ n_trucks: 1 }), need);
  const twelve = M.score(agent({ n_trucks: 12 }), need);
  const dilute = M.score(agent({ n_trucks: 1, n_houses: 11 }), need);

  ok(twelve.p > one.p, "a dozen trucks outranks one",
     `${twelve.p.toFixed(3)} > ${one.p.toFixed(3)}`);
  ok(dilute.p < one.p,
     "one truck among eleven houses is weaker than one truck alone",
     `${dilute.p.toFixed(3)} < ${one.p.toFixed(3)}`);

  // The depth curve has to saturate, or the biggest agency in the country wins
  // every search in every ward forever.
  const forty = M.score(agent({ n_trucks: 40 }), need);
  ok(forty.p - twelve.p < twelve.p - one.p,
     "the gain from 12 to 40 is smaller than from 1 to 12 — depth saturates",
     `${(forty.p - twelve.p).toFixed(3)} < ${(twelve.p - one.p).toFixed(3)}`);
}

// ---------------------------------------------------------------------------
section("Place is ONE signal, not four");
{
  const need = { region: "Mwanza", district: "Nyamagana", ward: "Mirongo", query: "Mirongo" };
  const stacked = M.score(agent({ region: "Mwanza", district: "Nyamagana", ward: "Mirongo", area: "Mirongo" }), need);
  const placeBits = stacked.evidence.filter((e) => e.why.indexOf("place") === 0 || e.why === "distance");
  ok(placeBits.length === 1,
     "an agent matching region, district, ward AND area contributes exactly one place term",
     JSON.stringify(placeBits.map((e) => e.why)));

  // The point of that: a region-only match must not be able to out-total a
  // ward match by stacking. Same region, wrong ward, must lose.
  const wardHit = M.score(agent({ region: "Mwanza", district: "Nyamagana", ward: "Mirongo" }), need);
  const regionOnly = M.score(agent({ region: "Mwanza", district: "Ilemela", ward: "Kitangiri" }), need);
  ok(wardHit.p > regionOnly.p, "the right ward beats the right region alone",
     `${wardHit.p.toFixed(3)} > ${regionOnly.p.toFixed(3)}`);
}
{
  const need = { region: "Mwanza" };
  const away = M.score(agent({ region: "Dodoma" }), need);
  const unknown = M.score(agent({ region: null }), need);
  ok(away.p < unknown.p,
     "being known to be in the wrong region costs; having no region recorded does not",
     `${away.p.toFixed(3)} < ${unknown.p.toFixed(3)}`);
  ok(near(unknown.p, M.PRIOR, 1e-9), "an unknown region really is treated as no evidence");
}
{
  // A two-letter query must not match half of Tanzania.
  const need = { query: "Ny" };
  const s = M.score(agent({ area: "Nyamagana" }), need);
  ok(!s.evidence.some((e) => e.why.indexOf("place") === 0),
     "a two-character query is too short to be a place match");
}

// ---------------------------------------------------------------------------
section("Distance competes with the place words rather than adding to them");
{
  const near1 = M.score(agent({ region: "Mwanza", lat: -2.516, lng: 32.917 }),
                        { region: "Mwanza", at: { lat: -2.517, lng: 32.918 } });
  const far = M.score(agent({ region: "Mwanza", lat: -6.792, lng: 39.208 }),
                      { region: "Mwanza", at: { lat: -2.517, lng: 32.918 } });
  ok(near1.p > far.p, "the same region, but next door beats 800km away",
     `${near1.p.toFixed(3)} > ${far.p.toFixed(3)}`);
  const bits = near1.evidence.filter((e) => e.why.indexOf("place") === 0 || e.why === "distance");
  ok(bits.length === 1, "and it is still exactly one place term", JSON.stringify(bits.map((e) => e.why)));
  ok(bits[0].why === "distance", "the stronger of the two won, which here is the distance");
}

// ---------------------------------------------------------------------------
section("Freshness and verification");
{
  const day = 86400000;
  const fresh = M.score(agent({ n_houses: 3, last_listed_at: new Date(Date.now() - 2 * day).toISOString() }), { category: "houses" });
  const stale = M.score(agent({ n_houses: 3, last_listed_at: new Date(Date.now() - 900 * day).toISOString() }), { category: "houses" });
  const never = M.score(agent({ n_houses: 3 }), { category: "houses" });
  ok(fresh.p > stale.p, "listed this week beats listed two and a half years ago",
     `${fresh.p.toFixed(3)} > ${stale.p.toFixed(3)}`);
  ok(fresh.p > never.p && never.p > stale.p,
     "and a missing date sits between the two rather than counting as either");

  const verified = M.score(agent({ n_houses: 6, n_verified: 6 }), { category: "houses" });
  const unverified = M.score(agent({ n_houses: 6, n_verified: 0 }), { category: "houses" });
  ok(verified.p > unverified.p, "verified listings help", `${verified.p.toFixed(3)} > ${unverified.p.toFixed(3)}`);
}

// ---------------------------------------------------------------------------
section("Day jobs are a category like any other, not a special case");
{
  ok(M.CATEGORIES.length === 4 && M.CATEGORIES.indexOf("jobs") >= 0,
     "jobs is one of the four categories", M.CATEGORIES.join(", "));

  const need = { category: "jobs" };
  const blank = M.score(agent(), need);
  const hirer = M.score(agent({ n_jobs: 9 }), need);
  const landlord = M.score(agent({ n_houses: 9 }), need);

  ok(near(blank.p, M.PRIOR, 1e-9),
     "a company that has posted nothing scores exactly the prior", blank.p.toFixed(4));
  ok(hirer.p > blank.p, "nine day jobs beats no information",
     `${hirer.p.toFixed(3)} > ${blank.p.toFixed(3)}`);
  ok(landlord.p < blank.p,
     "nine rooms and no jobs is evidence against, exactly as it is for trucks",
     `${landlord.p.toFixed(3)} < ${blank.p.toFixed(3)}`);
  ok(hirer.evidence.some((e) => e.why === "category_depth"),
     "and the depth term fires on n_jobs rather than being silently skipped");
  ok(hirer.counts.jobs === 9 && hirer.total === 9,
     "day jobs count toward the denominator too", `total ${hirer.total}`);
}
{
  // The bug this guards against: reading n_jobs from a row that has none must
  // read as zero, not as NaN. An older pm_agent_finder returns exactly that
  // row, and a NaN here would poison the whole score into never sorting.
  const legacy = { user_id: "u", display_name: "Old", reachable: true, is_agent: true,
                   n_houses: 3, n_services: 0, n_trucks: 0, n_verified: 0 };
  const s = M.score(legacy, { category: "houses" });
  ok(isFinite(s.p) && s.p > 0 && s.p < 1,
     "a row from a finder that never heard of jobs still scores", String(s.p));
  ok(s.counts.jobs === 0 && s.total === 3, "with jobs read as none, not as unknown");
}
{
  // Focus is measured against 1/4 now. The claim that has to survive the move
  // is the one the term exists for: a token listing in a category is not a
  // speciality in it, however the baseline is set.
  const need = { category: "jobs" };
  const only = M.score(agent({ n_jobs: 1 }), need);
  const token = M.score(agent({ n_jobs: 1, n_houses: 11 }), need);
  ok(token.p < only.p,
     "one day job among eleven rooms is weaker than one day job alone",
     `${token.p.toFixed(3)} < ${only.p.toFixed(3)}`);

  const even = M.score(agent({ n_houses: 6, n_services: 6, n_trucks: 6, n_jobs: 6 }), need);
  const focused = M.score(agent({ n_jobs: 24 }), need);
  ok(focused.p > even.p,
     "twenty-four day jobs beats six of everything — same depth, different focus",
     `${focused.p.toFixed(3)} > ${even.p.toFixed(3)}`);
  ok(even.spread > 0.99, "and the even mix is described as fully spread", even.spread.toFixed(3));
  ok(focused.spread === 0, "while the focused one has no spread at all");
}
{
  // An unknown category must not quietly behave like "any". The database says
  // the same thing (an unmatched p_category matches nobody); the client has to
  // agree, or the two disagree about who is on the screen.
  const s = M.score(agent({ n_jobs: 40 }), { category: "vibarua" });
  ok(!s.evidence.some((e) => e.why.startsWith("category")),
     "a category nobody has heard of produces no category evidence");
  ok(near(s.p, M.PRIOR, 1e-9), "and scores the prior rather than a guess");
}

// ---------------------------------------------------------------------------
section("Bands and bounds");
{
  ok(M.band(0.9) === "strong" && M.band(0.5) === "good" &&
     M.band(0.25) === "possible" && M.band(0.05) === "weak", "the four bands come out in order");
  // Pile on every good thing at once: the result must still be a probability.
  const stacked = M.score(agent({
    n_trucks: 200, n_verified: 200, region: "Mwanza", district: "Nyamagana",
    ward: "Mirongo", area: "Mirongo", lat: -2.516, lng: 32.917,
    last_listed_at: new Date().toISOString(),
  }), { category: "trucks", region: "Mwanza", district: "Nyamagana", ward: "Mirongo",
        query: "Mirongo", at: { lat: -2.516, lng: 32.917 } });
  ok(stacked.p > 0 && stacked.p < 1, "the best possible agent is still under 1", stacked.p.toFixed(5));
  const worst = M.score(agent({ n_houses: 50, region: "Dodoma", last_listed_at: "2019-01-01T00:00:00Z" }),
                        { category: "trucks", region: "Mwanza" });
  ok(worst.p > 0 && worst.p < M.PRIOR, "and the worst is above 0 but below the prior", worst.p.toFixed(5));
}

// ---------------------------------------------------------------------------
section("rank — reachability first, then the score");
{
  const people = [
    agent({ user_id: "unreachable_star", display_name: "Zawadi", reachable: false, n_trucks: 30, region: "Mwanza" }),
    agent({ user_id: "meh", display_name: "Baraka", reachable: true, n_trucks: 1 }),
    agent({ user_id: "good", display_name: "Amina", reachable: true, n_trucks: 9, region: "Mwanza" }),
  ];
  const r = M.rank(people, { category: "trucks", region: "Mwanza" });
  ok(r[0].agent.user_id === "good", "the best reachable agent leads", r.map((x) => x.agent.user_id).join(", "));
  ok(r[2].agent.user_id === "unreachable_star",
     "the strongest match of all is last, because you cannot write to them");

  // Stability: identical scores must not shuffle between loads.
  const twins = [agent({ user_id: "b", display_name: "Bee" }), agent({ user_id: "a", display_name: "Ay" })];
  const o1 = M.rank(twins, {}).map((x) => x.agent.user_id).join(",");
  const o2 = M.rank(twins.slice().reverse(), {}).map((x) => x.agent.user_id).join(",");
  ok(o1 === o2, "two identically-scored people sort the same way whatever order they arrived in", o1 + " vs " + o2);
}

// ---------------------------------------------------------------------------
section("shortlist — combining people who are not independent");
{
  const spread = [
    { p: 0.4, agent: agent({ user_id: "a", reachable: true, ward: "Mirongo" }) },
    { p: 0.4, agent: agent({ user_id: "b", reachable: true, ward: "Pamba" }) },
    { p: 0.4, agent: agent({ user_id: "c", reachable: true, ward: "Igoma" }) },
  ];
  const piled = [
    { p: 0.4, agent: agent({ user_id: "a", reachable: true, ward: "Mirongo" }) },
    { p: 0.4, agent: agent({ user_id: "b", reachable: true, ward: "Mirongo" }) },
    { p: 0.4, agent: agent({ user_id: "c", reachable: true, ward: "Mirongo" }) },
  ];
  const s1 = M.shortlist(spread, 0.99);
  const s2 = M.shortlist(piled, 0.99);
  ok(s1.p > s2.p,
     "three agents in three wards beat three agents in one — they fail together",
     `${s1.p.toFixed(3)} > ${s2.p.toFixed(3)}`);
  ok(s2.g < s1.g, "and the shared-failure factor is what does it",
     `g ${s2.g.toFixed(3)} < ${s1.g.toFixed(3)}`);
  ok(s1.p < 1 && s2.p < 1, "neither reaches certainty, however many are added");
  ok(s1.capped && s2.capped, "asking for 99% reports that it could not be met");

  // The naive independent answer for three at 0.4 is 0.784. Anything at or
  // above that would mean the correlation model is not doing its job.
  ok(s2.p < 1 - Math.pow(0.6, 3),
     "the piled-up shortlist comes in below the naive independent figure",
     `${s2.p.toFixed(3)} < ${(1 - Math.pow(0.6, 3)).toFixed(3)}`);
}
{
  // It stops as soon as the target is met — the point is a SHORT list.
  const many = [];
  for (let i = 0; i < 5; i++) many.push({ p: 0.7, agent: agent({ user_id: "u" + i, reachable: true, ward: "W" + i }) });
  const s = M.shortlist(many, 0.8);
  ok(s.picks.length < 5, "it stops once the target is met rather than listing everybody",
     s.picks.length + " picked");
  ok(!s.capped, "and reports the target as met", s.p.toFixed(3));
  ok(s.p >= 0.8, "with a combined figure that actually clears it", s.p.toFixed(3));
}
{
  const none = M.shortlist([{ p: 0.9, agent: agent({ reachable: false }) }], 0.5);
  ok(none.picks.length === 0 && none.p === 0,
     "an unreachable-only pool produces no shortlist rather than a fictional one");
  ok(M.shortlist([], 0.5).picks.length === 0, "and an empty pool does not throw");
}

// ---------------------------------------------------------------------------
section("Nothing asked for is answered with the prior, not with noise");
{
  const r = M.rank([agent({ user_id: "a", n_houses: 4 }), agent({ user_id: "b", n_trucks: 2 })], {});
  ok(r.every((x) => x.p > 0 && x.p < 1), "everybody still gets a real probability");
  ok(r[0].evidence.every((e) => e.why !== "category_depth"),
     "and no category evidence is invented when no category was asked for");
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
