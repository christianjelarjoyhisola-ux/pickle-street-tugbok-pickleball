'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');
const TENANT = 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';
const SLUG = 'pickle-street-tugbok';
const HOST = 'picklestreet.pages.dev';
const API = 'https://neqvrwtofiolcuxewdze.supabase.co';
const storage = () => { const data = new Map(); return {getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,String(v)),removeItem:k=>data.delete(k)}; };
function boot(options={}) {
  const calls=[];
  const bootstrap={tenant:{id:TENANT,slug:SLUG,name:'Pickle Street Tugbok',timezone:'Asia/Manila'},courts:[],settings:{},readiness:{publicBookingEnabled:false},...options.bootstrap};
  const account={id:'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3b',tenantSlug:SLUG,tenantId:TENANT,role:'owner',status:'active',...options.account};
  const state={signouts:0};
  const client={
    auth:{getSession:async()=>({data:{session:{access_token:'test-manager-token'}}}),getUser:async()=>({data:{user:{id:'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3b'}}}),signOut:async()=>{state.signouts++;}},
    rpc:async(name,args)=>{calls.push({kind:'rpc',name,args}); if(options.rpc)return options.rpc(name,args);return {data:name==='get_my_tenant_session'?account:name==='get_public_tenant_bootstrap'?bootstrap:name==='get_public_availability'?{tenantSlug:SLUG,date:args.p_date,courts:[],blockedDates:[]}:[]};},
    from:()=>{throw new Error('Direct table access is forbidden in this test.');},
    functions:{invoke:async()=>{throw new Error('Expected direct scoped request.');}},
  };
  const context={URL,Headers,AbortController,FormData,Blob,Intl,Date,JSON,Map,Set,Promise,structuredClone,setTimeout,clearTimeout,console,crypto:webcrypto,
    localStorage:storage(),sessionStorage:storage(),location:new URL('https://'+(options.hostname||HOST)+'/'),document:{documentElement:{dataset:{pbDataScope:options.scope||'public'}}},
    fetch:async(url,init)=>{calls.push({kind:'fetch',url:String(url),init});return new Response(JSON.stringify(options.response||{ok:true,booking:{reference:'PS-TEST',status:'confirmed'}}),{status:200});},
    supabase:{createClient:()=>client},
  };
  context.window=context;vm.createContext(context);
  vm.runInContext(fs.readFileSync('tenant-config.js','utf8'),context);
  vm.runInContext(fs.readFileSync('supabase-config.js','utf8'),context);
  context.Auth.getSession=()=>({role:'owner',membershipRole:'owner',tenantSlug:SLUG,tenantId:TENANT});
  vm.runInContext('globalThis.checkedFetch = _pbFetchWithTimeout; globalThis.checkedInvoke = _invokeEdgeFunction',context);
  return {context,calls,state};
}
test('routing is fixed and rejects unregistered hosts',()=>{
  assert.throws(()=>boot({hostname:'another-venue.example'}),/not registered/);
  const {context:c}=boot();assert.equal(c.PB_TENANT_CONFIG.tenantSlug,SLUG);
  assert.throws(()=>{c.PB_TENANT_CONFIG.tenantSlug='other';},TypeError);
});
test('a remembered owner visiting the public page cannot read manager bookings, courts, or settings',async()=>{
  const {context:c,calls}=boot();
  assert.equal((await c.DB.getBookings()).length,0);
  assert.equal((await c.DB.getBookings({date:'2026-10-01'})).length,0);
  await c.DB.getCourts(); await c.DB.getSettings();
  assert.equal(calls.some(call=>/manager/.test(call.name||call.url||'')),false);
  assert.equal(c.PB_PUBLIC_BOOKING_ENABLED,false);
});
test('bootstrap rejects a different tenant identity even with the right slug',async()=>{
  const {context:c}=boot({bootstrap:{tenant:{id:'wrong',slug:SLUG}}});
  await assert.rejects(c.DB.getCourts(),/not configured/);
});
test('validated owner identity can enter the new tenant dashboard',async()=>{
  const {context:c,state}=boot({scope:'auth'});const session=await c.Auth.refreshSessionFromAuth();
  assert.equal(session.tenantId,TENANT);assert.equal(session.role,'owner');assert.equal(state.signouts,0);
});
test('an account belonging to another tenant is signed out',async()=>{
  const {context:c,state}=boot({scope:'auth',account:{tenantId:'wrong',tenantSlug:'other'}});
  assert.equal(await c.Auth.refreshSessionFromAuth(),null);assert.equal(state.signouts,1);
});
test('all service calls reject a foreign origin and foreign tenant before fetch',async()=>{
  const {context:c,calls}=boot();
  await assert.rejects(c.checkedFetch('https://other.supabase.co/functions/v1/booking-status?tenantSlug='+SLUG),/Unexpected/);
  await assert.rejects(c.checkedFetch(API+'/functions/v1/booking-status?tenantSlug=other'),/venue-scoped/);
  await assert.rejects(c.checkedInvoke('booking-status?tenantSlug='+SLUG,{tenantSlug:'other'}),/venue-scoped/);
  assert.equal(calls.length,0);
});
test('guest booking status uses anonymous authorization even when a manager is remembered',async()=>{
  const {context:c,calls}=boot(); await c.DB.getPublicBookingStatus({bookingReference:'PS-TEST',bookingToken:'test-capability'});
  const request=calls.find(call=>call.kind==='fetch');const headers=new Headers(request.init.headers);
  assert.equal(headers.get('X-Tenant-Slug'),SLUG);assert.ok(!headers.get('Authorization').includes('test-manager-token'));
  assert.equal(JSON.parse(request.init.body).tenantSlug,SLUG);
});
test('published manager-only RPC signatures remain usable without weakening public scope',async()=>{
  for(const scope of ['public','manager']) {
    const {context:c,calls}=boot({scope});
    for(const name of ['manage_blocked_dates','get_blocked_date_access','set_blocked_date_access']) {
      const request=c.checkedFetch(API+'/rest/v1/rpc/'+name,{body:JSON.stringify({p_tenant_slug:SLUG})});
      if(scope==='public')await assert.rejects(request,/verified venue/);else await request;
    }
    assert.equal(calls.length,scope==='manager'?3:0);
  }
});
test('business settings use the loaded revision and refresh it only after a successful save',async()=>{
  let revision='2026-09-07T00:00:00Z';let updates=0;
  const {context:c,calls}=boot({scope:'manager',rpc:async(name,args)=>{
    if(name==='get_tenant_activation_settings')return {data:{updatedAt:revision,business:{displayName:'Pickle Street'}}};
    assert.equal(name,'update_tenant_business_settings_if_current');assert.equal(args.p_expected_revision,revision);updates++;revision='2026-09-07T00:0'+updates+':00Z';return {data:{updatedAt:revision,business:args.p_patch}};
  }});
  await assert.rejects(c.DB.saveTenantBusinessSettings({displayName:'New name'}),/Reload/);
  await c.DB.getTenantBusinessSettings();await c.DB.saveTenantBusinessSettings({displayName:'Pickle Street Tugbok'});await c.DB.saveTenantBusinessSettings({tagline:'Good rallies'});
  assert.equal(updates,2);assert.ok(calls.every(call=>call.args.p_tenant_slug===SLUG && call.args.p_hostname===HOST));
});
test('policy publication requires approval and uses its protected revision contract',async()=>{
  const {context:c,calls}=boot({scope:'manager',rpc:async(name)=>({data:name==='get_tenant_refund_reschedule_policy'?{revision:'policy-v1'}:{revision:'policy-v2'}})});
  await assert.rejects(c.DB.saveRefundReschedulePolicy({}),/approve/);
  await c.DB.getRefundReschedulePolicyState();await c.DB.saveRefundReschedulePolicy({ownerApproved:true,title:'Venue policy',intro:'Read before booking',content:'Actual owner-approved terms'});
  const publish=calls.at(-1);assert.equal(publish.name,'update_tenant_refund_reschedule_policy');assert.equal(publish.args.p_expected_revision,'policy-v1');assert.equal(publish.args.p_publish,true);
});
test('generic legacy writes are disabled',async()=>{
  const {context:c}=boot({scope:'manager'});await assert.rejects(c.DB.saveSetting('court_rate','1'),/disabled/);
  await assert.rejects(c.checkedFetch(API+'/rest/v1/bookings',{method:'POST',body:'{}'}),/Direct table access/);
});

