// ============================================================================
// p_message_lock_test.mjs — sealing the private key in the phone's hardware.
//
// js/lib/pm-device-lock.js takes the one irreversible action in this whole
// feature: it deletes the plaintext private key and keeps only a copy wrapped
// under a WebAuthn PRF secret. If any part of that is wrong, the failure is
// not a broken screen — it is every message the person has ever received
// becoming permanently unreadable.
//
// So the tests are about loss, not about the happy path:
//
//   · the plaintext really is gone, and the blob really does not contain it
//   · a LOCKED device is not mistaken for a NEW one — the thing that would
//     mint a second keypair, publish it, and orphan the first
//   · unlocking returns the SAME key, not merely some key
//   · turning it off gives the key back rather than dropping it
//   · it refuses to seal anything without a backup code first
//   · a wrong or reset passkey fails loudly instead of half-succeeding
//
// Chrome's virtual authenticator does support the PRF extension, so none of
// this is mocked: the real WebAuthn calls run against a real (virtual)
// authenticator and the real WebCrypto wraps the real key.
//
//   usage:  node server.js      then, in another shell:
//           node tests/p_message_lock_test.mjs
// ============================================================================
import puppeteer from "puppeteer";

const BASE = "http://localhost:8080";
let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  PASS  " + msg); }
  else { fail++; console.log("  FAIL  " + msg + (detail ? "\n        " + detail : "")); }
};
const section = (s) => console.log("\n" + s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A Supabase stand-in with just enough to get past me() and ensureIdentity.
const STUB = `
window.supabase = { createClient: function () {
  return {
    auth: {
      getSession: function () {
        return Promise.resolve({ data: { session: {
          user: { id: "user_locked", email: "someone@example.com", is_anonymous: false } } } });
      },
      onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; },
    },
    rpc: function (name) {
      if (name === "pm_inbox" || name === "pm_directory") return Promise.resolve({ data: [], error: null });
      return Promise.resolve({ data: null, error: null });
    },
    channel: function () { return { on: function () { return this; }, subscribe: function () { return this; },
      unsubscribe: function () {} }; },
    removeChannel: function () {},
  };
}};
`;

const browser = await puppeteer.launch({
  headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"], protocolTimeout: 120000,
});
const page = await browser.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
await page.setViewport({ width: 420, height: 900 });
await page.setRequestInterception(true);
page.on("request", (req) => {
  const url = req.url();
  if (req.method() === "OPTIONS") {
    return req.respond({ status: 204, headers: {
      "access-control-allow-origin": "*", "access-control-allow-headers": "*",
      "access-control-allow-methods": "*" } });
  }
  if (/cdn\.jsdelivr\.net.*supabase/.test(url)) {
    return req.respond({ status: 200, headers: { "content-type": "application/javascript" }, body: STUB });
  }
  if (/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(url)) {
    return req.respond({ status: 200, headers: { "content-type": "text/css" }, body: "" });
  }
  if (/supabase\.co/.test(url)) {
    return req.respond({ status: 200, headers: {
      "access-control-allow-origin": "*", "content-type": "application/json" }, body: "[]" });
  }
  req.continue();
});

// A real virtual authenticator: platform-attached, user-verifying, PRF-capable.
const cdp = await page.createCDPSession();
await cdp.send("WebAuthn.enable");
const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: {
    protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal",
    hasResidentKey: true, hasUserVerification: true, isUserVerified: true,
    automaticPresenceSimulation: true, hasPrf: true,
  },
});

const load = async () => {
  await page.goto(BASE + "/p-message.html", { waitUntil: "domcontentloaded" });
  await sleep(1400);
};

