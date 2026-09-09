import assert from 'node:assert/strict';
import { handleRequest, receiptRecipientDiagnostics, staffReviewResponse, TENANT_ID } from './index.ts';

const verificationId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const bookingId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const source={rawText:'PRIVATE RAW OCR',file:{sha256:'PRIVATE HASH'},detected:{route:{recipientMatched:false,
  recipient:{observedName:'TE•• VE••',observedNumber:'+63 917 111 1111',nameMatch:'mismatch',phoneMatch:'exact',expectedName:'PRIVATE EXPECTATION'},
  receiverSnapshot:{token:'PRIVATE TOKEN'}}}};

Deno.test('diagnostics return only bounded observed recipient evidence, never raw OCR or configured identity',()=>{
  assert.deepEqual(receiptRecipientDiagnostics(source),{observedName:'TE•• VE••',observedNumber:'+63 917 111 1111',nameMatch:'mismatch',phoneMatch:'exact',recipientMatched:false});
  assert.doesNotMatch(JSON.stringify(receiptRecipientDiagnostics(source)),/PRIVATE/);
  for(const input of [null,[],{detected:{route:{recipient:[],recipientMatched:'true'}}}]) {
    assert.deepEqual(receiptRecipientDiagnostics(input),{observedName:null,observedNumber:null,nameMatch:null,phoneMatch:null,recipientMatched:null});
  }
  assert.equal(receiptRecipientDiagnostics({detected:{route:{recipient:{observedName:'x'.repeat(1000)}}}}).observedName.length,160);
});

function store({receiptExists=true,bookingMatches=true}={}) {
  const calls:Array<{table:string;filters:Array<[string,unknown]>}>=[];
  const db={from(table:string){
    const call={table,filters:[] as Array<[string,unknown]>};calls.push(call);
    return {select(){return this;},eq(key:string,value:unknown){call.filters.push([key,value]);return this;},async maybeSingle(){
      return {error:null,data:table==='receipt_verifications'
        ? receiptExists?{id:verificationId,booking_id:bookingId,status:'approved',storage_path:'PRIVATE PATH',extracted_data:source}:null
        : bookingMatches?{id:bookingId,reference:'PB-SYNTHETIC',status:'confirmed',payment_status:'paid'}:null};
    }};
  }};
  return {db:db as unknown as Parameters<typeof staffReviewResponse>[0],calls};
}

Deno.test('confirmed receipt diagnostics are read-only and require matching tenant, receipt and booking reference',async()=>{
  const {db,calls}=store();
  const response=await staffReviewResponse(db,{action:'receipt_diagnostics',verificationId,bookingReference:'PB-SYNTHETIC'},'actor','https://picklestreetcourt.com');
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{ok:true,verificationId,...receiptRecipientDiagnostics(source)});
  assert.deepEqual(calls,[
    {table:'receipt_verifications',filters:[['tenant_id',TENANT_ID],['id',verificationId]]},
    {table:'bookings',filters:[['tenant_id',TENANT_ID],['id',bookingId],['reference','PB-SYNTHETIC']]},
  ]);
  for(const options of [{receiptExists:false},{bookingMatches:false}]) {
    await assert.rejects(staffReviewResponse(store(options).db,{action:'receipt_diagnostics',verificationId,bookingReference:'PB-SYNTHETIC'},'actor','https://picklestreetcourt.com'),(error:unknown)=>(error as {status:number}).status===404);
  }
});

Deno.test('diagnostics reject another tenant and unauthenticated requests before receipt lookup',async()=>{
  const previousFetch=globalThis.fetch;
  const envNames=['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY'];
  const old=envNames.map(name=>Deno.env.get(name));
  Deno.env.set('SUPABASE_URL','https://receipt-test.invalid');Deno.env.set('SUPABASE_SERVICE_ROLE_KEY','synthetic-service-key');
  const calls:string[]=[];
  globalThis.fetch=async(input)=>{
    const url=String(input);calls.push(url);
    assert.match(url,/\/rest\/v1\/rpc\/resolve_tenant_id$/);
    return new Response(JSON.stringify(TENANT_ID),{status:200,headers:{'Content-Type':'application/json'}});
  };
  try {
    for(const [slug,status] of [['other-court',403],['pickle-street-tugbok',401]] as const) {
      const response=await handleRequest(new Request(`https://receipt-test.invalid/functions/v1/picklestreet-receipts?tenantSlug=${slug}`,{
        method:'POST',headers:{'Content-Type':'application/json',Origin:'https://picklestreetcourt.com'},
        body:JSON.stringify({action:'receipt_diagnostics',verificationId,bookingReference:'PB-SYNTHETIC'}),
      }));
      assert.equal(response.status,status);
    }
    assert.equal(calls.length,1);
  } finally {
    globalThis.fetch=previousFetch;
    envNames.forEach((name,i)=>old[i]===undefined?Deno.env.delete(name):Deno.env.set(name,old[i]!));
  }
});
