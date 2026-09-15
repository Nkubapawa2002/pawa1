// ============================================================================
// pm_listing_card_test.mjs — reading a room, a service or a truck out of a
// message body.
//
// This file is the second exception to the rule that message bodies in
// P-Message are escaped and NEVER linkified. The first is the invite card, and
// tests/pm_invite_card_test.mjs says at length why that rule exists: turning
// arbitrary text into a tappable, styled, trusted-looking button inside an
// encrypted chat hands an attacker the best phishing surface in the app.
//
// The whole of the fence is isOurs(): a listing page, on this app's own
// origin, parsed with the URL constructor. So most of what follows is written
// as attacks, and each one passes against the obvious wrong implementation
// (a regex for "house.html?id=").
//
// The rest is about the two promises the card makes to the people using it:
//
//   · the reference carries the kind and the id and NOTHING ELSE, so a price
//     is always the catalogue's and never a copy quoted out of a composer
//     somebody left open yesterday,
//   · and the link into the composer carries WHAT, never WHO.
//
//   usage:  node tests/pm_listing_card_test.mjs   (no server, no browser)
// ============================================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The library reads window.location through the URL constructor, so the
// sandbox needs a real origin and a real href to resolve against.
const ORIGIN = "https://pawa.example";
const sandbox = { console, URL, URLSearchParams, window: {} };
sandbox.window.window = sandbox.window;
sandbox.window.location = { href: ORIGIN + "/p-message.html", origin: ORIGIN };
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, "js/lib/pm-listing-card.js"), "utf8"), sandbox);
const C = sandbox.window.PMListingCard;

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; process.stdout.write("  PASS  " + msg + "\n"); }
  else { fail++; process.stdout.write("  FAIL  " + msg + (detail ? "\n        " + detail : "") + "\n"); }
};

const ID = "7f3c1b8e-0d21-4a55-9c60-2b4e1a9d3f77";
const LINK = `${ORIGIN}/house.html?id=${ID}`;

process.stdout.write("\n1. Our own listing is recognised\n");
{
  const body = C.compose({ kind: "house", id: ID }, "Have a look at this one");
  ok(body.includes(LINK), "compose puts the listing's own public URL in the body as plain text", body);
  ok(body.split("\n")[0] === "Have a look at this one",
     "and the sentence a person wrote comes first");
  const got = C.read(body);
  ok(got && got.kind === "house" && got.id === ID, "read gets the kind and the id back out",
     JSON.stringify(got));
  ok(C.has(body), "has() agrees");
  ok(C.read("just some words") === null, "a body with no link is not a listing");
}

process.stdout.write("\n2. All three kinds, and only those three\n");
{
  [["house", "house.html"], ["service", "service.html"], ["truck", "truck.html"]].forEach(([kind, page]) => {
    const hit = C.read(`${ORIGIN}/${page}?id=${ID}`);
    ok(hit && hit.kind === kind, kind + " is read off " + page, JSON.stringify(hit));
    ok(C.urlFor(kind, ID) === `${ORIGIN}/${page}?id=${ID}`,
       "and urlFor builds the same link back", C.urlFor(kind, ID));
  });
  // Day jobs have no detail page. A card that opened onto the jobs board would
  // be a card pointing at the wrong thing, so there is deliberately no row.
  ok(C.urlFor("job", ID) === "", "a day job has no listing page, so it has no link");
  ok(C.read(`${ORIGIN}/jobs.html?id=${ID}`) === null, "and the jobs board is not one");
}

process.stdout.write("\n3. A link on somebody else's domain is NOT drawn as a listing\n");
{
  const attacks = [
    // The obvious one.
    `https://evil.example/house.html?id=${ID}`,
    // Our origin as a substring of theirs. A hostname endsWith() check passes
    // this; only a parser does not.
    `https://pawa.example.evil.com/house.html?id=${ID}`,
    // Our whole URL carried inside theirs as a parameter. A regex looking for
    // "pawa.example/house.html?id=" finds it here.
    `https://evil.example/go?to=${ORIGIN}/house.html?id=${ID}`,
    // A prefix of our host, and a suffix of it.
    `https://notpawa.example/house.html?id=${ID}`,
    // Right host, wrong scheme.
    `http://pawa.example/house.html?id=${ID}`,
    // Unicode that renders like our name.
    `https://pawa.exampIe/house.html?id=${ID}`,
    // Our page name as the tail of theirs. "(^|/)" is what refuses this; a
    // bare "endsWith(page)" does not.
    `https://evil.example/mad-house.html?id=${ID}`,
  ];
  attacks.forEach((a) => {
    ok(C.read("look at this " + a) === null,
       "refused: " + a.slice(0, 64), "it was read as one of ours");
  });
  // Same shape, our own origin: the last one must still be refused there, or
  // the fence only works against other people's domains.
  ok(C.read(`${ORIGIN}/mad-house.html?id=${ID}`) === null,
     "refused on our own origin too: /mad-house.html is not /house.html");
}

