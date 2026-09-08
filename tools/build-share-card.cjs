const fs=require('node:fs'),path=require('node:path');
const {chromium}=require('C:/Users/hisol/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root=path.resolve(__dirname,'..');
const asset=(name,type)=>`data:image/${type};base64,${fs.readFileSync(path.join(root,name)).toString('base64')}`;
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1200,height:630},deviceScaleFactor:1});
 await page.setContent(`<!doctype html><html><head><style>
 *{box-sizing:border-box}body{margin:0;background:#112b36;color:#f2f6f7;font-family:Arial,sans-serif}
 .photo{position:absolute;right:0;top:0;width:660px;height:630px;object-fit:cover;object-position:65% center}
 .shade{position:absolute;inset:0;background:linear-gradient(90deg,#112b36 0%,#112b36 40%,#112b36d9 54%,#112b361a 100%),linear-gradient(0deg,#112b36aa,transparent 70%)}
 .frame{position:absolute;inset:28px;border:1px solid #a2c4cd55}
 main{position:absolute;left:68px;top:57px;right:60px}
 .brand{display:flex;align-items:center;gap:26px}.logo{width:136px;height:164px;object-fit:contain}
 .eyebrow{font-size:17px;letter-spacing:3px;color:#a3d4de;line-height:1.6;font-weight:700}
 h1{font-size:62px;line-height:1.04;letter-spacing:-2px;margin:25px 0 18px;font-weight:800}
 .subtitle{font-size:27px;color:#d0dce1;margin:0 0 27px}.cta{display:inline-block;background:#157c8e;color:#fff;padding:15px 22px;border-radius:8px;font-size:21px;font-weight:700}
 footer{position:absolute;left:68px;bottom:53px;font-size:18px;color:#c2d3da;letter-spacing:.3px}
 </style></head><body><img class="photo" src="${asset('assets/pickle-street-courts.jpg','jpeg')}"><div class="shade"></div><div class="frame"></div><main><div class="brand"><img class="logo" src="${asset('assets/pickle-street-logo-transparent.png','png')}"><div class="eyebrow">COUNTRYSIDE FEEL.<br>URBAN ACCESS.</div></div><h1>Pickle Street<br>Tugbok</h1><p class="subtitle">Your new street for pickleball.</p><div class="cta">Book your court online</div></main><footer>Mangga St. Tugbok, Davao City</footer></body></html>`);
 await page.evaluate(()=>Promise.all([...document.images].map(img=>img.decode())));
 await page.screenshot({path:path.join(root,'assets/pickle-street-share-v1.jpg'),type:'jpeg',quality:92});
 await browser.close();console.log('Built 1200 × 630 social preview');
})().catch(error=>{console.error(error);process.exit(1)});
