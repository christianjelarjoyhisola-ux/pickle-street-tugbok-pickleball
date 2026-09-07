'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict');const {query}=require('./pending-platform.cjs');
async function main(){
 const before=JSON.parse(fs.readFileSync('operations/pending-flow/deployed/functions.json','utf8'));
 const names=[...new Set(before.map(x=>x.proname))];assert(names.every(n=>/^[a-z0-9_]+$/.test(n)));
 const after=await query("select p.proname,pg_get_functiondef(p.oid) as definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' and p.proname in ("+names.map(n=>"'"+n+"'").join(',')+")",true);
 const changes=before.filter(old=>!after.some(now=>now.proname===old.proname&&now.definition===old.definition)).map(x=>x.proname);
 assert.deepEqual(changes,[],'An existing shared function changed');
 const fixtures=await query("select count(*)::int as remaining from public.bookings where tenant_id='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a' and (reference like 'PS-ROLLBACK-%' or reference like 'PS-BALANCE-ROLLBACK-%')",true);
 assert.equal(fixtures[0].remaining,0,'A rollback fixture remains');
 const result={checkedAt:new Date().toISOString(),existingSharedFunctionsUnchanged:before.length,remainingTestBookings:0,targetTenant:'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a'};
 fs.writeFileSync('operations/pending-flow/isolation-check.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
