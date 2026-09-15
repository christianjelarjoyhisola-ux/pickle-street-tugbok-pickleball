'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const Pricing=require('./court-pricing.js');
const config=fs.readFileSync('supabase-config.js','utf8'),html=fs.readFileSync('index.html','utf8'),admin=fs.readFileSync('admin.html','utf8');
const promo={from:5,to:24,standardRate:200,promoRate:150,promoEnabled:true};
const legacy={start:'05:00',end:'24:00',hourlyRate:1};
const plain=value=>JSON.parse(JSON.stringify(value));
function extract(source,name){const start=source.search(new RegExp('^(?:async )?function '+name+'\\(','m'));assert(start>=0,name);return source.slice(start,source.indexOf('\n}',start)+2);}

test('legacy one-peso rates load with promo disabled and roundtrip unchanged',()=>{
  const tier=Pricing.fromBand(legacy),band=Pricing.toBand(tier);
  assert.equal(tier.rate,1);assert.equal(tier.standardRate,1);assert.equal(tier.promoEnabled,false);assert.equal(tier.promoRate,null);
  assert.equal(band.hourlyRate,1);assert.deepEqual(Pricing.fromBand(band),tier);
});
test('enabled, disabled and reenabled promos retain standard and promo prices',()=>{
  const on=Pricing.fromBand(Pricing.toBand(promo));assert.equal(on.rate,150);
  const off=Pricing.fromBand(Pricing.toBand({...on,promoEnabled:false}));assert.equal(off.rate,200);assert.equal(off.promoRate,150);
  assert.equal(Pricing.toBand({...off,promoEnabled:true}).hourlyRate,150);
});
test('promo and standard validation rejects invalid payable amounts and time boundaries',()=>{
  for(const patch of [{promoRate:null},{promoRate:0},{promoRate:200},{promoRate:201},{promoRate:150.001},{standardRate:0},{from:5.5},{to:25},{from:24}]) assert.throws(()=>Pricing.toBand({...promo,...patch}));
  assert.equal(Pricing.toBand({...promo,promoEnabled:false,standardRate:100}).hourlyRate,100);
  assert.equal(Pricing.fromBand({...legacy,end:'00:00'}).to,24);
  assert.ok(Pricing.validationError(Pricing.fromBand({...legacy,start:'05:30'})));
});
test('welcome advertising remains hidden for testing rates and qualifies limited promotions',()=>{
  const court={status:'active',rateSchedule:[Pricing.fromBand(legacy)]};assert.equal(Pricing.promotion([court]),null);
  const active={...court,rateSchedule:[promo]};assert.deepEqual(Pricing.promotion([active]),{rate:150,standardRate:200,uniform:true});
  assert.equal(Pricing.promotion([active,court]).uniform,false);
  assert.equal(Pricing.promotion([{...active,blocked:true}]),null);
  assert.equal(Pricing.promotion([{...active,status:'inactive'}]),null);
});
test('public hourly pricing crosses tier boundaries and excludes the end hour',()=>{
  const c={};vm.runInNewContext(extract(html,'getRateForHourFromTiers'),c);
  const tiers=[Pricing.normalize({...promo,from:5,to:12}),Pricing.normalize({...promo,from:12,to:24,promoEnabled:false})];
  assert.equal(c.getRateForHourFromTiers(11,tiers)+c.getRateForHourFromTiers(12,tiers),350);
  assert.equal(c.getRateForHourFromTiers(24,tiers),0);assert.equal(c.getRateForHourFromTiers(11,[...tiers,tiers[0]]),0);
});
test('manager and public court mappings preserve price metadata and exact revision strings',()=>{
  const c={PBCourtPricing:Pricing};vm.runInNewContext(extract(config,'_pbPlatformCourtToLegacy')+'\n'+extract(config,'_pbPlatformRawCourtToLegacy'),c);
  const mapped=c._pbPlatformRawCourtToLegacy({id:'court',name:'Court',updated_at:'2026-09-08T01:00:00.123456+00:00',opens_at:'05:00:00',closes_at:'00:00:00',status:'active',pricing_config:{regular:{bands:[Pricing.toBand(promo)]}}});
  assert.equal(mapped.updatedAt,'2026-09-08T01:00:00.123456+00:00');assert.equal(mapped.rateSchedule[0].standardRate,200);assert.equal(mapped.rate,150);
});
function adapter(){
  const calls=[],id='11111111-1111-4111-8111-111111111111',revisions={[id]:'2026-09-08T01:00:00.123456Z'};
  const court={id,name:'Court',status:'active',opensAt:'05:00',closesAt:'00:00',rateSchedule:[Pricing.normalize(promo)],pricingConfig:{regular:{minimumHours:1}},publicConfig:{minimumLeadMinutes:0,maximumAdvanceDays:30}};
  const c={PBCourtPricing:Pricing,PB_PLATFORM_V1:true,PB_TENANT_SLUG:'pickle-street-tugbok',_pbAuthenticatedSession:async()=>({}),_pbTenantHostname:()=> 'picklestreet.pages.dev',_pbClearFastCache:()=>{},_sb:{rpc:async(name,args)=>{calls.push({name,args});return{data:{revisions}};}}};
  const start=config.indexOf('  async saveCourt('),end=config.indexOf('  // ---- BOOKINGS ----',start);
  vm.runInNewContext(extract(config,'_extractFnError')+'\n'+extract(config,'_pbCourtSaveError')+'\nglobalThis.DB={'+config.slice(start,end)+'};',c);
  c.DB.getCourts=async()=>[court];return{c,court,revisions,calls};
}
test('individual court edit uses isolated RPC and retains enabled promo with original editor revisions',async()=>{
  const h=adapter();await h.c.DB.saveCourt({...h.court,name:'Renamed'}, {expectedRevisions:h.revisions});
  const {name,args}=h.calls[0];assert.equal(name,'manage_picklestreet_court');assert.equal(args.p_tenant_slug,'pickle-street-tugbok');assert.equal(args.p_hostname,'picklestreet.pages.dev');assert.deepEqual(plain(args.p_expected_revisions),h.revisions);
  const band=args.p_patch.pricingConfig.regular.bands[0];assert.equal(band.hourlyRate,150);assert.equal(band.standardHourlyRate,200);assert.equal(band.promoHourlyRate,150);assert.equal(band.promoEnabled,true);
});
test('shared schedule off saves both rates, revisions and restores payable standard price',async()=>{
  const h=adapter();const result=await h.c.DB.saveSharedCourtSchedule({opensAt:'05:00',closesAt:'00:00',rateSchedule:[{...promo,promoEnabled:false}],expectedRevisions:h.revisions});
  const {name,args}=h.calls[0];assert.equal(name,'apply_shared_picklestreet_court_schedule');assert.equal(args.p_bands[0].hourlyRate,200);assert.equal(args.p_bands[0].promoHourlyRate,150);assert.deepEqual(plain(result.revisions),h.revisions);
});
test('the 24-hour rollout preserves prices while extending the early band to midnight',()=>{
  const migration=fs.readFileSync('operations/pending-flow/027-twenty-four-hour-courts.sql','utf8');
  assert.match(migration,/v_close_minutes <= v_open_minutes/);
  assert.match(migration,/opens_at = time '00:00'/);
  assert.match(migration,/\{regular,bands,0,start\}/);
  const fullDay=[Pricing.normalize({...promo,from:0,to:18,promoEnabled:false}),Pricing.normalize({...promo,from:18,to:24,standardRate:280,promoRate:null,promoEnabled:false})];
  assert.equal(Pricing.validationError(fullDay[0]),'');
  assert.equal(Pricing.validationError(fullDay[1]),'');
  assert.equal(Pricing.toBand(fullDay[0]).start,'00:00');
  assert.equal(Pricing.toBand(fullDay[1]).end,'24:00');
});
test('manager accepts complete 24-hour pricing and distinguishes both midnight boundaries',()=>{
  const c={};
  vm.runInNewContext([extract(admin,'tierFmtH'),extract(admin,'pricingTierCoversHour'),extract(admin,'validatePricingTierCoverage')].join('\n'),c);
  const tiers=[Pricing.normalize({from:0,to:18,standardRate:200,promoEnabled:false}),Pricing.normalize({from:18,to:24,standardRate:280,promoEnabled:false})];
  assert.deepEqual(plain(c.validatePricingTierCoverage(tiers,0,24)),{ok:true,message:''});
  assert.equal(c.tierFmtH(0),'12:00 AM (Midnight)');
  assert.equal(c.tierFmtH(24),'12:00 AM (Next Day)');
  assert.match(admin,/first tier already includes 12:00–5:00 AM/);
  const readinessMigration=fs.readFileSync('operations/pending-flow/029-multi-tier-full-day-readiness.sql','utf8');
  assert.match(readinessMigration,/multi-tier full day forms a deliberate midnight cycle/i);
  assert.match(readinessMigration,/return v_expected_start = 1440/);
});
test('stale manager save surfaces a refresh instruction and never falls back to shared writes',async()=>{
  const h=adapter();h.c._sb.rpc=async(name,args)=>{h.calls.push({name,args});return{error:{message:'PICKLESTREET_COURT_REVISION_CONFLICT'}};};
  await assert.rejects(h.c.DB.saveCourt(h.court,{expectedRevisions:h.revisions}),/Refresh the page/);assert.equal(h.calls.length,1);assert.equal(h.calls[0].name,'manage_picklestreet_court');
});
test('all published pages load the pricing helper before the database adapter',()=>{
  for(const file of ['index.html','admin.html','booking-management.html','login.html']){const s=fs.readFileSync(file,'utf8');assert(s.indexOf('src="court-pricing.js')>=0);assert(s.indexOf('src="court-pricing.js')<s.indexOf('src="supabase-config.js'));}
});
