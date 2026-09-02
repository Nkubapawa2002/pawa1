// ============================================================================
// house_demand_place_test.mjs — telling an agent where you mean when the map
// has never heard of it. Runs against the REAL database.
//
// supabase/features/house/house_demand_place.sql exists for one failure: a
// seeker names a place the geocoder cannot find, the pin falls back to the
// region centroid, and house_demand_near then matches on a distance measured
// from a point nobody chose. The whole test is therefore about a pin that is
// FAR from the agent and must still reach them, and a pin that is far and must
// NOT.
//
// Every row it writes is prefixed `pmtest_` and removed at both ends of the
// run, and it never commits: each case runs inside a transaction that is
// rolled back, so production data is untouched.
//
//   usage:  node tests/house_demand_place_test.mjs
// ============================================================================
import { runSql, literal } from "../scripts/db/sql.mjs";

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  PASS  " + msg); }
  else { fail++; console.log("  FAIL  " + msg + (detail ? "\n        " + detail : "")); }
};
const section = (s) => console.log("\n" + s);

// Kigamboni, and the centroid of Dar es Salaam that a failed geocode lands on.
// ~13 km apart: far outside any sane radius, which is the entire point.
const AGENT = { lat: -6.8235, lng: 39.3300, ward: "Kigamboni", district: "Kigamboni" };
const CENTROID = { lat: -6.7924, lng: 39.2083 };

function pin(extra) {
  const base = {
    id: "'pmtest_" + Math.random().toString(36).slice(2, 10) + "'",
    lat: CENTROID.lat, lng: CENTROID.lng,
    radius_m: 1500, listing: "'rent'", phone: "'+255700000000'",
    name: "'pmtest seeker'", active: "true",
  };
  const row = Object.assign(base, extra);
  const cols = Object.keys(row).join(", ");
  const vals = Object.values(row).join(", ");
  return `insert into public.house_demand_pins (${cols}) values (${vals});`;
}

// One transaction per case, always rolled back.
async function inTx(setup, query) {
  const sql = `begin;\n${setup}\n${query}\nrollback;`;
  const out = await runSql(sql);
  return out;
}

const NEAR = (extra = "") => `
  select coalesce(string_agg(matched_on || '|' || coalesce(ward,'-') ||
    '|' || coalesce(place_label,'-') || '|' || coalesce(distance_m::text,'null'), ' ; '), 'NONE') as r
  from public.house_demand_near(
    ${AGENT.lat}, ${AGENT.lng}, 1500, 'rent', null, 0, 0,
    ${literal(AGENT.ward)}, ${literal(AGENT.district)})
  where id like 'pmtest_%' ${extra};`;

