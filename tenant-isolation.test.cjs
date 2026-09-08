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
    rpc:async(name,args)=>{calls.push({kind:'rpc',name,args}); if(name==='get_picklestreet_payment_settings' && options.response?.settings)return {data:options.response.settings}; if(options.rpc)return options.rpc(name,args);return {data:name==='get_my_tenant_session'?account:name==='get_public_tenant_bootstrap'?bootstrap:name==='get_public_availability'?{tenantSlug:SLUG,date:args.p_date,courts:[],blockedDates:[]}:[]};},
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

test('private payment settings reject public access before sending a manager request',async()=>{
  const {context:c,calls}=boot();
  await assert.rejects(c.DB.getTenantActivationSettings(),/Sign in/);
  await assert.rejects(c.DB.saveTenantActivationSettings({paymentMethods:[]}),/Sign in/);
  assert.equal(calls.length,0);
});

test('shared payment settings keep private receipt identity and both revisions on the isolated save route',async()=>{
  const settings={tenant:{id:TENANT,slug:SLUG},tenantRevision:'2026-09-08T00:00:00Z',
    receiptVerification:{gcashQrAlias:'TEST VENUE ALIAS',gcashQrToken:'TEST12345678'},receiptVerificationRevision:4,paymentMethods:[]};
  const {context:c,calls}=boot({scope:'manager',rpc:async(name)=>({data:name==='get_public_tenant_bootstrap'
    ? {tenant:{id:TENANT,slug:SLUG},courts:[],settings:{},paymentMethods:[],readiness:{publicBookingEnabled:true}}
    : settings})});
  const loaded=await c.DB.getTenantActivationSettings();assert.equal(loaded.receiptVerification.gcashQrAlias,'TEST VENUE ALIAS');
  await c.DB.saveTenantActivationSettings({replyToEmail:'venue@example.test',emailEnabled:true,
    paymentMethods:[{code:'maya',displayName:'Maya',accountName:'TEST VENUE',accountReference:'09172222222',isActive:true}],
    receiptVerification:loaded.receiptVerification,receiptVerificationRevision:loaded.receiptVerificationRevision});
  const save=calls.find(call=>call.name==='save_picklestreet_payment_settings');assert.ok(save);
  assert.equal(save.args.p_tenant_slug,SLUG);assert.equal(save.args.p_hostname,HOST);
  assert.equal(save.args.p_expected_revision,settings.tenantRevision);assert.equal(save.args.p_patch.receiptVerificationRevision,4);
  assert.equal(save.args.p_patch.receiptVerification.gcashQrToken,'TEST12345678');
  assert.equal(save.args.p_patch.paymentMethods[0].accountNumber,'09172222222');
  assert.equal(calls.some(call=>call.name==='update_tenant_business_settings_if_current'),false);
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
  assert.match(request.url,/picklestreet-receipts/);assert.equal(JSON.parse(request.init.body).action,'status');
});

test('Book Now creates a selection-only hold using guest authorization',async()=>{
  const {context:c,calls}=boot({bootstrap:{readiness:{publicBookingEnabled:true}},response:{ok:true,booking:{reference:'PS-HOLD',bookingToken:'test-capability',detailsCompleted:false}}});
  const result=await c.DB.createPublicBookingHold({courtId:'court-test',date:'2026-10-01',slots:[10,11],bookingType:'regular',clientRequestId:'10000000-0000-4000-8000-000000000001',fullName:'Do not send',policyAccepted:true,total:1},{turnstileToken:'test-challenge'});
  assert.equal(result.detailsCompleted,false);
  const request=calls.find(x=>x.kind==='fetch'),body=JSON.parse(request.init.body);
  assert.match(request.url,/picklestreet-booking-hold/);assert.equal(body.action,'create');
  assert.equal(body.startTime,'10:00');assert.equal(body.durationHours,2);
  assert.equal(body.tenantSlug,SLUG);
  for(const key of ['customer','fullName','policyAccepted','total','metadata'])assert.equal(Object.hasOwn(body,key),false);
  assert.ok(!new Headers(request.init.headers).get('Authorization').includes('test-manager-token'));
});

test('hold creation rejects invalid selection or missing challenge before writing',async()=>{
  const {context:c,calls}=boot({bootstrap:{readiness:{publicBookingEnabled:true}}});
  await assert.rejects(c.DB.createPublicBookingHold({slots:[10,12]},{turnstileToken:'challenge'}),/consecutive/);
  await assert.rejects(c.DB.createPublicBookingHold({slots:[10]}),/security check/);
  assert.equal(calls.filter(x=>x.kind==='fetch').length,0);
});

