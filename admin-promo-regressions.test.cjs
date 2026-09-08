'use strict';
// Read the current checkout; every database operation and DOM mutation is isolated.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const repo=__dirname;
const source=fs.readFileSync(path.join(repo,'admin.html'),'utf8');
const Pricing=require(path.join(repo,'court-pricing.js'));
function part(first,next){const a=source.indexOf(first),b=source.indexOf(next,a);assert(a>=0&&b>a,first);return source.slice(a,b);}
const helpers=part('function courtRevisionMap(','async function renderCourts()')+part('function courtWholeHour(','function courtStatus(')+part('function pricingTierCoversHour(','function renderTiersUI()')+part('function updateTierPricePreview(','function addTierRow()');
const editor=part('function addTierRow()','async function savePricingTiers()');
const save=part('async function savePlatformSharedCourtSchedule(','let adminTiers = [];');
const clone=value=>JSON.parse(JSON.stringify(value));
const promo={from:8,to:10,standardRate:200,promoRate:150,promoEnabled:true,rate:150};
const onePeso={from:10,to:12,standardRate:1,promoRate:null,promoEnabled:false,rate:1};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};

function harness(tiers=[promo],{getCourts=null,saveGate=null,courts=null,saveResult={},refreshGate=null}={}){
  let rows=[];const events={renders:[],writes:[],messages:[],hours:[]},refreshStarted=deferred();
  const controls={ohOpen:{value:'8'},ohClose:{value:String(Math.max(...tiers.map(t=>Number(t.to))))},saveHoursBtn:{disabled:false},savePricingTiersBtn:{disabled:false},tiersStatus:{textContent:'',classList:{add(){},remove(){}}}};
  function row(tier){
    const standard={value:String(tier.standardRate??tier.rate??'')},promoRate={value:tier.promoRate==null?'':String(tier.promoRate)},enabled={checked:tier.promoEnabled===true};
    const fields={'.tier-from':{value:tier.from==null?'':String(tier.from)},'.tier-to':{value:tier.to==null?'':String(tier.to)},'.tier-rate':standard,'.tier-standard-rate':standard,'.tier-promo-rate':promoRate,'.tier-promo-enabled':enabled};
    return{fields,dataset:{},querySelector:selector=>fields[selector]||null};
  }
  function setRows(values){rows=values.map(row);}
  const stored=tiers.map(t=>Pricing.normalize(t));
  const actualCourts=courts || [{id:'11111111-1111-4111-8111-111111111111',name:'Test court',updatedAt:'test-revision',opensAt:'08:00',closesAt:String(Math.max(...stored.map(t=>t.to))).padStart(2,'0')+':00',rateSchedule:stored,pricingConfig:{regular:{minimumHours:1,bands:stored.map(Pricing.toBand)}}}];
  const c={PBCourtPricing:Pricing,PB_PLATFORM_V1:true,adminTiers:clone(tiers),_sharedCourtScheduleDirty:true,_sharedCourtScheduleEditVersion:0,_sharedCourtScheduleSaving:false,
    _sharedCourtSchedule:{valid:true,openHour:8,closeHour:Number(controls.ohClose.value),tiers:clone(stored),revisions:Object.fromEntries(actualCourts.map(court=>[court.id,court.updatedAt]))},
    document:{querySelectorAll:selector=>selector==='#tiersBody .tier-row'?rows:[]},$:id=>controls[id],
    configuredWholeHour:(value,{closing=false}={})=>value===''?null:closing&&Number(value)===0?24:Number(value),
    courtRegularConfig:()=>({minimumHours:1}),courtEventConfig:()=>({enabled:false}),
    canManageVenue:()=>true,confirm:()=>true,
    toast:message=>events.messages.push(message),console:{error(){}},
    updateHoursSummary:(...args)=>events.hours.push(args),
    renderTiersUI:()=>{setRows(c.adminTiers);events.renders.push({kind:'editor',tiers:clone(c.adminTiers)});},
    DB:{getCourts:()=>getCourts?getCourts():Promise.resolve(actualCourts),saveSharedCourtSchedule:async payload=>{events.writes.push(clone(payload));if(saveGate)await saveGate.promise;return saveResult;}},
    renderCourts:async()=>{
      events.renders.push({kind:'courts',dirty:c._sharedCourtScheduleDirty});
      refreshStarted.resolve();
      if(refreshGate)await refreshGate.promise;
      // Mirrors the real renderCourts contract: a clean editor reloads saved state.
      if(!c._sharedCourtScheduleDirty&&events.writes.length){c.adminTiers=clone(events.writes.at(-1).rateSchedule);setRows(c.adminTiers);}
    },
  };
  c.window=c;setRows(tiers);vm.createContext(c);vm.runInContext(helpers+editor+save,c);
  return{c,events,controls,refreshStarted:refreshStarted.promise,get rows(){return rows;},setRows,async beginSave(){const p=c.savePlatformSharedCourtSchedule('Saved.');await Promise.resolve();await Promise.resolve();return{promise:p};}};
}

