const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('C:/Users/hisol/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
// Use the actual initial markup, styling and welcome controller. A blocked script
// after it represents the booking scripts still downloading on a slow connection.
const initial=html.slice(0,html.indexOf('<div class="toasts"'))
  .replace(/<script\b[^>]*\bsrc=[^>]*><\/script>/gi,'')
  +'<main id="courts">Loading courts</main><script src="slow.js"></script></body></html>';
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'});
 let release,blocked;
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.pathname==='/slow.js'){blocked=true;await new Promise(resolve=>release=resolve);return route.fulfill({contentType:'text/javascript',body:'window.bookingScriptsLoaded=true;'});}
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:initial});
  const local=path.join(root,decodeURIComponent(url.pathname));
  if(url.hostname==='welcome.test'&&fs.existsSync(local)&&fs.statSync(local).isFile())return route.fulfill({path:local});
  return route.abort();
 });
 for(const hash of ['', '#courts']){
  blocked=false;
  await page.goto('https://welcome.test/?case='+encodeURIComponent(hash)+hash,{waitUntil:'commit'});
  await page.waitForFunction(()=>document.getElementById('psWelcome')?.open);
  assert.equal(await page.evaluate(()=>window.bookingScriptsLoaded===true),false);
  assert.equal(await page.locator('#psWelcome').evaluate(el=>el.matches(':modal')),true);
  await page.locator('[data-welcome-dismiss]').click();
  assert.equal(await page.locator('#psWelcome').evaluate(el=>el.open),false);
  await page.waitForFunction(()=>document.readyState==='loading');
  while(!blocked)await new Promise(resolve=>setTimeout(resolve,10));
  release();await page.waitForLoadState('load');
  blocked=false;release=null;
  await page.reload({waitUntil:'commit'});
  await page.waitForFunction(()=>document.getElementById('psWelcome')?.open);
  assert.equal(await page.locator('#psWelcome').evaluate(el=>el.matches(':modal')),true);
  while(!release)await new Promise(resolve=>setTimeout(resolve,10));
  release();await page.waitForLoadState('load');
 }
 const out=path.join(root,'artifacts/welcome-first-paint');fs.mkdirSync(out,{recursive:true});
 await page.screenshot({path:path.join(out,'welcome-mobile.png')});
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({passed:4,cases:['welcome precedes slow booking scripts','welcome dismisses before scripts load','refresh reopens welcome','court anchor refresh opens welcome']},null,2));
 console.log('PASS 4 welcome first-paint and refresh checks');await browser.close();
})().catch(error=>{console.error(error);process.exit(1)});