test('preliminary status stays private and cannot claim completed details',async()=>{
  const {context:c,calls}=boot({response:{ok:true,booking:{reference:'PS-HOLD',status:'pending_payment',detailsCompleted:false}}});
  const result=await c.DB.getPublicBookingStatus({bookingReference:'PS-HOLD',bookingToken:'test-capability',preliminaryHold:true});
  assert.equal(result.detailsCompleted,false);
  const request=calls.find(x=>x.kind==='fetch');assert.match(request.url,/picklestreet-booking-hold/);
  assert.equal(JSON.parse(request.init.body).action,'status');
});

test('existing normal access remains customer-complete without a preliminary lookup',async()=>{
  const {context:c,calls}=boot();
  const result=await c.DB.getPublicBookingStatus({bookingReference:'PS-TEST',bookingToken:'test-capability'});
  assert.equal(result.detailsCompleted,true);assert.equal(calls.filter(x=>x.kind==='fetch').length,1);
});

test('preliminary cancellation routes to the isolated hold service',async()=>{
  const {context:c,calls}=boot({response:{ok:true,cancellation:{cancelled:true}}});
  const result=await c.DB.cancelPublicBookingHold({bookingReference:'PS-HOLD',bookingToken:'test-capability',preliminaryHold:true});
  assert.equal(result.cancelled,true);const request=calls.find(x=>x.kind==='fetch');
  assert.match(request.url,/picklestreet-booking-hold/);assert.equal(JSON.parse(request.init.body).action,'cancel');
});

test('customer completion requires real current consent and preserves the capability',async()=>{
  const policy={version:'test-v1',title:'Booking policy',intro:'Please review these test booking terms.',content:'Test booking terms require review and acceptance.',ownerApproved:true};
  const {context:c,calls}=boot({bootstrap:{settings:{refund_reschedule_policy:policy}},response:{ok:true,booking:{reference:'PS-HOLD',bookingToken:'same-capability',detailsCompleted:true}}});
  const payload={bookingReference:'PS-HOLD',bookingToken:'same-capability',customer:{name:'Test Guest',email:'test@example.test',phone:'09170000000'},policyVersion:'test-v1'};
  await assert.rejects(c.DB.completePublicBookingHold({...payload,policyAccepted:false}),e=>e.code==='POLICY_CHANGED');
  await assert.rejects(c.DB.completePublicBookingHold({...payload,policyAccepted:true,policyVersion:'older-v1'}),e=>e.code==='POLICY_CHANGED');
  assert.equal(calls.filter(x=>x.kind==='fetch').length,0);
  const result=await c.DB.completePublicBookingHold({...payload,policyAccepted:true});assert.equal(result.detailsCompleted,true);
  const body=JSON.parse(calls.find(x=>x.kind==='fetch').init.body);
  assert.equal(body.action,'complete');assert.equal(body.bookingToken,'same-capability');assert.equal(body.bookingReference,'PS-HOLD');assert.equal(body.policyAccepted,true);assert.equal(body.customer.name,'Test Guest');
});

test('receipt retry uses staff authorization and a stable caller request id',async()=>{
  const {context:c,calls}=boot({scope:'manager',response:{ok:true,bookingStatus:'payment_review',paymentStatus:'pending'}});
  const result=await c.DB.retryPaymentReceipt('PS-TEST','00000000-0000-4000-8000-000000000001');
  const request=calls.find(call=>call.kind==='fetch');assert.match(request.url,/picklestreet-receipts/);
  assert.ok(new Headers(request.init.headers).get('Authorization').includes('test-manager-token'));
  assert.equal(JSON.parse(request.init.body).idempotencyKey,'00000000-0000-4000-8000-000000000001');assert.equal(result.paymentStatus,'pending');
});

test('receipt images use the staff signer with the projected verification ID, never a public storage URL', async () => {
  const response = {ok:true, signedUrl:API+'/storage/v1/object/sign/tenant-private/receipt?token=test',
    booking:{reference:'PS-TEST', receipt_verifications:[{id:'receipt-1',image_available:true,status:'manual_review'}]}};
  const {context:c,calls}=boot({scope:'manager',response});
  assert.equal(await c.DB.getReceiptSignedUrl('PS-TEST','receipt-1'),response.signedUrl);
  const signed=calls.find(call=>(call.url||'').includes('get-receipt-view-url'));
  assert.ok(signed);
  assert.deepEqual(JSON.parse(signed.init.body),{tenantSlug:SLUG,verificationId:'receipt-1'});
  assert.match(new Headers(signed.init.headers).get('Authorization'),/test-manager-token/);
});

