const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/hisol/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

// Serve only the real first-paint welcome/policy markup and controller. No live
// backend is contacted and no booking, payment, or customer data is created.
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const initial = html.slice(0, html.indexOf('<div class="toasts"'))
  .replace(/<script\b[^>]*\bsrc=[^>]*><\/script>/gi, '') + `
  <main id="courts" style="max-width:1100px;margin:auto;padding:24px;box-sizing:border-box">
    <h1>Book a court</h1><p>Choose your date and available court hours.</p>
    <div style="display:grid;gap:16px">${[1,2,3].map(court => `<section style="padding:24px;border:1px solid #9eb9c1;border-radius:18px;background:#eaf1f4;color:#1b424b"><h2>Court ${court}</h2><p>Available times</p><div style="display:flex;gap:10px;flex-wrap:wrap">${['8:00 AM','9:00 AM','10:00 AM','11:00 AM'].map(time => `<button style="padding:14px;border:1px solid #88afb7;border-radius:10px;background:white;color:#215a66">${time}</button>`).join('')}</div></section>`).join('')}</div>
  </main><script src="slow.js"></script></body></html>`;
const out = path.join(root, 'artifacts/entry-policy');
const passed = [];

(async () => {
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  try {
    const page = await browser.newPage({ viewport:{ width:390, height:844 }, reducedMotion:'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let release;
    let slowPending = false;
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'entry-policy.test') return route.abort();
      if (url.pathname === '/slow.js') {
        slowPending = true;
        await new Promise(resolve => { release = resolve; });
        return route.fulfill({ contentType:'text/javascript', body:'window.bookingScriptsLoaded=true;' });
      }
      if (url.pathname === '/') return route.fulfill({ contentType:'text/html', body:initial });
      const local = path.join(root, decodeURIComponent(url.pathname));
      if (fs.existsSync(local) && fs.statSync(local).isFile()) return route.fulfill({ path:local });
      return route.abort();
    });
    async function start(caseName) {
      release = null;
      slowPending = false;
      await page.goto('https://entry-policy.test/?case=' + encodeURIComponent(caseName), { waitUntil:'commit' });
      await page.waitForFunction(() => document.getElementById('psWelcome')?.open);
      await page.evaluate(() => {
        window.entryFinished = false;
        window.PB_WELCOME_DISMISSED.then(() => { window.entryFinished = true; });
      });
    }
    async function loadRest() {
      while (!slowPending) await new Promise(resolve => setTimeout(resolve, 10));
      release();
      await page.waitForLoadState('load');
    }
    async function policyOpen() {
      await page.locator('[data-welcome-dismiss]').click();
      assert.equal(await page.locator('#psWelcome').evaluate(el => el.open), false);
      assert.equal(await page.locator('#psEntryPolicy').evaluate(el => el.matches(':modal')), true);
      assert.equal(await page.evaluate(() => window.entryFinished), false);
    }

    await start('slow-first-paint');
    assert.equal(await page.evaluate(() => window.bookingScriptsLoaded === true), false);
    await policyOpen();
    assert.equal(await page.evaluate(() => window.bookingScriptsLoaded === true), false);
    passed.push('Tap to book opens policy before booking scripts load; startup remains pending');
    const copy = (await page.locator('#psEntryPolicy').innerText()).replace(/\s+/g, ' ');
    for (const expected of [
      'PICKLE STREET – TGBK', 'BOOKING & REBOOKING POLICY',
      'Pickle Street – TGBK operates as an open court. Bookings are considered final and are non-refundable.',
      'Rebooking will only be allowed if rain or wet court conditions make the court unsafe or unusable for play.',
      'For safety and convenience, rebooking may be arranged subject to court availability.',
      'Light rain, passing showers, or weather conditions that do not make the court unsafe or unplayable will not automatically qualify for rebooking.',
      'Thank you for understanding and for helping us keep our courts safe and enjoyable for everyone.'
    ]) assert.ok(copy.includes(expected), 'Missing exact policy wording: ' + expected);
    passed.push('All supplied policy wording appears without changed conditions');
    assert.equal(await page.locator('[data-entry-policy-back]').count(), 0);
    assert.equal(await page.locator('[data-entry-policy-continue]').innerText(), 'Agree & Continue');
    passed.push('One Agree & Continue action; no Back button');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#psEntryPolicy').evaluate(el => el.matches(':modal')), true);
    assert.equal(await page.evaluate(() => window.entryFinished), false);
    passed.push('Escape does not acknowledge policy');
    await page.locator('[data-entry-policy-continue]').click();
    await page.waitForFunction(() => window.entryFinished === true);
    assert.equal(await page.locator('#psEntryPolicy').evaluate(el => el.open), false);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'courts');
    passed.push('Continue completes entry and places focus on courts');
    await loadRest();

    await start('automatic-recovery');
    await page.evaluate(() => window.dismissPickleStreetWelcome());
    await page.waitForFunction(() => window.entryFinished === true);
    assert.equal(await page.locator('#psWelcome').evaluate(el => el.open), false);
    assert.equal(await page.locator('#psEntryPolicy').evaluate(el => el.open), false);
    passed.push('Automatic recovery skips policy');
    await loadRest();

    await start('automatic-recovery-during-policy');
    await policyOpen();
    await page.evaluate(() => window.dismissPickleStreetWelcome());
    await page.waitForFunction(() => window.entryFinished === true);
    assert.equal(await page.locator('#psEntryPolicy').evaluate(el => el.open), false);
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('ps-entry-policy-open')), false);
    passed.push('Automatic recovery closes an already-open policy');
    await loadRest();

    fs.mkdirSync(out, { recursive:true });
    for (const view of [
      { name:'mobile-320', width:320, height:568 },
      { name:'mobile-390', width:390, height:844 },
      { name:'mobile-short', width:390, height:500 },
      { name:'desktop', width:1440, height:900 },
      { name:'mobile-dark', width:390, height:844, dark:true }
    ]) {
      await page.setViewportSize({ width:view.width, height:view.height });
      await start(view.name);
      await loadRest();
      if (view.dark) await page.evaluate(() => { document.body.classList.remove('light'); document.body.classList.add('dark'); });
      await policyOpen();
      const layout = await page.evaluate(() => {
        const policy = document.getElementById('psEntryPolicy');
        const content = policy.querySelector('.ps-entry-policy-content');
        const footer = policy.querySelector('.ps-entry-policy-footer');
        const rect = el => { const r=el.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}; };
        const buttons = [...footer.querySelectorAll('button')].map(rect);
        return { viewport:{width:innerWidth,height:innerHeight}, documentWidth:document.documentElement.scrollWidth, policy:rect(policy), content:rect(content), footer:rect(footer), buttons, policyOverflow:policy.scrollWidth-policy.clientWidth, contentOverflow:content.scrollWidth-content.clientWidth, backdrop:getComputedStyle(policy,'::backdrop').backdropFilter };
      });
      assert.ok(layout.documentWidth <= view.width + 1, view.name + ': document horizontal overflow');
      assert.ok(layout.policy.left >= -1 && layout.policy.right <= view.width + 1, view.name + ': policy off screen');
      assert.ok(layout.policyOverflow <= 1 && layout.contentOverflow <= 1, view.name + ': policy content horizontal overflow');
      assert.ok(layout.footer.top >= 0 && layout.footer.bottom <= view.height + 1, view.name + ': footer not visible');
      assert.ok(layout.content.height > 50, view.name + ': policy body unusably short');
      assert.ok(layout.content.bottom <= layout.footer.top + 1, view.name + ': content overlaps footer');
      assert.ok(layout.buttons.every(button => button.height >= 44 && button.left >= 0 && button.right <= view.width + 1), view.name + ': buttons do not fit/touch height too small');
      assert.match(layout.backdrop, /blur\(/, view.name + ': court backdrop is not blurred');
      await page.locator('.ps-entry-policy-content').evaluate(el => { el.scrollTop=el.scrollHeight; });
      const thanks = await page.locator('.ps-entry-policy-thanks').boundingBox();
      assert.ok(thanks.y >= layout.content.top - 1 && thanks.y + thanks.height <= layout.footer.top + 1, view.name + ': final policy paragraph not reachable');
      if (view.name === 'mobile-short' || view.name === 'mobile-320') {
        await page.screenshot({ path:path.join(out, view.name + '-bottom.png') });
      }
      await page.locator('.ps-entry-policy-content').evaluate(el => { el.scrollTop=0; });
      await page.screenshot({ path:path.join(out, view.name + '.png') });
      passed.push(view.name + ': no overflow, blurred backdrop, footer/buttons fit, full policy reachable');
    }
    assert.deepEqual(errors, [], 'Browser errors');
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({passed:passed.length,cases:passed}, null, 2));
    console.log('PASS ' + passed.length + ' entry policy interaction and responsive checks');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