test('fee saves preserve configured state and confirm the server amount without depending on public bootstrap',async()=>{
  for (const [method,field,mode,amount] of [
    ['saveTenantPlatformBilling','platformBilling','fixed_per_hour',12.5],
    ['saveTenantOpenPlayServiceFee','openPlayServiceFee','fixed_per_player',7.25],
  ]) {
    const settings={tenant:{id:TENANT,slug:SLUG},[field]:{feeMode:mode,feeAmount:amount,isConfigured:true}};
    const {context:c,calls}=boot({scope:'manager',response:{ok:true,settings},rpc:async()=>{throw Error('Public bootstrap unavailable');}});
    const saved=await c.DB[method]({feeMode:mode,feeAmount:amount});
    const fee=saved[field==='platformBilling'?'billing':field];
    assert.equal(fee.feeAmount,amount);assert.equal(fee.isConfigured,true);
    const body=JSON.parse(calls.find(call=>call.kind==='fetch').init.body);
    assert.equal(body.tenantSlug,SLUG);assert.equal(body.patch[field].feeAmount,amount);
    assert.equal(Object.keys(body.patch).length,1);
    assert.equal(calls.some(call=>call.kind==='rpc'),false);
    const loaded=await c.DB.getTenantActivationSettings();
    assert.equal(loaded[field==='platformBilling'?'billing':field].feeAmount,amount);
    for(const badFee of [{feeMode:mode,feeAmount:0,isConfigured:false},{feeMode:mode,feeAmount:amount+1,isConfigured:true}]) {
      const bad=boot({scope:'manager',response:{ok:true,settings:{...settings,[field]:badFee}}}).context;
      await assert.rejects(bad.DB[method]({feeMode:mode,feeAmount:amount}),/did not confirm/);
    }
  }
});

