import assert from 'node:assert/strict';
import {creditHistory} from './history.ts';
function fixture(allowed=true) {
  const calls: any[]=[];
  const db={from(table:string){const call:any={table,filters:[]};calls.push(call);const q:any={};for(const method of ['select','eq','in','order','range'])q[method]=(...args:any[])=>{call.filters.push([method,...args]);return q;};q.maybeSingle=()=>Promise.resolve({data:allowed&&table==='tenant_memberships'?{id:'member'}:null});q.then=(resolve:any)=>resolve({data:table==='picklestreet_weather_credits'?[{booking_id:'booking',email:'guest@example.test',minutes:90,balance_minutes:60,created_at:'2026-09-24T00:00:00Z',email_sent_at:null}]:[{id:'booking',reference:'TEST-BOOKING',customer_name:'Guest'}]});return q;}};
  return {db,calls};
}
Deno.test('history denies staff before reading private credits',async()=>{
  const f=fixture(false);await assert.rejects(()=>creditHistory(f.db,'tenant','actor',0),/Owner or administrator/);
  assert.equal(f.calls.some(c=>c.table==='picklestreet_weather_credits'),false);
});
Deno.test('history is tenant-scoped, paginated and excludes private redemption codes',async()=>{
  const f=fixture();const r=await creditHistory(f.db,'tenant','actor',0);
  assert.equal(r.credits[0].reference,'TEST-BOOKING');assert.equal(r.credits[0].balanceMinutes,60);assert.equal(r.hasMore,false);
  for(const table of ['tenant_memberships','picklestreet_weather_credits','bookings'])assert(f.calls.find(c=>c.table===table).filters.some((a:any[])=>a[0]==='eq'&&a[1]==='tenant_id'&&a[2]==='tenant'));
  assert(!JSON.stringify(r).includes('code'));assert(f.calls.find(c=>c.table==='picklestreet_weather_credits').filters.some((a:any[])=>a[0]==='range'&&a[1]===0&&a[2]===50));
});
Deno.test('history rejects invalid pagination',async()=>{
  for(const value of [-1,.5,'bad',100001])await assert.rejects(()=>creditHistory(fixture().db,'tenant','actor',value),/valid history page/);
});
