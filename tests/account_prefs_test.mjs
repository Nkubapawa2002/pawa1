// ============================================================================
// account_prefs_test.mjs — one set of preferences per account type.
//
// "Each type of account should be shown things in its own preferences."
//
// The trap in that sentence is the word TYPE. Nobody in this app is assigned
// one: a person who lists a house is a house owner, and if they post a truck
// tomorrow they are that too, and they never stopped being somebody looking
// for a room. So the type is derived from what the account has actually
// listed, and these tests are the ones that fail if it ever becomes a field.
//
// The rest is about not losing somebody's settings: two people share a phone,
// a guest signs out, private mode refuses to store anything.
//
//   usage:  node tests/account_prefs_test.mjs   (no server, no browser)
// ============================================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function load({ breakStorage = false } = {}) {
  const store = new Map();
  const sandbox = {
    console,
    window: {},
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => {
        if (breakStorage) throw new Error("QuotaExceededError");
        store.set(k, String(v));
      },
      removeItem: (k) => store.delete(k),
    },
  };
  sandbox.window.window = sandbox.window;
  sandbox.window.localStorage = sandbox.localStorage;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(ROOT, "js/lib/account-prefs.js"), "utf8"), sandbox);
  return { AP: sandbox.window.AccountPrefs, store };
}

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; process.stdout.write("  PASS  " + msg + "\n"); }
  else { fail++; process.stdout.write("  FAIL  " + msg + (detail ? "\n        " + detail : "") + "\n"); }
};

process.stdout.write("\n1. An account is what it has listed, not what it was labelled\n");
{
  const { AP } = load();
  const keys = (c) => AP.typesOf(c).map((t) => t.key).join(",");

  ok(keys({ houses: 3 }) === "houses", "somebody with three houses is a house owner");
  ok(keys({ houses: 2, trucks: 1 }) === "houses,trucks",
     "and somebody with a house and a truck is BOTH, not the first one that matched",
     keys({ houses: 2, trucks: 1 }));
  ok(keys({}) === "", "somebody who has listed nothing is offered nothing to arrange");
  ok(keys({ houses: 0, trucks: 0 }) === "",
     "and a zero is nothing listed, not a type with an empty catalogue");
  ok(keys({ houses: "4" }) === "houses",
     "the counts arrive from a screen as strings and still count");
  ok(keys({ jobs: 1 }) === "jobs", "day jobs are a type like any other");
  ok(AP.typesOf(null).length === 0, "no counts at all is not an error");
}

process.stdout.write("\n2. The default is the fair queue, and that is the point\n");
{
  const { AP } = load();
  ok(AP.get("u1", "houses").order === "fair",
     "an owner who has chosen nothing gets the order that stops them being buried");
  ok(AP.DEFAULTS.order === "fair", "stated once, in one place");
  ok(AP.ORDERS.map((o) => o.key).join(",") === "fair,newest,recommended",
     "with the fair queue offered first", AP.ORDERS.map((o) => o.key).join(","));
  // Each option must say what it COSTS as well as what it does: an order with
  // no downside stated is an advertisement, not a choice.
  ok(AP.ORDERS.every((o) => o.d && o.d !== o.i18n),
     "and every option carries its own explanation key");
}

process.stdout.write("\n3. A choice is kept, per type, per person\n");
{
  const { AP } = load();
  AP.set("u1", "houses", { order: "newest" });
  ok(AP.get("u1", "houses").order === "newest", "what was chosen is what comes back");
  ok(AP.get("u1", "trucks").order === "fair",
     "and it did not leak onto another type of the same account");
  ok(AP.get("u2", "houses").order === "fair",
     "nor onto another person on the same phone, which is the one that matters");

  AP.set("u1", "houses", { notify: false });
  ok(AP.get("u1", "houses").order === "newest",
     "changing one setting leaves the others alone");
  ok(AP.get("u1", "houses").notify === false, "and the new one is kept");

  AP.set("u1", "houses", { order: "nonsense" });
  ok(AP.get("u1", "houses").order === "fair",
     "an order nobody offers falls back to the default rather than being stored and obeyed");
}

process.stdout.write("\n4. Signed out is a third person, not the absence of one\n");
{
  const { AP } = load();
  AP.set(null, "houses", { order: "newest" });
  ok(AP.get(null, "houses").order === "newest", "a signed-out choice is kept for the session");
  ok(AP.get("u1", "houses").order === "fair",
     "and signing in does NOT inherit it, because they may be two different people");
}

process.stdout.write("\n5. Ending a guest session takes the guest's settings with it\n");
{
  const { AP } = load();
  AP.set("guest1", "houses", { order: "newest" });
  AP.set("u1", "houses", { order: "recommended" });
  AP.forget("guest1");
  ok(AP.get("guest1", "houses").order === "fair", "the guest's choices are gone");
  ok(AP.get("u1", "houses").order === "recommended",
     "and nobody else's went with them", AP.get("u1", "houses").order);
  AP.forget("nobody");
  ok(true, "forgetting somebody who was never there does not throw");
}

process.stdout.write("\n6. A browser that refuses to store anything still works\n");
{
  const { AP } = load({ breakStorage: true });
  const back = AP.set("u1", "houses", { order: "newest" });
  ok(back && back.order === "fair",
     "the write is swallowed and get() reports the truth, not the value that failed to save",
     JSON.stringify(back));
  ok(AP.get("u1", "houses").order === "fair", "so nothing on screen claims to have been saved");
}

process.stdout.write("\n7. Reading somebody else's rubbish out of the store\n");
{
  const { AP, store } = load();
  store.set("pawa-prefs-v1", "not json");
  ok(AP.get("u1", "houses").order === "fair", "corrupt storage reads as defaults, not a crash");
  store.set("pawa-prefs-v1", JSON.stringify({ "u:u1": { houses: "a string" } }));
  ok(AP.get("u1", "houses").order === "fair", "and so does a value of the wrong shape");
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
