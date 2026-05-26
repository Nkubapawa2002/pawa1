const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const SCREENSHOTS = path.join(__dirname, 'test-screenshots');
if (!fs.existsSync(SCREENSHOTS)) fs.mkdirSync(SCREENSHOTS);

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGE ERROR: ' + e.message));

  console.log('1. Loading send.html...');
  await page.goto('http://localhost:8080/send.html', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await new Promise(r => setTimeout(r, 5000)); // wait for async Supabase queries to complete
  await page.screenshot({ path: path.join(SCREENSHOTS, '01-loaded.png'), fullPage: true });
  console.log('   Screenshot: 01-loaded.png');

  // Check that regions populated
  const regionCount = await page.$eval('select[name="senderRegion"]', el => el.options.length);
  console.log(`   Regions loaded: ${regionCount} options`);

  const busCount = await page.$eval('select[name="bus"]', el => el.options.length);
  console.log(`   Buses loaded: ${busCount} options`);

  console.log('2. Filling sender info...');
  await page.type('input[name="senderName"]', 'Test Sender');
  await page.type('input[name="senderPhone"]', '+255712000001');
  await page.select('select[name="senderRegion"]', 'Dar es Salaam');
  await new Promise(r => setTimeout(r, 500));

  // Check agents loaded for Dar es Salaam
  const agentCount = await page.$eval('#originAgentSelect', el => el.options.length);
  console.log(`   Agents for Dar es Salaam: ${agentCount - 1} found`);

  if (agentCount > 1) {
    await page.select('#originAgentSelect', await page.$eval('#originAgentSelect option:nth-child(2)', el => el.value));
    await new Promise(r => setTimeout(r, 300));
    const agentCardHidden = await page.$eval('#originAgentCard', el => el.hidden);
    console.log(`   Agent card shown: ${!agentCardHidden}`);
  }

  console.log('3. Filling receiver info...');
  await page.type('input[name="receiverName"]', 'Test Receiver');
  await page.type('input[name="receiverPhone"]', '+255712000002');
  await page.select('select[name="receiverRegion"]', 'Arusha');

  console.log('4. Filling product details...');
  await page.type('input[name="productDesc"]', 'Test parcel - electronics');
  await page.type('input[name="weight"]', '5');
  await new Promise(r => setTimeout(r, 300));

  // Check freight estimate updates
  const freightText = await page.$eval('#freightEstimate', el => el.textContent);
  console.log(`   Freight estimate: "${freightText}"`);

  await page.type('input[name="value"]', '500000');
  await new Promise(r => setTimeout(r, 200));

  // Check insurance preview
  const insVisible = await page.$eval('#insurancePreview', el => el.style.display !== 'none');
  console.log(`   Insurance preview visible: ${insVisible}`);
  const insText = await page.$eval('#insurancePreview', el => el.textContent);
  console.log(`   Insurance text: "${insText.trim()}"`);

  // Change size category to large
  await page.select('#sizeCategorySelect', 'large');
  await new Promise(r => setTimeout(r, 200));
  const freightLarge = await page.$eval('#freightEstimate', el => el.textContent);
  console.log(`   Freight estimate (large): "${freightLarge}"`);

  console.log('5. Selecting bus and date...');
  // Pick first bus
  const firstBusVal = await page.$eval('select[name="bus"] option:nth-child(2)', el => el.value).catch(() => '');
  if (firstBusVal) await page.select('select[name="bus"]', firstBusVal);
  await new Promise(r => setTimeout(r, 200));

  await page.screenshot({ path: path.join(SCREENSHOTS, '02-form-filled.png'), fullPage: true });
  console.log('   Screenshot: 02-form-filled.png');

  console.log('6. Submitting form...');
  await page.click('button[type="submit"]');
  await new Promise(r => setTimeout(r, 4000)); // wait for Supabase call

  await page.screenshot({ path: path.join(SCREENSHOTS, '03-after-submit.png'), fullPage: true });
  console.log('   Screenshot: 03-after-submit.png');

  // Check if price panel appeared
  const panelHidden = await page.$eval('#pricePanel', el => el.hidden).catch(() => true);
  const formHidden  = await page.$eval('#sendForm',   el => el.hidden).catch(() => false);
  console.log(`   Price panel shown: ${!panelHidden}`);
  console.log(`   Form hidden: ${formHidden}`);

  if (!panelHidden) {
    const trackingCode = await page.$eval('#panelTrackingCode', el => el.textContent).catch(() => '');
    const titleText    = await page.$eval('#pricePanelTitle', el => el.textContent).catch(() => '');
    const statusText   = await page.$eval('#priceStatusContent', el => el.textContent).catch(() => '');
    console.log(`   Tracking code: "${trackingCode}"`);
    console.log(`   Panel title: "${titleText}"`);
    console.log(`   Status text: "${statusText}"`);
  }

  // Check error banner
  const bannerContent = await page.$eval('#resultBanner', el => el.innerHTML).catch(() => '');
  if (bannerContent) console.log(`   Banner: ${bannerContent.replace(/<[^>]+>/g, ' ').trim()}`);

  if (errors.length) {
    console.log(`\n⚠ Console errors (${errors.length}):`);
    errors.forEach(e => console.log('  ' + e));
  } else {
    console.log('\n✓ No JS console errors.');
  }

  await browser.close();
  console.log('\nDone. Screenshots saved to test-screenshots/');
})().catch(e => { console.error('Test failed:', e.message); process.exit(1); });
