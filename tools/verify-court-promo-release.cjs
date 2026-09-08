'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const origin='https://picklestreet.pages.dev',api='https://neqvrwtofiolcuxewdze.supabase.co';
const key='sb_publishable_UHMKYGsygjeMl79VRfPNVw_RyWiV5Yr';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
async function main(){
  const assets=[];
  for(const [route,file] of [['/','index.html'],['/admin','admin.html'],['/court-pricing.js','court-pricing.js'],['/supabase-config.js','supabase-config.js'],['/pickle-street.css','pickle-street.css']]){
    const response=await fetch(origin+route,{signal:AbortSignal.timeout(20000)});assert.equal(response.status,200);
    const body=Buffer.from(await response.arrayBuffer()),digest=hash(body);assert.equal(digest,hash(fs.readFileSync('dist/'+file)),file+' deployment differs');assets.push({route,sha256:digest});
  }
  const headers={apikey:key,'Content-Type':'application/json',Origin:origin};
  const target={p_tenant_slug:'pickle-street-tugbok',p_hostname:'picklestreet.pages.dev'};
  const response=await fetch(api+'/rest/v1/rpc/get_public_tenant_bootstrap',{method:'POST',headers,body:JSON.stringify(target),signal:AbortSignal.timeout(20000)});assert.equal(response.status,200);const data=await response.json();
  assert.equal(data.tenant.id,'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a');assert.equal(data.readiness.publicBookingEnabled,true);assert.equal(data.courts.length,3);
  const prices=data.courts.map(c=>({name:c.name,bands:c.pricingConfig.regular.bands.map(b=>({hourlyRate:b.hourlyRate,promoEnabled:b.promoEnabled===true}))}));
  assert.ok(prices.every(c=>c.bands.length&&c.bands.every(b=>b.hourlyRate===1&&!b.promoEnabled)),'Testing prices changed');
  const denied=[];
  for(const [name,args] of [
    ['apply_shared_picklestreet_court_schedule',{...target,p_opens_at:'05:00',p_closes_at:'00:00',p_bands:[],p_expected_revisions:{}}],
    ['manage_picklestreet_court',{...target,p_action:'invalid-readonly-probe',p_court_id:null,p_patch:{},p_expected_revisions:{}}]
  ]){
    const r=await fetch(api+'/rest/v1/rpc/'+name,{method:'POST',headers,body:JSON.stringify(args),signal:AbortSignal.timeout(20000)}),body=await r.json();
    assert.ok([401,403].includes(r.status),name+' must exist and reject anonymous callers');assert.equal(body.code,'42501');denied.push({name,status:r.status,code:body.code});
  }
  const report={checkedAt:new Date().toISOString(),origin,assets,publicBookingEnabled:true,courtCount:3,testingPrices:prices,anonymousManagerWritesDenied:denied,pricesChanged:false};
  fs.writeFileSync('operations/court-promo-release-verification.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
