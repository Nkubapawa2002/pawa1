// Exercises js/lib/video-national.js against a stubbed Supabase client.
import { readFileSync } from "node:fs";
let pass=0, fail=0;
const ok=(m,c)=>{ c?(pass++,console.log("  PASS "+m)):(fail++,console.log("  FAIL "+m)); };

function load(sbStub) {
  const w = { APP_CONFIG: { SUPABASE_URL: "https://x.supabase.co" }, SB: sbStub };
  w.window = w;
  const src = readFileSync("js/lib/video-national.js","utf8");
  new Function("window", src + "\n;return window;")(w);
  return w.VideoNational;
}
const clientReturning = (data, error=null) => ({
  from: () => ({ select: () => ({ is: () => ({ maybeSingle: async () => ({ data, error }) }) }) }),
});

console.log("\nvideo-national\n");
{
  const VN = load(clientReturning({ storage_path: "a/b.mp4", label: "Habari" }));
  const r = await VN.current();
  ok("returns the global default row", r && r.path === "a/b.mp4" && r.label === "Habari");
  ok("builds a public storage URL",
     VN.publicUrl("a/b.mp4") === "https://x.supabase.co/storage/v1/object/public/region-videos/a/b.mp4");
}
{
  const VN = load(clientReturning(null));
  ok("no default set -> null", (await VN.current()) === null);
}
{
  const VN = load(clientReturning(null, { message: "boom" }));
  ok("query error -> null, never throws", (await VN.current()) === null);
}
{
  const VN = load(clientReturning({ storage_path: null }));
  ok("row without a path -> null", (await VN.current()) === null);
}
{
  const VN = load({ from: () => { throw new Error("offline"); } });
  ok("client throwing -> null, never throws", (await VN.current()) === null);
}
{
  const w = { APP_CONFIG:{SUPABASE_URL:"https://x.supabase.co"}, SB:null }; w.window=w;
  new Function("window", readFileSync("js/lib/video-national.js","utf8")+"\n;return window;")(w);
  ok("no client at all -> null", (await w.VideoNational.current()) === null);
  await w.VideoNational.mount(null);
  ok("mount(null) is a no-op, not a crash", true);
}
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail?1:0);
