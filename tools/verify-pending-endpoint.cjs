'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
const base='https://neqvrwtofiolcuxewdze.supabase.co';
const apiKey='sb_publishable_UHMKYGsygjeMl79VRfPNVw_RyWiV5Yr';
const endpoint=base+'/functions/v1/picklestreet-receipts?tenantSlug=pickle-street-tugbok';
const headers={apikey:apiKey,Origin:'https://picklestreet.pages.dev','Content-Type':'application/json'};
const uploadHeaders=['apikey','authorization','x-tenant-slug','x-booking-reference','x-booking-token','x-payment-method','x-payment-reference','x-idempotency-key'];
const preflight=extra=>({Origin:headers.Origin,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':[...uploadHeaders,...extra].join(', ')});
async function main(){
const cases=[
 ['Initial receipt browser preflight',endpoint,{method:'OPTIONS',headers:preflight([])},204],
 ['Balance receipt browser preflight',endpoint,{method:'OPTIONS',headers:preflight(['x-balance-request'])},204],
 ['Other tenant denied',endpoint.replace('tenantSlug=pickle-street-tugbok','tenantSlug=other-tenant'),{method:'OPTIONS',headers},403],
 ['Unmapped origin denied',endpoint,{method:'OPTIONS',headers:{...headers,Origin:'https://example.invalid'}},403],
 ['Invalid private booking link denied',endpoint,{method:'POST',headers,body:JSON.stringify({action:'status',tenantSlug:'pickle-street-tugbok',bookingReference:'PS-NO-SUCH-BOOKING',bookingToken:'a'.repeat(43)})},401],
 ['Staff retry requires sign-in',endpoint,{method:'POST',headers,body:JSON.stringify({action:'retry',bookingReference:'PS-NO-SUCH-BOOKING',idempotencyKey:'00000000-0000-4000-8000-000000000000'})},401],
 ['Staff review context requires sign-in',endpoint,{method:'POST',headers,body:JSON.stringify({action:'review_context'})},401],
 ['Private receipt diagnostics require sign-in',endpoint,{method:'POST',headers,body:JSON.stringify({action:'receipt_diagnostics',bookingReference:'PS-NO-SUCH-BOOKING',verificationId:'00000000-0000-4000-8000-000000000000'})},401],
 ['Manual approval requires sign-in',endpoint,{method:'POST',headers,body:JSON.stringify({action:'review',decision:'approve'})},401],
 ['Guest cannot call manual payment review',base+'/rest/v1/rpc/review_picklestreet_pending_receipt',{method:'POST',headers,body:JSON.stringify({p_verification_id:'00000000-0000-4000-8000-000000000000',p_expected_attempt_id:'00000000-0000-4000-8000-000000000000',p_idempotency_key:'00000000-0000-4000-8000-000000000000',p_decision:'approve',p_review_note:'Guest denied',p_actor_user_id:'00000000-0000-4000-8000-000000000000'})},401],
 ['Private balance link required',endpoint,{method:'POST',headers,body:JSON.stringify({action:'balance_status',balanceRequestId:'00000000-0000-4000-8000-000000000000',balanceToken:'a'.repeat(43)})},401],
 ['Balance retry requires staff sign-in',endpoint,{method:'POST',headers,body:JSON.stringify({action:'retry',bookingReference:'PS-NO-SUCH-BOOKING',balanceRequestId:'00000000-0000-4000-8000-000000000000',idempotencyKey:'00000000-0000-4000-8000-000000000000'})},401],
 ['Guest cannot call the receipt transaction',base+'/rest/v1/rpc/begin_picklestreet_receipt_attempt',{method:'POST',headers,body:JSON.stringify({p_booking_id:'00000000-0000-4000-8000-000000000000',p_action:'retry',p_idempotency_key:'00000000-0000-4000-8000-000000000000'})},401],
 ['Guest cannot settle an additional payment',base+'/rest/v1/rpc/finish_picklestreet_balance_receipt_attempt',{method:'POST',headers,body:JSON.stringify({p_attempt_id:'00000000-0000-4000-8000-000000000000',p_lease_token:'00000000-0000-4000-8000-000000000000'})},401],
 ['Guest cannot invoke scheduled cleanup',base+'/rest/v1/rpc/run_picklestreet_balance_hold_cleanup',{method:'POST',headers,body:'{}'},401],
 ['Guest cannot read private QR receipt settings',base+'/rest/v1/rpc/get_picklestreet_payment_settings',{method:'POST',headers,body:JSON.stringify({p_tenant_slug:'pickle-street-tugbok',p_hostname:'picklestreet.pages.dev'})},401],
 ['Guest cannot save payment methods',base+'/rest/v1/rpc/save_picklestreet_payment_settings',{method:'POST',headers,body:JSON.stringify({p_tenant_slug:'pickle-street-tugbok',p_hostname:'picklestreet.pages.dev',p_expected_revision:'2026-09-08T00:00:00Z',p_patch:{}})},401],
 ['Guest cannot call source-route automatic approval',base+'/rest/v1/rpc/auto_approve_picklestreet_receipt_route',{method:'POST',headers,body:JSON.stringify({p_verification_id:'00000000-0000-4000-8000-000000000000'})},401],
];
const results=[];
for(const [name,url,options,expected] of cases){
 const response=await fetch(url,options);const body=await response.text();assert.equal(response.status,expected,name+': '+body.slice(0,300));
 if(options.method==='OPTIONS'&&expected===204){
  assert.equal(response.headers.get('access-control-allow-origin'),headers.Origin,name+': exact origin');
  const allowed=new Set((response.headers.get('access-control-allow-headers')||'').split(',').map(x=>x.trim().toLowerCase()));
  for(const requested of options.headers['Access-Control-Request-Headers'].split(',').map(x=>x.trim()))assert.ok(allowed.has(requested),name+': browser blocks '+requested);
  assert.ok((response.headers.get('access-control-allow-methods')||'').split(',').map(x=>x.trim()).includes('POST'),name+': POST allowed');
 }
 results.push({name,status:response.status,passed:true});
}
fs.writeFileSync('operations/pending-flow/live-access-checks.json',JSON.stringify({checkedAt:new Date().toISOString(),results},null,2));console.log(JSON.stringify(results));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