try {
  await load();

  section("1. Before anything is sealed");
  {
    const state = await page.evaluate(() => ({
      supported: typeof window.PMDeviceLock !== "undefined",
      enrolled: window.PMDeviceLock.isEnrolled(),
      locked: window.PMDeviceLock.isLocked(),
    }));
    ok(state.supported, "the library is loaded on the page");
    ok(!state.enrolled, "nothing is enrolled yet");
    ok(!state.locked, "and an un-enrolled device is not 'locked' — it is just open");
    ok(await page.evaluate(async () => await window.PMDeviceLock.supported()),
       "the virtual authenticator reports as a usable platform authenticator");
  }

  section("2. It refuses to seal a key with no way back");
  {
    const err = await page.evaluate(async () => {
      const id = await window.PMCrypto.generateIdentity();
      window.PMCrypto.save(id);
      window.__ID = id;
      try {
        await window.PMDeviceLock.enroll(id, { userId: "user_locked", backupSaved: false });
        return "no error";
      } catch (e) { return e.message; }
    });
    ok(err === "NO_BACKUP",
       "enrolling without a saved backup code is refused outright", err);
    ok(await page.evaluate(() => !!localStorage.getItem("pm-identity-v1")),
       "and the key is left exactly where it was");
  }

  section("3. Sealing it");
  {
    const res = await page.evaluate(async () => {
      await window.PMDeviceLock.enroll(window.__ID, { userId: "user_locked", backupSaved: true });
      return {
        plain: localStorage.getItem("pm-identity-v1"),
        blob: localStorage.getItem("pm-device-lock-v1"),
        stillWorks: !!window.PMCrypto.load(),
      };
    });
    ok(res.plain === null, "the plaintext key is gone from storage", String(res.plain).slice(0, 40));
    ok(!!res.blob, "a sealed blob is there instead");
    const priv = await page.evaluate(() => window.__ID.privateKey);
    ok(res.blob.indexOf(priv) < 0,
       "and the blob does NOT contain the private key in the clear");
    ok(res.blob.indexOf(priv.slice(0, 24)) < 0, "not even the first few bytes of it");
    ok(res.stillWorks,
       "the session that sealed it keeps working — nobody is logged out by turning this on");
    ok(JSON.parse(res.blob).publicKey === await page.evaluate(() => window.__ID.publicKey),
       "the PUBLIC half stays readable, because it is public");
  }

  section("4. After a reload — the case that could destroy an identity");
  {
    await load();
    const state = await page.evaluate(() => ({
      locked: window.PMDeviceLock.isLocked(),
      loaded: window.PMCrypto.load(),
      pub: window.PMDeviceLock.publicKey(),
    }));
    ok(state.locked, "the device reports itself locked");
    ok(state.loaded === null, "and PMCrypto has no key to hand out");
    ok(!!state.pub, "though the public half is still readable with no prompt at all");

    // THE test. A locked device must not look like a device that has never
    // had a key: that path generates a new keypair, publishes it, and every
    // message received under the old one becomes permanently unreadable.
    const err = await page.evaluate(async () => {
      try { await window.PMStore.ensureIdentity(); return "no error"; }
      catch (e) { return e.message; }
    });
    ok(err === "LOCKED",
       "ensureIdentity refuses rather than minting a second keypair", err);
    ok(await page.evaluate(() => localStorage.getItem("pm-identity-v1")) === null,
       "and nothing new was written over the sealed one");

    ok(await page.$("#pmUnlockBtn") !== null,
       "the page offers to unlock instead of claiming encryption is broken");
    const gateText = await page.$eval("#pmGate", (n) => n.textContent);
    ok(/locked to this device/i.test(gateText), "and says why", gateText.slice(0, 60));
  }

  section("5. Opening it again");
  {
    const got = await page.evaluate(async () => {
      const id = await window.PMDeviceLock.unlock();
      return { priv: id.privateKey, pub: id.publicKey, loadable: !!window.PMCrypto.load() };
    });
    const original = await page.evaluate(() => JSON.parse(localStorage.getItem("pm-device-lock-v1")).publicKey);
    ok(got.pub === original, "unlocking returns the key that was sealed, not a new one");
    ok(got.loadable, "and PMCrypto can hand it out for the rest of the session");
    ok(await page.evaluate(() => localStorage.getItem("pm-identity-v1")) === null,
       "without writing it back to disk — a session copy only");

    // And it really is the same key: something sealed to it must open.
    ok(await page.evaluate(async () => {
      const me = window.PMCrypto.load();
      const sealed = await window.PMCrypto.seal({
        threadId: "t-lock", senderId: "user_locked",
        recipients: [{ userId: "user_locked", publicKey: me.publicKey }],
        plaintext: "bado ipo?",
      });
      const row = Object.assign({ thread_id: "t-lock", sender_id: "user_locked",
        iv: sealed.iv, ciphertext: sealed.ciphertext }, sealed.keys[0]);
      return (await window.PMCrypto.open(row, { userId: "user_locked", ...me })) === "bado ipo?";
    }), "and the recovered key actually decrypts — it is the same key, not merely the same shape");
  }

  section("6. Turning it off gives the key back");
  {
    const res = await page.evaluate(async () => {
      await window.PMDeviceLock.disable();
      return {
        plain: localStorage.getItem("pm-identity-v1"),
        blob: localStorage.getItem("pm-device-lock-v1"),
      };
    });
    ok(!!res.plain, "the key is back in ordinary storage");
    ok(res.blob === null, "and the sealed blob is gone");
    ok(JSON.parse(res.plain).publicKey === await page.evaluate(() => window.PMDeviceLock.publicKey() || JSON.parse(localStorage.getItem("pm-identity-v1")).publicKey),
       "and it is the same key throughout — nothing was swapped in the round trip");

    await load();
    ok(!await page.evaluate(() => window.PMDeviceLock.isLocked()),
       "a reload finds an ordinary unlocked device again");
    ok(await page.evaluate(() => !!window.PMCrypto.load()), "with its key readable");
  }

  section("7. A passkey that is not the one it was sealed with");
  {
    // Reset the authenticator: the credential still exists as far as the
    // stored blob is concerned, but the secret behind the PRF is gone. This
    // is a phone reset, or passkeys cleared.
    await page.evaluate(async () => {
      const id = window.PMCrypto.load();
      await window.PMDeviceLock.enroll(id, { userId: "user_locked", backupSaved: true });
    });
    ok(await page.evaluate(() => window.PMDeviceLock.isEnrolled()), "sealed again for this test");

    await cdp.send("WebAuthn.clearCredentials", { authenticatorId });
    await load();
    const err = await page.evaluate(async () => {
      try { await window.PMDeviceLock.unlock(); return "no error"; }
      catch (e) { return e.message; }
    });
    ok(err !== "no error", "unlocking fails once the passkey is gone", err);
    ok(await page.evaluate(() => !!localStorage.getItem("pm-device-lock-v1")),
       "the sealed blob is NOT deleted on a failed attempt — the backup code is still the way in");
    ok(await page.evaluate(() => localStorage.getItem("pm-identity-v1")) === null,
       "and no replacement identity is quietly created");
  }

  section("8. Nothing threw along the way");
  {
    const real = errs.filter((e) => !/NotAllowedError|favicon|ai-chat/i.test(e));
    ok(real.length === 0, "no page errors", real.join(" | "));
  }
} finally {
  await browser.close();
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
}
