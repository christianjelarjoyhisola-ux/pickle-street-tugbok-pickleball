const fs=require('node:fs'),assert=require('node:assert/strict'),crypto=require('node:crypto');const {query}=require('./pending-platform.cjs');
const base='https://neqvrwtofiolcuxewdze.supabase.co';const origin='https://picklestreetcourt.com';
const key='sb_publishable_UHMKYGsygjeMl79VRfPNVw_RyWiV5Yr';
const headers={apikey:key,Origin:origin,'Content-Type':'application/json'};
const url=base+'/functions/v1/picklestreet-weather-credit?tenantSlug=pickle-street-tugbok';
(async()=>{
 const cases=[
  ['Browser preflight',url,{method:'OPTIONS',headers:{...headers,'Access-Control-Request-Headers':'authorization,apikey,content-type'}},204],
  ['Owner management requires sign-in',url,{method:'POST',headers,body:JSON.stringify({tenantSlug:'pickle-street-tugbok',action:'get',bookingReference:'TEST-NONEXISTENT'})},401],
  ['Foreign origin denied',url,{method:'POST',headers:{...headers,Origin:'https://example.com'},body:'{}'},403],
  ['Invalid private booking cannot redeem credit',url,{method:'POST',headers,body:JSON.stringify({tenantSlug:'pickle-street-tugbok',action:'apply',bookingReference:'TEST-NONEXISTENT',bookingToken:'x'.repeat(43),code:'PS-RAIN-'+'A'.repeat(24)})},409],
  ['Public callers cannot run the credit transaction',base+'/rest/v1/rpc/apply_picklestreet_weather_credit',{method:'POST',headers,body:JSON.stringify({p_reference:'TEST-NONEXISTENT',p_token:'x',p_code:'x'})},401],
 ];
 const checks=await Promise.all(cases.map(async([name,target,options,status])=>{const r=await fetch(target,{...options,signal:AbortSignal.timeout(20000)});assert.equal(r.status,status,name+': '+await r.text());if(status===204)assert.equal(r.headers.get('access-control-allow-origin'),origin);return{name,passed:true,status:r.status};}));
 const response=await fetch('https://api.supabase.com/v1/projects/neqvrwtofiolcuxewdze/functions',{headers:{Authorization:'Bearer '+process.env.SUPABASE_ACCESS_TOKEN}});assert(response.ok);const current=await response.json();
 const before=JSON.parse(fs.readFileSync('operations/late-confirmation/edge-before.json','utf8'));
 for(const old of before){if(old.slug==='picklestreet-receipts')continue;const now=current.find(x=>x.slug===old.slug);assert(now&&now.version===old.version,'Unrelated edge function changed: '+old.slug);}
 const rows=await query(`select count(*)::integer as leftover_test_bookings from public.bookings where tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and reference like 'PS-ROLLBACK-98%'`,true);assert.equal(rows[0].leftover_test_bookings,0);
 const assets=[];for(const file of ['weather-credit.js','weather-credit.css','supabase-config.js']){const r=await fetch(origin+'/'+file,{signal:AbortSignal.timeout(20000)});assert.equal(r.status,200);const data=Buffer.from(await r.arrayBuffer());assert.equal(crypto.createHash('sha256').update(data).digest('hex'),crypto.createHash('sha256').update(fs.readFileSync('dist/'+file)).digest('hex'),file+' differs');assets.push(file);}
 const report={at:new Date().toISOString(),checks,assets,unrelatedEdgeFunctionsPreserved:true,testBookingsRetained:0};
 fs.writeFileSync('operations/weather-credit/live-verification.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
