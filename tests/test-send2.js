const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  const logs = [], errors = [];
  page.on('console', m => {
    const txt = m.text();
    logs.push(`[${m.type()}] ${txt}`);
    if (m.type() === 'error' || m.type() === 'warning') errors.push(txt);
  });
  page.on('pageerror', e => errors.push('PAGE ERROR: ' + e.message));
  page.on('requestfailed', req => errors.push(`404/failed: ${req.url()}`));

  await page.goto('http://localhost:8080/send.html', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await new Promise(r => setTimeout(r, 5000)); // wait for async Supabase init + queries

  // Inject a diagnostic — run DataStore directly and report results
  const diag = await page.evaluate(async () => {
    try {
      const cfg = window.APP_CONFIG;
      const hasSb = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && window.supabase);
      const sbType = typeof window.supabase;
      const sbKeys = window.supabase ? Object.keys(window.supabase) : [];
      const SBtype = typeof window.SB;

      let regResult = null, regErr = null;
      try {
        const regions = await window.DataStore.getRegions();
        regResult = regions.slice(0, 3);
      } catch(e) { regErr = e.message; }

      let busResult = null, busErr = null;
      try {
        const buses = await window.DataStore.getBuses();
        busResult = buses.length;
      } catch(e) { busErr = e.message; }

      return { hasSb, sbType, sbKeys, SBtype, regResult, regErr, busResult, busErr };
    } catch(e) {
      return { topError: e.message };
    }
  });

  console.log('\n=== Diagnostic ===');
  console.log(JSON.stringify(diag, null, 2));

  console.log('\n=== All console messages ===');
  logs.forEach(l => console.log(' ', l));

  if (errors.length) {
    console.log('\n=== Errors/Warnings ===');
    errors.forEach(e => console.log(' ', e));
  }

  await browser.close();
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