test('add and remove a sibling tier preserve both prices, promo switch and current one-peso rate',()=>{
  const h=harness([promo,onePeso]);h.c.addTierRow();
  assert.equal(h.c.adminTiers.length,3);assert.equal(h.rows.length,3);
  const kept=h.c.adminTiers[0];assert.equal(Number(kept.standardRate),200);assert.equal(Number(kept.promoRate),150);assert.equal(kept.promoEnabled,true);
  assert.equal(Number(h.c.adminTiers[1].standardRate),1);assert.equal(h.c.adminTiers[1].promoEnabled,false);
  h.c.removeTier(2);const read=h.c.readPricingTierRows();assert.equal(read.ok,true);
  assert.equal(read.tiers.length,2);assert.equal(read.tiers[0].rate,150);assert.equal(read.tiers[0].standardRate,200);assert.equal(read.tiers[1].rate,1);
});

test('turning promo off retains its value; turning it on restores the discounted rate',()=>{
  const h=harness();h.rows[0].fields['.tier-promo-enabled'].checked=false;h.c.markSharedScheduleDirty();
  let read=h.c.readPricingTierRows();assert.equal(read.ok,true);assert.equal(read.tiers[0].standardRate,200);assert.equal(read.tiers[0].promoRate,150);assert.equal(read.tiers[0].rate,200);
  h.rows[0].fields['.tier-promo-enabled'].checked=true;h.c.markSharedScheduleDirty();read=h.c.readPricingTierRows();assert.equal(read.tiers[0].rate,150);
  assert.equal(h.c._sharedCourtScheduleEditVersion,2);
});

test('disabled empty promo survives add/remove and does not coerce the preserved one-peso standard rate',()=>{
  const h=harness([{...onePeso,from:8,to:10}]);h.c.addTierRow();h.c.removeTier(1);
  const read=h.c.readPricingTierRows();assert.equal(read.ok,true);assert.equal(read.tiers[0].standardRate,1);assert.equal(read.tiers[0].rate,1);assert.equal(read.tiers[0].promoRate,null);assert.equal(read.tiers[0].promoEnabled,false);
});

test('admin normalization and shared-schedule comparison retain metadata through backend roundtrip',()=>{
  const h=harness();const tier=h.c.normalizedCourtTiers([Pricing.fromBand(Pricing.toBand(promo))])[0];
  assert.equal(tier.standardRate,200);assert.equal(tier.promoRate,150);assert.equal(tier.promoEnabled,true);assert.equal(tier.rate,150);
  const court=t=>({opensAt:'08:00',closesAt:'10:00',rateSchedule:[t],pricingConfig:{regular:{bands:[Pricing.toBand(t)]}}});
  const distinct={...promo,standardRate:150,promoRate:null,promoEnabled:false,rate:150};
  const mixed=h.c.deriveSharedCourtSchedule([court(tier),court(distinct)]);assert.equal(mixed.mixedPricing,true,'equal effective rates do not erase different standard/promo configurations');
  const legacy=h.c.normalizedCourtTiers([{from:8,to:10,rate:1}])[0];assert.equal(legacy.standardRate,1);assert.equal(legacy.rate,1);assert.equal(legacy.promoEnabled,false);
});

test('a clean shared save sends and reloads both prices and the switch state',async()=>{
  const h=harness();await h.c.savePlatformSharedCourtSchedule('Saved.');
  assert.equal(h.events.writes.length,1);assert.equal(h.events.writes[0].rateSchedule[0].standardRate,200);assert.equal(h.events.writes[0].rateSchedule[0].promoRate,150);assert.equal(h.events.writes[0].rateSchedule[0].promoEnabled,true);
  assert.equal(h.c._sharedCourtScheduleDirty,false);assert.equal(h.c.readPricingTierRows().tiers[0].rate,150);
});