test('an unconfigured zero Open Play fee stays unconfigured',async()=>{
  const {context:c}=boot({scope:'manager',response:{ok:true,settings:{openPlayServiceFee:{feeAmount:0,isConfigured:false}}}});
  assert.equal((await c.DB.getTenantActivationSettings()).openPlayServiceFee.isConfigured,false);
});

test('realtime changes cannot reset payment drafts when focus moves to a save button',async()=>{
  const source=fs.readFileSync('admin.html','utf8');
  const start=source.indexOf('async function startAdminRealtime()');
  const end=source.indexOf('\n}',start)+2;
  let event;let refresh;let renders=0;
  const channel={on(_kind,_filter,callback){event=callback;return this;},subscribe(){}};
  const c={window:{},clearTimeout(){},setTimeout(callback){refresh=callback;},document:{activeElement:{tagName:'BUTTON'},querySelector:()=>null},DB:{getResolvedTenantId:async()=>TENANT},_supabase:{channel:()=>channel},_admRtDebounce:null,_curSection:'payments',SECTION_LOADERS:{payments:async()=>{renders++;},bookings:async()=>{renders++;}}};
  vm.createContext(c);vm.runInContext(source.slice(start,end),c);
  await c.startAdminRealtime();event();await refresh();assert.equal(renders,0);
  c._curSection='bookings';event();await refresh();assert.equal(renders,1);
});

