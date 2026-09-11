'use strict';
const assert=require('node:assert/strict');const fs=require('node:fs');
const origin='https://picklestreetcourt.com';
const key='sb_publishable_UHMKYGsygjeMl79VRfPNVw_RyWiV5Yr';
const endpoint='https://neqvrwtofiolcuxewdze.supabase.co/rest/v1/rpc/get_public_tenant_bootstrap';
async function bootstrap(slug){const r=await fetch(endpoint,{method:'POST',headers:{apikey:key,'Content-Type':'application/json',Origin:origin},body:JSON.stringify({p_tenant_slug:slug,p_hostname:'picklestreetcourt.com'}),signal:AbortSignal.timeout(20000)});return {status:r.status,data:await r.json()};}
async function check(){
  const pages=[];
  for(const [route,marker] of [['/','https://picklestreetcourt.com/'],['/login','data-pb-data-scope="auth"'],['/admin','data-pb-data-scope="manager"'],['/booking-management','Manage your booking']]){
    const r=await fetch(origin+route,{signal:AbortSignal.timeout(20000)});const body=await r.text();assert.equal(r.status,200,route);assert.ok(body.includes(marker),route+' must serve the current app');pages.push({route,status:r.status});
  }
  const config=await fetch(origin+'/tenant-config.js',{signal:AbortSignal.timeout(20000)});const source=await config.text();assert.equal(config.status,200);assert.ok(source.includes("'picklestreetcourt.com'"));assert.doesNotMatch(source,/turnstile|captcha|challenges\.cloudflare\.com/i,'Pickle Street must not include a CAPTCHA integration');
  for(const route of ['/feature-preview/supabase-config.js','/supabase/migrations','/.env','/operations/register-pages-domain.sql']){const r=await fetch(origin+route,{signal:AbortSignal.timeout(20000)});assert.equal(r.status,404,'Non-public source must not be served: '+route);}
  const own=await bootstrap('pickle-street-tugbok');assert.equal(own.status,200);assert.equal(own.data.tenant.id,'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a');assert.equal(own.data.readiness.domainConfigured,true);
  const wrong=await bootstrap('backyard-pickle');assert.ok(wrong.status>=400 || !wrong.data?.tenant,'Another tenant must not resolve from this origin');
  const report={checkedAt:new Date().toISOString(),origin,pages,privateSourceExcluded:true,tenantId:own.data.tenant.id,domainConfigured:true,wrongTenantRejected:true,publicBookingEnabled:own.data.readiness.publicBookingEnabled,courtCount:own.data.courts.length,blockingReasons:own.data.readiness.blockingReasons,onlyReadOperations:true};
  fs.writeFileSync('operations/cloudflare-release-verification.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}
check().catch(e=>{console.error(e.message);process.exitCode=1});
