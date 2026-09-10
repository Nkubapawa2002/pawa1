// ============================================================================
// pm_invite_card_test.mjs — reading an invite out of a message body.
//
// One of these assertions is a security assertion and the rest are about not
// breaking it. Message bodies in P-Message are escaped and deliberately NOT
// linkified, because turning arbitrary text into tappable links inside an
// encrypted chat hands an attacker a styled, trusted-looking button. This card
// is the single exception, and it is only safe while it recognises exactly one
// thing: an invite on this app's own origin.
//
// So the tests are written as attacks, and each one would pass against the
// obvious wrong implementation (a regex for "p-message.html?i="):
//
//   · a link on somebody else's domain
//   · our origin appearing inside somebody else's URL as a parameter
//   · our host as a prefix of a longer hostname
//   · http where we are https
//   · a token on a different page of ours
//
//   usage:  node tests/pm_invite_card_test.mjs   (no server, no browser)
// ============================================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The library reads window.location.origin through the URL constructor, so the
// sandbox needs a real one of each.
const ORIGIN = "https://pawa.example";
const sandbox = { console, URL, window: {} };
sandbox.window.window = sandbox.window;
sandbox.window.location = { href: ORIGIN + "/p-message.html", origin: ORIGIN };
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, "js/lib/pm-invite-card.js"), "utf8"), sandbox);
const C = sandbox.window.PMInviteCard;

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; process.stdout.write("  PASS  " + msg + "\n"); }
  else { fail++; process.stdout.write("  FAIL  " + msg + (detail ? "\n        " + detail : "") + "\n"); }
};

const TOKEN = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWpr";
const LINK  = `${ORIGIN}/p-message.html?i=${TOKEN}`;

process.stdout.write("\n1. Our own invite is recognised\n");
{
  const body = C.compose(LINK, "");
  ok(body.includes(LINK), "compose puts the link in the body as plain text");
  const got = C.read(body);
  ok(got && got.token === TOKEN, "and read gets the token back out", JSON.stringify(got));
  ok(C.has(body), "has() agrees");
  ok(C.read("just some words") === null, "a body with no link is not an invite");
}

process.stdout.write("\n2. A link on somebody else's domain is NOT drawn as an invite\n");
{
  const attacks = [
    // The obvious one.
    `https://evil.example/p-message.html?i=${TOKEN}`,
    // Our origin as a substring of theirs. A hostname `endsWith` check passes
    // this; only a parser does not.
    `https://pawa.example.evil.com/p-message.html?i=${TOKEN}`,
    // Our whole URL carried inside theirs as a parameter. A regex looking for
    // "pawa.example/p-message.html?i=" finds it here.
    `https://evil.example/go?to=${ORIGIN}/p-message.html?i=${TOKEN}`,
    // A prefix of our host, and a suffix of it.
    `https://notpawa.example/p-message.html?i=${TOKEN}`,
    // Right host, wrong scheme. An invite is a bearer token and http hands it
    // to anybody on the network.
    `http://pawa.example/p-message.html?i=${TOKEN}`,
    // Unicode that renders like our name.
    `https://pawa.exampIe/p-message.html?i=${TOKEN}`,
  ];
  attacks.forEach((a) => {
    ok(C.read("look at this " + a) === null,
       "refused: " + a.slice(0, 62), "it was read as one of ours");
  });
}

process.stdout.write("\n3. Our origin, but not an invite\n");
{
  ok(C.read(`${ORIGIN}/houses.html?i=${TOKEN}`) === null,
     "a token on another page of ours is not an invitation to a conversation");
  ok(C.read(`${ORIGIN}/p-message.html`) === null, "and neither is the page with no token");
  ok(C.read(`${ORIGIN}/p-message.html?i=abc`) === null,
     "nor a token far too short to be one of ours");
  ok(C.read(`${ORIGIN}/p-message.html?to=someone`) === null,
     "nor the deep link that opens a conversation, which carries no credential");
}

process.stdout.write("\n4. The words a person wrote survive\n");
{
  const body = C.compose(LINK, "My brother is looking too. Send him this.");
  const got = C.read(body);
  ok(got.note === "My brother is looking too. Send him this.",
     "the note comes back whole", got && got.note);
  ok(C.stripped(body) === "My brother is looking too. Send him this.",
     "and the link is stripped from what gets printed, so it is not shown twice");
  ok(C.stripped(LINK) === "", "a message that is nothing but a link has no note, not a made-up one");
  const plain = C.compose(LINK, "");
  ok(C.read(plain).note.length > 10, "with no note, compose writes the neutral sentence");
}

process.stdout.write("\n5. Punctuation belongs to the sentence, not to the URL\n");
{
  ok(C.read(`Here it is: ${LINK}.`).token === TOKEN, "a full stop after the link is not part of it");
  ok(C.read(`(${LINK})`).token === TOKEN, "and neither is a closing bracket");
}

process.stdout.write("\n6. The card says something different at each end\n");
{
  const inv = C.read(C.compose(LINK, ""));
  const mine = C.card(inv, { mine: true });
  const theirs = C.card(inv, { mine: false });
  ok(!mine.includes("<a "), "the sender is not offered a button to open their own invite");
  ok(theirs.includes("<a "), "the recipient is");
  ok(theirs.includes(LINK), "and the button goes to the real link");
  ok(mine.includes("Whoever opens it first"),
     "the sender is told the thing about links that cannot be fixed");
  ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(mine + theirs),
     "no emoji, on either card");
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