test('manual receipt context and decisions use tenant-scoped staff credentials and the expected attempt',async()=>{
 const {context:c,calls}=boot({scope:'manager',response:{ok:true,verificationId:'receipt-1',attemptId:'attempt-1',receiptStatus:'approved'}});
 const context=await c.DB.getPendingReceiptReviewContext('PS-TEST','receipt-1');assert.equal(context.attemptId,'attempt-1');
 await c.DB.reviewPendingReceipt({bookingReference:'PS-TEST',verificationId:'receipt-1',expectedAttemptId:'attempt-1',idempotencyKey:'key-1',decision:'approve',note:'Payment received'});
 const requests=calls.filter(call=>call.kind==='fetch');assert.equal(requests.length,2);
 for(const request of requests){assert.match(request.url,/picklestreet-receipts\?tenantSlug=pickle-street-tugbok/);assert.match(new Headers(request.init.headers).get('Authorization'),/test-manager-token/);}
 const payload=JSON.parse(requests[1].init.body);assert.equal(payload.action,'review');assert.equal(payload.expectedAttemptId,'attempt-1');assert.equal(payload.idempotencyKey,'key-1');
});
test('manual payment decisions reject public pages and invalid reasons before network access',async()=>{
 const {context:c,calls}=boot();await assert.rejects(c.DB.getPendingReceiptReviewContext('PS-TEST','receipt-1'),/Sign in/);
 await assert.rejects(c.DB.reviewPendingReceipt({decision:'approve'}),/Sign in/);assert.equal(calls.length,0);
 const staff=boot({scope:'manager'});await assert.rejects(staff.context.DB.reviewPendingReceipt({decision:'reject',note:'x'}),/rejection reason/);assert.equal(staff.calls.length,0);
});

test('receipt preview denies public pages, missing receipts and changed receipt IDs before signing', async () => {
  for(const options of [
    {scope:'public',response:{ok:true,booking:{receipt_verifications:[{id:'receipt-1',image_available:true}]}}},
    {scope:'manager',response:{ok:true,booking:{reference:'PS-TEST',receipt_verifications:[]}}},
    {scope:'manager',response:{ok:true,booking:{reference:'PS-TEST',receipt_verifications:[{id:'receipt-new',image_available:true}]}}},
  ]) {
    const {context:c,calls}=boot(options);
    await assert.rejects(c.DB.getReceiptSignedUrl('PS-TEST','receipt-1'),/No receipt|receipt has changed/);
    assert.equal(calls.some(call=>(call.url||'').includes('get-receipt-view-url')),false);
  }
});

test('receipt preview rejects untrusted signed URL hosts, schemes and embedded credentials', async () => {
  for(const signedUrl of ['https://other.supabase.co/receipt','http://neqvrwtofiolcuxewdze.supabase.co/receipt',
    'https://attacker@neqvrwtofiolcuxewdze.supabase.co/receipt']) {
    const {context:c}=boot({scope:'manager',response:{ok:true,signedUrl,
      booking:{reference:'PS-TEST',receipt_verifications:[{id:'receipt-1',image_available:true}]}}});
    await assert.rejects(c.DB.getReceiptSignedUrl('PS-TEST','receipt-1'),/not issued by the booking platform/);
  }
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

test('Open Play is hidden only in the dashboard and makes no dashboard data requests',async()=>{
  const {context:c,calls}=boot({scope:'manager'});
  assert.equal(c.PB_TENANT_CONFIG.adminOpenPlayEnabled,false);
  assert.equal(c.PB_TENANT_CONFIG.openPlayEnabled,true);
  const nodes=new Map(['openPlayDashboardMount','openPlayReportMount','rp-source-openplay','rpExportOpenPlay'].map(id=>[id,{hidden:false}]));
  c.document.getElementById=id=>nodes.get(id);
  vm.runInContext(fs.readFileSync('open-play-admin.js','utf8'),c);
  vm.runInContext(fs.readFileSync('open-play-reporting.js','utf8'),c);
  assert.equal(await c.OpenPlayAdmin.mount(),false);
  assert.equal(c.OpenPlayReporting.mount(),false);
  assert.equal(await c.OpenPlayReporting.renderDashboard(),false);
  assert.equal(await c.OpenPlayReporting.renderReport(),false);
  assert.ok([...nodes.values()].every(node=>node.hidden));assert.equal(calls.length,0);
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