test('fee forms show persistent validation, pending, success, and server error feedback',async()=>{
  const source=fs.readFileSync('admin.html','utf8');
  const start=source.indexOf('async function saveMaintRate()');
  const end=source.indexOf('let _chartBookings',start);
  const elements=Object.fromEntries(['maintRateInput','saveMaintRateBtn','maintRateSaveStatus','maintRateSummary','openPlayServiceFeeInput','saveOpenPlayServiceFeeBtn','openPlayFeeSaveStatus'].map(id=>[id,{value:'',textContent:'',disabled:false,focus(){}}]));
  let mode='';let resolveSave;let fail=false;let called=0;
  const context={console,window:{PB_PLATFORM_V1:true},sess:{role:'owner'},Auth:{can:()=>true},$:id=>elements[id],document:{querySelector:()=>mode?{value:mode}:null},toast(){},
    DB:{saveTenantPlatformBilling:async()=>{called++;if(fail)throw Error('Session expired. Sign in again.');await new Promise(resolve=>{resolveSave=resolve;});return {billing:{feeAmount:12.5,isConfigured:true}};},saveTenantOpenPlayServiceFee:async()=>({openPlayServiceFee:{feeAmount:7.25,isConfigured:true}})},
    renderMaintRateSettings:async()=>{},renderOpenPlayServiceFeeSettings:async()=>{},renderPlatformActivationSettings:async(_,options)=>assert.equal(options.preserveInputs,true),renderIntegrationStatus:async()=>{},_platformActivation:null};
  vm.createContext(context);vm.runInContext(source.slice(start,end),context);
  elements.maintRateInput.value='12.50';await context.saveMaintRate();assert.match(elements.maintRateSaveStatus.textContent,/Choose a charging method/);assert.equal(called,0);
  mode='per_hour';const saving=context.saveMaintRate();assert.equal(elements.saveMaintRateBtn.disabled,true);assert.match(elements.maintRateSaveStatus.textContent,/Saving/);
  await context.saveMaintRate();assert.equal(called,1);resolveSave();await saving;
  assert.equal(elements.saveMaintRateBtn.disabled,false);assert.match(elements.maintRateSaveStatus.textContent,/Saved:.*12.50/);
  fail=true;await context.saveMaintRate();assert.match(elements.maintRateSaveStatus.textContent,/Session expired/);assert.equal(elements.saveMaintRateBtn.disabled,false);
  elements.openPlayServiceFeeInput.value='7.25';await context.saveOpenPlayServiceFee();assert.match(elements.openPlayFeeSaveStatus.textContent,/Saved:.*7.25/);
});

test('customer booking activation stays closed until a real security widget is configured',async()=>{
  const {context:c}=boot({hostname:'pickle-street-tugbok.boothsandbeyondoffic.chatgpt.site',scope:'manager',bootstrap:{readiness:{publicBookingEnabled:true}}});
  await c.DB.getResolvedTenantId();assert.equal(c.PB_PUBLIC_BOOKING_ENABLED,false);
  await assert.rejects(c.DB.activateTenantInitially(),/security check/);
});

test('Pages uses the approved security widget and keeps the Sites preview gated',()=>{
  assert.equal(boot().context.PB_TENANT_CONFIG.turnstileSiteKey,'0x4AAAAAAD4f_jPZuqET5eVD');
  assert.equal(boot({hostname:'pickle-street-tugbok.boothsandbeyondoffic.chatgpt.site'}).context.PB_TENANT_CONFIG.turnstileSiteKey,'');
});

test('higher-price rescheduling returns the held payment request without inventing a completed event',async()=>{
  const response={ok:true,paymentRequired:true,booking:{id:TENANT,reference:'PS-TEST',status:'confirmed',startsAt:'2026-10-01T10:00:00+08:00',endsAt:'2026-10-01T11:00:00+08:00',totalAmount:500},balanceRequest:{id:TENANT,status:'awaiting_payment',remainingAmount:200,deadlineAt:'2026-09-07T18:00:00+08:00'},price:{additionalAmount:200,newTotalAmount:700}};
  const {context:c,calls}=boot({scope:'manager',response});
  const result=await c.DB.rescheduleBooking('PS-TEST',{newDate:'2026-10-02',newStartTime:'18:00',deadlineAt:'2026-09-07T10:00:00Z',idempotencyKey:'stable-request-id'});
  assert.equal(result.event,null);assert.equal(result.paymentRequired,true);assert.equal(result.booking.status,'confirmed');
  const sent=JSON.parse(calls.find(call=>call.kind==='fetch').init.body);assert.equal(sent.deadlineAt,'2026-09-07T10:00:00Z');assert.equal(sent.idempotencyKey,'stable-request-id');
});

test('equal-price rescheduling requires and returns a committed change event',async()=>{
  const response={ok:true,paymentRequired:false,booking:{id:TENANT,reference:'PS-TEST',status:'confirmed',startsAt:'2026-10-02T10:00:00+08:00',endsAt:'2026-10-02T11:00:00+08:00'},event:{id:TENANT},email:{status:'sent'}};
  const {context:c}=boot({scope:'manager',response});const result=await c.DB.rescheduleBooking('PS-TEST',{});
  assert.ok(result.event);assert.equal(result.email.status,'sent');
  const invalid=boot({scope:'manager',response:{...response,event:null}}).context;
  await assert.rejects(invalid.DB.rescheduleBooking('PS-TEST',{}),/could not be verified/);
});