try {
  await runSql("delete from public.house_demand_pins where id like 'pmtest_%';");

  // =========================================================================
  section("1. The failure this file exists for");
  // =========================================================================
  {
    // A pin left on the region centroid, the way every unmappable place used
    // to be sent. 13 km from the agent, so distance can never reach them.
    const r = await inTx(pin({ anchor_kind: "'region'" }), NEAR());
    ok(String(r[0].r) === "NONE",
       "a region-centroid pin does NOT reach an agent 13 km away, which is how these requests were dying",
       JSON.stringify(r[0].r));
  }

  // =========================================================================
  section("2. Naming the ward exactly is what rescues it");
  // =========================================================================
  {
    const r = await inTx(
      pin({ anchor_kind: "'ward'", ward: "'Kigamboni'", district: "'Kigamboni'",
            place_label: "'Kwa Ndege, nyuma ya shule'" }),
      NEAR());
    const v = String(r[0].r);
    ok(v.startsWith("ward|"),
       "the same request, anchored on the ward, reaches the agent despite the distance", v);
    ok(v.includes("Kwa Ndege"),
       "and carries the seeker's own words, which is the only part an agent will recognise", v);
    ok(v.endsWith("|null"),
       "with NO distance reported, because the point is a stand-in and a number here would be invented", v);
  }

  // =========================================================================
  section("3. Names that are written differently but mean one place");
  // =========================================================================
  {
    const r = await inTx(
      pin({ anchor_kind: "'ward'", ward: "'kata ya  KIGAMBONI Ward'",
            district: "'Kigamboni'", place_label: "'Sokoni'" }),
      NEAR());
    ok(String(r[0].r).startsWith("ward|"),
       "a ward typed with a prefix, a suffix, doubled spaces and the wrong case still matches",
       String(r[0].r));
  }

  // =========================================================================
  section("4. The fences that stop it becoming a shotgun");
  // =========================================================================
  {
    const r = await inTx(
      pin({ anchor_kind: "'ward'", ward: "'Mikocheni'", district: "'Kinondoni'",
            place_label: "'somewhere else'" }),
      NEAR());
    ok(String(r[0].r) === "NONE",
       "a different ward does not match, so naming a ward narrows rather than widens",
       String(r[0].r));
  }
  {
    // A ward pin deliberately does NOT fall through to the district: somebody
    // who could name their ward meant that ward.
    const r = await inTx(
      pin({ anchor_kind: "'ward'", ward: "'Vijibweni'", district: "'Kigamboni'",
            place_label: "'x'" }),
      NEAR());
    ok(String(r[0].r) === "NONE",
       "a ward pin does not fall through to the district it sits in", String(r[0].r));
  }
  {
    const r = await inTx(
      pin({ anchor_kind: "'district'", district: "'Kigamboni'", place_label: "'Kwa Ndege'" }),
      NEAR());
    ok(String(r[0].r).startsWith("district|"),
       "a district pin matches the district, for a seeker who did not know their ward",
       String(r[0].r));
  }

  // =========================================================================
  section("5. Nothing that worked yesterday stops working");
  // =========================================================================
  {
    // A real point, close by. Arm 1, exactly as before this file existed.
    const r = await inTx(
      pin({ lat: AGENT.lat + 0.002, lng: AGENT.lng, anchor_kind: "'exact'" }),
      NEAR());
    const v = String(r[0].r);
    ok(v.startsWith("distance|"), "a real nearby point still matches on distance", v);
    ok(!v.endsWith("|null"), "and still reports a real distance", v);
  }
  {
    const r = await inTx(
      pin({ lat: AGENT.lat + 0.002, lng: AGENT.lng }),   // anchor_kind omitted
      NEAR());
    ok(String(r[0].r).startsWith("distance|"),
       "a pin written with no anchor_kind at all defaults to exact, so old rows are unaffected",
       String(r[0].r));
  }

  // =========================================================================
  section("6. An agent who registered no ward");
  // =========================================================================
  {
    const sql = `begin;
${pin({ anchor_kind: "'ward'", ward: "'Kigamboni'", district: "'Kigamboni'", place_label: "'x'" })}
select coalesce(string_agg(matched_on, ','), 'NONE') as r
  from public.house_demand_near(${AGENT.lat}, ${AGENT.lng}, 1500, 'rent', null, 0, 0, null, null)
  where id like 'pmtest_%';
rollback;`;
    const r = await runSql(sql);
    ok(String(r[0].r) === "NONE",
       "cannot be matched by name, and gets no false positive either: the named arm simply cannot fire",
       String(r[0].r));
  }

  // =========================================================================
  section("7. An agent who works in more than one ward");
  // =========================================================================
  // agent_profiles carried ONE ward until agent_multi_area.sql, which made the
  // singular column decide which requests an agent could see at all. An agent
  // covering three wards was reachable in one and invisible in the other two.
  const NEAR_MULTI = (wards, districts) => `
    select coalesce(string_agg(matched_on || '|' || coalesce(ward,'-'), ' ; '), 'NONE') as r
    from public.house_demand_near(
      ${AGENT.lat}, ${AGENT.lng}, 1500, 'rent', null, 0, 0,
      null, null, ${wards}, ${districts})
    where id like 'pmtest_%';`;
  {
    const r = await inTx(
      pin({ anchor_kind: "'ward'", ward: "'Vijibweni'", district: "'Kigamboni'",
            place_label: "'Kwa Ndege'" }),
      NEAR_MULTI("array['Kigamboni','Vijibweni','Kibada']", "null"));
    ok(String(r[0].r).startsWith("ward|"),
       "a request in the agent's SECOND ward reaches them", String(r[0].r));
  }
  {
    const r = await inTx(
      pin({ anchor_kind: "'ward'", ward: "'Mikocheni'", district: "'Kinondoni'",
            place_label: "'x'" }),
      NEAR_MULTI("array['Kigamboni','Vijibweni','Kibada']", "null"));
    ok(String(r[0].r) === "NONE",
       "a ward outside the set still does not, so covering more is not covering everything",
       String(r[0].r));
  }
  {
    // Spelling drift across the array, not just against a single value.
    const r = await inTx(
      pin({ anchor_kind: "'ward'", ward: "'kata ya  VIJIBWENI Ward'",
            district: "'Kigamboni'", place_label: "'x'" }),
      NEAR_MULTI("array['Kigamboni','Vijibweni']", "null"));
    ok(String(r[0].r).startsWith("ward|"),
       "and every entry in the set is compared normalised, not literally",
       String(r[0].r));
  }
  {
    // The singular argument must still be folded in, or a caller that passes
    // only p_ward loses its match the moment arrays exist.
    const r = await inTx(
      pin({ anchor_kind: "'ward'", ward: "'Kigamboni'", district: "'Kigamboni'",
            place_label: "'x'" }),
      NEAR());
    ok(String(r[0].r).startsWith("ward|"),
       "a caller still passing only the singular ward keeps working", String(r[0].r));
  }

  const left = await runSql("select count(*)::int c from public.house_demand_pins where id like 'pmtest_%';");
  ok(Number(left[0].c) === 0, "every test row is gone", JSON.stringify(left[0]));
} finally {
  await runSql("delete from public.house_demand_pins where id like 'pmtest_%';").catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
