'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
const base='https://neqvrwtofiolcuxewdze.supabase.co';
const apiKey='sb_publishable_UHMKYGsygjeMl79VRfPNVw_RyWiV5Yr';
const endpoint=base+'/functions/v1/picklestreet-receipts?tenantSlug=pickle-street-tugbok';
const headers={apikey:apiKey,Origin:'https://picklestreet.pages.dev','Content-Type':'application/json'};
async function main(){
const cases=[
 ['Browser preflight',endpoint,{method:'OPTIONS',headers},204],
 ['Other tenant denied',endpoint.replace('tenantSlug=pickle-street-tugbok','tenantSlug=other-tenant'),{method:'OPTIONS',headers},403],
 ['Unmapped origin denied',endpoint,{method:'OPTIONS',headers:{...headers,Origin:'https://example.invalid'}},403],
 ['Invalid private booking link denied',endpoint,{method:'POST',headers,body:JSON.stringify({action:'status',tenantSlug:'pickle-street-tugbok',bookingReference:'PS-NO-SUCH-BOOKING',bookingToken:'a'.repeat(43)})},401],
 ['Staff retry requires sign-in',endpoint,{method:'POST',headers,body:JSON.stringify({action:'retry',bookingReference:'PS-NO-SUCH-BOOKING',idempotencyKey:'00000000-0000-4000-8000-000000000000'})},401],
 ['Private balance link required',endpoint,{method:'POST',headers,body:JSON.stringify({action:'balance_status',balanceRequestId:'00000000-0000-4000-8000-000000000000',balanceToken:'a'.repeat(43)})},401],
 ['Balance retry requires staff sign-in',endpoint,{method:'POST',headers,body:JSON.stringify({action:'retry',bookingReference:'PS-NO-SUCH-BOOKING',balanceRequestId:'00000000-0000-4000-8000-000000000000',idempotencyKey:'00000000-0000-4000-8000-000000000000'})},401],
 ['Guest cannot call the receipt transaction',base+'/rest/v1/rpc/begin_picklestreet_receipt_attempt',{method:'POST',headers,body:JSON.stringify({p_booking_id:'00000000-0000-4000-8000-000000000000',p_action:'retry',p_idempotency_key:'00000000-0000-4000-8000-000000000000'})},401],
 ['Guest cannot settle an additional payment',base+'/rest/v1/rpc/finish_picklestreet_balance_receipt_attempt',{method:'POST',headers,body:JSON.stringify({p_attempt_id:'00000000-0000-4000-8000-000000000000',p_lease_token:'00000000-0000-4000-8000-000000000000'})},401],
 ['Guest cannot invoke scheduled cleanup',base+'/rest/v1/rpc/run_picklestreet_balance_hold_cleanup',{method:'POST',headers,body:'{}'},401],
];
const results=[];
for(const [name,url,options,expected] of cases){const response=await fetch(url,options);const body=await response.text();assert.equal(response.status,expected,name+': '+body.slice(0,300));results.push({name,status:response.status,passed:true});}
fs.writeFileSync('operations/pending-flow/live-access-checks.json',JSON.stringify({checkedAt:new Date().toISOString(),results},null,2));console.log(JSON.stringify(results));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
