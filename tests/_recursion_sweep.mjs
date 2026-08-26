import puppeteer from "puppeteer";
const PAGES = ["index.html","login.html","admin.html","super-admin.html","agent-houses.html",
  "agent-services.html","agent-trucks.html","houses.html","house.html","services.html","service.html",
  "near-me.html","jobs.html","favorites.html","chat.html","meet.html","trucks.html","truck.html","share-location.html"];
const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
for (const p of PAGES) {
  const page = await browser.newPage();
  const errs = [];
  page.on("pageerror", e => errs.push((e.stack||e.message).split("\n").slice(0,4).join(" | ")));
  page.on("console", m => { if (m.type()==="error") errs.push("C:"+m.text().slice(0,160)); });
  try { await page.goto(`http://localhost:8080/${p}`, { waitUntil:"networkidle2", timeout:25000 }); }
  catch(e){ errs.push("GOTO:"+e.message); }
  await new Promise(r=>setTimeout(r,1500));
  const rec = errs.filter(e=>/recursion|call stack|Maximum/i.test(e));
  console.log(`${p.padEnd(22)} ${errs.length? (rec.length?"♻ RECURSION":"err"):"ok"}  ${rec[0]||errs[0]||""}`);
  await page.close();
}
await browser.close();
