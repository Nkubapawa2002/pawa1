// Pictures of PN-Zaki, in both themes:
//   1. the pane you land on — hero, the six things worth asking, the honest
//      warning, and the one row that leads to a person
//   2. a real conversation, answered by a stubbed gemini-chat, showing the
//      list/link/money formatting an answer is allowed to carry
//   3. the same conversation with the voice dock open
//   4. chat.html, which is now support and nothing else
//
// Usage: node server.js   then:  node tests/_shot_pn_zaki.mjs [light|dark]
import puppeteer from "puppeteer";

const theme = process.argv[2] || "dark";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The answer the stubbed model gives. It deliberately contains every shape the
// renderer has a rule for — bold, a bullet list, a page name, a TZS amount —
// so a picture of it is a test of the formatter, not just of the layout.
const REPLY = [
  "Karibu! There are **three rooms** in Nyamagana within that budget right now:",
  "",
  "- Two rooms, Mirongo — TZS 250,000/month",
  "- Self-contained near the market — TZS 180,000/month",
  "- Shop on the main road — TZS 900,000/month",
  "",
  "Open houses.html and filter by area to see photos and call the owner.",
].join("\n");

// The Supabase client stub. P-Message needs an identity and an inbox before it
// will draw anything at all, so this is the smallest shape that gets the page
// past its gate — the assistant itself needs none of it.
const stub = `window.supabase={createClient:function(){
var s={user:{id:"me",email:"pawa4761@gmail.com",is_anonymous:false}};
function t(){var b={};["select","eq","neq","gt","gte","lt","lte","is","or","order","limit","in"].forEach(function(m){b[m]=function(){return b}});
b.then=function(r,j){return Promise.resolve({data:[],error:null}).then(r,j)};return b}
return{rpc:function(n){
 if(n==="pm_online_window")return Promise.resolve({data:150,error:null});
 if(n==="pm_touch_seen")return Promise.resolve({data:new Date().toISOString(),error:null});
 if(n==="pm_inbox")return Promise.resolve({data:[],error:null});
 return Promise.resolve({data:[],error:null})},from:t,
auth:{getSession:function(){return Promise.resolve({data:{session:s},error:null})},getUser:function(){return Promise.resolve({data:{user:s.user},error:null})},signOut:function(){return Promise.resolve({error:null})},onAuthStateChange:function(){return{data:{subscription:{unsubscribe:function(){}}}}}},
channel:function(){return{on:function(){return this},subscribe:function(){return this}}},removeChannel:function(){},
storage:{from:function(){return{getPublicUrl:function(){return{data:{publicUrl:""}}}}}}}}};`;

const b = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"], protocolTimeout: 120000 });

async function open(path, seedLog) {
  const p = await b.newPage();
  await p.setViewport({ width: 390, height: 900, deviceScaleFactor: 2, isMobile: true });
  await p.setRequestInterception(true);
  p.on("request", (r) => {
    const u = r.url();
    if (/cdn\.jsdelivr\.net.*supabase/.test(u))
      return r.respond({ status: 200, headers: { "content-type": "application/javascript" }, body: stub });
    if (/fonts\.googleapis|fonts\.gstatic/.test(u))
      return r.respond({ status: 200, headers: { "content-type": "text/css" }, body: "" });
    // The service worker precaches a long list on install and every one of
    // those goes through this same (serialised) queue. An empty worker keeps
    // the queue short without changing anything the test looks at.
    if (/service-worker\.js/.test(u))
      return r.respond({ status: 200, headers: { "content-type": "application/javascript" }, body: "" });
    if (/^http:\/\/localhost:8080\//.test(u)) return r.continue();
    // Everything else is third-party. Refusing is instant; letting it out to a
    // real network stalls the queue for seconds.
    return r.abort();
  });

  await p.evaluateOnNewDocument((t, log, reply) => {
    try {
      localStorage.setItem("pawa-theme", t);
      if (log) localStorage.setItem("pm-assistant-log-v1", log);
      else localStorage.removeItem("pm-assistant-log-v1");
    } catch (e) {}
    // The brain, stubbed where it leaves the browser. Answering gemini-chat
    // means the Anthropic fallback is never reached, which is the path a real
    // deployment takes too — and it keeps this a test of PN-Zaki rather than
    // of puppeteer's cross-origin interception, which does not reliably
    // resolve a POST.
    const real = window.fetch.bind(window);
    window.__pzCalls = [];
    window.fetch = (input, init) => {
      const url = String((input && input.url) || input || "");
      window.__pzCalls.push(url);
      const json = (o) => Promise.resolve(new Response(JSON.stringify(o), {
        status: 200, headers: { "content-type": "application/json" } }));
      if (url.includes("/functions/v1/gemini-chat")) return json({ reply });
      if (url.includes("/functions/v1/gemini-token")) return json({ token: "stub" });
      if (url.includes("/functions/v1/")) return json({});
      return real(input, init);
    };
  }, theme, seedLog || "", REPLY);

  await p.goto("http://localhost:8080/" + path, { waitUntil: "domcontentloaded" });
  await wait(2400);
  return p;
}

function must(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; }
  else console.log("  ok  ", msg);
}

