import assert from 'node:assert/strict';
import {paymentReceiptContext,TENANT_ID} from './index.ts';
function database(options:Record<string,unknown>={}) {
  const queries:{table:string;filters:Record<string,unknown>}[]=[];
  const receiver={account_name:'TEST VENUE ONLY',account_reference:'09171234567'};
  const db={from(table:string){const filters:Record<string,unknown>={};queries.push({table,filters});
    const response=()=>({error:null,data:table==='tenants'?{public_config:{bookingApprovalMode:options.manual?'manual':'automatic'}}
      :table==='picklestreet_receipt_route_settings'?{gcash_qr_alias:'TEST ALIAS',gcash_qr_token:'TESTTOKEN12345',revision:7}
      :filters.method_code==='gcash'?receiver:options.disabled?null:options.wrongDestination?{...receiver,account_reference:'09999999999'}:receiver});
    return {select(){return this;},eq(key:string,value:unknown){filters[key]=value;return this;},async single(){return response();},async maybeSingle(){return response();}};
  }};return {db,queries,receiver};
}
Deno.test('source context uses one shared receiver independently of its direct GCash switch',async()=>{
  const h=database();const c=await paymentReceiptContext(h.db as any,'gotyme');
  assert.equal(c.route.sourceProvider,'gotyme');assert.equal(c.route.destinationProvider,'gcash');
  assert.equal(c.route.autoApprovalEnabled,true);assert.equal(c.route.gcashQrAlias,'TEST ALIAS');
  assert.equal(c.snapshot.verificationSettingsRevision,7);assert.equal(c.snapshot.account,h.receiver.account_reference);
  assert.ok(h.queries.find(q=>q.filters.method_code==='gotyme')?.filters.is_active);
  assert.equal(h.queries.find(q=>q.filters.method_code==='gcash')?.filters.is_active,undefined);
  for(const q of h.queries)assert.equal(q.filters[q.table==='tenants'?'id':'tenant_id'],TENANT_ID);
});
Deno.test('disabled source and conflicting old recipient cannot reach the receipt adapter',async()=>{
  for(const options of [{disabled:true},{wrongDestination:true}])await assert.rejects(paymentReceiptContext(database(options).db as any,'gotyme'));
});
Deno.test('global manual mode disables automatic eligibility while retaining upload context',async()=>{
  const c=await paymentReceiptContext(database({manual:true}).db as any,'maribank');
  assert.equal(c.route.autoApprovalEnabled,false);assert.equal(c.route.enabled,true);
});
Deno.test('PNB retains its independent receiver and receives no GCash private identity',async()=>{
  const h=database();const c=await paymentReceiptContext(h.db as any,'pnb');
  assert.equal(c.route,null);assert.equal(c.snapshot.destinationMethod,undefined);
  assert.equal(h.queries.some(q=>q.table==='picklestreet_receipt_route_settings'),false);
});

Deno.test('native Maya keeps its independent receiver without GCash identity',async()=>{
 const h=database({wrongDestination:true});const c=await paymentReceiptContext(h.db as any,'maya');
 assert.equal(c.route,null);assert.equal(c.snapshot.method,'maya');assert.equal(c.snapshot.account,'09999999999');
 assert.equal(h.queries.some(q=>q.filters.method_code==='gcash'||q.table==='picklestreet_receipt_route_settings'),false);
});