test('an edit during a pending save stays dirty and is not replaced by the submitted snapshot',async()=>{
  const gate=deferred(),h=harness([promo],{saveGate:gate});const {promise}=await h.beginSave();
  assert.equal(h.events.writes.length,1,'save reached the protected adapter');
  h.rows[0].fields['.tier-promo-rate'].value='125';h.c.markSharedScheduleDirty();gate.resolve();await promise;
  assert.equal(h.events.writes[0].rateSchedule[0].promoRate,150,'in-flight snapshot is unchanged');
  assert.equal(h.c._sharedCourtScheduleDirty,true,'new edit remains unsaved');
  assert.equal(h.c.readPricingTierRows().tiers[0].promoRate,125,'new value remains visible');
  assert.equal(h.events.writes.length,1,'newer edit is never silently submitted');
  assert.match(h.controls.tiersStatus.textContent,/unsaved|not saved|newer/i);
  assert.equal(h.controls.saveHoursBtn.disabled,false);assert.equal(h.controls.savePricingTiersBtn.disabled,false);
});

test('an edit while the initial no-court lookup is pending is not discarded by draft staging',async()=>{
  const lookup=deferred(),h=harness([promo],{getCourts:()=>lookup.promise});const pending=h.c.savePlatformSharedCourtSchedule('Saved.');
  h.rows[0].fields['.tier-promo-rate'].value='125';h.c.markSharedScheduleDirty();lookup.resolve([]);await pending;
  assert.equal(h.events.writes.length,0,'first-court staging never performs a database write');
  assert.equal(h.c._sharedCourtScheduleDirty,true);assert.equal(h.c.readPricingTierRows().tiers[0].promoRate,125);
});

test('a failed protected save leaves the edited promo draft available to retry',async()=>{
  const gate=deferred(),h=harness([promo],{saveGate:gate});const {promise}=await h.beginSave();gate.reject(new Error('Revision changed. Reload the saved schedule.'));await promise;
  assert.equal(h.c._sharedCourtScheduleDirty,true);assert.equal(h.c.readPricingTierRows().tiers[0].promoRate,150);assert.match(h.controls.tiersStatus.textContent,/Revision changed/);assert.equal(h.controls.savePricingTiersBtn.disabled,false);
});

test('a second click during save is ignored and successful revisions are retained for newer edits',async()=>{
  const id='11111111-1111-4111-8111-111111111111',gate=deferred(),h=harness([promo],{saveGate:gate,saveResult:{revisions:{[id]:'saved-revision'}}});
  const {promise}=await h.beginSave();await h.c.savePlatformSharedCourtSchedule('Second click.');
  assert.equal(h.events.writes.length,1);assert.equal(h.events.writes[0].expectedRevisions[id],'test-revision');
  h.rows[0].fields['.tier-promo-rate'].value='125';h.c.markSharedScheduleDirty();gate.resolve();await promise;
  assert.equal(h.c._sharedCourtSchedule.revisions[id],'saved-revision');
  assert.equal(h.c._sharedCourtScheduleDirty,true);assert.equal(h.c._sharedCourtScheduleSaving,false);
  await h.c.savePlatformSharedCourtSchedule('Saved newer draft.');
  assert.equal(h.events.writes.length,2);assert.equal(h.events.writes[1].expectedRevisions[id],'saved-revision');
  assert.equal(h.events.writes[1].rateSchedule[0].promoRate,125);
});

test('an edit during the post-save refresh retains its value and an accurate unsaved status',async()=>{
  const refreshGate=deferred(),h=harness([promo],{refreshGate});const {promise}=await h.beginSave();
  await h.refreshStarted;
  assert.equal(h.events.renders.filter(event=>event.kind==='courts').length,1,'post-save refresh started');
  h.rows[0].fields['.tier-promo-rate'].value='125';h.c.markSharedScheduleDirty();refreshGate.resolve();await promise;
  assert.equal(h.c._sharedCourtScheduleDirty,true);assert.equal(h.c.readPricingTierRows().tiers[0].promoRate,125);
  assert.match(h.controls.tiersStatus.textContent,/unsaved|not saved|newer/i,'status must describe edits made while refresh was pending');
});