// ── 1. the pane ────────────────────────────────────────────────────────────
{
  const p = await open("p-message.html");
  await p.evaluate(() => { const m = document.getElementById("pmModalBack"); if (m) m.classList.remove("is-on"); });
  await p.evaluate(() => document.getElementById("segAi").click());
  await wait(700);

  const seen = await p.evaluate(() => ({
    seg: (document.getElementById("segAi") || {}).textContent,
    name: (document.querySelector(".pz-hero-name") || {}).textContent,
    caps: document.querySelectorAll(".pz-cap").length,
    support: (document.querySelector(".pz-support .pm-name") || {}).textContent,
    supportHref: document.querySelector(".pz-support") ? document.querySelector(".pz-support").getAttribute("href") : null,
    warn: !!document.querySelector(".pz-warn"),
    // The old one-line row and the old "voice agent and support" link must be
    // gone, not merely hidden.
    oldRow: !!document.querySelector("[data-ai]"),
  }));

  must(/PN-Zaki/.test(seen.seg), "the segment is named PN-Zaki");
  must(/PN-Zaki/.test(seen.name), "the hero names PN-Zaki");
  must(seen.caps === 6, "six suggestions are offered (got " + seen.caps + ")");
  must(/support/i.test(seen.support), 'the last row says "Contact support" (got "' + seen.support + '")');
  must(seen.supportHref === "chat.html", "and it goes to chat.html");
  must(seen.warn, "the not-encrypted warning is on the pane");
  must(!seen.oldRow, "the old one-line assistant row is gone");

  await p.screenshot({ path: `tests/shot_pz_pane_${theme}.png` });
  await p.close();
}