process.stdout.write("\n4. Our origin, but not a listing\n");
{
  ok(C.read(`${ORIGIN}/house.html`) === null, "the page with no id is not a listing");
  ok(C.read(`${ORIGIN}/house.html?ref=abc`) === null, "and neither is one with some other parameter");
  ok(C.read(`${ORIGIN}/houses.html?id=${ID}`) === null,
     "the catalogue is not a listing, even though its name starts the same");
  ok(C.read(`${ORIGIN}/p-message.html?i=abc`) === null, "an invite is not a listing");
}

process.stdout.write("\n5. Punctuation belongs to the sentence, not to the URL\n");
{
  const hit = C.read(`Is this the one you meant? ${LINK}.`);
  ok(hit && hit.id === ID, "a full stop after the link is not part of it", JSON.stringify(hit));
  const bracket = C.read(`(${LINK})`);
  ok(bracket && bracket.id === ID, "and neither is a closing bracket", JSON.stringify(bracket));
}

process.stdout.write("\n6. The words are kept, the link is not printed twice\n");
{
  const body = C.compose({ kind: "truck", id: ID }, "Two tonnes, and he has loaders");
  ok(C.stripped(body) === "Two tonnes, and he has loaders",
     "stripped() leaves the sentence and takes the link", JSON.stringify(C.stripped(body)));
  const bare = C.compose({ kind: "truck", id: ID }, "");
  ok(C.stripped(bare) === "", "a message that is only a link has no note, not a fabricated one",
     JSON.stringify(C.stripped(bare)));
  const two = C.read(`It is near the school.\nCheaper than the last one.\n${LINK}`);
  ok(two && two.note === "It is near the school. Cheaper than the last one.",
     "two sentences before the link are both kept", JSON.stringify(two && two.note));
}

process.stdout.write("\n7. The reference carries the kind and the id, and nothing else\n");
{
  // The card looks the listing up for itself at the far end. Nothing about the
  // room travels in the message, so a price cannot be quoted at somebody out
  // of a stale copy — and a doctored link cannot name a room one thing in a
  // conversation and another thing in the catalogue.
  const body = C.compose({ kind: "house", id: ID, title: "Master, Mikocheni", price: 450000 },
                         "what do you think");
  ok(!body.includes("Mikocheni"), "the title does not travel in the body", body);
  ok(!body.includes("450000"), "and neither does the price", body);
  const got = C.read(body);
  ok(got && Object.keys(got).sort().join(",") === "id,kind,note,url",
     "what comes back out is the kind, the id, the link and the human words",
     JSON.stringify(got && Object.keys(got)));
}

process.stdout.write("\n8. The card is drawn as a frame, and fills in afterwards\n");
{
  const html = C.card({ kind: "house", id: ID, url: LINK }, { reach: true });
  ok(/data-lc-pending="1"/.test(html), "it starts pending, so hydrate() knows to fill it");
  ok(html.includes('data-lc-kind="house"') && html.includes('data-lc-id="' + ID + '"'),
     "the kind and the id ride in data attributes, not an index into a list that gets redrawn");
  ok(html.includes(LINK), "and the link is on the card before anything is looked up");
  ok(/class="pm-lc-reach" hidden/.test(html), "the door onto whoever posted it is reserved and hidden");
  const mine = C.card({ kind: "house", id: ID, url: LINK }, { reach: false });
  ok(!mine.includes("pm-lc-reach"), "and is not drawn at all on your own message");
  ok(C.card({ kind: "job", id: ID }, {}) === "", "a kind with no page draws no card");
}

process.stdout.write("\n9. The card escapes what it is given\n");
{
  const html = C.card({ kind: "house", id: '"><script>alert(1)</script>', url: "x" }, {});
  ok(!html.includes("<script>"), "an id full of markup is escaped, not executed", html.slice(0, 160));
  ok(!/id="">/.test(html), "and does not break out of its own attribute");
}

process.stdout.write("\n10. The door into the composer carries WHAT, never WHO\n");
{
  const href = C.sendHref("house", ID, "Master, Mikocheni");
  ok(href.startsWith("p-message.html?listing=house%3A" + ID),
     "the link names the listing", href);
  ok(!/[?&](to|i)=/.test(href),
     "and never a recipient: choosing who to show a room to is a decision, not a query string", href);
  ok(href.includes("&t=Master%2C%20Mikocheni") || href.includes("&t=Master%2C+Mikocheni"),
     "the title rides along for the strip above the composer", href);
  ok(C.sendHref("house", "") === "", "no id, no link");
  ok(C.sendHref("job", ID) === "", "and no page, no link");

  const btn = C.sendButton("truck", { id: ID, title: "Canter, Mbezi" }, { className: "td-cta-send" });
  ok(btn.includes('class="td-cta-send"'), "the button takes the caller's class, as pm-reach.js does");
  ok(btn.includes("<svg"), "it carries a stroke SVG");
  ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(btn), "and no emoji");
  ok(C.sendButton("truck", { id: "" }, {}) === "", "a row with no id draws no button");
}

process.stdout.write("\n" + pass + " passed, " + fail + " failed\n");
process.exit(fail ? 1 : 0);
