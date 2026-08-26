import puppeteer from "puppeteer";
const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("PAGEERROR: " + (e.stack || e.message)));
page.on("console", (m) => { if (m.type()==="error") errors.push("CONSOLE.ERR: " + m.text()); });

// Stub a logged-in session BEFORE login.js runs by injecting on new document.
await page.evaluateOnNewDocument(() => {
  window.__fakeRouted = false;
});
await page.goto("http://localhost:8080/login.html", { waitUntil: "networkidle2", timeout: 30000 });

// Now force the signed-in path: stub Auth.getSession to a fake session and re-init.
const res = await page.evaluate(async () => {
  try {
    window.Auth.getSession = async () => ({ user: { id: "00000000-0000-0000-0000-000000000000", email: "pawa4761@gmail.com" } });
    // Re-run the page init so the "already signed in" IIFE fires with the fake session.
    window.initLoginPage();
    await new Promise(r => setTimeout(r, 1500));
    return "ran initLoginPage with fake session";
  } catch (e) { return "EVAL ERR: " + (e.stack || e.message); }
});
await new Promise(r=>setTimeout(r,1500));
console.log("RESULT:", res);
console.log(errors.length ? errors.join("\n\n---\n\n") : "(no errors captured)");
await browser.close();