// ── 2. a conversation ──────────────────────────────────────────────────────
{
  const p = await open("p-message.html");
  await p.evaluate(() => { const m = document.getElementById("pmModalBack"); if (m) m.classList.remove("is-on"); });
  await p.evaluate(() => document.getElementById("segAi").click());
  await wait(500);
  // Tapping a suggestion IS the question — no typing, no second press.
  await p.evaluate(() => document.querySelectorAll(".pz-cap")[0].click());
  await wait(2500);

  const conv = await p.evaluate(() => ({
    open: document.getElementById("pmConv").classList.contains("is-on"),
    name: document.getElementById("pmConvName").textContent,
    lock: document.getElementById("pmLockText").textContent,
    msgs: document.querySelectorAll("#pmLog .pm-msg").length,
    list: document.querySelectorAll("#pmLog .pz-list li").length,
    link: document.querySelector("#pmLog .pz-link") ? document.querySelector("#pmLog .pz-link").getAttribute("href") : null,
    money: document.querySelectorAll("#pmLog .pz-money").length,
    bold: document.querySelectorAll("#pmLog strong").length,
    micShown: !document.getElementById("pmVoiceBtn").hidden,
    pinShown: !document.getElementById("pmPlaceBtn").hidden,
    // The log survives a reload: it is this device's, in localStorage.
    stored: JSON.parse(localStorage.getItem("pm-assistant-log-v1") || "[]").length,
  }));

  must(conv.open, "the conversation opened");
  must(/PN-Zaki/.test(conv.name), "with PN-Zaki's name in the header");
  must(/not encrypted/i.test(conv.lock) || /Haijafichwa/i.test(conv.lock),
       'the lock line says "not encrypted" (got "' + conv.lock + '")');
  must(conv.msgs === 2, "the question and the answer are both drawn (got " + conv.msgs + ")");
  must(conv.list === 3, "the answer's three bullets became one list (got " + conv.list + ")");
  must(conv.link === "houses.html", "the page name became a link (got " + conv.link + ")");
  must(conv.money === 3, "the three TZS amounts got the mono treatment (got " + conv.money + ")");
  must(conv.bold === 1, "the bold run rendered (got " + conv.bold + ")");
  must(conv.micShown, "the voice button is offered on this thread");
  must(!conv.pinShown, "and the send-a-place button is not — PN-Zaki cannot travel");
  must(conv.stored === 2, "and the turn was kept on this device (got " + conv.stored + ")");

  await p.screenshot({ path: `tests/shot_pz_thread_${theme}.png` });

  // ── 3. the voice dock ────────────────────────────────────────────────────
  await p.evaluate(() => document.getElementById("pmVoiceBtn").click());
  await wait(500);
  const dock = await p.evaluate(() => ({
    shown: !document.getElementById("pmVoiceDock").hidden,
    state: (document.querySelector("#pmVoiceDock .pz-state") || {}).textContent,
    // Showing the dock must not have started anything.
    live: !!(window.PNZaki && window.PNZaki.voiceActive()),
    // And the log is still there — the whole point of a dock over a tab.
    msgs: document.querySelectorAll("#pmLog .pm-msg").length,
  }));
  must(dock.shown, "the dock opens from the header button");
  must(!dock.live, "opening the dock does NOT open the microphone");
  must(dock.msgs === 2, "and the conversation is still on screen behind it");
  // ── 3b. one conversation, two inputs ─────────────────────────────────────
  // The claim this whole rebuild rests on: a spoken line and a typed line land
  // in the SAME log, in order, and survive the mic being turned off. Proved
  // with a fake session standing in for Gemini Live — the real one needs a
  // microphone and a socket, neither of which a test has, but everything
  // between the transcript callback and the screen is the shipping code.
  await p.evaluate(() => {
    window.PNZaki.stopVoice();
    window.PawaVoice = function (opts) {
      this.start = async () => {
        opts.onState("listening");
        opts.onTranscript("user", "Nataka lori la kuhamia Mwanza");
        opts.onTranscript("assistant", "Kuna malori matatu Mwanza. Nikupe namba?");
        opts.onState("listening");
      };
      this.stop = () => opts.onState("idle");
      this.sendText = () => {};
    };
  });
  await p.evaluate(() => document.querySelector("#pmVoiceDock [data-pz-mic]").click());
  await wait(900);

  const spoken = await p.evaluate(() => ({
    msgs: document.querySelectorAll("#pmLog .pm-msg").length,
    voiceMarks: document.querySelectorAll("#pmLog .pz-msg.is-voice").length,
    order: [...document.querySelectorAll("#pmLog .pm-msg")].map((m) => m.className.includes("mine") ? "u" : "a").join(""),
    stored: JSON.parse(localStorage.getItem("pm-assistant-log-v1") || "[]").map((r) => r.role + (r.voice ? "!" : "")).join(","),
  }));
  must(spoken.msgs === 4, "the spoken turn joined the typed one in one log (got " + spoken.msgs + ")");
  must(spoken.order === "uaua", "in order, question then answer, twice (got " + spoken.order + ")");
  must(spoken.voiceMarks === 2, "with the two spoken lines marked as spoken (got " + spoken.voiceMarks + ")");
  must(spoken.stored === "user,assistant,user!,assistant!",
       "and all four kept on this device (got " + spoken.stored + ")");
  await p.screenshot({ path: `tests/shot_pz_voice_${theme}.png` });

  // Turning the mic off must not take away what was said through it.
  await p.evaluate(() => document.querySelector("#pmVoiceDock [data-pz-mic]").click());
  await wait(400);
  const afterMic = await p.evaluate(() => document.querySelectorAll("#pmLog .pm-msg").length);
  must(afterMic === 4, "and hanging up leaves the transcript on screen (got " + afterMic + ")");

  // ── 3c. typing still works, with the dock open ───────────────────────────
  await p.evaluate(() => {
    document.getElementById("pmInput").value = "Asante";
    document.getElementById("pmComposeForm").dispatchEvent(new Event("submit"));
  });
  await wait(2000);
  const typed = await p.evaluate(() => ({
    msgs: document.querySelectorAll("#pmLog .pm-msg").length,
    input: document.getElementById("pmInput").value,
  }));
  must(typed.msgs === 6, "typing into the same thread carries on from there (got " + typed.msgs + ")");
  must(typed.input === "", "and the composer clears");

  // Leaving the thread must hang up and put the dock away.
  await p.evaluate(() => document.getElementById("pmBack").click());
  await wait(400);
  const after = await p.evaluate(() => ({
    dock: !document.getElementById("pmVoiceDock").hidden,
    mic: !document.getElementById("pmVoiceBtn").hidden,
    live: !!(window.PNZaki && window.PNZaki.voiceActive()),
  }));
  must(!after.dock && !after.mic && !after.live, "leaving the thread closes the dock and hangs up");
  await p.close();
}

