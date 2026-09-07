const assert=require('node:assert/strict');
const fs=require('node:fs');
const origin='https://pickle-street-tugbok.boothsandbeyondoffic.chatgpt.site';
const endpoint='https://neqvrwtofiolcuxewdze.supabase.co/rest/v1/rpc/get_public_tenant_bootstrap';
const key='sb_publishable_UHMKYGsygjeMl79VRfPNVw_RyWiV5Yr';
async function bootstrap(slug,hostname) {
  const response=await fetch(endpoint,{method:'POST',headers:{apikey:key,'Content-Type':'application/json',Origin:origin},body:JSON.stringify({p_tenant_slug:slug,p_hostname:hostname}),signal:AbortSignal.timeout(20000)});
  return {status:response.status,data:await response.json()};
}
(async()=>{
  const good=await bootstrap('pickle-street-tugbok',new URL(origin).hostname);
  assert.equal(good.status,200);
  assert.equal(good.data.tenant.slug,'pickle-street-tugbok');
  assert.equal(good.data.tenant.id,'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a');
  assert.equal(good.data.readiness.publicBookingEnabled,false);
  assert.equal(good.data.courts.length,0);
  const wrong=await bootstrap('backyard-pickle',new URL(origin).hostname);
  assert.ok(wrong.status>=400 || !wrong.data?.tenant,'Other tenant must not resolve on the Pickle Street domain');
  const report={checkedAt:new Date().toISOString(),project:'neqvrwtofiolcuxewdze',tenant:good.data.tenant,readiness:good.data.readiness,courtCount:good.data.courts.length,wrongTenantRejected:true,capabilities:good.data.capabilities||{},onlyReadOperations:true};
  fs.writeFileSync('operations/live-verification.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
})().catch(error=>{console.error(error.message);process.exitCode=1});