// ── 4. a link straight to PN-Zaki ──────────────────────────────────────────
{
  const p = await open("p-message.html?seg=ai&voice=1");
  await wait(900);
  const seen = await p.evaluate(() => ({
    pane: document.getElementById("paneAi").classList.contains("is-on"),
    conv: document.getElementById("pmConv").classList.contains("is-on"),
    dock: !document.getElementById("pmVoiceDock").hidden,
    live: !!(window.PNZaki && window.PNZaki.voiceActive()),
  }));
  must(seen.pane, "?seg=ai lands on the PN-Zaki pane");
  must(seen.conv && seen.dock, "&voice=1 opens the thread with the dock showing");
  must(!seen.live, "but a link can never open the microphone");
  await p.close();
}

// ── 5. chat.html is support, and only support ──────────────────────────────
{
  const p = await open("chat.html");
  const sup = await p.evaluate(() => ({
    title: document.title,
    cards: document.querySelectorAll(".sp-card").length,
    call: !!document.querySelector(".sp-btn.is-call"),
    wa: !!document.querySelector(".sp-btn.is-wa"),
    zakiHref: document.querySelector(".sp-zaki") ? document.querySelector(".sp-zaki").getAttribute("href") : null,
    // Nothing that talks to a model may survive on this page.
    brains: ["AI", "PNZaki", "GeminiChat", "PawaVoice", "AITools"].filter((k) => !!window[k]),
    tabs: document.querySelectorAll(".chat-tab").length,
  }));
  must(/support/i.test(sup.title), "the page is titled for support");
  must(sup.cards === 2 && sup.call && sup.wa, "both contacts render with Call and WhatsApp");
  must(sup.zakiHref === "p-message.html?seg=ai", "and it points back at PN-Zaki");
  must(sup.brains.length === 0, "no AI client is loaded here any more (found: " + sup.brains + ")");
  must(sup.tabs === 0, "the old three-tab bar is gone");
  await p.screenshot({ path: `tests/shot_pz_support_${theme}.png`, fullPage: true });
  await p.close();
}

await b.close();
console.log(process.exitCode ? "\nFAILED" : "\nall ok");
